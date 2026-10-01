import { Blocks, Eye, Link, Package, Paintbrush, Ruler, Save, Shapes, ShieldCheck } from 'lucide-react';

/** Match the current generated activity, so the icon changes with the phrase. */
export function buildActivityIcon(activity: string) {
  if (/\b(?:saving|saved|storing|uploading|exporting)\b/i.test(activity)) return Save;
  if (/\b(?:packing|packaging)\b/i.test(activity)) return Package;
  if (/\b(?:rendering|preview|reviewing|viewing|angles)\b/i.test(activity)) return Eye;
  if (/\b(?:checking|verifying|validating|stability|reinforcing|strengthening)\b/i.test(activity)) return ShieldCheck;
  if (/\b(?:painting|coloring|colouring|colors?|colours?|markings|spots?|patterns?|stripes?)\b/i.test(activity)) return Paintbrush;
  if (/\b(?:connecting|connections?|joining|bridging)\b/i.test(activity)) return Link;
  if (/\b(?:measuring|spacing|sizing|sizes?|proportions?|positioning|aligning|adjusting)\b/i.test(activity)) return Ruler;
  if (/\b(?:shaping|forming|rounding|curving|flattening|trimming|tapering|sculpting)\b/i.test(activity)) return Shapes;
  return Blocks;
}
