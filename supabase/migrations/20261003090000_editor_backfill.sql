-- C3 bước 1 (spec editor-rewrite): mở đường cho backfill document trước khi gỡ
-- cột TSX ở migration kế tiếp.
--
-- SQL không đọc được TSX, nên document của hàng cũ phải do script Node suy ra
-- (`npm run editor:backfill`, chạy bằng service role). `editor_projects` ghi
-- thẳng được; `editor_revisions` thì bất biến qua trigger. Trigger riêng cho
-- bảng này cho đúng MỘT ngoại lệ: điền `document` đang NULL, mọi cột khác y
-- nguyên. Migration gỡ TSX trả lại trigger đóng băng hoàn toàn.
--
-- Không có policy UPDATE nào cho `authenticated` trên bảng này: ngoại lệ chỉ
-- chạm được bằng service role.

begin;

create or replace function public.freeze_editor_revision()
returns trigger
language plpgsql
as $$
begin
  if old.document is null and new.document is not null
     and (to_jsonb(new) - 'document') = (to_jsonb(old) - 'document') then
    return new;
  end if;
  -- Tiếng Anh: message của trigger đi thẳng qua PostgREST ra màn hình.
  raise exception 'Revisions cannot be changed.' using errcode = 'P0001';
end;
$$;

drop trigger if exists editor_revisions_immutable on public.editor_revisions;
create trigger editor_revisions_immutable
  before update on public.editor_revisions
  for each row execute function public.freeze_editor_revision();

revoke execute on function public.freeze_editor_revision() from public, anon, authenticated;

commit;
