import { strToU8, zipSync } from 'fflate';
// LDraw → BrickLink IDs from backend/gobrick_colors.csv, with transparent
// colors 40 and 47 checked against the LDraw and BrickLink color guides.
import bricklinkColors from './bricklinkColors.json';

export type ModelExportFormat = 'ldraw' | 'io' | 'csv' | 'xml';
interface Part { id: string; color: number; quantity: number }

/** Count model placements, expanding submodels but never the geometry inside a part. */
export function modelParts(content: string): Part[] {
  const sections = new Map<string, string[]>();
  let current: string[] = [];
  let root = current;
  let firstFile = true;
  for (const line of content.split(/\r?\n/)) {
    const file = line.trim().match(/^0\s+FILE\s+(.+)$/i);
    if (file) {
      current = [];
      sections.set(file[1].toLowerCase().replaceAll('\\', '/'), current);
      // Packed MPDs can place the model before their first FILE section and
      // append library part geometry afterward. Keep those placements as root.
      if (firstFile) {
        if (!root.some(placement => /^1\s/.test(placement))) root = current;
        firstFile = false;
      }
    } else current.push(line.trim());
  }
  const parts = new Map<string, Part>();
  let placements = 0;
  const visit = (lines: string[], inheritedColor: number, parents: Set<string>) => {
    for (const line of lines) {
      if (!/^1\s/.test(line)) continue;
      const tokens = line.split(/\s+/);
      if (tokens.length < 15 || !tokens.slice(1, 14).every(token => Number.isFinite(Number(token)))) {
        throw new Error('The model contains an invalid part placement.');
      }
      if (++placements > 100_000) throw new Error('This model is too large to export a parts list.');
      const color = tokens[1] === '16' ? inheritedColor : Number(tokens[1]);
      const file = tokens.slice(14).join(' ').toLowerCase().replaceAll('\\', '/');
      const submodel = sections.get(file);
      if (submodel && !file.endsWith('.dat')) {
        if (parents.has(file) || parents.size > 100) throw new Error('The model contains a circular or deeply nested submodel.');
        visit(submodel, color, new Set([...parents, file]));
      } else {
        const partFile = file.startsWith('parts/') ? file.slice('parts/'.length) : file;
        if (!/^[a-z0-9][a-z0-9_-]*\.dat$/i.test(partFile)) throw new Error('A part in this model cannot be exported to a parts list.');
        const id = partFile.slice(0, -4);
        const key = `${id}:${color}`;
        const part = parts.get(key);
        if (part) part.quantity++;
        else parts.set(key, { id, color, quantity: 1 });
      }
    }
  };
  visit(root, 16, new Set());
  if (!parts.size) throw new Error('No parts were found in this model.');
  return [...parts.values()].sort((a, b) => a.id.localeCompare(b.id) || a.color - b.color);
}

export function createModelExport(content: string, name: string, format: ModelExportFormat): { blob: Blob; filename: string } {
  const base = name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'model';
  if (format === 'ldraw') return { blob: new Blob([content], { type: 'text/plain;charset=utf-8' }), filename: `${base}.ldr` };
  if (format === 'io') return { blob: new Blob([zipSync({ 'model.ldr': strToU8(content) })], { type: 'application/zip' }), filename: `${base}.io` };
  const parts = modelParts(content);
  if (format === 'csv') {
    const rows = parts.map(part => `${part.id}.dat,${part.color},${part.quantity}`);
    return { blob: new Blob([['LdrawId,LDrawColorId,Qty', ...rows].join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), filename: `${base}_parts.csv` };
  }
  const items = parts.map(part => {
    const color = (bricklinkColors as Record<string, number>)[part.color];
    if (color === undefined) throw new Error(`LDraw color ${part.color} has no BrickLink match. Download the CSV parts list instead.`);
    return `  <ITEM><ITEMTYPE>P</ITEMTYPE><ITEMID>${part.id}</ITEMID><COLOR>${color}</COLOR><MINQTY>${part.quantity}</MINQTY></ITEM>`;
  });
  return { blob: new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n<INVENTORY>\n${items.join('\n')}\n</INVENTORY>\n`], { type: 'application/xml;charset=utf-8' }), filename: `${base}_parts.xml` };
}

export function downloadModel(content: string, name: string, format: ModelExportFormat): void {
  const { blob, filename } = createModelExport(content, name, format);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Keep the URL alive until the browser has accepted the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
