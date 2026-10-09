#!/usr/bin/env bash
# Bản schema `public` HIỆN HÀNH (sau mọi migration) → supabase/schema/current.sql.
#
#   scripts/dump-schema.sh                       # Supabase local (supabase start)
#   scripts/dump-schema.sh "postgresql://…"      # DB bất kỳ đã áp đủ migration
#
# Chỉ để ĐỌC: 305 lần `create or replace` rải qua các migration, muốn biết hàm đang chạy ra
# sao thì đọc file này thay vì tìm bản cuối. Không phải migration, không bao giờ áp nó.
# Chạy lại sau mỗi migration mới (report kiến trúc 06/10, R6).
set -euo pipefail
url="${1:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
out="$(dirname "$0")/../supabase/schema/current.sql"
mkdir -p "$(dirname "$out")"
# Máy không cài client Postgres: dùng pg_dump trong container Supabase local. Thiếu cả hai
# thì dừng TRƯỚC khi mở file — `>` đã cắt rỗng file cũ rồi mới chạy lệnh.
if command -v pg_dump >/dev/null; then
  dump() { pg_dump "$url" "$@"; }
elif [ -z "${1:-}" ] && docker inspect supabase_db_opencmo >/dev/null 2>&1; then
  dump() { docker exec supabase_db_opencmo pg_dump -U postgres -d postgres "$@"; }
else
  echo "cần pg_dump (hoặc Supabase local đang chạy)" >&2; exit 1
fi
{
  echo "-- SINH TỰ ĐỘNG bởi scripts/dump-schema.sh — đừng sửa tay, đừng áp như migration."
  dump --schema-only --schema=public --no-owner --no-privileges --no-comments \
    | grep -v -E '^-- Dumped (from|by)' | sed -E '/^\\(un)?restrict /d'
} > "$out"
echo "đã ghi $out ($(wc -l < "$out") dòng)"
