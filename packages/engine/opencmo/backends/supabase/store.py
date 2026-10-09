"""`SupabaseStore` = các miền ghép lại; mỗi miền chỉ dùng `_Http`, không gọi chéo."""

from __future__ import annotations

from opencmo.backends.supabase.generations import GenerationsMixin
from opencmo.backends.supabase.jobs import JobsMixin
from opencmo.backends.supabase.storage import StorageMixin
from opencmo.backends.supabase.tasks import TasksMixin


class SupabaseStore(JobsMixin, TasksMixin, GenerationsMixin, StorageMixin):
    """Client service-role duy nhất của worker. Xem docstring của package."""
