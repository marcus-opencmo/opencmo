-- Ngân sách lượt 3D (spec code-scenes): viết code cảnh + 3 vòng preview_3d của
-- Gemini Pro tiêu hết 5 credit giữ trước (đo 01/10) và người dùng phải bấm
-- Continue giữa chừng. Lượt ĐÃ dùng preview_3d được tự nâng phần giữ lên
-- agent_3d_hold_credits() trước khi phải hỏi. Vẫn chỉ trừ theo mức dùng thật:
-- phần giữ thừa hoàn lúc chốt lượt như mọi lượt (agent_finish_turn).

create or replace function public.agent_3d_hold_credits()
returns int language sql immutable set search_path = public as $$ select 20 $$;

-- Trả phần giữ MỚI của lượt; không đổi gì (và không lỗi) khi lượt không làm 3D,
-- đã ở mức 3D, không còn chạy, hay số dư không đủ — vòng lặp khi đó dừng hỏi như cũ.
create or replace function public.agent_raise_hold_3d(p_turn_id uuid)
returns int language plpgsql volatile security definer set search_path = public
as $$
declare
  v_user uuid := public.require_user();
  v_turn public.agent_turns;
  v_more int;
begin
  perform public.lock_credit_owner(v_user);
  select t.* into v_turn from public.agent_turns t
  join public.agent_sessions s on s.id = t.session_id
  where t.id = p_turn_id and s.user_id = v_user
  for update of t;
  if not found then
    raise exception 'Turn not found.' using errcode = 'P0002';
  end if;
  v_more := public.agent_3d_hold_credits() - v_turn.hold_credits;
  if v_turn.status <> 'running' or v_more <= 0
     or not exists (select 1 from public.agent_tool_calls c where c.turn_id = v_turn.id and c.name = 'preview_3d')
     or public.credit_balance(v_user) < v_more then
    return v_turn.hold_credits;
  end if;
  insert into public.credit_ledger(user_id, delta, reason) values (v_user, -v_more, 'Assistant hold (3D)');
  update public.agent_turns set hold_credits = hold_credits + v_more where id = v_turn.id;
  return v_turn.hold_credits + v_more;
end;
$$;

revoke execute on function public.agent_raise_hold_3d(uuid) from public, anon;
grant execute on function public.agent_raise_hold_3d(uuid) to authenticated;
grant execute on function public.agent_3d_hold_credits() to authenticated;
