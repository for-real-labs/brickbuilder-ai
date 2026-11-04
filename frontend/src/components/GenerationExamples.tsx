import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import posthog from 'posthog-js';
import './GenerationExamples.css';

const examples = [
  { name: 'Santa’s Workshop', id: '3164643e-974e-452a-8819-a1cc7788a628', asset: 'workshop', pieces: '1,581', dimensions: '51.2 × 38.4 × 32.6 cm', price: '$266.30' },
  { name: 'Lighthouse', id: '4e5a6629-bdd4-46d0-97cc-d7271691e60c', asset: 'lighthouse', pieces: '777', dimensions: '38.4 × 32 × 32.8 cm', price: '$214.68' },
  { name: 'Tiger', id: '126a7995-3bfe-4744-8008-c9eb39d386f5', asset: 'tiger', pieces: '1,989', dimensions: '20 × 48 × 14.4 cm', price: '$188.03' },
];

function ModelLoop({ asset, reducedMotion }: { asset: string; reducedMotion: boolean }) {
  const [failed, setFailed] = useState(false);
  const poster = `/examples/${asset}.jpg`;
  return <div className="generation-example-preview" aria-hidden="true">
    <img className="generation-example-poster" src={poster} alt="" loading="lazy" width="640" height="640" />
    {!reducedMotion && !failed && <video src={`/examples/${asset}.mp4`} poster={poster} autoPlay muted loop playsInline
      preload="metadata" disablePictureInPicture onError={() => setFailed(true)} />}
    <img className="generation-example-pet" src="/pets/pip.webp" alt="" width="64" height="64" loading="lazy" />
  </div>;
}

export function GenerationExamples({ onView }: { onView: () => void }) {
  const [reducedMotion, setReducedMotion] = useState(true);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media?.matches ?? false);
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, []);
  return <section className="generation-examples" aria-labelledby="generation-examples-title">
    <h2 id="generation-examples-title">See what you can build</h2>
    <ul>
      {examples.map(({ name, id, asset, pieces, dimensions, price }) => <li key={id}>
        <Link to={`/?id=${id}`} className="generation-example-card" aria-label={`View model: ${name}`} onClick={() => {
          posthog.capture('generation_subscription_example_clicked', { generation_id: id });
          onView();
        }}>
          <ModelLoop asset={asset} reducedMotion={reducedMotion} />
          <div className="generation-example-details">
            <h3>{name}</h3>
            <p>{pieces} pieces</p>
            <p>{dimensions}</p>
            <p className="generation-example-price">{price} <span>before shipping</span></p>
            <span className="generation-example-view">View model</span>
          </div>
        </Link>
      </li>)}
    </ul>
    <p className="generation-examples-note">Approximate dimensions (W × D × H). Estimated USD kit prices before shipping, tax, and member discounts.</p>
  </section>;
}
