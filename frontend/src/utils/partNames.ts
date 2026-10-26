// Library part descriptions travel with the packed MPD, including uncommon parts.
const COMMON_PART_NAMES: { [key: string]: string } = {
  '3005.dat': '1x1',
  '3004.dat': '1x2', 
  '3622.dat': '1x3',
  '3010.dat': '1x4',
  '3009.dat': '1x6',
  '3008.dat': '1x8',
  '6111.dat': '1x10',
  '3003.dat': '2x2',
  '3002.dat': '2x3',
  '3001.dat': '2x4',
  '2456.dat': '2x6',
  '3007.dat': '2x8',
  '3006.dat': '2x10',
};

function normalizePartFilename(filename: string): string {
  return filename.trim().replace(/\\/g, '/').replace(/^parts\//i, '').replace(/\.dat$/i, '').toLowerCase();
}

export function parsePartNames(content: string): Map<string, string> {
  const names = new Map<string, string>();
  let filename: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const file = line.trim().match(/^0 FILE (.+)$/i);
    if (file) {
      filename = normalizePartFilename(file[1]);
      continue;
    }
    if (!filename || !line.trim()) continue;
    // A library description is the first nonblank line of its FILE section.
    // Never mistake metadata, geometry, or a moved-part redirect for a name.
    const description = line.trim().match(/^0 ([^!/]+)$/)?.[1].replace(/^~+/, '').trim();
    if (description && !/^(?:Name:|Author:|BFC\b|STEP\b|NOFILE\b|Moved to\b)/i.test(description)
        && /[a-z]/i.test(description) && !/\.(?:dat|ldr|mpd)\b/i.test(description)) {
      names.set(filename, description.replace(/\s+/g, ' ').replace(/(\d)\s*x\s*(?=\d)/gi, '$1x'));
    }
    filename = null;
  }
  return names;
}

export function getPartName(filename: string, names: ReadonlyMap<string, string>): string {
  const key = normalizePartFilename(filename);
  return names.get(key) || COMMON_PART_NAMES[`${key}.dat`] || 'Custom part';
}
