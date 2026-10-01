import React from 'react';

// A little brick house assembles from the base up, then starts again.
const BRICKS = [
  { x: 126, y: 188, w: 68, color: '#60a5fa' }, { x: 198, y: 188, w: 96, color: '#38bdf8' },
  { x: 126, y: 162, w: 96, color: '#fbbf24' }, { x: 226, y: 162, w: 68, color: '#f59e0b' },
  { x: 126, y: 136, w: 68, color: '#fcd34d' }, { x: 198, y: 136, w: 96, color: '#fbbf24' },
  { x: 114, y: 110, w: 104, color: '#fb7185' }, { x: 222, y: 110, w: 84, color: '#f43f5e' },
  { x: 140, y: 84, w: 140, color: '#fb7185' }, { x: 166, y: 58, w: 88, color: '#f43f5e' },
] as const;

export function LlmPreviewLoader({ previewImageUrl, compact = false }: { previewImageUrl?: string | null; compact?: boolean }) {
  return (
    <div className={`llm-preview-loader ${compact ? 'llm-preview-loader-compact' : ''}`} style={compact ? { height: '100%' } : undefined}>
      {previewImageUrl ? (
        <div className="llm-preview-loader-image-shell">
          <img src={previewImageUrl} alt="Generation preview" className="h-full w-full object-contain" />
        </div>
      ) : (
        <svg viewBox="0 0 420 270" className="brick-build-scene" role="img" aria-label="Colorful bricks snapping together to build a little house">
          <ellipse cx="210" cy="227" rx="117" ry="17" fill="#cbded7" opacity=".5" />
          <g fill="#fff" opacity=".85"><path d="M44 62h57c10-18-12-28-22-20-3-17-29-15-28 1-17-2-23 19-7 19Z" /><path d="M325 48h45c8-14-10-23-18-16-3-14-23-12-22 1-14-2-18 15-5 15Z" /></g>
          <path d="m95 218 18-10h209v18H95Z" fill="#34d399" />
          <path d="M95 218h209v12H95Z" fill="#10b981" />
          <path d="m304 218 18-10v18l-18 4Z" fill="#059669" />
          {Array.from({ length: 10 }, (_, i) => <ellipse key={i} cx={113 + i * 20} cy="213" rx="5" ry="2.5" fill="#6ee7b7" />)}
          {BRICKS.map((brick, i) => (
            <g key={i} className="brick-build-piece" style={{ animationName: `brickSnap${i}` } as React.CSSProperties}>
              <g transform={`translate(${brick.x} ${brick.y})`}>
                <rect width={brick.w} height="25" rx="3" fill={brick.color} />
                <path d={`M0 0 12-8h${brick.w}L${brick.w} 0Z`} fill={brick.color} />
                <path d={`m${brick.w} 0 12-8v25l-12 8Z`} fill={brick.color} />
                <path d={`M0 0 12-8h${brick.w}L${brick.w} 0Z`} fill="#fff" opacity=".25" />
                <path d={`m${brick.w} 0 12-8v25l-12 8Z`} fill="#000" opacity=".12" />
                <path d={`M3 4h${brick.w - 6}`} stroke="#fff" opacity=".25" strokeWidth="2" strokeLinecap="round" />
                {Array.from({ length: Math.floor(brick.w / 24) }, (_, stud) => (
                  <g key={stud} transform={`translate(${18 + stud * 24} -6)`}>
                    <path d="M-7-3v4c0 4 14 4 14 0v-4" fill={brick.color} />
                    <ellipse cy="-3" rx="7" ry="3" fill={brick.color} />
                    <ellipse cy="-3" rx="7" ry="3" fill="#fff" opacity=".35" />
                  </g>
                ))}
              </g>
            </g>
          ))}
          <g className="brick-build-details">
            <rect x="181" y="168" width="29" height="44" rx="3" fill="#7c5b47" /><circle cx="203" cy="191" r="2" fill="#fde68a" />
            <rect x="244" y="144" width="31" height="29" rx="3" fill="#e0f2fe" stroke="#fff" strokeWidth="3" />
            <path d="M259 144v29m-15-14h31" stroke="#fff" strokeWidth="2" />
            <path d="m102 100 3-7 3 7 7 3-7 3-3 7-3-7-7-3Zm224 54 3-7 3 7 7 3-7 3-3 7-3-7-7-3Z" fill="#fbbf24" />
          </g>
        </svg>
      )}
      {!compact && <p className="absolute bottom-4 inset-x-4 text-center text-sm font-medium text-slate-600">One brick at a time</p>}
    </div>
  );
}
