# MLS state health and recovery plan

## Context

Production testing revealed that a single poisoned group can do more than break one local client. A divergent admin client accepted a pending join request for the poisoned group, produced a new add-member commit and welcome from its local MLS state, and posted that commit to the coordinator. Other clients that were previously healthy then became poisoned after processing that commit.

This is consistent with Cordn's coordinator/client trust boundary:

- Coordinators are intentionally dumb delivery services.
- Coordinators preserve per-group ordering and fetch progression.
- Clients create, process, and validate MLS state.
- Coordinators cannot know whether a posted MLS commit was authored from a branch that all current members can process.

The defensive boundary must therefore be the client.

## Core finding

A poisoned client must not be allowed to author new group traffic.

The critical failure mode was:

```text
1. Client A has a locally poisoned/divergent group state.
2. Client A still has admin rights in that local state.
3. Client A accepts a pending join request.
4. Client A creates an add-member commit from the poisoned branch.
5. The coordinator stores and orders the message correctly.
6. Healthy clients fetch/subscribe and process the commit.
7. Healthy clients become poisoned too.
```

The coordinator behaved according to its role. The missing invariant was local: clients must not author from unhealthy state.

## Immediate hardening rules

### Poisoned groups are read-only

Once a group is marked poisoned/unhealthy, it should become read-only for all normal operations, just as deleted from group state behaves:

- no message send
- no invite/add-member
- no join-request acceptance
- no remove-member
- no metadata update
- no normal watch progression for that group
- no normal manual sync that blindly mutates durable state

The group can still be displayed with local diagnostics and recovery guidance.

### Catch up before outbound operations

Before any outbound group operation, the client should fetch and ingest pending coordinator messages first.

If catch-up marks the group poisoned, abort the outbound operation.

This should apply to:

- send message
- invite/add-member
- accept join request
- remove member
- update metadata

The CLI already follows this shape for add-member flows:

```text
catch up group
assert group is active
assert admin permission
prepare MLS operation
post group message
adopt new state
```

The web client should match this reference behavior.

## Snapshot registry model

The recovery primitive should be a bounded local MLS state snapshot registry.

Keep at most three snapshots per group:

```text
[healthy, healthy, healthy]
```

or, immediately after an epoch-moving transition:

```text
[healthy, healthy, tentative]
```

Rules:

1. Keep at most three snapshots per group.
2. Keep at most one tentative snapshot.
3. The tentative snapshot, if present, is always the newest/current snapshot.
4. Tentative state is usable by the UI and outbound operations.
5. Tentative state does not block UX.
6. Tentative state only prevents older healthy rollback points from being evicted by promotion.
7. Promotion only flips `tentative` to `healthy`.
8. Promotion does not evict previous healthy snapshots.
9. A new epoch-moving tentative snapshot replaces the previous tentative snapshot.
10. If there is no tentative snapshot, a new epoch-moving snapshot appends and evicts the oldest snapshot only when length exceeds three.

Example transitions:

```text
[H1, H2, H3]
commit epoch 4 succeeds
=> [H2, H3, T4]

later inbound decrypt succeeds
=> [H2, H3, H4]

commit epoch 5 succeeds
=> [H3, H4, T5]

self/local epoch 6 succeeds before T5 promotion
=> [H3, H4, T6]

later inbound decrypt succeeds
=> [H3, H4, H6]
```

Replacing `T5` with `T6` loses a speculative rollback point, but that is acceptable because `T5` was never confirmed healthy. Recovery still starts from the newest healthy snapshot, and replay can reconstruct valid intermediate epochs deterministically from coordinator history.

## Tentative state semantics

Tentative must not mean read-only.

Blocking tentative groups would deadlock UX:

```text
1. Everyone receives the same commit.
2. Everyone marks the new state tentative.
3. Everyone waits for a later message to confirm the state.
4. Nobody can send because tentative is blocked.
5. Confirmation never arrives.
```

Instead:

- poisoned blocks operations
- tentative preserves rollback state
- healthy is a confirmed recovery anchor

Tentative current state should remain usable. The only restriction is snapshot retention: do not treat it as a confirmed healthy checkpoint until it is promoted.

## Promotion rule

Promote a tentative snapshot to healthy when the client successfully processes later inbound traffic under that state.

Recommended first version:

- Promote on a later successfully decrypted application message.
- The message must be after the tentative-producing cursor.
- Stale/former-epoch messages must not promote.
- Self-echo reconciliation should not promote initially, because it may not prove inbound decryptability.

This keeps the rule conservative without harming UX.

## Recovery model

Recovery should use the newest healthy snapshot as a deterministic replay base.

High-level algorithm:

```text
1. Detect fatal MLS failure at cursor C / epoch E.
2. Mark group poisoned and stop normal progression.
3. Select newest healthy snapshot before C/E.
4. Restore that snapshot into a working recovery session.
5. Fetch coordinator messages using since_epoch = snapshot.epoch.
6. Replay through the same ingestion pipeline.
7. If replay succeeds past the failing cursor, persist recovered state and clear poisoned status.
8. If replay fails again, keep poisoned status and surface manual recovery guidance.
```

Recovery should be explicit at first, not automatic. Automatic rollback/replay can loop or oscillate if the underlying coordinator history contains an unrecoverable branch. Always prompt the user for manual recovery.

## Suggested snapshot fields

```ts
type ChatGroupStateSnapshotStatus = 'healthy' | 'tentative';

interface ChatGroupStateSnapshot {
	groupId: string;
	status: ChatGroupStateSnapshotStatus;
	epoch: string;
	cursor: number;
	createdAt: number;
	stateBytes: Uint8Array;
	triggerCursor?: number;
	triggerMessageId?: string;
}
```

Notes:

- `epoch` should be stored as a string to match existing bigint persistence style.
- `cursor` is the known coordinator progression for the snapshot.
- `triggerCursor` or `triggerMessageId` is useful for diagnostics and replay boundaries.
- `stateBytes` should be encoded/decoded at the storage boundary like existing group state bytes.

## Suggested operation guard

```ts
async function assertGroupCanPerformOutboundOperation(groupId: string) {
	const group = requireChatGroup(groupId);
	assertChatGroupIsActive(group);

	await catchUpGroupBeforeOutboundOperation(group);

	const refreshed = requireChatGroup(groupId);
	assertChatGroupIsActive(refreshed);

	if (isChatGroupPoisoned(refreshed)) {
		throw new Error('This group is unhealthy and is read-only until recovered.');
	}

	return refreshed;
}
```

This guard should be used by sends, membership changes, join-request acceptance, and metadata updates.

## Suggested snapshot update helpers

```ts
function appendHealthySnapshot(
	snapshots: ChatGroupStateSnapshot[],
	next: ChatGroupStateSnapshot
): ChatGroupStateSnapshot[] {
	const withoutTentative = snapshots.filter((snapshot) => snapshot.status === 'healthy');
	return [...withoutTentative, { ...next, status: 'healthy' }].slice(-3);
}

function replaceTentativeSnapshot(
	snapshots: ChatGroupStateSnapshot[],
	next: ChatGroupStateSnapshot
): ChatGroupStateSnapshot[] {
	const healthy = snapshots.filter((snapshot) => snapshot.status === 'healthy').slice(-2);
	return [...healthy, { ...next, status: 'tentative' }];
}

function promoteTentativeSnapshot(
	snapshots: ChatGroupStateSnapshot[]
): ChatGroupStateSnapshot[] {
	return snapshots.map((snapshot) =>
		snapshot.status === 'tentative' ? { ...snapshot, status: 'healthy' } : snapshot
	);
}
```

The exact implementation can differ, but the invariants should remain: max three snapshots, max one tentative, tentative is newest.

## CLI harness test cases to add

### 1. Poisoned admin cannot accept a join request

Scenario:

```text
1. Alice creates a group and has admin rights.
2. Alice's local group state is made divergent/poisoned.
3. Bob submits a join request.
4. Alice attempts to accept the join request.
5. Client catches up before accepting.
6. Catch-up detects poison.
7. Accept operation aborts.
8. No add-member commit is posted to the coordinator.
9. Other healthy clients remain healthy.
```

Assertion focus:

- `PostGroupMessage` is not called.
- Join request remains pending or is not marked accepted.
- Healthy clients can still send/sync.
- Poisoned client shows a sync issue and read-only state.

### 2. Poisoned admin cannot add member directly

Scenario:

```text
1. Alice creates a group.
2. Alice becomes locally poisoned.
3. Alice tries add-member directly with Bob's key package.
4. Catch-up detects poison.
5. Operation aborts before consuming/posting.
```

Assertion focus:

- No commit is posted.
- Ideally no key package is consumed before health is confirmed.
- Group is marked poisoned/read-only.

### 3. Outbound send catches up before authoring

Scenario:

```text
1. Alice has stale local state.
2. Coordinator contains pending messages that will poison Alice's state.
3. Alice tries to send.
4. Client catches up first.
5. Poison is detected.
6. Send aborts.
```

Assertion focus:

- No application message is posted after poison detection.
- Cursor does not advance past fatal cursor.
- Group becomes read-only.

### 4. Tentative state does not block UX

Scenario:

```text
1. Alice and Bob are healthy.
2. Alice posts an epoch-moving commit.
3. Bob processes it and creates a tentative snapshot.
4. Bob sends an application message before tentative promotion.
5. Alice decrypts Bob's message.
```

Assertion focus:

- Bob is allowed to send while tentative.
- Bob retains older healthy snapshots.
- Bob has at most one tentative snapshot.

### 5. Tentative promotion on later inbound decrypt

Scenario:

```text
1. Bob processes a commit and stores Tn.
2. Alice sends a later application message.
3. Bob decrypts it successfully.
4. Tn is promoted to healthy.
```

Assertion focus:

- Snapshot status flips from tentative to healthy.
- Previous healthy snapshots are not evicted by promotion.
- Snapshot count remains <= 3.

### 6. New tentative replaces old tentative

Scenario:

```text
1. Snapshot registry is [H1, H2, T3].
2. A local/self-authored epoch-moving operation creates epoch 4 before T3 promotion.
3. Registry becomes [H1, H2, T4] or [H2, H3, T4] depending on available confirmed snapshots.
```

Assertion focus:

- There is never more than one tentative snapshot.
- The tentative snapshot is always newest.
- Unconfirmed tentative snapshots are not retained as recovery anchors.

### 7. Recovery replay from newest healthy snapshot

Scenario:

```text
1. Registry contains [H1, H2, T3].
2. Fatal failure occurs after T3.
3. Recovery selects H2.
4. Client fetches using since_epoch = H2.epoch.
5. Client replays coordinator history.
```

Assertion focus:

- Replay uses the same ingestion pipeline.
- Successful replay clears poisoned status.
- Failed replay preserves poisoned status and does not advance past the fatal cursor.

## Final implementation priorities

1. Poisoned groups are read-only for all normal operations.
2. Catch up before every outbound group operation.
3. Add a bounded state snapshot registry with max three snapshots.
4. Support `[healthy, healthy, healthy]` and `[healthy, healthy, tentative]` shapes.
5. Keep tentative usable and non-blocking.
6. Promote tentative on later successful inbound application decrypt.
7. Recover explicitly from newest healthy snapshot using `since_epoch` replay.
8. Add CLI harness tests for poisoned admin propagation, tentative behavior, promotion, replacement, and recovery replay.
