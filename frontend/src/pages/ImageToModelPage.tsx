import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Box, LayoutDashboard } from 'lucide-react';
import posthog from 'posthog-js';
import { ProfileMenu } from '../components/ProfileMenu';
import { SEO } from '../components/SEO';
import { SiteFooter } from '../components/SiteFooter';
import { LegoDesignCallout } from '../components/LegoDesignCallout';
import { ImageModelUploadCard } from '../components/ImageModelUploadCard';
import { IMAGE_MODEL_PAGES, imageModelFaqs, type ImageModelOutput } from '../imageModelPages';

export default function ImageToModelPage({ output }: { output: ImageModelOutput }) {
  const page = IMAGE_MODEL_PAGES.find(page => page.output === output)!;
  const faqs = imageModelFaqs(output);
  const url = `https://brickbuilder.ai${page.path}`;
  const structuredData = [
    { '@context': 'https://schema.org', '@type': 'WebApplication', name: page.name, url,
      description: page.description, applicationCategory: 'DesignApplication', operatingSystem: 'Web Browser',
      creator: { '@type': 'Organization', name: 'BrickBuilder AI', url: 'https://brickbuilder.ai/' },
      featureList: ['AI 3D model generation from an image', 'Interactive 3D preview', 'GLB download', 'Wavefront OBJ geometry export'] },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(faq => ({
      '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'BrickBuilder AI', item: 'https://brickbuilder.ai/' },
      { '@type': 'ListItem', position: 2, name: page.name, item: url },
    ] },
  ];
  const trackLink = (destination: string) => posthog.capture('image_model_converter_link_clicked', { page: page.path, destination });
  return <div className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-white text-slate-900">
    <SEO title={page.title} description={page.description} url={url} structuredData={structuredData}
      keywords={`image to ${output}, image to ${output} converter, photo to ${output}, AI 3D model generator, image to 3d model, GLB download, OBJ mesh`} />
    <div className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col px-4 pb-10 pt-6 sm:px-6 md:px-8 lg:px-10">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" onClick={() => trackLink('/')} className="flex items-center gap-2"><img src="/brickbuilder-logo.PNG" alt="BrickBuilder" className="h-8 w-auto object-contain" /><span className="hidden text-sm font-semibold sm:inline">BrickBuilder</span></Link>
        <nav aria-label="Account" className="flex items-center gap-2">
          <Link to="/dashboard" aria-label="Dashboard" title="Dashboard" onClick={() => trackLink('/dashboard')} className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"><LayoutDashboard className="h-5 w-5" /></Link>
          <ProfileMenu />
        </nav>
      </header>
      <main className="flex flex-1 flex-col items-center py-10 text-center sm:py-16">
        <div className="w-full max-w-3xl">
          <Link to="/" onClick={() => trackLink('/')} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#f44336]"><ArrowLeft className="h-4 w-4" />Back</Link>
          <div className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#f44336]"><Box className="h-4 w-4" />Your image, in three dimensions</div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">{page.name}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">{page.intro}</p>
          <div className="flex justify-center"><ImageModelUploadCard output={output} /></div>
          <LegoDesignCallout page={page.path} />
          <section className="mt-12 text-left">
            <h2 className="text-2xl font-bold">{page.heading}</h2>
            <div className="mt-4 space-y-4 text-sm leading-7 text-slate-600 sm:text-base"><p>{page.body}</p><p>{page.use}</p></div>
          </section>
          <section aria-label="How image conversion works" className="mt-10 grid gap-4 text-left sm:grid-cols-3">
            {[
              ['Upload an image', 'Choose a clear photo or illustration of one object. Simple backgrounds help make the subject easy to identify.'],
              ['Generate and preview', 'AI estimates the shape and appearance. Inspect the result in the interactive 3D viewer.'],
              ['Download your model', output === 'obj' ? 'Export OBJ geometry for editing, or download the original GLB with its generated appearance.' : 'Download the generated GLB, or export its geometry as OBJ without another AI generation.'],
            ].map(([title, body]) => <article key={title} className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p></article>)}
          </section>
          <section className="mt-12 text-left"><h2 className="text-2xl font-bold">{page.name.replace('Converter', 'FAQ')}</h2>
            <div className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {faqs.map(faq => <article key={faq.question} className="p-5"><h3 className="text-base font-semibold">{faq.question}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{faq.answer}</p></article>)}
            </div>
          </section>
          <nav aria-label="Related image converters" className="mt-10 flex flex-wrap justify-center gap-x-5 gap-y-3 text-sm">
            {IMAGE_MODEL_PAGES.filter(other => other.path !== page.path).map(other => <Link key={other.path} to={other.path} onClick={() => trackLink(other.path)} className="font-semibold text-[#c42d23] underline">{other.name}</Link>)}
          </nav>
        </div>
      </main>
      <SiteFooter />
    </div>
  </div>;
}
