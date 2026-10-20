import React from 'react';
import { Helmet } from 'react-helmet-async';

interface SEOProps {
  title?: string;
  description?: string;
  keywords?: string;
  image?: string;
  url?: string;
  type?: string;
  noIndex?: boolean;
  structuredData?: Record<string, unknown> | Record<string, unknown>[];
}

export function SEO({
  title = "BrickBuilder AI",
  description = "Turn images and text into LEGO compatible brick models. Get building instructions instantly!",
  keywords = "use ai to build legos, image to lego, how to convert image to legos, lego ai, brick ai, brickai, brickbuilder, brickbuilder.ai, lego building ai, ai building lego, turn images into lego, AI lego converter, brick model generator, turn images into actual legos, lego building software, lego generator, lego instruction generator, lego ai agent",
  image = "https://brickbuilder.ai/share-card.png",
  url = "https://brickbuilder.ai/",
  type = "website",
  noIndex = false,
  structuredData
}: SEOProps) {
  const defaultStructuredData = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    "name": "BrickBuilder AI",
    "alternateName": ["Image to LEGO Brick Converter", "LEGO AI", "Brick AI", "BrickAI", "AI LEGO Builder", "Turn Images Into LEGO"],
    "description": description,
    "url": url,
    "applicationCategory": "DesignApplication",
    "operatingSystem": "Web Browser",
    "offers": {
      "@type": "Offer",
      "price": "0",
      "priceCurrency": "USD",
      "availability": "https://schema.org/InStock"
    },
    "creator": {
      "@type": "Organization",
      "name": "BrickBuilder AI",
      "url": "https://brickbuilder.ai"
    },
    "featureList": [
        "AI-powered LEGO brick conversion",
        "Turn images into actual LEGO models",
        "Brick AI building assistant",
        "3D LEGO model visualization",
        "Building instructions generation",
        "LDR file download",
        "Real-time AI processing"
      ],
    "screenshot": image,
    "softwareVersion": "Beta 1.0",
    "datePublished": "2025-10-06",
    "inLanguage": "en-US"
  };

  return (
    <Helmet defer={false}>
      <title>{title}</title>
      <meta name="title" content={title} />
      <meta name="description" content={description} />
      <meta name="keywords" content={keywords} />
      <meta name="robots" content={noIndex ? 'noindex, nofollow' : 'index, follow'} />
      <meta property="og:type" content={type} />
      <meta property="og:url" content={url} />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:image" content={image} />
      <meta property="og:site_name" content="BrickBuilder AI" />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:url" content={url} />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={image} />
      <link rel="canonical" href={url} />
      {/* Escape HTML delimiters so public article text cannot close the script. */}
      <script type="application/ld+json">
        {JSON.stringify(structuredData ?? defaultStructuredData, null, 2).replace(/</g, '\\u003c')}
      </script>
    </Helmet>
  );
}
