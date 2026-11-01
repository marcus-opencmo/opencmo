-- 20270101140000: P6 S4, B's request 1b (docs/plans/cmo/2026-10-28-p6-sessions/A.md): a send-back the squad cannot
-- redo raises its card now, with the round-0 note.
--
-- Renders are keyed on the document hash, so most failures (a black stretch, a frozen shot, every shorts batch and
-- slideshow) would render the same file again. `look-redo.ts` says so; without this the card waited for the
-- hour-long give-up in `studio_look_sendbacks_claim`.

begin;

-- A claimed send-back → failed, and its card is raised (the snapshot carries the note: `approval_snapshot` reads a
-- failed check of this exact render). False when the check is not a claimed send-back (already settled, or not one).
create or replace function public.studio_look_sendback_unchanged(p_check uuid)
returns boolean language plpgsql volatile security definer set search_path = public
as $$
declare
  v_check public.look_checks;
begin
  update public.look_checks set status = 'failed', settled_at = now()
  where id = p_check and status = 'claimed'
  returning * into v_check;
  if not found then
    return false;
  end if;
  perform public.look_check_raise(v_check);
  return true;
end;
$$;
revoke all on function public.studio_look_sendback_unchanged(uuid) from public, anon, authenticated;
grant execute on function public.studio_look_sendback_unchanged(uuid) to service_role;

commit;
