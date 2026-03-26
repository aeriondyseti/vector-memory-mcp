---
name: publish
description: Publish to npm - bump version, tag, and push (GHA handles npm publish)
user-invocable: true
disable-model-invocation: true
---

Prepare and trigger an npm publish via GitHub Actions.

## 1. Determine Flow

If the user passed an argument (`dev`, `rc`, or `release`), use that flow directly.
Otherwise, ask: **"Dev, RC, or stable release?"**

- **dev**: Dev prerelease based on current stable version (e.g., `1.0.0` -> `1.0.0-dev.1`). Backward-looking — "stuff since last release."
- **rc**: Release candidate. Creates or updates an `rc/X.Y.Z` branch for stabilization. Forward-looking — "this will become X.Y.Z." No new features — bugfixes and chores only.
- **release**: Full stable release. Merges rc branch to main, tags stable version.

---

## Dev Flow

Dev releases are lightweight — just a git tag on the current commit. No version bump commit needed.
GHA sets `package.json` version from the tag at build time.

### D1. Pre-flight

```bash
git branch --show-current   # Must be dev
git status --short           # Must be clean
git fetch origin && git status -sb  # Must be up to date
```

Must be on `dev` branch, clean, and up to date. If not, stop and fix first.

### D2. Determine Next Dev Tag

Dev versions are based on the **current stable version** (not the next one).

```bash
# Get the stable base version from the latest stable tag (exclude dev and rc tags)
BASE=$(git tag --list 'v*' --sort=-version:refname | grep -v -E '(-dev\.|-rc)' | head -1 | sed 's/^v//')

# Find the latest dev tag for this base and increment
LAST_DEV=$(git tag --list "v${BASE}-dev.*" --sort=-version:refname | head -1)
if [ -z "$LAST_DEV" ]; then
  NEXT_NUM=1
else
  LAST_NUM=$(echo "$LAST_DEV" | grep -o '[0-9]*$')
  NEXT_NUM=$((LAST_NUM + 1))
fi
NEW_VERSION="${BASE}-dev.${NEXT_NUM}"
```

### D3. Sync Plugin Version, Tag, and Push (triggers GHA)

```bash
bun scripts/sync-version.ts "${NEW_VERSION}"
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: sync plugin version to ${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin dev && git push --tags
```

### D4. Report

```
Pushed v$NEW_VERSION - GitHub Actions will publish to npm @dev
Monitor: https://github.com/AerionDyseti/vector-memory-mcp/actions
```

---

## RC Flow

RC uses **branches**, not tags. Pushing to an `rc/*` branch auto-publishes to `@rc`.
The `rc/X.Y.Z` branch is a stabilization branch — **no new features, only bugfixes and chores**.
The version in `package.json` on the rc branch determines the published version.

### RC1. Pre-flight

```bash
git branch --show-current   # Must be dev
git status --short           # Must be clean
git fetch origin && git status -sb  # Must be up to date
```

Must be on `dev` branch, clean, and up to date. If not, stop and fix first.

### RC2. Check for Existing RC Branch

```bash
# Check if an rc/* branch already exists
git branch --list 'rc/*'
git branch -r --list 'origin/rc/*'
```

**If an RC branch exists:** The user should be on that branch iterating, not starting a new RC.
Ask if they want to switch to the existing RC branch, or if they intend to supersede it.

### RC3. Determine Version (new RC only)

```bash
# Last stable tag (exclude dev and rc tags)
LAST_STABLE=$(git tag --list 'v*' --sort=-version:refname | grep -v -E '(-dev\.|-rc)' | head -1)
echo "Last stable: $LAST_STABLE"

# Commits since last stable
git log ${LAST_STABLE}..HEAD --oneline
```

Analyze commit messages to determine the semver bump:

| Bump | Trigger |
|------|---------|
| **MAJOR** | `BREAKING CHANGE:` in body, or `feat!:`, `fix!:` |
| **MINOR** | `feat:` commits |
| **PATCH** | `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:` |

Use the highest applicable level.

### RC4. Confirm with User

Present:
- Current stable version -> Proposed RC version
- Key commits being included

Ask: "Create rc/X.Y.Z with version X.Y.Z-rc.1? (yes/no)"

### RC5. Create Branch and Bump Version

```bash
git checkout -b rc/X.Y.Z
npm version X.Y.Z-rc.1 --no-git-tag-version
bun scripts/sync-version.ts
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: begin rc X.Y.Z"
git push -u origin rc/X.Y.Z
```

GHA will auto-publish to `@rc` on push.

### RC6. Iterating on RC

When fixing bugs on the RC branch, bump the RC number before pushing:

```bash
# Already on rc/X.Y.Z branch
npm version X.Y.Z-rc.N --no-git-tag-version
bun scripts/sync-version.ts
git add package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump rc to X.Y.Z-rc.N"
git push origin rc/X.Y.Z
```

Each push triggers a new `@rc` publish.

### RC7. Report

```
Created rc/X.Y.Z with version X.Y.Z-rc.1
GitHub Actions will publish to npm @rc on each push
Monitor: https://github.com/AerionDyseti/vector-memory-mcp/actions
```

---

## Release Flow

Stable releases merge the `rc/X.Y.Z` branch into `main` and tag the stable version.

### R1. Pre-flight

```bash
git branch --show-current   # Must be on rc/* branch
git status --short           # Must be clean
git fetch origin && git status -sb  # Must be up to date
```

Must be on an `rc/*` branch, clean, and up to date. If not, stop and fix first.

### R2. Determine Version

The version comes from the branch name:

```bash
BRANCH=$(git branch --show-current)
RELEASE_VERSION=${BRANCH#rc/}
echo "Release version: $RELEASE_VERSION"
```

### R3. Confirm with User

Present:
- RC branch -> Stable version
- Commits being released (since last stable tag)

Ask: "Release v{VERSION}? (yes/no)"

### R4. Prepare Release Commit

Update CHANGELOG and set final version on the rc branch:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- [new features]

### Changed
- [changes]

### Fixed
- [bug fixes]
```

```bash
npm version X.Y.Z --no-git-tag-version
bun scripts/sync-version.ts
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: release vX.Y.Z"
git push origin rc/X.Y.Z
```

### R5. Create PR (rc/X.Y.Z -> main)

```bash
gh pr create --base main --head rc/X.Y.Z \
  --title "Release vX.Y.Z" \
  --body "$(cat <<'PREOF'
## Release vX.Y.Z

[Summary of changes from CHANGELOG]
PREOF
)"
```

### R6. Merge PR and Tag

After PR is merged:

```bash
git checkout main && git pull origin main
git tag vX.Y.Z
git push --tags
```

Then update dev to include the release and clean up:

```bash
git checkout dev && git merge main
git push origin dev
git branch -d rc/X.Y.Z
git push origin --delete rc/X.Y.Z
```

### R7. Report

```
Released vX.Y.Z via PR merge
GitHub Actions workflow triggered - will:
   - Publish to npm @latest
   - Cascade dist-tags to @dev and @rc
   - Create GitHub Release automatically

Monitor: https://github.com/AerionDyseti/vector-memory-mcp/actions
Release will appear at: https://github.com/AerionDyseti/vector-memory-mcp/releases/tag/vX.Y.Z
```
