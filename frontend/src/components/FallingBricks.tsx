import React, { useEffect, useRef } from "react";

type Brick = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;   // width in px
  h: number;   // height in px
  rot: number; // radians
  omega: number; // angular velocity
  color: string;
  studsX: number; // studs across
  studsY: number; // studs along
};

const COLORS = [
  "#D32F2F", // red
  "#1976D2", // blue
  "#FBC02D", // yellow
  "#2E7D32", // green
  "#6A1B9A", // purple
  "#FF6F00", // orange
  "#455A64", // dark gray
];

// Brick sizes in studs (x by y)
const BRICK_SIZES: Array<[number, number]> = [
  [2, 2],
  [2, 3],
  [2, 4],
  [3, 3],
  [4, 2],
];

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function pick<T>(arr: T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

function drawBrick(ctx: CanvasRenderingContext2D, b: Brick) {
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);

  // brick body
  const r = Math.min(b.w, b.h) * 0.12; // corner radius
  const bw = b.w;
  const bh = b.h;

  // body shadow
  ctx.fillStyle = "rgba(0,0,0,0.05)";
  roundRect(ctx, -bw / 2 + 3, -bh / 2 + 5, bw, bh, r);
  ctx.fill();

  // body
  ctx.fillStyle = b.color;
  roundRect(ctx, -bw / 2, -bh / 2, bw, bh, r);
  ctx.fill();

  // top studs (simple circles)
  const studR = Math.min(bw / (b.studsX * 3.2), bh / (b.studsY * 3.2));
  const padX = bw / (b.studsX + 1);
  const padY = bh / (b.studsY + 1);
  for (let iy = 1; iy <= b.studsY; iy++) {
    for (let ix = 1; ix <= b.studsX; ix++) {
      const sx = -bw / 2 + padX * ix;
      const sy = -bh / 2 + padY * iy;
      // stud shading
      ctx.beginPath();
      ctx.arc(sx + 1, sy + 1, studR, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(sx, sy, studR, 0, Math.PI * 2);
      // slightly lighter than body for perceived top light
      ctx.fillStyle = lighten(b.color, 0.08);
      ctx.fill();
    }
  }

  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function lighten(hex: string, amt: number): string {
  const c = parseInt(hex.slice(1), 16);
  let r = (c >> 16) & 255;
  let g = (c >> 8) & 255;
  let b = c & 255;
  r = Math.min(255, Math.round(r + (255 - r) * amt));
  g = Math.min(255, Math.round(g + (255 - g) * amt));
  b = Math.min(255, Math.round(b + (255 - b) * amt));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export default function FallingBricks({
  density = 22,
  zIndex = 0,
  opacity = 0.25,
}: {
  density?: number;   // number of bricks (desktop baseline)
  zIndex?: number;    // stacking context
  opacity?: number;   // canvas global alpha
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const bricksRef = useRef<Brick[]>([]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d", { alpha: true })!;
    let dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    let width = 0;
    let height = 0;
    let running = true;

    const isMobile = () => window.matchMedia("(max-width: 640px)").matches;
    const targetCount = () => Math.max(8, Math.round((isMobile() ? density * 0.6 : density)));

    function resize() {
      const rect = canvas.getBoundingClientRect();
      width = Math.floor(rect.width * dpr);
      height = Math.floor(rect.height * dpr);
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      seedBricks();
    }

    function makeBrick(): Brick {
      const size = pick(BRICK_SIZES);
      const studsX = size[0];
      const studsY = size[1];
      const pxPerStud = rand(12, 20); // scale bricks
      const w = studsX * pxPerStud + rand(2, 4);
      const h = studsY * pxPerStud + rand(2, 4);
      const x = rand(-w, canvas.clientWidth + w);
      const y = rand(-canvas.clientHeight, -h * 2);
      const vy = rand(30, 70); // px/s
      const vx = rand(-10, 10); // slight drift
      const rot = rand(0, Math.PI * 2);
      const omega = rand(-0.6, 0.6); // rad/s
      const color = pick(COLORS);
      return { x, y, vx, vy, w, h, rot, omega, color, studsX, studsY };
    }

    function seedBricks() {
      const want = targetCount();
      const arr = bricksRef.current;
      if (arr.length > want) {
        arr.length = want;
      } else {
        while (arr.length < want) {
          const brick = makeBrick();
          // Start throughout the viewport, with one random position per vertical
          // band so the background is populated from its very first frame.
          brick.x = rand(0, canvas.clientWidth);
          brick.y = ((arr.length + Math.random()) / want) * canvas.clientHeight;
          arr.push(brick);
        }
      }
    }

    function step(prevTs: number) {
      if (!running) return;
      const now = performance.now();
      const dt = Math.min(50, now - prevTs) / 1000; // clamp dt

      // clear
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

      // draw/update
      for (let i = 0; i < bricksRef.current.length; i++) {
        const b = bricksRef.current[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.rot += b.omega * dt;

        // recycle when below
        if (b.y - b.h > canvas.clientHeight + 40) {
          bricksRef.current[i] = makeBrick();
          bricksRef.current[i].y = -bricksRef.current[i].h - rand(0, 100);
        }

        drawBrick(ctx, b);
      }

      rafRef.current = requestAnimationFrame(() => step(now));
    }

    function onVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(rafRef.current);
      } else {
        running = true;
        rafRef.current = requestAnimationFrame(() => step(performance.now()));
      }
    }

    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    rafRef.current = requestAnimationFrame(() => step(performance.now()));

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [density]);

  return (
    <div
      className="pointer-events-none absolute inset-0 -z-10"
      style={{ zIndex, opacity }}
    >
      <canvas ref={ref} className="h-full w-full" />
    </div>
  );
}
