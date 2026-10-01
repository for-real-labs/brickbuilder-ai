import React from 'react';

import { useBrickBuildScene } from '../hooks/useBrickBuildScene';

export function LlmPreviewLoader({ previewImageUrl, compact = false }: { previewImageUrl?: string | null; compact?: boolean }) {
  const scene = useBrickBuildScene(!previewImageUrl);

  return (
    <div className={`llm-preview-loader ${compact ? 'llm-preview-loader-compact' : ''}`} style={compact ? { height: '100%' } : undefined}>
      {previewImageUrl ? (
        <div className="llm-preview-loader-image-shell">
          <img src={previewImageUrl} alt="Generation preview" className="h-full w-full object-contain" />
        </div>
      ) : (
        <svg key={scene.id} viewBox="0 0 420 270" className="brick-build-scene" role="img" aria-label={`Colorful bricks snapping together to build a ${scene.name}`} data-build-scene={scene.id}>
          <ellipse cx="210" cy="227" rx="117" ry="17" fill="#cbded7" opacity=".5" />
          <g fill="#fff" opacity=".85"><path d="M44 62h57c10-18-12-28-22-20-3-17-29-15-28 1-17-2-23 19-7 19Z" /><path d="M325 48h45c8-14-10-23-18-16-3-14-23-12-22 1-14-2-18 15-5 15Z" /></g>
          <path d="m95 218 18-10h209v18H95Z" fill="#34d399" />
          <path d="M95 218h209v12H95Z" fill="#10b981" />
          <path d="m304 218 18-10v18l-18 4Z" fill="#059669" />
          {Array.from({ length: 10 }, (_, i) => <ellipse key={i} cx={113 + i * 20} cy="213" rx="5" ry="2.5" fill="#6ee7b7" />)}
          {scene.bricks.map((brick, i) => (
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
            {scene.details}
            <path d="m102 100 3-7 3 7 7 3-7 3-3 7-3-7-7-3Zm224 54 3-7 3 7 7 3-7 3-3 7-3-7-7-3Z" fill="#fbbf24" />
          </g>
        </svg>
      )}
      {!compact && <p className="absolute bottom-4 inset-x-4 text-center text-sm font-medium text-slate-600">One brick at a time</p>}
    </div>
  );
}
