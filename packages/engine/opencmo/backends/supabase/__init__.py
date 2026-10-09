"""Client Supabase tối giản cho worker.

Gọi thẳng REST API bằng httpx thay vì dùng SDK: số thao tác ít, và viết
tường minh thì dễ đọc, dễ debug, không phụ thuộc vòng đời phiên bản SDK.

Worker dùng SERVICE ROLE KEY nên đi vòng qua RLS — đó là chủ đích: worker phải
ghi được vào job của mọi người dùng. Khóa này KHÔNG BAO GIỜ được lộ ra phía
client; nó chỉ sống trong secret của Modal.

Mọi thao tác ghi trạng thái job và credit đi qua RPC trong
`20260913120000_worker_lifecycle.sql`: chúng kiểm attempt hiện hành và nhận
operation key, nên retry ở `retry.py` không thể trừ/hoàn đôi hay chốt job hộ
một attempt khác.

Chia theo miền (R7a): `jobs`, `tasks`, `generations`, `storage` dùng chung `_Http`.
Mọi `from opencmo.backends.supabase import …` cũ vẫn chạy qua phần re-export dưới đây.
"""

from opencmo.backends.supabase.models import (
    LEASE_SECONDS,
    InsufficientCreditsError,
    Job,
    ObjectTooLargeError,
    StaleAttemptError,
    Task,
)
from opencmo.backends.supabase.storage import BUCKET, SOURCE_PREFIX, SOURCES_BUCKET, storage_path
from opencmo.backends.supabase.store import SupabaseStore

__all__ = [
    "BUCKET",
    "LEASE_SECONDS",
    "SOURCES_BUCKET",
    "SOURCE_PREFIX",
    "InsufficientCreditsError",
    "Job",
    "ObjectTooLargeError",
    "StaleAttemptError",
    "SupabaseStore",
    "Task",
    "storage_path",
]
