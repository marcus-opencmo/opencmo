"""Chạy worker cục bộ bằng ``python -m opencmo.worker``."""

from __future__ import annotations

import os
import sys


def main() -> int:
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    if not url or not key:
        print(
            "Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY để chạy worker.",
            file=sys.stderr,
        )
        return 2

    # Import muộn để lỗi cấu hình được báo rõ trước.
    from opencmo.backends.supabase import SupabaseStore
    from opencmo.worker.kinds import handlers
    from opencmo.worker.loop import run_forever
    from opencmo.worker.process_job import process as process_job

    run_forever(lambda: SupabaseStore(url, key), {"job": process_job, **handlers()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
