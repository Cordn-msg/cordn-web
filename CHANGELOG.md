# Changelog

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
