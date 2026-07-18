# Cordn multi-device design & roadmap

**Status:** Design locked · **Phase 0 validated (GO)** · **Scope:** Android native (F-Droid + zap.store); iOS served by the existing PWA · **Last updated:** 2026-07

> TL;DR — We go native by **wrapping the existing SvelteKit SPA in Capacitor** (zero adapter changes — `adapter-static` is already configured). Notifications use **polling only** (no FCM, no push service, no coordinator-as-push-trigger), made reliable by the cursor/idempotent protocol (worst case is latency, never loss) and made low-latency by event-driven polls + adaptive bursts. The background poller is **key-less** (throwaway ContextVM key, unauthenticated message fetch only) and **never decrypts MLS** (single-consumer rule). It talks to the **Nostr-only coordinator through the canonical ContextVM Rust SDK via UniFFI Kotlin bindings** — no Quartz, no Kotlin rewrite, no HTTP. A native **sidecar** stages fetched bytes so opening the app never re-fetches. The web app deploys unchanged.

---

## 1. Background & goals

Cordn is a privacy messaging app. The web client ([`cordn-web`](package.json)) is Svelte 5 + TypeScript + Tailwind 4, with MLS group messaging ([`ts-mls`](package.json)), Nostr ([`applesauce-*`](package.json), [`nostr-tools`](package.json)), and a ContextVM coordinator ([`@contextvm/sdk`](package.json), [`@contextvm/mcp-sdk`](package.json)).

**Goal:** deliver a native Android client whose defining capability is **background notifications for new messages** so we can gather user attention when the app is closed.

**Hard constraints (self-imposed, intentional):**
- **Single codebase.** Minimize maintenance burden. A React Native rewrite is rejected — it forks the UI layer into a second codebase forever.
- **No Google.** No Firebase Cloud Messaging, no Play Services dependency. Distribution via **F-Droid** and **zap.store** (Nostr-native).
- **No push service.** The coordinator stays a dumb store-and-forward; it does not become a push trigger. No APNs/FCM, no third-party push gateway.
- **Privacy-first.** Accept the constraints that privacy imposes (e.g. ~15 min polling latency) rather than work around them with tricks that leak metadata or add dependencies.

---

## 2. Platform scope

| Platform | Strategy | Rationale |
|---|---|---|
| **Android** | Capacitor native wrapper, polling notifications | The target. Achievable without Google. |
| **iOS** | Existing **PWA** (no native wrapper) | On iOS a Capacitor app and a PWA have near-identical background limits (both suspend in ~30 s, both need APNs for reliable push). A wrapper buys nothing over the PWA we already serve ([`src/app.html`](src/app.html) is already PWA-tagged). Defer; revisit APNs only if iOS demand justifies it. |
| **Desktop / web** | Unchanged SvelteKit SPA | Continues to deploy exactly as today. |

---

## 3. Why Capacitor (and not the alternatives)

The decision rests on three facts about **this** codebase:

1. **The build is already a static SPA.** [`svelte.config.js`](svelte.config.js) uses `@sveltejs/adapter-static` with `fallback: 'index.html'` + prerender. Capacitor consumes this directly (`webDir: 'build'`). Zero adapter migration.
2. **The crypto stack is pure JS** — [`ts-mls`](src/lib/services/chatMlsUtils.ts), [`@noble/ciphers`](src/lib/services/chatMediaCipher.ts)/[`@noble/hashes`](src/lib/services/chatGroupPayloadCrypto.ts), [`nostr-tools`](package.json), [`applesauce-*`](package.json). No WASM, no native bindings. It runs in a WebView unmodified. This is the detail that usually kills "just wrap it," and it's already cleared.
3. **IndexedDB + Web Crypto + WebSocket all work in WebView.** [`chatStorage.ts`](src/lib/storage/chatStorage.ts) (IndexedDB), `crypto.subtle` in [`chatMediaWorker.ts`](src/lib/services/chatMediaWorker.ts), Nostr relays + the coordinator streaming subscribe all function foregrounded.

| Alternative | Verdict | Why |
|---|---|---|
| **Capacitor** | ✅ Chosen | 100% code reuse (UI + all services), smallest delta. |
| **React Native** | ❌ | Forces a full rewrite of the Svelte UI layer → permanent two-codebase maintenance. (Note: the framework-agnostic services in `src/lib/services/*` *would* port to RN, but the entire UI would not.) |
| **PWA-only** | ❌ | iOS PWA push is unreliable; no app-store presence; doesn't meet "release native + reliable notifications." |
| **Tauri 2 mobile** | ⏸ Watch | System WebView like Capacitor but younger mobile plugin ecosystem; Capacitor is more mature for push/background today. |
| **NativeScript / Flutter** | ❌ | UI rewrite (NativeScript) or full language rewrite (Flutter/Dart). No reuse advantage over Capacitor. |

---

## 4. Notification architecture

### 4.1 The reliability reframe (anchors everything)

The Cordn message model is **cursor-based and idempotent**: [`FetchManyGroupMessages`](src/lib/contracts/index.ts:173) takes `{groups:[{gid, after: fetchCursor}]}` and returns only messages past the client's watermark; ingestion dedups by cursor. Therefore:

> A missed, delayed, or doubled background poll can only change **when** a message is discovered — it can never lose one or show a duplicate.

The reliability bar is **"eventually deliver, never lose, never dupe"**, and the protocol guarantees that for free. ~15 min polling is acceptable *precisely because* the cost of a missed poll is a delay, not data loss. The **foreground catch-up** ([`catchUpGroupBeforeOutboundOperation`](src/lib/services/chatGroups.svelte.ts) and the open-app flow) is the reliability anchor: even if every background poll were killed, the user never *misses* a message — they just don't get a notification until they open the app.

### 4.2 Polling layers

| Layer | Mechanism | Role |
|---|---|---|
| **Steady-state floor** | WorkManager periodic, **~15 min**, on all installs | Always works; guarantees eventual delivery. (15 min is WorkManager's hard minimum.) |
| **Felt-latency bursts** | WorkManager *expedited* one-shots on: post-background, post-send, post-new-message-found | Cuts latency in the moments users feel it; same average budget. |
| **Free well-timed polls** | `BroadcastReceiver`-triggered on: **network reconnect**, app **foreground/resume**, **boot-completed** | Zero steady-state battery; fires at the moments fresh data matters. |
| **Reliability anchor** | Foreground catch-up (existing) hardened | No permanent miss even if all background polls die. |

**Explicitly rejected:**
- **Exact alarms** — unnecessary given the above; would add complexity for marginal promptness. (Also Play-policy-restricted, though we're not on Play.)
- **Silent-audio keep-alive / "live mode" tricks** — being deprecated (Android 17 hardens background audio) and aggressively killed by OEM battery "optimizations." We build it right and accept the tradeoffs instead.
- **Always-on foreground service with persistent WebSocket** — OEM-killer bait; battery-hostile. Not used.

**OEM killers** (see dontkillmyapp.com): Xiaomi/Huawei/Oppo/Vivo/Samsung aggressively kill background apps. WorkManager periodic is comparatively OEM-tolerant (it looks "normal"). Optional in-app guidance to disable battery optimization for Cordn improves real-world reliability (F-Droid users will comply); not required.

### 4.3 The single-MLS-consumer rule

**MLS group state is stateful** (ratchet/epoch secrets advance as messages process). There must be **exactly one consumer** of a group's MLS state. The background poller therefore **never decrypts** — it counts. Decryption stays in the WebView ([`applyIncomingChatGroupMessages`](src/lib/services/chatGroups.svelte.ts)), the sole consumer. Two consumers (e.g. native background-runner + WebView) would desync the ratchet and brick a group's decryption. This also independently rules out "keep the WebView alive to decrypt."

**Consequence:** background notifications are **count-based**, not content-based. This is a deliberate UX trade, not a fallback.

### 4.4 Notification richness (cheap, no background crypto)

Group name + icon + count are derivable **without decryption**:
- **Group name/icon** live in local storage ([`chatStorage`](src/lib/storage/chatStorage.ts) → `group.metadata.name`), surfaced by [`getChatGroupDisplayTitle`](src/lib/components/chat/chatGroupDisplay.ts) / `getChatGroupNotificationIcon`.
- **Count** is the cursor delta: messages returned with `cursor > nativeCursor`. Counting ciphertexts needs no decryption.

So a background notification is `"N new in <GroupName>"` with the cached group icon — genuinely rich, zero background crypto. Sender/preview (which need decryption) are foreground-only. The existing foreground notification logic ([`notifyForUnreadChatMessages`](src/lib/services/chatAttention.svelte.ts)) is reused verbatim for the foreground path.

---

## 5. The sidecar (no-refetch-on-open)

Without a sidecar, the bytes the background poll already downloaded (to count) get thrown away and re-downloaded when the app opens. The sidecar eliminates that redundancy.

**Design:** a native table stages the **exact coordinator wire format** (encrypted MLS ciphertexts) the background poll fetched:

```
(account_pubkey, gid, cursor, msg_64, at)
```

- **On background poll:** fetch → stage rows → advance `nativeCursor[gid]` → fire count notification.
- **On app open:** drain the sidecar → feed staged bytes into [`applyIncomingChatGroupMessages`](src/lib/services/chatGroups.svelte.ts) (**the same function the network path uses**) → `fetchCursor` advances to `nativeCursor` → then catch-up `after: fetchCursor` fetches only the **tiny delta since the last poll** (usually empty). No redundant round-trip.

**Why it doesn't create maintenance dissonance:** the sidecar is a **replay buffer of the wire format, not a parallel data model.** There is nothing to keep in sync — one ingestion function, two sources (network fetch vs sidecar drain), both producing identical bytes.

**Cursor contract (`nativeCursor`, the only thing the native layer persists per group):**

| Event | Action |
|---|---|
| Background poll finds new messages | `nativeCursor[gid] = max(returned cursors)` (**advance on notify**) |
| App backgrounding | seed `nativeCursor[gid] = group.fetchCursor` |
| App foreground / while open | resync `nativeCursor[gid] = group.fetchCursor` |

The app always queries `after: fetchCursor` (its own watermark) and ingests everything regardless of native state; `nativeCursor` only suppresses *re-notification*, never blocks ingestion. The two watermarks are independent and reconcile at handoff. (Advance-on-notify is mandatory — without it, repeated background polls double-notify.)

The sidecar is namespaced per account (matching the cross-account isolation principle behind our query keys).

---

## 6. Background scope: unauthenticated, message-only

[`FetchManyGroupMessages`](src/lib/services/coordinatorClient.ts) is an **unauthenticated** coordinator method — the [`cordnClient`](src/lib/services/coordinatorClient.ts:94) already operates two transports: a **stable** (authed) client and an **ephemeral** (unauthed) client; message fetch runs on the ephemeral one with a throwaway key.

Background scope is **messages only, via the ephemeral/unauthed path:**

| Endpoint group | Background? | Why |
|---|---|---|
| `FetchManyGroupMessages` (messages) | ✅ | Unauthed → throwaway key → no signer needed. |
| `FetchPendingWelcomes`, `FetchManyPendingJoinRequests`, news | ❌ foreground-only | Authed → need the real signer. Users on a **remote signer (NIP-46 bunker)** can't sign in the background (signer RTTs need the WebView). |

**This sidesteps the remote-signer problem entirely** rather than working around it: because message fetch needs no signature, **all users (including NIP-46) get identical background notifications.** It also makes the background poller **key-less and signer-less** — it holds only public routing info (coordinator pubkey, relays, gids, cursors) plus a throwaway transport key. No user `nsec`, no MLS state. If compromised, it leaks only gids + cadence (already visible to the coordinator).

---

## 7. Coordinator transport: ContextVM via the Rust SDK + UniFFI

The coordinator is a **ContextVM** server: MCP-over-Nostr. It is reachable **only** via Nostr relays + the coordinator's public key — **no DNS, no static IP** (that is the entire point of ContextVM; an HTTP endpoint would defeat it). The web client reaches it through [`@contextvm/sdk`](src/lib/services/coordinatorClient.ts)'s `NostrClientTransport` (over an `ApplesauceRelayPool`, with `PrivateKeySigner`, `serverPubkey`, and `GiftWrapMode`).

### 7.1 The decision: Rust SDK via UniFFI Kotlin bindings

For Android we do **not** rewrite the transport in Kotlin and do **not** pull in Quartz. We use the **canonical ContextVM Rust SDK** (feature-complete, matches the TS SDK) through its **`contextvm-ffi` UniFFI Kotlin bindings**. Protocol/reference: [ContextVM docs](https://docs.contextvm.org) · [draft NIP #2246](https://github.com/nostr-protocol/nips/pull/2246).

- The whole Nostr / NIP-44 / NIP-59 / kind-`25910` MCP framing lives in **one upstream-maintained Rust implementation** that speaks the *same* protocol as `@contextvm/sdk`. **No dual-language transport maintenance.**
- UniFFI generates idiomatic Kotlin from the FFI; an internal Tokio runtime exposes **blocking** calls (Kotlin blocks on a worker thread).
- The native poll needs **one method**: a `tools/call` for `msg_fetch_many`.

### 7.2 The native call shape

Confirmed against the **actual UniFFI Kotlin surface** emitted by the Phase-0 Android cross-compile (not the C ABI). `contextvm-ffi`'s proc-macro UniFFI generates idiomatic objects — `Keys` (`Keys.generate()` for a throwaway), `ClientConfig`, and `Client` / `Proxy` / `Gateway` (`Disposable, AutoCloseable`, each `constructor(keys, config)`) exposing `send(payloadJson)` / `recvTimeout(secs): JsonRpcMessage` / `recvTry()`. The C header's `cvm_*` functions exist for direct C/JNI binding, but UniFFI's object API is what Kotlin consumes. Protocol/reference: [ContextVM docs](https://docs.contextvm.org) · [draft NIP #2246](https://github.com/nostr-protocol/nips/pull/2246):

```kotlin
// In the WorkManager worker, on a background thread (FFI is blocking)
val keys   = Keys.generate()                         // throwaway signer — key-less poller
val client = Client(keys, ClientConfig(
               serverPubkey   = coordinatorServerPubkey,         // Nostr-only — no DNS/IP
               relayUrls      = configuredOrEmpty,               // empty → CEP-17 kind:10002 discovery
               encryptionMode = EncryptionMode.OPTIONAL,         // mirror the JS ephemeral client
               giftWrapMode   = GiftWrapMode.EPHEMERAL,             //   (match @contextvm/sdk)
               isStateless    = true,                            // skip initialize handshake — fast one-shot
               timeoutSecs    = 30))
client.send(jsonRpcToolsCall(                        // the ONE method
               "msg_fetch_many", mapOf("groups" to gidsWithCursors)))
val resp   = client.recvTimeout(30u)                   // e-tag correlation + gift-wrap unwrap
                                                                 //   + CEP-22 oversized reassembly — all internal
// parse resp.payloadJson → result.structuredContent → {messages:[{cursor,at,msg_64}]}
//   (msg_fetch_many returns data in structuredContent; the content array is empty —
//    the web client reads result.structuredContent at coordinatorClient.ts:237)
//   → stage to sidecar, advance nativeCursor, emit local notification
client.close()
```

Key properties (all confirmed in the Phase-0 host spike — see §7.3):
- **`is_stateless = true`** works and skips the MCP `initialize` round-trip (stateless client mode) — minimal overhead per poll.
- **The result lives in MCP `structuredContent`, not `content`.** `msg_fetch_many` returns `{messages:[{cursor,at,gid,msg_64}]}` as structured data; the `content` array is empty by design. Parsing `content` (or only the text items) silently returns zero messages — the #1 gotcha for the Kotlin binding.
- **Throwaway key (unauthed) returns full message data** — the key-less poller design is validated; no recipient-scoping, no auth requirement.
- **`after` is a positive-int cursor** (`0` is rejected); omit it for a full fetch, or pass the last-seen cursor (e.g. `after:1` returns cursors `>1`).
- **Working transport config** maps onto the generated `ClientConfig` data class (matches the web client): `GiftWrapMode.EPHEMERAL`, `EncryptionMode.OPTIONAL`, `isStateless=true`, `timeoutSecs`, plus relay fields `relayUrls` / `discoveryRelayUrls` / `fallbackOperationalRelayUrls` (CEP-17). `openStream` + CEP-22 oversized transfer are on by default.
- **CEP-22 oversized transfer** is automatic, so a group with many messages won't hit relay event limits.
- **Relay resolution** can run via the coordinator's published `kind:10002` (CEP-17) — no hardcoded hosts.

### 7.3 Costs (all one-time setup, not ongoing maintenance)

| Cost | Reality |
|---|---|
| Rust→Android cross-compile in CI | NDK targets (`aarch64`/`armv7`/`x86_64`/`i686-linux-android`) + `cargo-ndk`. `nostr-sdk`/`tokio`/`secp256k1` all target Android. Setup, paid once. |
| APK size | The `.so` adds a few MB/ABI → mitigate with per-ABI APKs (F-Droid supports multiple) or a universal build. |
| UniFFI version pin | bindgen must match runtime `uniffi = "0.31"` (embedded checksums). Pin; regenerate on SDK bumps. |
| Threading | FFI blocks over an internal Tokio runtime → call from the WorkManager thread, never main. |
| Phase-0 validation | **Done (✅✅).** Transport round-trip validated on host (throwaway key + `is_stateless=true` → real `msg_fetch_many` bytes), AND `contextvm-ffi` cross-compiles to Android (`aarch64-linux-android` via NDK r27c + cargo-ndk) with idiomatic UniFFI Kotlin bindings (`Client`/`Proxy`/`ClientConfig`/`Keys`) generated — the `.so` is a valid ARM64 Android ELF. |

---

## 8. Native service composition (Kotlin)

There is **no web Service Worker.** The "service" is a native Android background worker. Everything that executes *during a background poll* is Kotlin (+ Rust via JNI); everything else stays TS in the WebView.

| Piece | Language | Notes |
|---|---|---|
| WorkManager `Worker` (periodic + expedited) | Kotlin | Runs with WebView suspended. |
| `BroadcastReceiver` (boot, network reconnect) | Kotlin | Schedule expedited one-shots. |
| Coordinator fetch (`msg_fetch_many`) | Rust via UniFFI Kotlin | One `tools/call`; no Quartz. |
| Sidecar store (staged bytes + `nativeCursor`) | Kotlin (Room/SQLite) | Native; readable/writable without IndexedDB. |
| Local notification (name/icon/count) | Kotlin | `NotificationManager`. |
| Capacitor plugin bridge (`drain` / `seed` / `configure`) | Kotlin + thin TS | The only TS↔Kotlin boundary. |
| **MLS decrypt/ingest, `chatAttention`, `chatGroupWatch`, `chatStorage`, all UI** | **TS (WebView), unchanged** | 100% shared with web. |

Estimated native surface: ~500–900 lines of Kotlin + Rust `.so` (bundled) + UniFFI bindings. The only thing spiritually "duplicated" is the ~10-line `tools/call` JSON-RPC body — transport only, never logic.

---

## 9. Repo layout

Single repo, pnpm workspaces. **The app does not move** — `src/`, configs, everything stays at root (zero refactor of existing code). The Capacitor plugin is its own workspace package.

```
cordn-web/                        ← repo root, stays the app
├─ package.json                   ← root: the SvelteKit app + pnpm workspaces
├─ pnpm-workspace.yaml            ← packages: ['packages/*']
├─ capacitor.config.ts            ← webDir: 'build'
├─ android/                       ← generated by `npx cap add android`, committed
├─ src/  (UNCHANGED)
├─ svelte.config.js, vite.config.ts, …  (UNCHANGED)
└─ packages/
   └─ cordn-background/           ← the Capacitor plugin (workspace package)
      ├─ package.json
      ├─ src/index.ts             ← TS bridge: registerPlugin + drain/seed/configure types
      └─ android/
         ├─ src/main/.../CordnBackgroundPlugin.kt   ← plugin class, WorkManager, receivers, sidecar, notifications
         ├─ src/main/jniLibs/<abi>/libcontextvm_ffi.so  ← Rust SDK, cross-compiled per ABI
         └─ uniffi/               ← generated Kotlin bindings for contextvm-ffi
```

**Web deploys unchanged:** `@capacitor/core` is web-safe; `Capacitor.isNativePlatform()` returns `false` on web, so the one sidecar-drain branch is dead code there. No behavior change.

---

## 10. Build & release flow

```bash
# 1. Build the Rust FFI for each Android ABI (one-time / on SDK bumps)
cd packages/cordn-background/android-rust
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 -o ./jniLibs build --release
uniffi-bindgen generate ... --language kotlin --out-dir ../android/uniffi   # pinned to uniffi 0.31

# 2. Build the web app (adapter-static → build/), as today
pnpm build

# 3. Sync web assets + plugin native code into the Android project
npx cap sync

# 4. Open in Android Studio → run / build signed release
npx cap open android
```

**Distribution:** publish the signed APK to **F-Droid** (reproducible build metadata) and **zap.store** (Nostr-signed via `zsp` CLI; APK fetched from GitHub/F-Droid). No Google Play.

---

## 11. Design invariants (must-not-break)

These are the load-bearing rules. Any future change that violates one must be challenged.

1. **Single MLS consumer.** MLS decryption happens only in the WebView ([`applyIncomingChatGroupMessages`](src/lib/services/chatGroups.svelte.ts)). The native layer never decrypts — it counts.
2. **Sidecar behind one seam.** The sidecar is drained in exactly one place (the foreground catch-up), guarded by `Capacitor.isNativePlatform()`. It is a replay buffer of the wire format, not a parallel data model.
3. **`nativeCursor` advances on notify** and resyncs to `fetchCursor` on foreground; the app always queries `after: fetchCursor` so native never blocks ingestion.
4. **Background = unauthenticated message fetch only.** Throwaway key, no user secrets, no signer. Authed endpoints (welcomes, join-requests, news) are foreground-only.
5. **Coordinator stays Nostr-only (ContextVM).** No HTTP endpoint. Native speaks ContextVM via the Rust SDK + UniFFI — no Quartz, no Kotlin transport rewrite.
6. **Web deploys unchanged.** No native code path executes on web; the app builds and ships as today.

---

## 12. Phased roadmap

### Phase 0 — Spike (validate the risky unknowns first)
- Bootstrap Capacitor in this repo (`capacitor.config.ts`, `npx cap add android`), prove the existing build runs in the Android emulator with live reload.
- Verify `ts-mls` + `@noble` + IndexedDB + `crypto.subtle` work end-to-end in Android WebView (MLS group create/join/send).
- **Cross-compile `contextvm-ffi` to Android ABIs; confirm it links and UniFFI Kotlin bindings generate.** *(✅ done — NDK r27c + cargo-ndk; `aarch64-linux-android` `.so` builds, UniFFI Kotlin `Client`/`Proxy`/`ClientConfig`/`Keys` surface generates)*
- Prove a **stateless** `msg_fetch_many` round-trip from Kotlin against the coordinator via the Rust SDK (throwaway key). *(✅ validated on host via a Rust spike: throwaway key + `is_stateless=true` returns real message bytes; data is in MCP `structuredContent`. Re-confirm from Kotlin on-device at cross-compile time.)*
- *Exit criterion:* one background fetch → bytes returned → parseable. Go/no-go on the transport decision. *(✅✅ GO — transport logic AND Android cross-compile/binding generation both validated)*

### Phase 1 — Native shell + foreground parity
- `@capacitor/app` (lifecycle), `@capacitor/status-bar`, `@capacitor/splash-screen`, deep-link handling for notification taps (route into [`/chat/[id]`](src/routes/chat/[id]) like [`chatAttention`](src/lib/services/chatAttention.svelte.ts) does).
- Route foreground notifications through `Capacitor.isNativePlatform()` so [`chatAttention`](src/lib/services/chatAttention.svelte.ts) uses the native local-notification path when applicable.
- App-store groundwork: icons, signing config, bundle ID.

### Phase 2 — Background polling + sidecar + no-refetch
- WorkManager periodic (~15 min) + `BroadcastReceiver`s (boot, network reconnect).
- Kotlin poll worker → Rust `msg_fetch_many` → sidecar staging → `nativeCursor` advance → local notification (group name/icon/count from local cache).
- The TS seam: drain sidecar in the foreground catch-up behind `Capacitor.isNativePlatform()`; `nativeCursor`↔`fetchCursor` handoff.
- *Exit criterion:* a closed app reliably notifies on new messages within ~15 min; opening from a notification shows the message with no redundant fetch.

### Phase 3 — Felt-latency bursts
- Expedited WorkManager one-shots on post-background, post-send, post-new-message-found.
- Measure real-world latency/battery; tune.

### Phase 4 — Packaging & release
- F-Droid reproducible-build metadata; zap.store publishing via `zsp`.
- Per-ABI APK sizing; final battery/latency field testing.

---

## 13. Costs & accepted tradeoffs

| Tradeoff | Accepted because |
|---|---|
| Up to ~15 min notification latency when idle | Cursor/idempotent → latency never loss; foreground catch-up never misses. |
| Count-only (not content) notifications | Single-MLS-consumer rule protects group state from ratchet desync. |
| No background notifications for welcomes/join-requests/news | Authed endpoints can't run backgrounded for NIP-46 users; these are lower-frequency, caught on open. |
| Rust cross-compile pipeline + APK size | One-time setup cost; avoids permanent dual-language transport maintenance. |
| OEM killers may defer polls | WorkManager is OEM-tolerant; optional user guidance; reliability anchor is foreground catch-up. |

---

## 14. Alternatives considered (rationale preserved)

- **React Native** — rejected: full UI rewrite, permanent two-codebase maintenance.
- **FCM / UnifiedPush / APNs (any push)** — rejected: adds a dependency (Google/Apple/distributor app) and/or forces the coordinator into a push-trigger role; conflicts with privacy/no-third-party principles. Polling suffices given the cursor guarantee.
- **Exact-alarm scheduler (<15 min)** — rejected: unnecessary with adaptive + event-driven polling; Play-policy-restricted (moot, we're not on Play).
- **Silent-audio "live mode" / keep-WebView-alive** — rejected: deprecated by Android 17 and OEM-killed; we don't build on disappearing primitives.
- **Always-on foreground service + persistent WebSocket** — rejected: battery-hostile, OEM-killer bait.
- **Background MLS decryption** — rejected: would create two ratchet consumers and risk bricking group decryption.
- **HTTP coordinator endpoint** — rejected: defeats ContextVM's no-DNS/no-IP raison d'être.
- **Quartz + Kotlin transport rewrite** — rejected: permanent dual-language transport maintenance; the Rust SDK + UniFFI reuses the canonical implementation instead.
- **Tauri 2 mobile** — deferred: viable system-WebView alternative, but Capacitor's mobile plugin maturity wins today.

---

## 15. Open questions / future

- **NIP-9a / federated push** (draft) — watch as a future opt-in "fast notifications" mode for users who *choose* to run a push distributor; not on the v1 path.
- **iOS** — revisit APNs only if iOS demand justifies standing up a server-side push trigger (the one thing that conflicts with the "coordinator stays dumb" principle).
- **`ctxcn`-style typed native client** — if the ContextVM ecosystem grows a Kotlin client generator, the `msg_fetch_many` glue could shrink further; not required today.
