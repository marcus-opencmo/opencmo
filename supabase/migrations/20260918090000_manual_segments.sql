-- Đoạn video người dùng TỰ chọn.
--
-- Cho tới nay mọi job đều đi một đường: transcribe cả video → LLM chọn khoảnh
-- khắc → tải đúng đoạn đó. Hai bước đầu chỉ tồn tại để trả lời câu hỏi "cắt
-- đoạn nào", và chúng là toàn bộ thời gian chờ — với video dài không có phụ đề
-- sẵn, người dùng ngồi nhìn màn hình vài phút trước khi thấy bất cứ thứ gì.
--
-- Người dùng kéo thanh bar trên video nhúng và tự trả lời câu hỏi đó. Khi có
-- `segments`, worker bỏ hẳn hai bước kia: tải đúng các đoạn, transcribe riêng
-- chúng, rồi render.
--
-- `null` nghĩa là "để AI chọn" — đúng hành vi của mọi job đã tạo trước migration
-- này, nên không cần backfill.

alter table public.jobs
  add column if not exists segments jsonb;

-- Ràng buộc hình dạng đặt ở constraint chứ không chỉ trong hàm: `jobs` có
-- những đường ghi khác (worker, retry), và một cột jsonb không kiểm hình dạng
-- là chỗ để dữ liệu rác nằm im tới lúc worker vấp phải nó giữa job.
--
-- Phải đi qua một hàm vì `check` KHÔNG nhận subquery, mà duyệt từng phần tử của
-- một mảng jsonb thì bắt buộc phải có `jsonb_array_elements` — tức là subquery.
-- Hàm giữ `immutable` để dùng được trong constraint, và nó thuần tính toán trên
-- tham số nên đúng nghĩa immutable, không phải khai khống.
--
-- KHÔNG thu quyền execute của hàm này: Postgres đánh giá constraint với quyền
-- của vai đang ghi, nên thu lại sẽ chặn chính `create_job` và worker.
create or replace function public.valid_job_segments(p_segments jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_segments is null
     or (
       jsonb_typeof(p_segments) = 'array'
       and jsonb_array_length(p_segments) between 1 and 10
       and not exists (
         select 1
         from jsonb_array_elements(p_segments) as s
         -- `is distinct from` chứ không phải `<>`: khoá thiếu cho
         -- `jsonb_typeof` ra NULL, và `NULL <> 'number'` là NULL, tức lọt.
         where jsonb_typeof(s) is distinct from 'object'
            or jsonb_typeof(s -> 'start') is distinct from 'number'
            or jsonb_typeof(s -> 'end') is distinct from 'number'
            or (s ->> 'start')::numeric < 0
            or (s ->> 'end')::numeric - (s ->> 'start')::numeric < 1
            or (s ->> 'end')::numeric - (s ->> 'start')::numeric > 180
       )
     );
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'jobs_segments_check') then
    alter table public.jobs
      add constraint jobs_segments_check check (public.valid_job_segments(segments));
  end if;
end;
$$;

-- Bản ba tham số bị thay hẳn, cùng lý do như lần trước: giữ cả hai thì
-- PostgREST gọi bằng tên tham số sẽ nhập nhằng giữa hai chữ ký.
drop function if exists public.create_job(text, int, text);

create or replace function public.create_job(
  p_source_url text,
  p_clips int default 5,
  p_length text default 'auto',
  p_segments jsonb default null
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
  v_prev numeric;
  v_item jsonb;
begin
  if v_source = '' then
    raise exception 'Missing video link.' using errcode = '22023';
  end if;

  -- Mảng rỗng là "không chọn đoạn nào", không phải lỗi: người dùng kéo một đoạn
  -- rồi xoá nó đi vẫn phải tạo được job (AI chọn hộ).
  if v_segments is not null and jsonb_typeof(v_segments) = 'array'
     and jsonb_array_length(v_segments) = 0 then
    v_segments := null;
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

  insert into public.jobs (user_id, source_url, clips_requested, clip_length, watermark, segments)
    values (v_user, v_source, v_clips, v_length, coalesce(v_plan, 'free') = 'free', v_segments)
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
  f text := 'public.create_job(text,int,text,jsonb)';
begin
  execute format('revoke execute on function %s from public, anon', f);
  execute format('grant execute on function %s to authenticated', f);
end;
$$;
