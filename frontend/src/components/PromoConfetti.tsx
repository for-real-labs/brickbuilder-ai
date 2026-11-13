import React from 'react';

/** CSS-only burst inside the modal top layer; honors reduced motion. */
export function PromoConfetti() {
  return <div className="promo-confetti" aria-hidden="true">{Array.from({ length: 36 }, (_, index) => <i key={index} style={{
    left: `${(index * 29) % 100}%`, backgroundColor: ['#ef5241', '#f9bd32', '#35a98b', '#698ae8'][index % 4],
    animationDelay: `${(index % 7) * 0.07}s`, '--drift': `${(index % 2 ? 1 : -1) * (20 + index * 3)}px`,
  } as React.CSSProperties} />)}</div>;
}
