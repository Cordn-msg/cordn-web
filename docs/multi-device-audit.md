# Multi-device feature audit

- Date: 2026-07-14
- Scope: `src/lib/services/multiDevice.ts` (pure core), `src/lib/services/multiDevice.svelte.ts` (service layer), and their integration points (`chatGroupMessages.svelte.ts`, `chatGroupWatch.svelte.ts`, `chatGroups.svelte.ts`, `chatKeyPackages.svelte.ts`, `chatGroupSnapshots.ts`, `chatUiActions.svelte.ts`).
- Spec reference: `cordn/spec/applications/multi-device.md`.

## Overall verdict

The implementation is **faithful to the spec and architecturally sound**. The hard invariants are all correctly implemented and unit-tested at the pure-core level:

- §8 CRDT resolution (forward-only epoch, seed/fast-forward/skip, tombstone anti-downgrade) ✅ tested
- §10 sibling-skip in the MLS authorization callback (before UpdatePath applies — exact detection, not heuristic) ✅ tested
- §10.5 reconcile-before-push via a shared `applyTip` chokepoint ✅
- §10.5 tombstone carry-forward durability (with idempotency regression test) ✅ tested
- §10.6 ingest gate wired into `startWatchingAllGroups` ✅
- §4.3 live-XOR-tombstoned enforced once in `buildInventory` ✅ tested
- §8.5 chained catch-up with correct per-epoch gen-0 selection ✅ `walkGroupChain` tested
- §11.5 last-resort replication + §6 DEK-in-tip ✅
- Content-addressing re-verified on both publish and pull ✅ tested
- MLS state health (tentative/healthy snapshots, poisoned=read-only, catch-up-before-outbound, explicit recovery) ✅ wired

The pure-core / service-layer split is the right call and pays off in testability. The `ponytail:` comments consistently mark deliberate simplifications with their ceilings — exactly the discipline that keeps this kind of code honest.

What follows is the gap analysis, ranked by impact.

## Findings

### P1 — Shipping blockers / correctness gaps

**1. `dbg` logging is shipping-hot.** `multiDevice.svelte.ts` — `dbg()` is gated only on `browser`, not on a dev flag. **46 call sites** + 3 direct `console.*` calls will spam `[multi-device] …` into production consoles, including metadata that weakens the tip's unlinkability goal (gid prefixes, document addresses, server names, byte sizes, relay counts). The docstring literally says *"Remove before shipping."*

Fix: gate on Svelte's dev flag. The module already imports `browser` from `$app/environment`; add `dev` from the same module:

```ts
import { browser, dev } from '$app/environment';

function dbg(label: string, detail?: unknown): void {
	if (!browser || !dev) return;
	console.debug('[multi-device]', label, detail ?? '');
}
```

`dev` is the Svelte-native signal for "dev server is running" and is the project-consistent choice (the codebase already imports `browser` from `$app/environment` throughout). Note `dev` is not guaranteed to correspond to `NODE_ENV` or `MODE` — it is specifically the dev-server flag, which is exactly what we want here. If production-debuggability is later needed, layer a `localStorage`-read flag (`cordn.debug.multiDevice`) on top, but default to silent in prod.

**2. §10 symmetric-race mitigation #1 is not implemented.** `assertGroupCanPerformOutboundOperation` (`chatGroups.svelte.ts:451`) catches up the **coordinator delivery stream** before an outbound Commit, but it does *not* reconcile the multi-device tip, and nothing refuses to stage a Commit when the device has skipped a sibling Commit but not yet fast-forwarded. The spec calls this a SHOULD (§10 mitigation #1). Consequence today: a device that authors a Commit while behind a sibling's Commit produces a doomed Commit (others drop it as a former-epoch message, the author fast-forwards and loses the op). Not corruption — but the user's invite/remove/metadata change silently no-ops. Cheapest real fix: before staging an epoch-advancing Commit, check for an unresolved `SiblingCommitSkipped` syncIssue whose epoch is above local, and surface a "this device is behind, re-syncing…" conflict instead of authoring.

**3. No service-layer tests.** `multiDevice.ts` (pure core) has 45 tests. `multiDevice.svelte.ts` (**2107 lines**, the hardest logic) has **zero**. Specifically untested:

- `publish()` — the reconcile-before-push → re-seal → `buildInventory` → tombstone-carry-forward-persist → `pendingReap` queueing sequence. The idempotency test proves `composeTombstoneUnion` is idempotent; it does *not* prove `publish()` calls it with the right args in the right order.
- `catchUpGroupFromChain` — the per-epoch boundary partitioning is the most subtle logic in the feature. `walkGroupChain` is tested; its caller (the replay loop that threads `states[i]` against `boundaries[i..i+1]`) is not.
- `handleTipEvent` dedup / `inflightTipEventId` re-entrancy guards.
- `fastForwardGroup` CAS-under-lock.
- `softDeleteGroup` atomic tombstone-append + publish on the serialized lane.

The seams for testing already exist (`BlobStore`, `Nip44Seal`, `ReconcileTarget` are injected interfaces). This is the highest-leverage test work you could do.

### P2 — Code smells / dead code

**4. Dead code: `appendHealthySnapshot`.** Defined in `chatGroupSnapshots.ts:29`, exercised by `chatGroups.test.ts:621`, but **never called from production code**. The actual snapshot flow uses `replaceTentativeSnapshot` + `promoteTentativeSnapshot`. Delete it and its tests.

**5. `multiDevice.svelte.ts` is a 2107-line monolith mixing 8+ concerns.** Config persistence, NIP-44/Blossom adapters, tip transport, the serialized+coalesced publish lane, the tip subscription, reconciliation, device linking, chained catch-up, soft-delete, reaping. The pure core was extracted; the service layer wasn't. Not urgent on its own, but it's the root cause of #3 (untestable) — the publish lane and the catch-up replay are the two slices that most warrant extraction into their own modules with injected seams.

**6. `catchUpGroupBeforeOutboundOperation` does not reconcile the multi-device tip.** It only catches up the coordinator stream. This is the same root gap as #2: a sibling Commit that has been *published as a group document* but not yet delivered on the stream is invisible to the outbound guard. Folding a tip reconcile (or at least a "do I have an unresolved sibling-skip?" check) into the outbound guard closes both.

### P3 — Inefficiencies / bottlenecks

**7. Unbounded parallelism on cold-link seed.** `applyTip` (`multiDevice.svelte.ts`) does `Promise.all(pointer.groups.map(...))`. For an identity with N groups, each `pullDocument` races M Blossom servers → up to N×M concurrent fetches (e.g. 13×3 = 39). `makeReadStore`'s `Promise.any` race mitigates the slow-primary case *per document*, but N documents in parallel can still saturate the browser's connection pool and stall the whole cold link behind one slow host. A small concurrency limiter (4–6 in flight) on the group fan-out would make cold links more predictable. Low priority — the race already prevents head-of-line blocking per-doc.

**8. `makeReadStore` aborts losers only after the winner fully downloads.** `multiDevice.svelte.ts` — `controller.abort()` fires inside the winner's callback *after* `fetchBlob` resolves, so losers keep downloading the full body until the winner's full body is in hand. Wastes bandwidth on large group docs. Cheap fix: abort losers as soon as the first promise fulfills (move the abort into `.then` on each, or use a shared abort on first settled). Minor.

**9. `carriedTombstones` grows unbounded in localStorage.** Spec-compliant ("retained for the identity's lifetime — bounded by group churn"), and the XOR at publish prunes resurrected gids. But adopted *peer* tombstones for groups this device never held are carried forever (the `applyTip` union uses empty `presentGids`). ~80 bytes each; needs thousands of soft-deletes across the fleet to matter. Not near-term. Worth a cap or a TTL sweep eventually.

**10. `walkGroupChain` 1000-hop bound is silent.** Hitting it during catch-up means messages beyond are silently lost (single-snapshot fallback); during reaping, blobs beyond aren't reaped. No surfacing when the bound is hit. A high-churn group over years could reach it. At minimum log/syncIssue when the bound is hit so it's diagnosable; ideally make it a named constant with a comment on the trade-off.

### P4 — Minor / UX

**11. `reconcileMultiDeviceNow` can bail silently.** It clears `lastSeenTip`/`lastSeenTipEventId` then calls `handleTipEvent`, but the `inflightTipEventId` guard makes it a no-op if a background cycle for the same tip is in flight. User clicks "Re-sync now" and nothing visibly happens. Either bypass the inflight guard for manual triggers or surface "already syncing."

**12. `linkDeviceFromConnectionString` inherits default Blossom servers, not the source's.** Documented `ponytail:` trade-off. Read path tries `pointer.servers` first so reads still work, but new docs replicate to the defaults while old chain links live on the source's servers. If the source's servers later vanish, old chain links become unreachable → catch-up falls back to single-snapshot (message loss for those epochs). Worth a one-line UI note on the link screen, or inherit the source's server list from the tip's `server` tags.

**13. Rotation reap is best-effort with a 15s cap.** Stranded blobs are unrecoverable without BUD-12 `/list` (acknowledged in comments). The rotation UI should probably warn that historical blobs may remain if the tab closes mid-rotation.

### Interop — confirmed aligned

The CLI (`references/cordn`) uses `DEFAULT_TIP_KIND = 30078` / `DEFAULT_TIP_INNER_KIND = 178`, matching the web client's `MULTI_DEVICE_TIP_KIND` / `MULTI_DEVICE_INNER_KIND`. Schema version, document shapes, and the §8 rule agree across both. No interop drift found. (Minor: the CLI makes the kinds configurable via opts; the web hardcodes. Defaults match, so fine.)

## Recommended next steps (ordered)

1. ✅ **Gate `dbg` behind `dev` from `$app/environment`.** Done — `dbg` now returns early unless `browser && dev`; all 46 call sites silent in prod. (#1)
2. ✅ **Add service-layer tests for `publish()` and `catchUpGroupFromChain`.** Done via pure-helper extraction (the established `multiDevice.ts` pattern) rather than mocking the world: `partitionGapByEpoch` (§8.5 replay boundaries) and `planCarryForward` (§10.5 durability + §12 reap) moved to the pure core, wired into the service layer, covered by 12 new tests. The service-layer orchestration now delegates its subtle logic to tested pure functions. (#3, #5)
3. ✅ **Implement §10 mitigation #1.** `reconcileTipForOutbound()` self-heals (fast-forwards) before staging instead of refusing — strictly better UX than the spec's "refuse to stage" wording. Delta-gated via `handleTipEvent`'s `lastSeenTipEventId` dedup, so the common case is one relay round-trip; no-op when MD is off. Covers invite/remove/metadata (the epoch-advancing paths); application messages on watched groups skip the guard entirely (they don't advance the epoch). **Final-pass correction:** the reconcile is called from a new `runOutboundGroupOperation` helper that runs it *before* `runGroupOperation` acquires the per-group lock — NOT from inside `assertGroupCanPerformOutboundOperation`. The guard runs inside the lock, and `reconcileTipForOutbound` → `fastForwardGroup` re-enters `runGroupOperation` (same group) → the chain mutex deadlocks (inner acquire awaits the outer's `release()`). Reconciling before the lock lets the fast-forward acquire+release cleanly; the helper's comment documents the deadlock so it can't be re-broken. Residual: the narrower window where a sibling Commit is on the coordinator stream but its group document isn't published yet — left to the tip subscription's seconds-later convergence (spec §10 mitigation #3 calls full auto-resolution disproportionate). (#2, #6)
4. ✅ **Delete `appendHealthySnapshot` + its tests.** Done. (#4)
5. ✅ **Concurrency-limit the cold-link group fan-out.** Done — `mapPool` + `MD_GROUP_RECONCILE_CONCURRENCY = 5` bound the `applyTip` group fan-out (was unbounded `Promise.all`). (#7)
6. ⏭️ **Move `makeReadStore`'s abort to first-settled.** Skipped on re-examination — the audit finding was a misread. `fetchBlob` passes `signal` through to `fetch()`, and `controller.abort()` fires inside the winner's callback the instant its `fetchBlob` resolves, so losers' body downloads ARE cancelled at first-fulfillment (not "after the winner fully downloads"). The only remaining parallelism (N servers downloading until the first completes) is inherent to racing and optimal for an opaque `fetchBlob`. No change needed. (#8)

All six items resolved. `pnpm check` 0/0, `pnpm test` 153/153, Prettier clean, ESLint clean on touched files. (8 pre-existing ESLint errors remain in untouched files — `chatBackup.svelte.ts`, `chatCoordinators.svelte.ts`, `coordinators/[coordinatorKey]/+page.svelte` — out of scope.)
