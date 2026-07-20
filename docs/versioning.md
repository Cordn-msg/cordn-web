# Versioning

Single source of truth: **[`package.json`](../package.json) `version`** (semver). It feeds the
Android `versionName`, the user-facing "now running vX" toast, and the `CHANGELOG.md`. There is no
separate release tool — `pnpm version` bumps + commits + tags natively, and a lifecycle hook
regenerates the changelog. Branch-agnostic: cut versions from whatever branch you're on.

## Two version tokens (don't collapse them)

The app carries two distinct versions, on purpose:

| | `__APP_VERSION__` (git SHA) | `__APP_SEMVER__` (package.json version) |
|---|---|---|
| Granularity | per build | per release cut |
| Changes when… | every build/deploy | only on `pnpm version …` |
| Purpose | web deploy-change detection | release identity (humans, stores, changelog) |
| Consumer | [`appUpdate.svelte.ts`](../src/lib/services/appUpdate.svelte.ts) banner comparison | toast, banner text, Android `versionName` |

The SHA drives the "a new version is available" banner and **must not be replaced by semver**.
semver is too coarse: a hotfix rebuild or a CI auto-deploy keeps the same semver but ships a new
bundle, and only the per-build SHA detects that. Both are written to
[`static/version.json`](../static/version.json) by [`scripts/write-version.mjs`](../scripts/write-version.mjs)
(`prebuild`) and stamped into the bundle by [`vite.config.ts`](../vite.config.ts). The SHA is also
your debug identity — a bug report against a SHA pins one exact commit.

## How Android reads it

[`android/app/build.gradle`](../android/app/build.gradle) derives both at build time:

- **`versionName`** ← `package.json` `version` (e.g. `0.2.0`, `0.2.0-next.3`). Display-only;
  Android accepts arbitrary strings, so prerelease tags are fine.
- **`versionCode`** ← `git rev-list --count HEAD`. Monotonically increasing across **every** build
  (stable *and* prerelease), so an internal `next.3` always installs over `next.2`. No CI needed.

The running app reads them back via `App.getInfo()` (`version` = versionName, `build` = versionCode).

## Cutting a release

`pnpm version <bump>` refuses a dirty tree, bumps `package.json`, commits as `vX.Y.Z`, tags it, and
runs the `version` lifecycle hook (which regenerates `CHANGELOG.md` into the release commit).

```
# start an internal/preview cycle (from current 0.1.0)
pnpm version preminor --preid=next     # 0.1.0 → 0.2.0-next.0
git push --follow-tags                  # CI dispatches on the v*-*.* tag → internal APK

# iterate — each fresh build testers should install
pnpm version prerelease --preid=next    # → 0.2.0-next.1 → next.2 …
git push --follow-tags

# validated → graduate to stable
pnpm version patch                      # 0.2.0-next.5 → 0.2.0  (patch *graduates* a prerelease)
git push --follow-tags                  # release build off the bare vX.Y.Z tag → F-Droid / zap.store
```

**The one gotcha:** from a prerelease, `patch` *graduates* it (`0.2.0-next.5 → 0.2.0`), it does not
go to `0.2.1`. If that's too implicit, `pnpm version 0.2.0` is unambiguous.

CI keys off tag shape: `v*-*` (has a prerelease hyphen) → internal lane; bare `vX.Y.Z` → release lane.

## Changelog

`CHANGELOG.md` is **generated, not hand-written.** The `version` lifecycle hook runs
[`scripts/changelog.mjs`](../scripts/changelog.mjs), which `git log`s the Conventional Commits since
the previous tag, groups them (`feat`→Features, `fix`→Fixes, `perf`, `docs`, `refactor`, `chore`),
and prepends a section under the new version header — then `git add`s it so it lands inside the
release commit + tag.

This requires **Conventional Commit messages**: `feat(android): …`, `fix(chat): …`, `docs: …`,
`chore: …` (scope optional). Non-conventional messages (merges, the bare `0.2.0` bump commit) are
skipped. So: write conventional commits, and the changelog takes care of itself.

## Native vs web updates (different mechanisms)

| | Web | Native |
|---|---|---|
| Update trigger | any deploy (SHA changes) | new APK release (semver + versionCode) |
| Detection | SHA banner → reload | user installs new APK |
| Needs a semver bump? | no | yes (it *is* the release) |

Web assets in the native app are **bundled into the APK** at build time ([`capacitor.config.ts`](../capacitor.config.ts)
`webDir: 'build'`); the WebView loads them locally, the service worker is dormant on native, and the
update banner's poll is skipped there (served SHA always equals bundled SHA). So you can push web
hotfixes freely (the SHA banner handles web users), but native users only move on a versioned APK
release. OTA/live-update plugins and `server.url` remote loading are rejected by design (offline-first,
no extra server/dependency) — see roadmap §11.

## Why not changesets

Stable `@changesets/cli` discovers packages via `@manypkg/get-packages`, which lists workspace
*members* but not the workspace *root* — so it can't see `cordn-web` to version it (and the app stays
at the repo root per roadmap §9). This is a single-app repo that never publishes, so the multi-package
machinery changesets exists to provide is unused. `pnpm version` has no such limitation and is the
native fit.
