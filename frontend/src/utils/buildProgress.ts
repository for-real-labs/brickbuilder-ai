/** Condense the latest streamed activity; never display the full reasoning log. */
export function summarizeBuildProgress(notes: string, fallback = 'Planning your brick build'): string {
  const phrases = notes.slice(-4000).replace(/```[\s\S]*?(?:```|$)/g, '')
    .split(/\n+|[.!?]\s+/)
    .map(line => line.replace(/^[\s#>*\-]+/, '').replace(/[*_\x60]/g, '').trim())
    .filter(line => /[a-z]/i.test(line) && !/^[{\[\d]|^\s*"[^"\n]+"\s*:/.test(line));
  const latest = [...phrases].reverse().find(line => line.split(/\s+/).length >= 3) ?? phrases.at(-1);
  if (!latest) return fallback;
  const action = latest.match(/\b(?:checking|preparing|building|designing|adding|adjusting|choosing|coloring|colouring|connecting|refining|shaping|creating|placing|planning|reviewing|finishing|applying|assembling|packing|saving|rendering)\b.*$/i)?.[0] ?? latest;
  const summary = action.replace(/[.!…]+$/, '').split(/\s+/).slice(0, 8).join(' ').replace(/[,;:]$/, '');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}
