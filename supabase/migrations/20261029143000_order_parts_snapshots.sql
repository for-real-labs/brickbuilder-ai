-- Preserve the inventory quoted at checkout for future redesigns.
alter table public.orders add column if not exists parts_list_csv_url text;
comment on column public.orders.parts_list_csv_url is 'Parts-list artifact recorded in the paid checkout metadata; never replaced by later model edits.';

-- Older orders reference an exact generation version. Recover its BOM only
-- when the artifact was saved before that order, not regenerated afterward.
update public.orders o
set parts_list_csv_url = g.parts_list_csv_url
from public.generations g
where o.generation_id = g.id
  and o.parts_list_csv_url is null
  and substring(g.parts_list_csv_url from '/parts_list_([0-9]{10})[.]csv([?].*)?$')::numeric
      <= extract(epoch from o.created_at);
