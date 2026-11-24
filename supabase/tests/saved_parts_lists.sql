-- Run against a migrated Supabase test database. All fixtures are rolled back.
begin;
insert into auth.users(id) values ('c94601bc-1200-4d52-832d-ce0a13eef001'), ('c94601bc-1200-4d52-832d-ce0a13eef002');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"c94601bc-1200-4d52-832d-ce0a13eef001","aal":"aal2"}',true);
insert into public.saved_parts_lists(id,owner_id,name,parts) values
('c94601bc-1200-4d52-832d-ce0a13eef003',auth.uid(),'Bin','[{"part_id":"3001","color_id":4,"quantity":2}]');
do $$
declare r record;
begin
  update public.saved_parts_lists set name = 'Bin two' where id = 'c94601bc-1200-4d52-832d-ce0a13eef003' and revision = 1 returning revision,piece_count into strict r;
  assert r.revision = 2 and r.piece_count = 2;
  update public.saved_parts_lists set name = 'Stale' where id = 'c94601bc-1200-4d52-832d-ce0a13eef003' and revision = 1;
  assert not found;
  begin
    update public.saved_parts_lists set parts = '[{"part_id":"3001","color_id":16,"quantity":2}]' where id = 'c94601bc-1200-4d52-832d-ce0a13eef003';
    raise exception 'Invalid color accepted';
  exception when check_violation then null;
  end;
  assert public.parts_list_piece_count('[{"part_id":"3001","color_id":0,"quantity":100001}]') = 0;
end $$;
select set_config('request.jwt.claims','{"sub":"c94601bc-1200-4d52-832d-ce0a13eef002","aal":"aal2"}',true);
do $$
begin
  assert not exists (select 1 from public.saved_parts_lists where id='c94601bc-1200-4d52-832d-ce0a13eef003');
  update public.saved_parts_lists set name = 'Other' where id='c94601bc-1200-4d52-832d-ce0a13eef003';
  assert not found;
end $$;
rollback;
