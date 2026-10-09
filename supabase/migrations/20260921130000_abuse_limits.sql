-- Siết lạm dụng: đẩy ba chốt của route xuống SQL, và làm credit thật sự chặn
-- được chi phí compute.
--
-- Bối cảnh: `create_job()` được grant cho `authenticated`, nên mọi thứ chỉ kiểm
-- ở route `/api/v1/jobs` đều bỏ qua được bằng một dòng curl vào PostgREST.
-- Trước migration này có ba thứ như vậy: allowlist host, rate limit 10/giờ, và
-- (chưa từng có ở đâu) trần số job đang chạy.
--
-- Thứ hai: huỷ job đang chạy hoàn ĐỦ credit, nên start-rồi-huỷ là một vòng lặp
-- compute miễn phí. Giữ lại 1 credit cho job đã `running`.

begin;

-- ================================================================ create_job
create or replace function public.create_job(
  p_source_url text,
  p_clips int default 5,
  p_length text default 'auto',
  p_segments jsonb default null,
  p_mode text default 'clip',
  p_aspect text default '9:16',
  p_layout text default 'auto',
  p_captions boolean default true,
  p_caption_preset text default 'bold'
)
returns public.jobs
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_hold int := public.job_hold_credits();
  v_balance int;
  v_plan text;
  v_length text := coalesce(p_length, 'auto');
  v_job public.jobs;
  v_source text := trim(coalesce(p_source_url, ''));
  v_segments jsonb := p_segments;
  v_clips int := p_clips;
  v_mode text := coalesce(p_mode, 'clip');
  v_aspect text := coalesce(p_aspect, '9:16');
  v_layout text := coalesce(p_layout, 'auto');
  v_captions boolean := coalesce(p_captions, true);
  v_preset text := coalesce(p_caption_preset, 'bold');
  v_prev numeric;
  v_item jsonb;
begin
  if v_source = '' then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;
  -- Ba chốt dưới TRƯỚC ĐÂY chỉ nằm ở route `/api/v1/jobs`. RPC này công khai
  -- với `authenticated`, nên một dòng curl thẳng vào PostgREST đi vòng qua cả
  -- ba. Đây là chỗ duy nhất không đi vòng được.
  --
  -- Host nguồn. KHÔNG phải chốt SSRF — `validate_public_url()` của worker mới
  -- chặn IP nội bộ — mà là chốt "đừng bắt máy ta tải hộ một web lạ". Danh sách
  -- phải trùng `ALLOWED_HOSTS` ở `lib/api/source.ts`; route giữ lại để câu lỗi
  -- nói đúng chỗ sai, SQL mới là chốt thật.
  -- `!~*` chứ không `!~`: `new URL()` ở route hạ chữ cả scheme lẫn host trước
  -- khi so, nên `https://YouTube.com/...` qua được route rồi chết ở đây với
  -- "Paste a YouTube or Vimeo link." cho một link hoàn toàn hợp lệ. Regex vẫn
  -- đòi host đứng NGAY sau `//` và kết bằng `/`, nên `https://youtube.com@evil
  -- .com/` vẫn bị chặn.
  if v_source not like 'storage://%'
     and v_source !~* '^https://(www\.youtube\.com|m\.youtube\.com|youtube\.com|youtu\.be|vimeo\.com|www\.vimeo\.com|player\.vimeo\.com)/'
  then
    raise exception 'Paste a YouTube or Vimeo link.' using errcode = '22023';
  end if;

  if v_mode not in ('clip', 'full') then
    raise exception 'Choose whether to clip the video or download it whole.' using errcode = '22023';
  end if;

  if v_segments is not null and jsonb_typeof(v_segments) = 'array'
     and jsonb_array_length(v_segments) = 0 then
    v_segments := null;
  end if;
  if v_mode = 'full' then
    if v_segments is not null then
      raise exception 'Picked moments only apply when we clip your video.' using errcode = '22023';
    end if;
    v_clips := 1;
  end if;

  if v_segments is not null then
    if jsonb_typeof(v_segments) <> 'array' then
      raise exception 'Pick the moments you want on the timeline.' using errcode = '22023';
    end if;
    if jsonb_array_length(v_segments) > 10 then
      raise exception 'Pick at most 10 moments.' using errcode = '22023';
    end if;

    v_prev := null;
    for v_item in
      select value from jsonb_array_elements(v_segments)
      order by (value ->> 'start')::numeric
    loop
      if jsonb_typeof(v_item) is distinct from 'object'
         or jsonb_typeof(v_item -> 'start') is distinct from 'number'
         or jsonb_typeof(v_item -> 'end') is distinct from 'number' then
        raise exception 'Each moment needs a start and end time.' using errcode = '22023';
      end if;
      if (v_item ->> 'start')::numeric < 0 then
        raise exception 'A moment cannot start before the video does.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric < 1 then
        raise exception 'Each moment must be at least 1 second long.' using errcode = '22023';
      end if;
      if (v_item ->> 'end')::numeric - (v_item ->> 'start')::numeric > 180 then
        raise exception 'Each moment must be 3 minutes or shorter.' using errcode = '22023';
      end if;
      if v_prev is not null and (v_item ->> 'start')::numeric < v_prev then
        raise exception 'Your moments overlap. Move them apart and try again.' using errcode = '22023';
      end if;
      v_prev := (v_item ->> 'end')::numeric;
    end loop;

    select jsonb_agg(value order by (value ->> 'start')::numeric)
    into v_segments from jsonb_array_elements(v_segments);
    v_clips := jsonb_array_length(v_segments);
  end if;

  if v_clips < 1 or v_clips > 10 then
    raise exception 'Clip count must be between 1 and 10.' using errcode = '22023';
  end if;
  if v_length not in ('auto', 'short', 'medium', 'long') then
    raise exception 'Choose a clip length.' using errcode = '22023';
  end if;
  if v_aspect not in ('9:16', '1:1', '16:9') then
    raise exception 'Unsupported aspect ratio.' using errcode = '22023';
  end if;
  if v_layout not in ('auto', 'fill', 'fit') then
    raise exception 'Unsupported frame layout.' using errcode = '22023';
  end if;
  if v_preset not in ('bold', 'clean', 'minimal') then
    raise exception 'Unsupported caption style.' using errcode = '22023';
  end if;

  -- Trần job đang chạy. Preview/export đã có trần 20 từ D3 (`request_preview`),
  -- job thì chưa — mà job mới là thứ tốn tiền Modal. Huỷ và thất bại đều hoàn
  -- credit, nên credit một mình KHÔNG chặn được chi phí compute.
  if (select count(*) from public.jobs
      where user_id = v_user and status in ('queued', 'running') and purging_at is null) >= 3
  then
    raise exception 'You already have 3 projects in progress. Please wait for one to finish.'
      using errcode = 'P0001';
  end if;

  -- Cùng bucket/tuple mà route vẫn gửi; route đã bỏ `rateLimit` để không đếm đôi.
  if not public.rate_limit_hit('jobs', 10, 3600) then
    raise exception 'Too many projects started. Please wait a while and try again.'
      using errcode = 'P0001';
  end if;

  if v_source like 'storage://%' then
    perform public.consume_upload_reservation('sources', substring(v_source from 11), null);
  end if;

  -- Tất cả đường ghi credit giữ cùng thứ tự khoá: profile trước, job sau.
  perform 1 from public.profiles where id = v_user for update;
  v_balance := public.credit_balance(v_user);
  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;
  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs(
    user_id, source_url, clips_requested, clip_length, watermark, segments,
    mode, aspect, layout, captions, caption_preset
  ) values(
    v_user, v_source, v_clips, v_length, coalesce(v_plan, 'free') = 'free', v_segments,
    v_mode, v_aspect, v_layout, v_captions, v_preset
  ) returning * into v_job;

  insert into public.credit_ledger(user_id, delta, reason, job_id)
  values(v_user, -v_hold, 'Hold for new job', v_job.id);
  return v_job;
end;
$$;

revoke execute on function public.create_job(text, int, text, jsonb, text, text, text, boolean, text)
  from public, anon;
grant execute on function public.create_job(text, int, text, jsonb, text, text, text, boolean, text)
  to authenticated;

-- ================================================================ cancel_job
create or replace function public.cancel_job(p_job_id uuid)
returns public.jobs language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_job public.jobs;
  v_was_running boolean;
  v_refunded int;
begin
  -- Cùng thứ tự profiles -> jobs với settle/finalize để tránh deadlock.
  perform public.lock_credit_owner(v_user);
  select * into v_job from public.jobs
  where id = p_job_id and user_id = v_user for update;
  if not found then
    raise exception 'Project not found.' using errcode = 'P0002';
  end if;
  if v_job.status = 'cancelled' then return v_job; end if;
  if v_job.status not in ('queued', 'running') then
    raise exception 'This project has already finished.' using errcode = '22023';
  end if;
  -- Đọc TRƯỚC lệnh update: `returning * into v_job` ghi đè hàng cũ ngay sau đó.
  v_was_running := v_job.status = 'running';
  update public.jobs set status = 'cancelled', stage = 'cancelled',
    finished_at = now(), lease_until = null
  where id = p_job_id returning * into v_job;
  v_refunded := public.refund_job(p_job_id, 'Refund: project cancelled');
  -- Job đã `running` nghĩa là worker đã tải/giải mã thật. Hoàn đủ thì start rồi
  -- huỷ là một vòng lặp compute miễn phí. Giữ lại 1 credit — ghi thành dòng
  -- ledger RIÊNG chứ không trừ vào số hoàn, để đối soát đọc được cả hai vế.
  -- Job `failed` vẫn hoàn đủ: lỗi thường là của ta, không phải của người dùng.
  if v_was_running and v_refunded > 1 then
    insert into public.credit_ledger(user_id, delta, reason, job_id)
    values (v_user, -1, 'Cancelled while running', p_job_id);
  end if;
  update public.tasks set status = 'cancelled', finished_at = now(), lease_until = null
  where status in ('queued', 'running') and (
    job_id = p_job_id or clip_id in (select id from public.clips where job_id = p_job_id)
    or asset_id in (select id from public.media_assets where job_id = p_job_id)
  );
  return v_job;
end;
$$;

revoke execute on function public.cancel_job(uuid) from public, anon;
grant execute on function public.cancel_job(uuid) to authenticated;

-- ======================================================= dọn receipt Polar
--
-- `polar_webhook_receipts` là lớp chống replay thứ nhất, nhưng nó chưa bao giờ
-- bị dọn. 90 ngày dài hơn hẳn cửa sổ retry của Polar (tính bằng ngày), và hai
-- lớp còn lại — cờ `polar_purchases.granted` theo order id và unique index
-- `credit_ledger.external_id` — vẫn chặn cộng đôi kể cả khi receipt đã bị xoá.
create or replace function public.purge_stale_rate_limits()
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare v_rows int;
begin
  delete from public.rate_limits where window_start < now() - interval '2 days';
  get diagnostics v_rows = row_count;
  delete from public.upload_reservations
   where status = 'reserved' and expires_at < now() - interval '1 day';
  delete from public.polar_webhook_receipts where received_at < now() - interval '90 days';
  return v_rows;
end;
$$;

revoke execute on function public.purge_stale_rate_limits() from public, anon, authenticated;
grant execute on function public.purge_stale_rate_limits() to service_role;

commit;
