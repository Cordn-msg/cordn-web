# Multi-Device Ratchet Divergence — Root-Cause Analysis and Fix Plan

Status: Executed — code (P0–P4) + spec deltas landed; pending review. No commits / pushes.
Date: 2026-07-29
Context: Field incident from two-device multi-device testing; analysis grounded in
[`reference/cordn/spec/applications/multi-device.md`](../reference/cordn/spec/applications/multi-device.md)
(the MD spec), the ts-mls secret-tree implementation, and the web client sources.

---

## 1. Incident report

Two devices, one identity (shared-leaf MD, opt-in):

- **D1** — primary, MD active all along, online continuously.
- **D2** — linked a while ago, then offline for an extended period.

Observed:

1. D2 reopened and **appeared to catch up** (full history visible).
2. All messages sent from D2 were **invisible on D1**.
3. D1's group sync issues show **"Desired gen in the past"** for every D2 message
   (cursors 431–437, 7/29 11:36–12:13).
4. D2's **only** sync issue is a single **"Skipped sibling commit (own shared leaf);
   awaiting group-document fast-forward"** (cursor 367, 7/28 08:32).

## 2. Background mechanics (verified in source)

### 2.1 "Desired gen in the past" (ts-mls)

Each MLS leaf has a per-epoch, per-content-type secret-tree ratchet
(`{ secret, generation, unusedGenerations }`). Each application message from a leaf
burns one generation; used secrets are deleted (forward secrecy).

- Receive path (`ratchetToGeneration`, `node_modules/ts-mls/dist/src/secretTree.js:160`):
  a message generation below the ratchet's current generation is only decryptable if
  still present in `unusedGenerations`, which is capped by
  `retainKeysForGenerations: 10` (`keyRetentionConfig.js`). Otherwise:
  **"Desired gen in the past"**.
- **Send path (`consumeRatchet` → `createRatchetResult`) never populates
  `unusedGenerations`.** Retention only applies to generations stepped over while
  *receiving*. Generations a device consumed via its **own sends** are gone
  immediately and forever.
- Consequence: once two writers of the same leaf diverge, the loser's messages are
  **unrecoverable** (lost, not delayed), and retention does nothing when the leader
  advanced via its own sends.

### 2.2 Shared-leaf model makes the generation counter distributed state

Both devices occupy one leaf ([`multi-device.md`](../reference/cordn/spec/applications/multi-device.md) §3).
Each device increments the leaf's send generation independently; the only thing
keeping replicas in lockstep is **complete, in-order stream processing of each
other's sends** (spec §10: "Application messages converge via the delivery stream").
Any mechanism that advances a cursor without ratcheting is a potential permanent
divergence.

### 2.3 Cursor bookkeeping in the web client

- Own sends advance `lastCursor`, **not** `fetchCursor`
  (`sendChatGroupMessage`, `src/lib/services/chatGroups.svelte.ts:1395`).
- Own echoes are skipped via `seenCursors` (outbound message stored with
  `posted.cursor`), but the skip still advances `fetchCursor`
  (`src/lib/services/chatGroupMessages.svelte.ts:507`).
- Group documents publish `cursor: fetchCursor`
  (`src/lib/services/multiDevice.ts:230`) and are republished **only on
  epoch-advancing commits** (`onGroupStateAdvance` in
  `runOutboundGroupOperation`, `src/lib/services/chatGroups.svelte.ts:605`) —
  unconditionally, not waiting for self-echo.
- Fast-forward clamps `fetchCursor = max(existing.fetchCursor, doc.cursor)`
  (`src/lib/services/multiDevice.svelte.ts:2011`); same-epoch docs are rejected
  (`incomingEpoch <= localEpoch → 'skipped'`).

## 3. Root cause

**The §8.5 chained catch-up and the live delivery stream both claim the
`(tipDoc.cursor, now]` window; when catch-up wins the race, live ingestion skips
those messages silently and the shared-leaf ratchet never advances.**

Sequence of the incident (all steps spec-compliant — the bug class lives in the
spec's epoch-centric definitions, see §5):

1. **7/28, cursor 367:** D1 authors a Commit (epoch E → E+1) and republishes the
   group document per spec §10. A new epoch resets generation counters to 0. The
   published doc carries ratchet gen ~0 and `cursor ≈ 367`.
2. D1 sends ~63 application messages (cursors 368–430, generations 0–62). No
   republish — spec §10: "Application traffic … needs no re-publish."
3. **7/29, D2 opens:** the §10.6 reconcile gate fast-forwards D2 to the doc
   (epoch E+1 correct, ratchet gen 0, `fetchCursor = max(local, doc.cursor)`).
4. **§8.5 catch-up fires** (fire-and-forget, concurrent with the live watch):
   - The gap fetch is `after: decryptFrontier` — **unbounded above** — so it
     includes cursors 368–430 (`catchUpGroupFromChain`,
     `src/lib/services/multiDevice.svelte.ts:2112`).
   - The final partition range is `(tipDoc.cursor, +Infinity]`, replayed against
     the tip state (`boundaries` construction, `multiDevice.svelte.ts:2147`;
     `partitionGapByEpoch`, `src/lib/services/multiDevice.ts:457`).
   - Replay decrypts on a **disposable copy** of the state — "Catch-up never
     touches state" — and merges the recovered messages into `group.messages`
     for display (`multiDevice.svelte.ts:2165`).
   - The replay also ingests the historical commit at 367 with
     `localStablePubkey` set → `SiblingCommitSkippedError` → **the single issue
     observed on D2** (merged via the catch-up issue-merge path).
5. **Live watch** fetches the same window (`after: fetchCursor = doc.cursor`).
   But `ingestChatGroupMessages` builds `seenCursors` from `group.messages` at
   ingest start — and where the §8.5 merge landed first, every cursor hits
   `seenCursors.has(cursor)` → **skip: cursor advances, ratchet never steps, no
   issue recorded** (`chatGroupMessages.svelte.ts:507`). Total, traceless
   divergence. The race outcome is timing-dependent; partial interleaves produce
   partial gaps.
6. **D2 sends** (cursors 431–437): its live ratchet is still at gen ~0, so it
   emits generations 0–6. D1 is at gen ~63, advanced via its own sends → no
   retained keys → **"Desired gen in the past" ×7**, same epoch.
7. **No healing:** same-epoch document adoption is forbidden (spec §8
   forward-only), docs only republish on commits, and no commit happened after
   367. D2 stays broken until some unrelated commit bumps the epoch.

Fingerprint match: D2's single issue (a §8.5 replay artifact), "seemed to catch
up" (display-only recovery), same-epoch gen errors on D1 (epoch fast-forwarded,
ratchet didn't), and persistence (no in-spec repair).

## 4. The concurrent-send collision — scoped correctly

The **strictly-concurrent collision** (both devices pick generation *g* before
either sees the other's message) is a rare edge case for one human: the window is
stream delivery latency (sub-second to seconds), the cost is bounded (each side
loses one of the *other's* messages), and it **self-heals** (both ratchets land at
*g+1*). Not worth heavy engineering.

**However**, the same failure signature arises from the **stale-watch window**,
which is minutes to hours and occurs in normal usage: `prepareGroupForApplicationMessage`
trusts `isGroupActivelyWatched` (`chatGroups.svelte.ts:487`) and skips the pre-send
catch-up, but "watched" ≠ "current" — backgrounded browser tabs get frozen,
mobile WebViews get suspended, sockets go zombie. The common pattern — send from
the phone, then open a laptop whose tab was backgrounded all day and immediately
reply — sends from a ratchet *k* generations stale. No commit, no offline period,
no §8.5 needed. This is the realistic version of "two devices at once" and is why
the pre-send guard (P2) stays in the plan.

## 5. Spec findings (multi-device.md) — update justified

The implementation is largely *faithful* to the spec; the holes are in the spec's
epoch-centric definitions, which miss the ratchet-generation dimension:

1. **§4.1 — consistent-snapshot rule is epoch-level only.**
   *"The `(clientState, cursor)` pair MUST be a consistent snapshot: ingesting the
   delivery stream up to and including `cursor` MUST leave the writer at the epoch
   encoded in `clientState`."* The implementation's `cursor: fetchCursor` satisfies
   the letter but not the ratchet: own sends are folded into `clientState` at send
   time yet their cursors exceed `fetchCursor`, so the pair can be epoch-consistent
   and ratchet-inconsistent.
2. **§8.5 — the gap is unbounded above.**
   *"Fetch that group's message gap (every delivery-stream message after the local
   cursor)"* — implemented verbatim. The tail range `(tipDoc.cursor, ∞)` overlaps
   live delivery's territory; combined with cursor-based dedup (an implementation
   detail the spec doesn't constrain), display recovery suppresses live ratcheting.
   The spec never states the invariant it implies in §10: **every device must
   ratchet-process every same-leaf application message exactly once through the
   stream path.**
3. **§8 — forward-only rule makes within-epoch ratchet drift unhealable.**
   *"Never adopt a `clientState` at or below the local epoch."* Ratchet divergence
   is within-epoch, so no document can repair it. The spec defines no divergence
   signal and no repair for application-ratchet desync; §10's concurrency analysis
   covers only Commits, not application messages. Note: same-epoch document
   adoption is NOT a safe repair mechanism (a doc's cursor doesn't reveal its
   shared-leaf ratchet position; adopting a ratchet-older doc would regress the
   adopter) — epoch advance is the only sound reset.
4. **§10.6 — "behind" is defined only in epochs.**
   *"A device MUST NOT begin backlog fetch for a group whose local epoch is behind
   the tip"* — implemented. But a device that skipped same-leaf application
   messages at its *current* epoch is behind **for sending purposes**, and the
   spec doesn't know it.

## 6. Spec deltas (cordn repo, `spec/applications/multi-device.md`)

1. **§4.1:** strengthen the snapshot rule to ratchet granularity — every stream
   message whose processing advanced any per-leaf ratchet in `clientState` MUST
   have cursor ≤ `cursor`. Writer-side rule: `cursor` covers both processed
   inbound *and* own posted messages (implementation: `max(fetchCursor, lastCursor)`).
2. **§8.5:** bound the gap at the tip document's cursor and state the partition
   invariant: **catch-up owns `(localCursor, tipDoc.cursor]`; live delivery owns
   `(tipDoc.cursor, ∞)`.** Add a MUST: display recovery must not mark stream
   messages as processed for dedup purposes. (The tail replay is pure UX latency —
   live delivery always covers it — so nothing is lost by bounding.)
3. **§10:** add the shared-leaf application-ratchet invariant (process every
   same-leaf app message exactly once via the stream); a concurrent-application-
   messages paragraph (rarity, bounded cost, self-healing); and the **divergence
   signal + repair**: generation-in-the-past on an MD group indicates sibling
   divergence; since §8 forbids same-epoch document repair, convergence is
   restored by an **epoch-advancing self-update Commit + republish** by the
   detecting device (SHOULD, rate-limited once per epoch per group).
4. **§10.6:** extend "behind" to the generation dimension — a device that has
   skipped same-leaf application messages at its current epoch MUST catch up the
   stream before staging application sends.
5. **§13 (optional):** note ratchet divergence as an availability hazard of the
   shared-leaf model, mitigated by the §8.5 bound + §10 repair, eliminated only by
   per-device leaves.

## 7. Implementation plan (cordn-web, no new files)

Ordered by priority. P0 fixes the reported incident; P0+P1 make the partition
invariant hold by construction; P2 closes the realistic race; P3 is the safety
net; P4 is cheap insurance.

### P0 — Bound the §8.5 replay (fixes the incident)

- `src/lib/services/multiDevice.svelte.ts` (`catchUpGroupFromChain`, ~line 2147):
  drop the `Number.POSITIVE_INFINITY` boundary so the replay covers only
  `(decryptFrontier, tipDoc.cursor]`. Tail messages stay with live delivery, which
  both stores *and* ratchets them. One line plus comment.
- Safe in all cases: a third-party Commit in the tail is processed in-band by live
  delivery; a sibling Commit in the tail is sibling-skipped + awaited per §10.
- Regression test in `src/lib/services/multiDevice.test.ts`: gap messages beyond
  the tip cursor are **not** merged by catch-up.
- Invariant restored: *a cursor must only enter `group.messages` if the live state
  ratcheted it.*

### P1 — Honest document cursor

- Thread `lastCursor` into `GroupSnapshot` (`src/lib/services/multiDevice.ts:140`
  and `toGroupSnapshot`, `src/lib/services/multiDevice.svelte.ts:1388`).
- `buildGroupDocument` (`multiDevice.ts:218`): publish
  `cursor: max(fetchCursor, lastCursor)`.
- Effect: the §4.1 strengthened rule holds; adopters neither skip ratchet-folded
  messages nor re-process the writer's unechoed sends (which today produce
  spurious gen-in-past noise on the adopter).
- Known tiny trade-off: an adopter won't display sends in the writer's unechoed
  echo-window (seconds) — spec-consistent with §9 ("messages at or before cursor
  are not re-fetched").

### P2 — Pre-send guard for MD groups

- `prepareGroupForApplicationMessage` (`src/lib/services/chatGroups.svelte.ts:487`):
  when MD is active, don't trust `isGroupActivelyWatched` alone — route through the
  coordinator catch-up (`assertGroupCanPerformOutboundOperation`), or minimally
  when a fast-forward/sibling-skip occurred this session or last ingestion is
  older than a few seconds.
- Cost: one `after: fetchCursor` round-trip per send, near-empty when current.
- Closes the stale-watch window (§4) — the common version of the collision concern.

### P3 — Divergence detection + epoch-advance repair (self-heal)

- In the `isStaleGenerationIssue` branch of `ingestChatGroupMessages`
  (`src/lib/services/chatGroupMessages.svelte.ts:686`): on gen-in-past in an
  MD-active group, treat as probable sibling divergence and have the **detecting**
  device author a self-update Commit through the existing
  `runOutboundGroupOperation` chokepoint (which already republishes the doc).
- The detector holds the advanced state, making it the right repairer. Epoch bump
  → sibling fast-forwards → ratchets resync.
- Rate-limit: once per epoch per group (the error repeats per message).
- Lost messages stay lost (visible as sync issues; user can resend) — the goal is
  bounding divergence from silent-permanent to transient-self-healing.

### P4 — Sealed-layer behind-safety (latent, same class)

- Unseal-failure branch (`chatGroupMessages.svelte.ts:520`): when `mdActive`,
  mirror the `epochAhead` logic — record a deduped issue but **do not advance
  `fetchCursor`**. The seal hides the epoch, so a behind device currently advances
  past messages it cannot classify, making them unrecoverable before the
  epochAhead gate can ever see them.
- Did not fire in this incident (no unseal issues on D2) but is the same hole one
  layer down.

## 8. Validation

- Existing seams are covered by `src/lib/services/multiDevice.test.ts` and
  `src/lib/services/chatGroupMessages.test.ts`; add:
  - **P0 regression:** fast-forward + §8.5 + live ingest over the same window →
    catch-up must not merge cursors above the tip doc cursor.
  - **Incident reproduction:** fast-forward + catch-up + live delivery, then a
    sibling send → must decrypt on the primary device.
- `pnpm check`, `pnpm lint`, `pnpm test` before landing.
- Field re-test of the exact incident scenario: D2 offline, D1 commits + chats,
  D2 opens, D2 sends → expect zero sync issues on both devices.

## 9. Sequencing and ownership

| Step | Repo | Scope |
| --- | --- | --- |
| 1 | cordn-web | P0 (+ regression test) — ship first |
| 2 | cordn-web | P1 |
| 3 | cordn (spec) | §4.1, §8.5 deltas (alongside steps 1–2) |
| 4 | cordn-web | P2 |
| 5 | cordn (spec) | §10, §10.6 deltas |
| 6 | cordn-web | P3 |
| 7 | cordn-web | P4 |
| 8 | cordn (spec) | §13 note (optional) |

Spec deltas and code fixes can proceed in parallel; no implementation coupling
between them beyond the shared invariants in §6.
