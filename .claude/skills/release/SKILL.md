---
name: release
description: >
  Release a new version of loopbase to npm end-to-end: bump the version, publish
  the scoped package, record the bump via PR, and update the local global install.
  Use when asked to "publish loopbase", "release loopbase", "cut a release",
  "ship a new version to npm", "publish to npm", or after merging fixes you want
  live on npm.
---

# Releasing loopbase

Package: **`@superdesign/loopbase`** (scoped — the bare `loopbase` name is blocked
by npm as "too similar to loopback"). Installed bins stay `loopbase`/`lb`. Source
is published (no build step); `npm publish` packs the `files` whitelist **from the
working tree**, so always publish from a clean checkout.

## Preconditions
- All fixes for this release are **merged into `main`** (publish from `main`, not a
  dirty tree or a feature branch).
- Pick the new version: **patch** for fixes, **minor** for features. Versions are
  immutable — you can't republish or cleanly unpublish, so bump every time.
  Current published: `npm view @superdesign/loopbase version`.

## Steps

1. **Publish from a clean checkout of `main`** (isolated worktree → never ships a
   dirty tree or another session's WIP):
   ```sh
   git fetch origin
   git worktree add -b release/x.y.z /tmp/lb-pub origin/main
   cd /tmp/lb-pub
   npm version x.y.z --no-git-tag-version    # bumps package.json only (no git tag)
   npm publish --dry-run                      # sanity: name, version, file count
   ```

2. **Auth + OTP.** The npm account has 2FA, and the token expires between releases.
   ```sh
   npm whoami        # 401? → tell the user to run `npm login` (browser flow), confirm "Logged in"
   ```
   The write needs a **fresh OTP (~30s lifetime)** which only the user's
   authenticator can produce. So: stage everything first, **then ask the user for a
   6-digit code**, then publish immediately:
   ```sh
   npm publish --access public --otp=<code>
   ```
   - `--access public` is **required** for a scoped package.
   - A misleading **`404 … not in this registry`** almost always means the token
     expired → re-`npm login`, then retry with a new OTP.

3. **Record the version bump via PR — never push to `main` directly.**
   ```sh
   git commit -aqm "release: vx.y.z"
   git push origin release/x.y.z
   gh pr create --base main --head release/x.y.z --title "release: vx.y.z" --body "…"
   ```
   Merge the PR so the repo's `package.json` matches the registry.

4. **Clean up + update the local global install:**
   ```sh
   cd <repo> && git worktree remove /tmp/lb-pub --force && git branch -D release/x.y.z
   bun add -g @superdesign/loopbase     # updates global loopbase/lb to latest
   bun pm ls -g | grep loopbase         # verify the new version
   ```

## Gotchas (learned the hard way)
- **OTP timing:** do the bump + worktree + dry-run BEFORE asking for the code. The
  OTP expires in ~30s — don't set up after you have it.
- **Token expiry between releases is normal** (`npm whoami` → 401) — re-login.
- **Publish from clean `main`:** `npm publish` packs the working tree, so a dirty
  tree ships uncommitted edits. The `origin/main` worktree avoids that.
- **Branch-first:** the version-bump commit goes through a PR, like every other
  change — don't push it straight to `main`.
- The CLI has **no `--version` flag**; check the installed version with
  `bun pm ls -g | grep loopbase`.
