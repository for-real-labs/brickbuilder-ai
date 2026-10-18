/** Fixed app capabilities; model output cannot supply URLs, code or form submissions. */
export const BUDDY_TOOL_INTENTS = [
  'export', 'export_ldraw', 'export_io', 'export_csv', 'export_xml',
  'import', 'import_ldraw', 'import_io', 'convert_image', 'convert_glb', 'convert_obj',
  'generation_settings', 'buddy_settings', 'community', 'github', 'feedback', 'support',
] as const;
export type BuddyToolIntent = typeof BUDDY_TOOL_INTENTS[number];
export const isBuddyToolIntent = (intent: string): intent is BuddyToolIntent =>
  (BUDDY_TOOL_INTENTS as readonly string[]).includes(intent);

export const BUDDY_TOOL_ROUTES: Partial<Record<BuddyToolIntent, string>> = {
  import_ldraw: '/use-ai-to-edit-ldraw?format=ldraw', import_io: '/use-ai-to-edit-ldraw?format=io',
  convert_image: '/image-to-lego', convert_glb: '/glb-to-lego', convert_obj: '/obj-to-lego', community: '/community',
};
