-- Commit both location changes together, only if both still match the preview.
create function public.transfer_ot_order(source_ot text, destination_ot text,
    source_before jsonb, destination_before jsonb, source_after jsonb, destination_after jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
declare
    changed integer;
begin
    if source_ot is null or destination_ot is null or source_ot = destination_ot
        or source_ot = '' or destination_ot = ''
        or left(source_ot, 2) = '__' or left(destination_ot, 2) = '__' then
        raise exception 'Choose two different locations';
    end if;
    -- Seed-only locations have no stored overrides until their first edit.
    insert into public.ot_edits (ot)
        select id from unnest(array[source_ot, destination_ot]) id order by id
        on conflict (ot) do nothing;
    perform ot from public.ot_edits where ot in (source_ot, destination_ot)
        order by ot for update;
    update public.ot_edits e set edits = p.after_edits, updated_at = now()
        from (values (source_ot, source_before, source_after),
                     (destination_ot, destination_before, destination_after))
             as p(id, before_edits, after_edits)
        where e.ot = p.id and e.edits = p.before_edits;
    get diagnostics changed = row_count;
    if changed <> 2 then
        raise exception using errcode = 'PT409', message = 'Location changed. Reopen Move to review the latest orders.';
    end if;
end;
$$;
revoke all on function public.transfer_ot_order(text,text,jsonb,jsonb,jsonb,jsonb) from public;
grant execute on function public.transfer_ot_order(text,text,jsonb,jsonb,jsonb,jsonb) to anon, authenticated;
