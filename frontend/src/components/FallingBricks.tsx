import React, { useEffect, useRef } from "react";

type FallingItem = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;   // width in px
  h: number;   // height in px
  rot: number; // radians
  omega: number; // angular velocity
  symbol: typeof HALLOWEEN_SYMBOLS[number];
};

export const HALLOWEEN_SYMBOLS = ['🎃', '💀', '🌙', '👻', '🦇', '🦴'] as const;

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function pick<T>(arr: readonly T[]): T {
  return arr[(Math.random() * arr.length) | 0];
}

function drawHalloweenItem(ctx: CanvasRenderingContext2D, item: FallingItem) {
  ctx.save();
  ctx.translate(item.x, item.y);
  ctx.rotate(item.rot);
  ctx.font = `${item.h}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(item.symbol, 0, 0);
  ctx.restore();
}

export default function FallingBricks({
  density = 22,
  zIndex = 0,
  opacity = 0.25,
}: {
  density?: number;   // number of Halloween items (desktop baseline)
  zIndex?: number;    // stacking context
  opacity?: number;   // canvas global alpha
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const bricksRef = useRef<FallingItem[]>([]);

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

    function makeBrick(): FallingItem {
      const w = rand(32, 58);
      const h = w;
      const x = rand(-w, canvas.clientWidth + w);
      const y = rand(-canvas.clientHeight, -h * 2);
      const vy = rand(30, 70); // px/s
      const vx = rand(-10, 10); // slight drift
      const rot = rand(0, Math.PI * 2);
      const omega = rand(-0.6, 0.6); // rad/s
      const symbol = pick(HALLOWEEN_SYMBOLS);
      return { x, y, vx, vy, w, h, rot, omega, symbol };
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

        drawHalloweenItem(ctx, b);
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
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10"
      style={{ zIndex, opacity }}
    >
      <canvas ref={ref} className="h-full w-full" />
    </div>
  );
}
