-- Retain the landing page for image-to-model generations without storing URL queries.
alter table public.generations
  drop constraint generations_entry_page_valid,
  add constraint generations_entry_page_valid
    check (entry_page in ('/', '/image-to-lego', '/photo-to-lego', '/glb-to-lego',
                         '/obj-to-lego', '/use-ai-to-edit-ldraw', '/generated-model',
                         '/image-to-3d', '/image-to-glb', '/image-to-obj'));
