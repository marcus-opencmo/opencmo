-- Kiểm tham chiếu trong DB; max_rows của PostgREST không thể cắt tập giữ lại.
create or replace function public.orphan_safe_paths(p_bucket text, p_paths text[])
returns table (path text)
language plpgsql stable security definer set search_path = public
as $$
begin
  if p_bucket not in ('sources', 'media') or p_bucket is null
     or p_paths is null or cardinality(p_paths) > 100 then
    raise exception 'Invalid orphan candidates.' using errcode = '22023';
  end if;
  return query
    select distinct candidate.path from unnest(p_paths) candidate(path)
    where candidate.path is not null
      and not exists (select 1 from public.orphan_keep_paths(p_bucket) k where k.path = candidate.path)
      -- Cả job đã hết hạn nhưng đang đợi task cũng cần nguồn; manifest xử lý sau.
      and not exists (select 1 from public.jobs j
        where p_bucket = 'sources' and j.source_url = 'storage://' || candidate.path)
      -- Giữ bảo thủ khi manifest nhắc cùng object ở bucket khác; không bao giờ
      -- coi đường dẫn có tham chiếu là orphan chỉ vì field bucket còn thiếu.
      and not exists (select 1 from public.jobs j where jsonb_path_exists(
        j.media_manifest, '$.**.object ? (@ == $path)', jsonb_build_object('path',candidate.path)))
      and not exists (select 1 from public.tasks t where jsonb_path_exists(
        t.output, '$.**.object ? (@ == $path)', jsonb_build_object('path',candidate.path)));
end;
$$;
revoke all on function public.orphan_safe_paths(text,text[]) from public, anon, authenticated;
grant execute on function public.orphan_safe_paths(text,text[]) to service_role;

alter table public.storage_deletions add column deferred_at timestamptz;

create or replace function public.defer_object_deletions(p_ids bigint[])
returns int language plpgsql volatile security definer set search_path = public
as $$
declare v_rows int;
begin
  update public.storage_deletions set attempts = attempts + 1, deferred_at = clock_timestamp()
    where id = any(p_ids);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Giữ bước ghi manifest cũ; truy vấn mới lọc defer trước LIMIT, không cần
-- mang một mảng ID tăng vô hạn qua từng request.
alter function public.expired_object_paths(int) rename to enqueue_expired_object_paths;
create function public.expired_object_paths(p_limit int, p_started_at timestamptz)
returns table (id bigint, bucket text, path text)
language plpgsql volatile security definer set search_path = public
as $$
begin
  if p_started_at is null then
    raise exception 'Invalid cleanup invocation.' using errcode = '22023';
  end if;
  perform public.enqueue_expired_object_paths(p_limit);
  return query select d.id, d.bucket, d.path from public.storage_deletions d
    where d.deferred_at is null or d.deferred_at < p_started_at
    order by d.attempts, d.id limit p_limit;
end;
$$;
create function public.expired_object_paths(p_limit int default 200)
returns table (id bigint, bucket text, path text)
language sql volatile security definer set search_path = public
as $$ select * from public.expired_object_paths(p_limit, clock_timestamp()); $$;
revoke all on function public.expired_object_paths(int,timestamptz) from public, anon, authenticated;
revoke all on function public.expired_object_paths(int) from public, anon, authenticated;
grant execute on function public.expired_object_paths(int,timestamptz) to service_role;
grant execute on function public.expired_object_paths(int) to service_role;

-- Chỉ lưu tiến độ scan; tuyệt đối không sửa/xoá metadata storage.objects.
create table public.orphan_scan_cursors (
  bucket text primary key check (bucket in ('sources','media')),
  after_path text not null default ''
);
alter table public.orphan_scan_cursors enable row level security;
revoke all on public.orphan_scan_cursors from public, anon, authenticated;
grant all on public.orphan_scan_cursors to service_role;

create or replace function public.orphan_scan_page(p_bucket text, p_limit int default 100)
returns table(path text)
language plpgsql volatile security definer set search_path = public
as $$
declare v_after text; v_paths text[];
begin
  if p_bucket is null or p_bucket not in ('sources','media') or p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'Invalid orphan scan.' using errcode = '22023';
  end if;
  insert into public.orphan_scan_cursors(bucket) values(p_bucket) on conflict do nothing;
  select c.after_path into v_after from public.orphan_scan_cursors c where c.bucket = p_bucket for update;
  select array_agg(candidate.name order by candidate.name) into v_paths from (
    select o.name from storage.objects o
    where o.bucket_id = p_bucket and o.name > v_after
      -- Khớp hợp đồng reserve_upload: nguồn <uid>/<file>, B-roll
      -- <uid>/<project>/<file>. Artifact lồng sâu vẫn do manifest xử lý.
      and ((p_bucket = 'sources' and o.name ~ '^[^/]+/[^/]+$')
        or (p_bucket = 'media' and o.name ~ '^[^/]+/[^/]+/[^/]+$'))
      and o.created_at < now() - interval '6 hours'
    order by o.name limit p_limit
  ) candidate;
  update public.orphan_scan_cursors set after_path = coalesce(v_paths[cardinality(v_paths)], '')
    where bucket = p_bucket;
  return query select unnest(v_paths);
end;
$$;
revoke all on function public.orphan_scan_page(text,int) from public, anon, authenticated;
grant execute on function public.orphan_scan_page(text,int) to service_role;

-- Dùng đồng hồ DB cho cả mở invocation lẫn defer, tránh lệch giờ app/DB.
create function public.cleanup_started_at() returns timestamptz
language sql volatile security definer set search_path = public
as $$ select clock_timestamp(); $$;
revoke all on function public.cleanup_started_at() from public, anon, authenticated;
grant execute on function public.cleanup_started_at() to service_role;
