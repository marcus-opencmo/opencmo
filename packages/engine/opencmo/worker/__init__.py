"""Worker: claim `jobs` (pipeline clip) và `tasks` (mọi kind trong bảng dispatch
của `worker/__main__.py`), nói chuyện với Supabase qua
`opencmo.backends.supabase.SupabaseStore`.

Package này KHÔNG được import từ `opencmo.pipeline` hay bất cứ gì dưới
`opencmo.steps`/`opencmo.media`: hướng phụ thuộc chỉ một chiều (worker biết về
engine, engine không biết gì về web/worker) — xem CLAUDE.md, mục Bố cục.
"""

from __future__ import annotations
