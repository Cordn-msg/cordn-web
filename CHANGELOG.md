# Changelog

## 0.3.0 — 2026-08-18

### Features

- **chat:** add multiple members in one MLS commit
- **chat:** pull-to-refresh on the chat list
- web storage disclaimer banner and consistency pass
- **onboarding:** calm logged-out home with one clear first step
- chat-wide UI/UX refresh, Android stability fixes, crash diagnostics
- voice notes with hold-to-record and inline playback
- native camera capture, Android back button, and chat media polish
- portable cordn1 group links and foreground notification cleanup
- add keyboard plugin and edge-to-edge support
- add skater and bitcoin_sikho to .well-known/nostr.json

### Fixes

- **chat:** stop showing and failing to remove zombie key packages
- **chat:** harden peer-data parsing and skip redundant unread rescans
- **chat:** steadier reconnection lifecycle and calmer coordinator handling
- **chat:** bound the coordinator connect wait
- **chat:** steady-state ticks must be silent and never block sends
- **chat:** make watch reconnection convergent and signer-gated
- **ui:** coordinator dot only on active sidebar row; hide scrollbar gutter in sidebar nav
- **multi-device:** prevent cursor advance on sealed decrypt failure

### Refactor

- pre-release dead-code sweep and consistency pass
- **profile:** dedupe metadata and relay-list loading through Svelte Query

### Other

- publish to Zapstore manually via zsp, drop the CI publish job

## 0.2.4 — 2026-07-24

### Fixes

- **android:** compute versionCode via ProcessBuilder (exec threw -> versionCode 1)

## 0.2.3 — 2026-07-24

### Fixes

- **ci:** force git unshallow so versionCode isn't 1 on tag builds

## 0.2.2 — 2026-07-24

### Fixes

- **ci:** use full checkout so gradle versionCode isn't 1 in shallow clone

## 0.2.1 — 2026-07-24

### Features

- **news:** add 0.2.1 release notes
- add NIP-05/shortname profile links and join-group onboarding
- **android:** enable app links verification for cordn.net deep links
- close native/web gaps, add migration banner, refresh landing
- announce native Android app and update Zapstore badge link

### Other

- wrap long lines for readability

## 0.2.0 — 2026-07-23

### Chore

- add MIT license, public README, and NIP-05 domain verification

## 0.2.0-next.8 — 2026-07-23

### Fixes

- **native:** suppress push notifications triggered by your own actions
- **chat:** recover silent delivery failures and stale stream identities

## 0.2.0-next.7 — 2026-07-23

### Features

- **auth:** add the Amber signer app as a first-class login tab
- **native:** share into a conversation and open cordn.net links in-app
- **chat:** support multiple media attachments in composer

### Fixes

- **native:** flush the background sidecar when messages arrive in the foreground

### Chore

- refresh app icon, splash, and PWA assets

## 0.2.0-next.6 — 2026-07-22

### Features

- **native:** deep-link a notification tap to its conversation

### Fixes

- **native:** stop re-prompting notification permission on every message
- **android:** disable full backup to protect chat history and keys
- **native:** stop Android 15+ from force-stopping the FGS on its dataSync cap

### Chore

- clear pre-existing lint violations
- **android:** trim dead config and shrink the release APK

### Other

- **android:** publish changelog + signing-cert fingerprint; gate on lint

## 0.2.0-next.5 — 2026-07-22

### Fixes

- **android:** keep JNA + signer plugin classes from R8 so background fetch works in release
- **chat:** make open-stream subscriptions resilient to backgrounding + silent close

## 0.2.0-next.4 — 2026-07-21

### Fixes

- **ci:** use JDK 21 — capacitor-android compiles to Java 21 bytecode

## 0.2.0-next.3 — 2026-07-21

### Fixes

- **ci:** tolerate whitespace in keystore base64 secret

## 0.2.0-next.2 — 2026-07-21

### Fixes

- **signer:** seed pubkey on rehydration to skip re-prompting Amber

### Chore

- **release:** add CI/CD, APK signing, R8 minify, background relay re-sync

## 0.2.0-next.1 — 2026-07-20

### Fixes

- **deps:** patch vulnerable deps and pin safe transitive versions

### Chore

- **android:** name APK outputs with semver to prevent overwrite

## 0.2.0-next.0 — 2026-07-20

_First tracked release; prior history is in git._
