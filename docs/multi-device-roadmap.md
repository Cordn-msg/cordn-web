# Cordn multi-device design & roadmap

**Status:** Phase 0–2 validated (emulator + real device) · **Phase 3 in progress — configurable delivery + notification quality** · **Scope:** Android native (F-Droid + zap.store); iOS served by the existing PWA · **Last updated:** 2026-07

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

### 4.2 Delivery modes (user-configurable latency/battery tradeoff)

Cordn exposes the latency/battery tradeoff as a **user setting**, not a fixed decision. All modes share one idempotent fetch path (cursor-based → never double-deliver) and one count-only notification renderer.

| Mode | Mechanism | Latency | Battery | Persistent notif |
|---|---|---|---|---|
| **Off** | nothing | on-open only | zero | no |
| **Standard (15 min)** | WorkManager periodic *(always-on fallback)* | ≤15 min (Doze may stretch) | lowest | no |
| **Fast (1 / 5 / 10 min)** | Foreground service + coroutine timer, reusing the fetch loop | ~the interval, Doze-exempt | medium | yes (low-priority) |
| **Live (instant)** | Foreground service + persistent ContextVM subscription | seconds | highest | yes |

**Default:** foreground service at **5 min** + WorkManager periodic at **15 min**, both running. The dual-run is safe — both share one `nativeCursor` (idempotent advance-on-notify) and one sidecar (`UNIQUE(account,gid,cursor)`), so whoever polls first moves the watermark and the other finds nothing. WorkManager-15 is the reliability backstop if an OEM kills the service.

**Why a foreground service for sub-15-min:** WorkManager's periodic floor is ~15 min and Doze stretches it further. Reliable faster polling needs a long-running process, which on Android means a foreground service (background services die in seconds post-Android-8; exact alarms are battery-hostile + OEM-killed + need a permission). Our fast-poll service is far lighter than a live websocket — it connects for a few seconds every N min and sleeps between, so "foreground service" ≠ "Armada's always-on battery cost."

**Event-driven free polls (all modes):** `BroadcastReceiver`/`ConnectivityManager.NetworkCallback`-triggered on **network reconnect** (while the process is alive), **boot-completed**, and app **foreground/resume** — zero steady-state battery, fire when fresh data matters. *(Fully-closed-app reconnect still waits for the periodic — no foreground-service-free way to run instantly on reconnect.)*

**The cost of Fast/Live:** a mandatory persistent notification ("Cordn is syncing") on a low-priority channel, plus baseline process drain. Users opt in via settings; Standard (15 min) stays the battery-light default.

**Live mode is deferred** (Phase 3C, spike-gated): it needs the native ContextVM *streaming/subscription* path — we've only used request-response `send`/`recvTimeout` so far. Key-less count-only (the sub receives encrypted bytes, counts, notifies). Spike before building.

**Still rejected:** exact alarms (battery-hostile, OEM-killed); silent-audio keep-alive (deprecated by Android 17, OEM-killed); *forced* always-on foreground service as the only option (now opt-in instead).

**OEM killers** (dontkillmyapp.com): Xiaomi/Huawei/Oppo/Vivo/Samsung aggressively kill background apps — even foreground services without a battery-optimization exemption. A **battery-optimization exemption prompt** (borrowed from Armada) gates the aggressive modes and improves Standard-mode reliability under Doze too. Not a silver bullet; the worst OEMs may still need user guidance ("enable Autostart").

### 4.3 The single-MLS-consumer rule

**MLS group state is stateful** (ratchet/epoch secrets advance as messages process). There must be **exactly one consumer** of a group's MLS state. The background poller therefore **never decrypts** — it counts. Decryption stays in the WebView ([`applyIncomingChatGroupMessages`](src/lib/services/chatGroups.svelte.ts)), the sole consumer. Two consumers (e.g. native background-runner + WebView) would desync the ratchet and brick a group's decryption. This also independently rules out "keep the WebView alive to decrypt."

**Consequence:** background notifications are **count-based**, not content-based. This is a deliberate UX trade, not a fallback.

### 4.4 Notification richness (cached metadata, still no background crypto)

Group name + icon + count are derivable **without the worker decrypting anything** — because the **WebView (which already decrypted the metadata) caches it** into native SQLite as bytes the worker just reads:
- **Display title** — [`getChatGroupDisplayTitle`](src/lib/components/chat/chatGroupDisplay.ts) (group name, else member names for unnamed groups).
- **Icon bytes** — [`getChatGroupNotificationIcon`](src/lib/components/chat/chatGroupDisplay.ts) normalized to PNG bytes by a new `renderGroupIconBytes`: emoji branch reuses the existing canvas render (`emojiToNotificationIcon` → decode data URL); image-URL / member-picture branches fetch → draw to canvas (rounded, ~96–128 px) → bytes. Uniform output regardless of source.
- **Count** — the cursor delta (`cursor > nativeCursor`). Counting ciphertexts needs no decryption.

**Cache freshness (no staleness):** the native `groups` table holds `title`, `icon_bytes`, `meta_hash`. A debounced reactive `$effect` derives `(title, iconBytes)` per group, diffs against a last-sent map, and pushes only changed groups via `upsertGroupMeta`; the native side hash-skips redundant writes. Bulk re-upsert on every `seed` (bg/fg transition) is the backstop. So the cache tracks the app within seconds while foregrounded.

**Rendering split:** `smallIcon` (status bar) = a static monochrome `ic_stat_cordn` mask (Android requirement); `largeIcon` (expanded view) = the cached per-group bytes (emoji or picture, full color). All rendering happens in the alive WebView (during seed/sync), never in the worker.

The ceiling: sender name, message text, and avatar **picture at send time** need decryption → foreground-only. The cached icon/title is the rich-background ceiling by design (single-MLS-consumer rule, §4.3). Foreground notifications (when not suppressed) reuse [`notifyForUnreadChatMessages`](src/lib/services/chatAttention.svelte.ts) verbatim.

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
| App backgrounding / foregrounding | seed `nativeCursor[gid] = max(group.fetchCursor, group.lastCursor)` |

**Why `max(fetchCursor, lastCursor)`, not `fetchCursor` alone:** sends advance `lastCursor` ([`sendChatGroupMessage`](src/lib/services/chatGroups.svelte.ts)) but **not** `fetchCursor`. Seeding `fetchCursor` alone leaves the user's own just-sent message above the native watermark → the worker re-fetches and **self-notifies** (the bug seen in the first real-device test). `lastCursor` covers own sends; `fetchCursor` covers received; the max is the true local high-watermark. No data-loss risk: anything skipped in the `(fetchCursor, lastCursor]` gap is recovered by the app's own foreground `after: fetchCursor` fetch on open. (Advance-on-notify is still mandatory — without it, repeated background polls double-notify.)

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
- **`recvTimeout()` returns the whole `#[serde(untagged)]` message.** `JsonRpcMessage.payloadJson` is `serde_json::to_string(msg)` of the untagged enum — i.e. `{"jsonrpc","id","result":{"content":[],"structuredContent":{…}}}` with *no* variant wrapper. Parse: `JSONObject(payloadJson).optJSONObject("result").optJSONObject("structuredContent")`. (The higher-level `client.tools().call()` API hides this; the raw `send`/`recvTimeout` channel exposes it.)
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
3. **`nativeCursor` advances on notify** and seeds to `max(fetchCursor, lastCursor)` on background/foreground (own sends advance `lastCursor` but not `fetchCursor` — seeding only `fetchCursor` self-notifies). The app always queries `after: fetchCursor`, so native never blocks ingestion.
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
- ✅ `@capacitor/app` / `status-bar` / `splash-screen` / `local-notifications` installed + synced; local-notification tap routing into [`/chat/[id]`](src/routes/chat/[id]) lives in [`nativeBridge.ts`](src/lib/services/nativeBridge.ts) (the single native-aware seam, roadmap §11.2).
- ✅ Foreground notifications routed through `isNativePlatform()` — [`chatAttention`](src/lib/services/chatAttention.svelte.ts) dispatches via `showLocalNotification` (native → Capacitor local notification; web → Notification API). Fixes the latent WebView bug where `'Notification' in window` is false.
- ✅ Branded launcher icon generated (`favicon.svg` → all `mipmap-*` densities + adaptive, via `@capacitor/assets`); foreground notifications gated to **background-only** (no noise while the app is open, via an `appActive` flag in [`nativeBridge.ts`](src/lib/services/nativeBridge.ts)); native entry point redirected to **`/chat`** (mirrors the PWA `start_url`).
- ⏳ Remaining app-store groundwork: release signing config + keystore; dedicated `ic_stat_cordn` notification smallIcon arrives in Phase 3A.

### Phase 2 — Background polling + sidecar + no-refetch
- ✅ Capacitor plugin workspace package `packages/cordn-background/` ([`src/index.ts`](packages/cordn-background/src/index.ts)) — the single TS↔Kotlin seam: `configure` / `seed` / `drain`.
- ✅ Kotlin: `MessageFetchWorker` (CoroutineWorker, ~15 min periodic, per-coordinator throwaway-key stateless `Client` → `msg_fetch_many` → parse `structuredContent` → stage sidecar → advance `nativeCursor` → count notification), `BackgroundStore` (SQLite sidecar + `nativeCursor` watermark, namespaced per account), `BootReceiver` (re-schedule after reboot), `PollScheduler`.
- ✅ Rust `.so` + UniFFI Kotlin bindings bundled in the plugin module; full debug APK builds (`libcontextvm_ffi.so` packaged, plugin + bindings dexed).
- ✅ TS seam wired in [`nativeBridge.ts`](src/lib/services/nativeBridge.ts): `configure`/`seed`/`drain` on init + `App.appStateChange` (background→seed, foreground→drain+seed); drain feeds `ingestIncomingChatGroupMessages` (the single MLS path).
- ✅ **On-device validated.** The `.so` loads via JNA in-process (`libjnidispatch.so … : ok` mid-worker), a real background `msg_fetch_many` returns and parses (`structuredContent` → 5 msgs / 3 groups in the test), count-only notifications fire, and the sidecar drains on open. A poll completes in <1 s — the ~15-min floor is purely WorkManager cadence, not FFI cost. Zero `FfiException`/crashes across the run.
- ✅ **Real-device validated (overnight).** Installed on physical Android; closed-app count-only notifications delivered reliably across an overnight test — Phase 2's reliability claim holds outside the emulator. The test surfaced three follow-ups → Phase 3: (a) **self-message notifications** (root cause: `fetchCursor`-only seeding; fixed via `max(fetchCursor, lastCursor)` — §5); (b) **generic icon + no group name** (→ icon/metadata cache, §4.4); (c) **no network-reconnect trigger** (→ event-driven polls, §4.2).
- *Exit criterion:* a closed app reliably notifies on new messages within ~15 min; opening from a notification shows the message with no redundant fetch. *(✅ MET — closed-app count-only notifications within the ~15-min cycle; messages appear on open via sidecar drain; advance-on-notify prevents double-notify.)*

> **Regeneration note (must read before re-running `uniffi-bindgen-cli`):** the generated `contextvm_ffi.kt` carries a one-time patch — the SDK's own FFI `close()` collides with UniFFI's Disposable/AutoCloseable boilerplate `close()` in exactly the `Client` and `Server` classes (two `override fun close()`). The patch removes the boilerplate `close()` from those two classes only (the UniFFI Cleaner still releases the handle on GC). Regeneration re-introduces the collision; re-apply via `packages/cordn-background/android/src/main/java/uniffi/contextvm_ffi/` (drop the `@Synchronized override fun close() { this.destroy() }` block where an FFI `override fun \`close\`()` also exists). The plugin module also pins **Kotlin 1.9.25** in its own buildscript (UniFFI 0.31 bindings target the 1.9.x era).

### Phase 3 — Configurable delivery & notification quality

Redefined after the first real-device test. 3A is mode-agnostic quality (reused by every delivery mode); 3B adds configurable polling; 3C is the optional live extreme.

#### Phase 3A — Quality + presentation cache (mode-agnostic)
- **Self-message fix** — seed `max(fetchCursor, lastCursor)` (§5). One line; kills the most-reported annoyance.
- **Icon/metadata cache** — `renderGroupIconBytes` (reuse the web canvas/emoji path) → bytes + hash; native `groups` table gains `title`/`icon_bytes`/`meta_hash`; hash-gated `upsertGroupMeta`; debounced reactive sync `$effect` + bulk-on-seed backstop (§4.4).
- **Notification presentation** — dedicated monochrome `ic_stat_cordn` smallIcon + brand color + named channel; worker renders `largeIcon` (cached bytes) + `contentTitle` (cached title).
- **`pnpm android:apk`** build script (build → sync → `assembleDebug` → print APK path).
- **Battery-optimization exemption prompt** (borrowed from Armada) — gates aggressive modes; improves Standard-mode Doze reliability too.

#### Phase 3B — Configurable polling
- Extract `MessageFetcher.run()` shared by the worker and the new service.
- `CordnNotificationService` foreground service (coroutine loop, 1/5/10-min).
- Settings UI (mode + interval); `configure(mode, interval)` → start/stop service; WorkManager-15 always-on as fallback (dual-run, idempotent — §4.2).
- BootReceiver restarts in the chosen mode.

#### Phase 3C — Live mode (deferred, spike-gated)
- Native ContextVM persistent subscription (key-less, count-only). Verify the streaming API works unauthed before building.

### Phase 4 — Packaging & release
- From-source `.so` build (drop the vendored 49 MB binary; required for F-Droid reproducible).
- Per-ABI APK splits / ABB; release signing config + keystore; F-Droid reproducible-build metadata; zap.store via `zsp`.
- Final battery/latency field testing across delivery modes.

---

## 13. Costs & accepted tradeoffs

| Tradeoff | Accepted because |
|---|---|
| Default ~15 min latency when idle (Standard mode) | Cursor/idempotent → latency never loss; foreground catch-up never misses. Users who want less can opt into Fast (1/5/10 min) or Live at a battery cost (§4.2). |
| Count-only notifications (with cached group name + icon) | Single-MLS-consumer rule protects group state from ratchet desync. Cached metadata closes most of the richness gap without background crypto (§4.4). |
| Fast/Live modes show a mandatory persistent notification | Required by Android for foreground services; low-priority channel, user-opted-in. |
| No background notifications for welcomes/join-requests/news | Authed endpoints can't run backgrounded for NIP-46 users; these are lower-frequency, caught on open. |
| Rust cross-compile pipeline + APK size | One-time setup cost; avoids permanent dual-language transport maintenance. |
| OEM killers may defer/kill polls | WorkManager-15 always-on as backstop; battery-optimization exemption prompt + user guidance for aggressive modes; reliability anchor is foreground catch-up. |

---

## 14. Alternatives considered (rationale preserved)

- **React Native** — rejected: full UI rewrite, permanent two-codebase maintenance.
- **FCM / UnifiedPush / APNs (any push)** — rejected: adds a dependency (Google/Apple/distributor app) and/or forces the coordinator into a push-trigger role; conflicts with privacy/no-third-party principles. Polling suffices given the cursor guarantee.
- **Exact-alarm scheduler (<15 min)** — rejected: battery-hostile + OEM-killed + needs a permission. Sub-15-min is achieved via an *opt-in foreground service* instead (§4.2).
- **Silent-audio "live mode" / keep-WebView-alive** — rejected: deprecated by Android 17 and OEM-killed; we don't build on disappearing primitives.
- **Forced always-on foreground service + persistent WebSocket as the only option** — rejected *as a default*: battery-hostile, OEM-killer bait. **Revised:** an *opt-in* foreground service for sub-15-min polling is accepted (Phase 3B), and a persistent-subscription *Live* mode is a future opt-in (Phase 3C, spike-gated). The default stays WorkManager-15.
- **Background MLS decryption** — rejected: would create two ratchet consumers and risk bricking group decryption.
- **HTTP coordinator endpoint** — rejected: defeats ContextVM's no-DNS/no-IP raison d'être.
- **Quartz + Kotlin transport rewrite** — rejected: permanent dual-language transport maintenance; the Rust SDK + UniFFI reuses the canonical implementation instead.
- **Tauri 2 mobile** — deferred: viable system-WebView alternative, but Capacitor's mobile plugin maturity wins today.

---

## 15. Open questions / future

- **Live mode (Phase 3C)** — native ContextVM persistent subscription for instant count-only notifications; deferred until Fast polling (3B) is stable, and spike-gated on the unauthed streaming API.
- **Warm connection for very-fast polling** — at 1-min intervals, a persistent relay connection may beat connect/disconnect 1440×/day; revisit once 3B is measured on real devices.
- **NIP-9a / federated push** (draft) — watch as a future opt-in "fast notifications" mode for users who *choose* to run a push distributor; not on the v1 path.
- **iOS** — revisit APNs only if iOS demand justifies standing up a server-side push trigger (the one thing that conflicts with the "coordinator stays dumb" principle).
- **`ctxcn`-style typed native client** — if the ContextVM ecosystem grows a Kotlin client generator, the `msg_fetch_many` glue could shrink further; not required today.
