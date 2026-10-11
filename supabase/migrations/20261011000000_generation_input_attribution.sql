-- Preserve the user's original input independently of pipeline and model mode.
alter table public.generations
  add column input_type text not null default 'unknown'
    constraint generations_input_type_valid check (input_type in ('text', 'image', 'glb', 'ldraw', 'unknown')),
  add column input_format text
    constraint generations_input_format_valid check (input_format in ('io', 'ldr', 'mpd', 'glb')),
  add column entry_page text
    constraint generations_entry_page_valid check (entry_page in ('/', '/image-to-lego', '/photo-to-lego', '/glb-to-lego', '/use-ai-to-edit-ldraw', '/generated-model'));

-- Generated images in textToBricks are intermediate output, not user input.
-- Missing reference images on incomplete old AI jobs cannot establish origin.
update public.generations set input_type = case
  when endpoint = 'textToBricks' then 'text'
  when endpoint = 'imageToBricks' then 'image'
  when endpoint = 'glbToBricks' then 'glb'
  when endpoint = 'uploadLdraw' then 'ldraw'
  when endpoint in ('novaToBricks', 'llmToBricks') and original_image_url is not null then 'image'
  when endpoint in ('novaToBricks', 'llmToBricks') and status = 'completed' then 'text'
  else 'unknown' end;
update public.generations set input_format = 'glb' where endpoint = 'glbToBricks';

-- AI and manual revisions retain the initial model's input origin.
update public.generations revision
set input_type = root.input_type, input_format = root.input_format
from public.generations root
where revision.generation_id = root.id and revision.id <> root.id;

-- Protect inheritance even for older clients inserting manual revisions.
create function public.assign_generation_input() returns trigger
language plpgsql set search_path = public as $$
declare source_type text; source_format text;
begin
  if new.generation_id <> new.id then
    select g.input_type, g.input_format into source_type, source_format
    from public.generations g where g.id = new.generation_id;
    new.input_type := coalesce(source_type, 'unknown');
    new.input_format := source_format;
  elsif new.input_type = 'unknown' then
    new.input_type := case new.endpoint
      when 'textToBricks' then 'text' when 'imageToBricks' then 'image'
      when 'glbToBricks' then 'glb' when 'uploadLdraw' then 'ldraw'
      else 'unknown' end;
  end if;
  return new;
end;
$$;
-- Alphabetical trigger ordering places this after version allocation.
create trigger generations_z_input_after_version before insert on public.generations
for each row execute function public.assign_generation_input();

create or replace view public.latest_generations with (security_invoker = true) as
select distinct on (user_id, user_type, generation_id) * from public.generations
order by user_id, user_type, generation_id, version desc;
grant select (input_type, input_format, entry_page) on public.generations to anon, authenticated;
comment on column public.generations.input_type is 'Original user input: text, image (including photos), glb, ldraw (Studio/io/ldr/mpd), or unknown for unidentifiable historical jobs. Inherited by edits.';
comment on column public.generations.input_format is 'Original model file extension, when known. Inherited by edits.';
comment on column public.generations.entry_page is 'Allowlisted submitting page pathname for this revision; no query strings. Null for older or non-web clients.';
notify pgrst, 'reload schema';
