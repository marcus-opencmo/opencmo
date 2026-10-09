#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATUS_FILE="$(mktemp)"
trap 'rm -f "$STATUS_FILE"' EXIT

cd "$ROOT_DIR/apps/web"
supabase status -o env >"$STATUS_FILE"

strip_value() {
  local value="$1"
  value="${value#\"}"
  value="${value%\"}"
  value="${value#\'}"
  value="${value%\'}"
  printf '%s' "$value"
}

while IFS='=' read -r key value; do
  case "$key" in
    API_URL) export SUPABASE_URL="$(strip_value "$value")" ;;
    SERVICE_ROLE_KEY) export SUPABASE_SERVICE_ROLE_KEY="$(strip_value "$value")" ;;
  esac
done <"$STATUS_FILE"

load_allowed_env() {
  local file="$1" key value
  [[ -f "$file" ]] || return 0
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    case "$key" in
      GROQ_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|OPENCMO_SELECT_MODEL|OPENCMO_PROXY|OPENCMO_ENCODER|OPENCMO_WATERMARK|OPENCMO_MAX_PARALLEL)
        export "$key=$(strip_value "$value")"
        ;;
    esac
  done <"$file"
}

load_allowed_env "$ROOT_DIR/.env.local"
load_allowed_env "$ROOT_DIR/apps/web/.env.local"

: "${SUPABASE_URL:?Không đọc được API_URL từ supabase status}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Không đọc được SERVICE_ROLE_KEY từ supabase status}"

cd "$ROOT_DIR/packages/engine"
exec .venv312/bin/python -m opencmo.worker
