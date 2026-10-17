-- Keep OBJ input identity through conversion, resizing, and agent edits.
alter table public.generations
  drop constraint generations_input_type_valid,
  add constraint generations_input_type_valid
    check (input_type in ('text', 'image', 'glb', 'obj', 'ldraw', 'unknown')),
  drop constraint generations_input_format_valid,
  add constraint generations_input_format_valid
    check (input_format in ('io', 'ldr', 'mpd', 'glb', 'obj')),
  drop constraint generations_entry_page_valid,
  add constraint generations_entry_page_valid
    check (entry_page in ('/', '/image-to-lego', '/photo-to-lego', '/glb-to-lego',
                         '/obj-to-lego', '/use-ai-to-edit-ldraw', '/generated-model'));
