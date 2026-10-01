import React from 'react';

type Brick = { x: number; y: number; w: number; color: string };
type BrickBuildScene = { id: string; name: string; bricks: readonly Brick[]; details: React.ReactNode };

const colors = { blue: '#60a5fa', sky: '#38bdf8', yellow: '#fbbf24', red: '#fb7185', pink: '#f43f5e', green: '#34d399', darkGreen: '#059669', purple: '#a78bfa', white: '#e2e8f0', brown: '#b98053' };
type Color = keyof typeof colors;
// Ordered from the foundation up so every model uses the same snap-in timeline.
function bricks(rows: readonly (readonly [number, number, number, Color])[]): Brick[] {
  return rows.map(([x, y, w, color]) => ({ x, y, w, color: colors[color] }));
}

const HOUSE_BRICKS = [
  { x: 126, y: 188, w: 68, color: '#60a5fa' }, { x: 198, y: 188, w: 96, color: '#38bdf8' },
  { x: 126, y: 162, w: 96, color: '#fbbf24' }, { x: 226, y: 162, w: 68, color: '#f59e0b' },
  { x: 126, y: 136, w: 68, color: '#fcd34d' }, { x: 198, y: 136, w: 96, color: '#fbbf24' },
  { x: 114, y: 110, w: 104, color: '#fb7185' }, { x: 222, y: 110, w: 84, color: '#f43f5e' },
  { x: 140, y: 84, w: 140, color: '#fb7185' }, { x: 166, y: 58, w: 88, color: '#f43f5e' },
] as const;


export const BRICK_BUILD_SCENES: readonly BrickBuildScene[] = [
  { id: 'house', name: 'little house', bricks: HOUSE_BRICKS, details: <>
    <rect x="181" y="168" width="29" height="44" rx="3" fill="#7c5b47" /><circle cx="203" cy="191" r="2" fill="#fde68a" />
    <rect x="244" y="144" width="31" height="29" rx="3" fill="#e0f2fe" stroke="#fff" strokeWidth="3" />
    <path d="M259 144v29m-15-14h31" stroke="#fff" strokeWidth="2" />
  </> },
  { id: 'castle', name: 'tiny castle', bricks: bricks([
    [114,188,90,'purple'],[208,188,90,'purple'],[114,162,58,'blue'],[176,162,58,'white'],[238,162,60,'blue'],
    [114,136,58,'blue'],[238,136,60,'blue'],[108,110,70,'purple'],[232,110,72,'purple'],[172,136,62,'white'],
  ]), details: <><path d="M187 213v-23a18 18 0 0 1 36 0v23" fill="#475569" /><path d="M143 111V65l30 12-30 12m125 22V65l30 12-30 12" fill="#fb7185" stroke="#475569" strokeWidth="3" /><path d="M138 142h12v17h-12m124-17h12v17h-12" fill="#e0f2fe" /></> },
  { id: 'rocket', name: 'space rocket', bricks: bricks([
    [158,188,40,'red'],[230,188,40,'red'],[186,188,52,'white'],[186,162,52,'white'],[174,136,76,'sky'],
    [174,110,76,'white'],[186,84,52,'white'],[186,58,52,'red'],[198,32,28,'pink'],[198,214,28,'yellow'],
  ]), details: <><circle cx="212" cy="123" r="17" fill="#bae6fd" stroke="#64748b" strokeWidth="5" /><path d="m178 222-8 16m75-16 8 16" stroke="#fbbf24" strokeWidth="5" strokeLinecap="round" /></> },
  { id: 'robot', name: 'friendly robot', bricks: bricks([
    [146,188,52,'purple'],[222,188,52,'purple'],[158,162,104,'blue'],[158,136,104,'blue'],[118,136,36,'purple'],
    [266,136,36,'purple'],[184,110,52,'yellow'],[146,84,128,'white'],[146,58,128,'white'],[198,32,24,'red'],
  ]), details: <><circle cx="178" cy="82" r="8" fill="#334155" /><circle cx="242" cy="82" r="8" fill="#334155" /><path d="M188 99h44" stroke="#64748b" strokeWidth="5" strokeLinecap="round" /><rect x="186" y="144" width="48" height="18" rx="4" fill="#fbbf24" /></> },
  { id: 'race-car', name: 'race car', bricks: bricks([
    [116,188,48,'white'],[254,188,48,'white'],[104,162,96,'red'],[204,162,110,'red'],[104,136,60,'pink'],
    [168,136,84,'sky'],[256,136,58,'pink'],[176,110,68,'sky'],[104,110,36,'yellow'],[284,110,36,'yellow'],
  ]), details: <><circle cx="144" cy="200" r="20" fill="#334155" /><circle cx="280" cy="200" r="20" fill="#334155" /><circle cx="144" cy="200" r="9" fill="#e2e8f0" /><circle cx="280" cy="200" r="9" fill="#e2e8f0" /><path d="M210 111v46" stroke="#fff" strokeWidth="4" /><text x="218" y="184" fill="#fff" fontSize="22" fontWeight="bold">7</text></> },
  { id: 'sailboat', name: 'sailboat', bricks: bricks([
    [144,188,136,'blue'],[118,162,92,'sky'],[214,162,92,'sky'],[202,136,24,'brown'],[202,110,24,'brown'],
    [140,110,58,'white'],[152,84,46,'white'],[168,58,30,'white'],[230,110,58,'yellow'],[230,84,32,'yellow'],
  ]), details: <><path d="M103 222q20 12 40 0t40 0 40 0 40 0 40 0" fill="none" stroke="#38bdf8" strokeWidth="4" strokeLinecap="round" /><path d="M211 57V37l30 9-30 10" fill="#fb7185" /></> },
  { id: 'dinosaur', name: 'little dinosaur', bricks: bricks([
    [164,188,44,'darkGreen'],[240,188,44,'darkGreen'],[152,162,132,'green'],[126,136,132,'green'],[94,162,54,'darkGreen'],
    [70,136,52,'green'],[230,110,44,'green'],[230,84,44,'green'],[230,58,92,'green'],[286,84,36,'darkGreen'],
  ]), details: <><circle cx="287" cy="67" r="6" fill="#334155" /><path d="m151 132 11-19 11 19m9 0 11-19 11 19m9 0 11-19 11 19" fill="#fbbf24" /><path d="M292 94h25" stroke="#fff" strokeWidth="3" strokeLinecap="round" /></> },
  { id: 'tree', name: 'leafy tree', bricks: bricks([
    [176,188,68,'brown'],[188,162,44,'brown'],[188,136,44,'brown'],[126,110,82,'darkGreen'],[212,110,82,'green'],
    [114,84,94,'green'],[212,84,94,'darkGreen'],[140,58,68,'darkGreen'],[212,58,68,'green'],[176,32,68,'green'],
  ]), details: <><circle cx="154" cy="100" r="7" fill="#fb7185" /><circle cx="252" cy="74" r="7" fill="#fb7185" /><circle cx="234" cy="126" r="7" fill="#fbbf24" /><path d="M202 176v28" stroke="#865b3d" strokeWidth="4" strokeLinecap="round" /></> },
  { id: 'flower', name: 'flower in a pot', bricks: bricks([
    [166,188,88,'brown'],[154,162,112,'red'],[198,136,24,'green'],[154,110,44,'green'],[222,110,44,'green'],
    [198,84,24,'green'],[162,58,44,'pink'],[210,58,44,'red'],[186,32,44,'red'],[186,84,44,'pink'],
  ]), details: <><circle cx="210" cy="74" r="18" fill="#fbbf24" /><circle cx="204" cy="70" r="3" fill="#92400e" /><circle cx="217" cy="70" r="3" fill="#92400e" /><path d="M202 80q8 7 16 0" fill="none" stroke="#92400e" strokeWidth="2" /></> },
  { id: 'train', name: 'toy train', bricks: bricks([
    [104,188,100,'blue'],[208,188,108,'blue'],[104,162,100,'green'],[208,162,108,'green'],[108,136,88,'yellow'],
    [212,136,104,'green'],[108,110,88,'yellow'],[104,84,96,'red'],[270,110,32,'white'],[270,84,32,'white'],
  ]), details: <><path d="M128 118h47v39h-47Z" fill="#e0f2fe" stroke="#fff" strokeWidth="3" />{[132,210,288].map(x => <g key={x}><circle cx={x} cy="207" r="17" fill="#334155" /><circle cx={x} cy="207" r="7" fill="#e2e8f0" /></g>)}<path d="M132 207h156" stroke="#94a3b8" strokeWidth="4" /><circle cx="292" cy="60" r="10" fill="#cbd5e1" /><circle cx="310" cy="43" r="14" fill="#e2e8f0" /></> },
  { id: 'lighthouse', name: 'lighthouse', bricks: bricks([
    [150,188,120,'white'],[162,162,96,'red'],[174,136,72,'white'],[174,110,72,'red'],[174,84,72,'white'],
    [162,58,44,'yellow'],[210,58,44,'yellow'],[150,32,56,'red'],[210,32,56,'red'],[186,12,48,'pink'],
  ]), details: <><path d="M174 70h72" stroke="#fff" strokeWidth="3" /><path d="m158 71-43-18v36Zm102 0 43-18v36Z" fill="#fde68a" opacity=".65" /><path d="M197 212v-24a13 13 0 0 1 26 0v24" fill="#475569" /></> },
];
