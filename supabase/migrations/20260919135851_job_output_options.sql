-- Tuỳ chọn đầu ra của một job: clip hay tải nguyên bản, khung hình, phụ đề.
--
-- Cho tới nay mọi job đều ra 9:16, luôn crop, luôn burn phụ đề style "bold".
-- Ba thứ đó đã có tham số ở đường editor (`clip_revisions.settings`) nhưng
-- đường pipeline thì chốt cứng, nên người dùng chỉ đổi được SAU khi clip đã
-- render xong — tức là sau khi đã trả tiền cho một lần render sai.
--
-- Hai giá trị đáng giải thích:
--
--   `mode = 'full'`   không cắt gì cả, chỉ tải video nguyên bản về cho người
--       dùng tải xuống. Không transcript, không revision, nên nhánh này KHÔNG
--       tạo `clip_revisions` và không đụng trần 180 giây của revision.
--
--   `layout = 'auto'` KHÔNG có trong `LAYOUTS` của revision settings, và cố ý
--       như vậy: nó chỉ sống ở mức job và nghĩa là "fill nếu dò được mặt, fit
--       nếu không". Worker giải nó thành 'fill'/'fit' trước khi ghi revision
--       đầu tiên, nên hợp đồng revision không phải biết tới nó. Đây là câu trả
--       lời cho nguồn screencast: không có mặt người thì crop 9:16 cắt vào
--       vùng editor trống.
--
-- Mặc định của cả năm cột là đúng hành vi cũ, nên job đã tạo không cần backfill.

alter table public.jobs
  add column if not exists mode text not null default 'clip'
    check (mode in ('clip', 'full')),
  add column if not exists aspect text not null default '9:16'
    check (aspect in ('9:16', '1:1', '16:9')),
  add column if not exists layout text not null default 'auto'
    check (layout in ('auto', 'fill', 'fit')),
  add column if not exists captions boolean not null default true,
  add column if not exists caption_preset text not null default 'bold'
    check (caption_preset in ('bold', 'clean', 'minimal'));

-- Bản bốn tham số bị thay hẳn, cùng lý do như hai lần trước: giữ cả hai thì
-- PostgREST gọi bằng tên tham số sẽ nhập nhằng giữa hai chữ ký.
drop function if exists public.create_job(text, int, text, jsonb);

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

  if v_mode not in ('clip', 'full') then
    raise exception 'Choose whether to clip the video or download it whole.'
      using errcode = '22023';
  end if;

  -- Mảng rỗng là "không chọn đoạn nào", không phải lỗi: người dùng kéo một đoạn
  -- rồi xoá nó đi vẫn phải tạo được job (AI chọn hộ).
  if v_segments is not null and jsonb_typeof(v_segments) = 'array'
     and jsonb_array_length(v_segments) = 0 then
    v_segments := null;
  end if;

  -- Không cắt thì không có đoạn nào để chọn, và số clip luôn là 1. Sửa im lặng
  -- thay vì báo lỗi sẽ giấu mất việc client gửi hai thứ mâu thuẫn nhau.
  if v_mode = 'full' then
    if v_segments is not null then
      raise exception 'Picked moments only apply when we clip your video.'
        using errcode = '22023';
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

    -- Duyệt theo thứ tự đã sắp: bắt chồng lấn bằng cách so với mép phải trước đó.
    v_prev := null;
    for v_item in
      select value
      from jsonb_array_elements(v_segments)
      order by (value ->> 'start')::numeric
    loop
      -- `is distinct from` chứ không phải `<>`: khoá thiếu cho `jsonb_typeof`
      -- ra NULL, và `NULL <> 'number'` là NULL — `if` coi đó là sai và đoạn
      -- thiếu mốc kết thúc đi thẳng tới worker.
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

    -- Lưu đã sắp theo thời gian: clip 1 là đoạn sớm nhất, đúng thứ tự người
    -- dùng nhìn thấy trên thanh bar.
    select jsonb_agg(value order by (value ->> 'start')::numeric)
      into v_segments
      from jsonb_array_elements(v_segments);

    -- Số clip LÀ số đoạn. `p_clips` không còn nghĩa ở nhánh này, và tin nó thì
    -- worker render 5 clip cho 2 đoạn — lệch số lượng giữa DB và kết quả.
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

  if v_source like 'storage://%' then
    perform public.consume_upload_reservation('sources', substring(v_source from 11), null);
  end if;

  -- Thứ tự khoá giữ nguyên: hàng profiles trước, hàng jobs sau.
  perform 1 from public.profiles where id = v_user for update;
  select coalesce(sum(delta), 0)::int into v_balance
    from public.credit_ledger where user_id = v_user;
  if v_balance < v_hold then
    raise exception 'Not enough credits: % needed, % left. Top up on the Credits page.',
      v_hold, v_balance using errcode = 'P0001';
  end if;
  select plan into v_plan from public.profiles where id = v_user;

  insert into public.jobs (
    user_id, source_url, clips_requested, clip_length, watermark, segments,
    mode, aspect, layout, captions, caption_preset
  )
    values (
      v_user, v_source, v_clips, v_length, coalesce(v_plan, 'free') = 'free', v_segments,
      v_mode, v_aspect, v_layout, v_captions, v_preset
    )
    returning * into v_job;
  insert into public.credit_ledger (user_id, delta, reason, job_id)
    values (v_user, -v_hold, 'Hold for new job', v_job.id);

  return v_job;
end;
$$;

-- `drop function` xoá luôn mọi grant của chữ ký cũ, nên phải cấp lại. Thiếu
-- khối này thì `create_job` mặc định cho PUBLIC execute — nới quyền chứ không
-- phải giữ nguyên.
do $$
declare
  f text := 'public.create_job(text,int,text,jsonb,text,text,text,boolean,text)';
begin
  execute format('revoke execute on function %s from public, anon', f);
  execute format('grant execute on function %s to authenticated', f);
end;
$$;

-- Video tải nguyên bản sống 24 giờ, không phải 7 ngày.
--
-- Clip cắt ra là thứ người dùng quay lại xem, sắp lịch đăng, tải lại nhiều lần
-- trong tuần. Một bản tải nguyên bản thì không: họ bấm tải, nhận file, xong.
-- Giữ một video 1–2 GB thêm sáu ngày cho một lượt tải duy nhất là phần tốn
-- nhất của chế độ này và cũng là phần vô ích nhất.
--
-- Viết đè `set_job_storage_expiry` của `20260918110000` thay vì thêm trigger
-- thứ hai: hai trigger cùng ghi `expires_at` thì thứ tự chạy quyết định giá
-- trị cuối, và thứ tự đó là tên trigger — một chỗ để lỗi nấp.
create or replace function public.set_job_storage_expiry()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_window interval := case when new.mode = 'full'
                            then interval '24 hours'
                            else interval '7 days' end;
begin
  if new.status::text in ('done', 'failed', 'cancelled')
     and new.status is distinct from old.status then
    new.expires_at := coalesce(new.finished_at, now()) + v_window;
  elsif new.status::text in ('queued', 'running')
        and old.status::text in ('done', 'failed', 'cancelled') then
    -- Retry phải có một cửa sổ mới; cron không được dọn source giữa lần chạy.
    new.expires_at := now() + v_window;
  end if;
  return new;
end;
$$;

revoke execute on function public.set_job_storage_expiry() from public, anon, authenticated;
