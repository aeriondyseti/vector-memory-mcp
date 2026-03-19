# Git-Flow CI/CD Implementation Plan

**Goal:** Align CI/CD with simplified git-flow: `dev` auto-publishes `@dev`, stable tags from `main` publish `@latest` + `@dev`.
**Execution:** Serial
**Branch:** `fix/ci-gitflow`

---

## Target State

| Event | npm dist-tag | Version source |
|-------|-------------|----------------|
| Push to `dev` branch | `@dev` | `package.json` |
| Push stable `v*` tag | `@latest` + `@dev` | Git tag name |
| Manual dispatch | Chosen tag | `package.json` |

Stable tags must point to a commit on `main`. Drop the `@rc` dist-tag.

---

### Task 1: Rewrite publish workflow

**Files:**
- Modify: `.github/workflows/publish.yml`

**Steps:**

1. Add `push: branches: [dev]` trigger alongside existing `tags` trigger
2. Rewrite "Determine npm tag" with three clear paths:
   - Branch push to `dev` → `tag=dev`
   - Tag push → `tag=latest`
   - Manual dispatch → use input value (keep `dev` and `latest` as options, remove `rc`)
3. "Set version from git tag" only runs for tag pushes (`startsWith(github.ref, 'refs/tags/')`)
4. Add version-exists guard: check npm registry before publish, skip if already published
5. After publishing `@latest`, also run `npm dist-tag add ... dev`

### Task 2: Add branch-tag safety check

**Files:**
- Modify: `.github/workflows/publish.yml`

**Steps:**

1. Add `fetch-depth: 0` to checkout for full history
2. Add early step (tag pushes only) that verifies the tagged commit is on `main`
3. Fail fast with clear error if not

### Task 3: Manual — add required CI status checks

GitHub UI: require `test` job to pass before merging to `main` and `dev`.
