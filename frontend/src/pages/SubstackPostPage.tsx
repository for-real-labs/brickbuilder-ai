import React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import posthog from 'posthog-js';
import { ArrowLeft } from 'lucide-react';
import { SEO } from '../components/SEO';
import { SiteFooter } from '../components/SiteFooter';
import { findSubstackPost } from '../utils/blog-posts';
import './substack-post.css';

export default function SubstackPostPage() {
  const { slug } = useParams();
  const post = findSubstackPost(slug);
  if (!post) return <Navigate to="/blog" replace />;
  const url = `https://brickbuilder.ai/blog/${post.slug}`;
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <SEO title={`${post.title} | BrickBuilder AI`} description={post.description} url={url} type="article" structuredData={{
        '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title,
        description: post.description, datePublished: post.publishedAt, mainEntityOfPage: url,
        author: { '@type': 'Person', name: post.author || 'AI and LEGO' },
        publisher: { '@type': 'Organization', name: 'BrickBuilder AI' },
      }} />
      <div className="mx-auto max-w-screen-xl px-4 pb-10 pt-6 sm:px-6 md:px-8 lg:px-10">
        <header><Link to="/" className="inline-flex items-center gap-2 font-semibold"><img src="/brickbuilder-logo.PNG" alt="BrickBuilder" className="h-8 w-auto" />BrickBuilder</Link></header>
        <main className="mx-auto max-w-3xl py-10 sm:py-14">
          <Link to="/blog" onClick={() => posthog.capture('blog_navigation_clicked', { destination: 'index' })} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-[#f44336]"><ArrowLeft className="h-4 w-4" />Blog</Link>
          <article>
            <p className="mt-8 text-sm font-semibold uppercase tracking-[0.18em] text-[#f44336]">AI and LEGO</p>
            <h1 className="mt-3 text-4xl font-extrabold leading-tight sm:text-5xl">{post.title}</h1>
            <p className="mt-5 text-lg leading-8 text-slate-600">{post.description}</p>
            <p className="mt-5 text-sm text-slate-500">{post.author}{post.publishedAt && <> · <time dateTime={post.publishedAt}>{new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(post.publishedAt))}</time></>}</p>
            {/* Only sanitized, checked-in public HTML from the feed importer reaches this boundary. */}
            <div className="substack-article mt-9 text-base leading-8 text-slate-700" dangerouslySetInnerHTML={{ __html: post.content }} />
            <p className="mt-10 text-sm text-slate-500">Originally published on <a href={post.sourceUrl} onClick={() => posthog.capture('blog_original_source_clicked', { source: 'substack' })} className="text-[#f44336] underline" rel="noopener noreferrer">AI and LEGO on Substack</a>.</p>
          </article>
        </main>
        <SiteFooter />
      </div>
    </div>
  );
}
