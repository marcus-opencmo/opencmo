-- The CMO chat can rewrite the founder's marketing documents when they ask it to. Each save is a
-- new version (history keeps the old ones), written under the founder's session and badged
-- "Drafted by OpenCMO". Validation and the version lock are save_marketing_document's.

begin;

create or replace function public.cmo_chat_save_document(p_kind text, p_body jsonb)
returns public.marketing_documents
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_row public.marketing_documents;
begin
  v_row := public.save_marketing_document(p_kind, p_body, null);
  update public.marketing_documents set created_by = 'agent' where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

revoke all on function public.cmo_chat_save_document(text, jsonb) from public, anon;
grant execute on function public.cmo_chat_save_document(text, jsonb) to authenticated;

commit;
