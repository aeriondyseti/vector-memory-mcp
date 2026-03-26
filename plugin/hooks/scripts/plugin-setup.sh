#!/usr/bin/env bash
# Plugin setup hook — ensures dependencies and ML models are ready.
# Runs on SessionStart before other hooks. Self-contained (no project imports)
# because node_modules may not exist yet.
#
# Uses CLAUDE_PLUGIN_DATA to cache a hash of package.json so we only reinstall
# when dependencies change.

set -euo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT not set}"
DATA="${CLAUDE_PLUGIN_DATA:?CLAUDE_PLUGIN_DATA not set}"

HASH_FILE="${DATA}/package-json.sha256"
MODEL_CACHE="${HOME}/.cache/huggingface"
MODEL_MARKER="${DATA}/.model-ready"

actions=()

# ── 1. Check dependencies ───────────────────────────────────────────

current_hash=$(sha256sum "${ROOT}/package.json" | cut -d' ' -f1)

needs_install=false
if [ ! -d "${ROOT}/node_modules" ]; then
  needs_install=true
elif [ ! -f "${HASH_FILE}" ]; then
  needs_install=true
else
  stored_hash=$(cat "${HASH_FILE}")
  if [ "${current_hash}" != "${stored_hash}" ]; then
    needs_install=true
  fi
fi

if [ "${needs_install}" = true ]; then
  actions+=("deps")
  # Emit progress message (raw text to stderr so it doesn't pollute JSON stdout)
  echo "⏳ Vector Memory: Installing dependencies..." >&2
  cd "${ROOT}"
  bun install --frozen-lockfile 2>&1 >&2 || bun install 2>&1 >&2
  mkdir -p "${DATA}"
  echo "${current_hash}" > "${HASH_FILE}"
fi

# ── 2. Check ML model ───────────────────────────────────────────────

needs_warmup=false
if [ ! -f "${MODEL_MARKER}" ]; then
  needs_warmup=true
fi

if [ "${needs_warmup}" = true ]; then
  actions+=("model")
  echo "⏳ Vector Memory: Warming up embedding model (first run only)..." >&2
  cd "${ROOT}"
  bun run scripts/warmup.ts 2>&1 >&2 && touch "${MODEL_MARKER}"
fi

# ── 3. Emit hook output ─────────────────────────────────────────────

# Read stdin (hook protocol requires it)
cat > /dev/null

if [ ${#actions[@]} -eq 0 ]; then
  # Nothing to do — silent exit (no JSON output = no user message)
  exit 0
fi

# Build a user-facing summary
parts=()
for action in "${actions[@]}"; do
  case "${action}" in
    deps)  parts+=("dependencies installed") ;;
    model) parts+=("embedding model ready") ;;
  esac
done

summary=$(IFS=", "; echo "${parts[*]}")

# Emit structured hook output
cat <<EOF
{"systemMessage":"\n━━━ Vector Memory Setup ━━━━━━━━━━━━━━━━━━━━━━━━━\n  ✅ First-run setup complete: ${summary}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"}
EOF
