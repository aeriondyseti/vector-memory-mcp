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
- **rc**: Release candidate declaring the next version (e.g., `1.1.0-rc.1`). Forward-looking — "this will become 1.1.0."
- **release**: Full stable release. Merges dev to main, tags stable version.

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
BASE=$(git tag --list 'v*' --sort=-version:refname | grep -v -E '(-dev\.|--rc\.)' | head -1 | sed 's/^v//')

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

### D3. Tag and Push (triggers GHA)

```bash
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

RC tags declare the **intended next version**. They are created on the `dev` branch when you're ready to start dogfooding a release candidate.

### RC1. Pre-flight

```bash
git branch --show-current   # Must be dev
git status --short           # Must be clean
git fetch origin && git status -sb  # Must be up to date
```

Must be on `dev` branch, clean, and up to date. If not, stop and fix first.

### RC2. Analyze Commits and Determine Version

```bash
# Last stable tag (exclude dev and rc tags)
LAST_STABLE=$(git tag --list 'v*' --sort=-version:refname | grep -v -E '(-dev\.|-rc\.)' | head -1)
echo "Last stable: $LAST_STABLE"

# Commits since last stable
git log ${LAST_STABLE}..HEAD --oneline
```

Check if there's already an RC series for a version:

```bash
# Find any existing RC tags newer than last stable
EXISTING_RC=$(git tag --list 'v*-rc.*' --sort=-version:refname | head -1)
echo "Latest RC: $EXISTING_RC"
```

**If no existing RC:** Analyze commit messages to determine the semver bump:

| Bump | Trigger |
|------|---------|
| **MAJOR** | `BREAKING CHANGE:` in body, or `feat!:`, `fix!:` |
| **MINOR** | `feat:` commits |
| **PATCH** | `fix:`, `docs:`, `refactor:`, `perf:`, `test:`, `chore:` |

Use the highest applicable level. Present the proposed version and ask for confirmation.

**If existing RC:** Increment the RC number (e.g., `1.1.0-rc.1` -> `1.1.0-rc.2`).

### RC3. Confirm with User

Present:
- Current stable version -> Proposed RC version
- Key commits being included

Ask: "Tag v{VERSION}? (yes/no)"

### RC4. Tag and Push (triggers GHA)

```bash
git tag "v${NEW_VERSION}"
git push origin dev && git push --tags
```

### RC5. Report

```
Pushed v$NEW_VERSION - GitHub Actions will publish to npm @rc
Monitor: https://github.com/AerionDyseti/vector-memory-mcp/actions
```

---

## Release Flow

Stable releases merge `dev` into `main` and tag the stable version. The RC phase should have already determined the version.

### R1. Pre-flight

```bash
git branch --show-current   # Must be dev
git status --short           # Must be clean
git fetch origin && git status -sb  # Must be up to date
```

Must be on `dev` branch, clean, and up to date. If not, stop and fix first.

### R2. Determine Version

The version comes from the latest RC tag:

```bash
# Find the latest RC tag to determine the release version
LATEST_RC=$(git tag --list 'v*-rc.*' --sort=-version:refname | head -1)
# Strip the -rc.N suffix to get the stable version
RELEASE_VERSION=$(echo "$LATEST_RC" | sed 's/^v//; s/-rc\.[0-9]*$//')
echo "Release version: $RELEASE_VERSION"
```

If there's no RC tag, fall back to commit analysis (same as RC2/RC3 logic).

### R3. Confirm with User

Present:
- Latest RC tag -> Stable version
- Commits being released

Ask: "Release v{VERSION}? (yes/no)"

### R4. Prepare Release Commit

Update CHANGELOG and bump version on `dev`:

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
git add CHANGELOG.md package.json
git commit -m "chore: release vX.Y.Z"
git push origin dev
```

### R5. Create PR (dev -> main)

```bash
gh pr create --base main --head dev \
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

Then reset dev to main and tag dev.0:

```bash
git checkout dev && git reset --hard main
git tag "vX.Y.Z-dev.0"
git push origin dev --force && git push --tags
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
