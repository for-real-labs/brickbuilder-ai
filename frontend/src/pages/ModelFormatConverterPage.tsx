import React from 'react';
import posthog from 'posthog-js';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ArrowRightLeft, Box, Image, LayoutDashboard, Sparkles } from 'lucide-react';
import { ModelFormatUploadCard } from '../components/ModelFormatUploadCard';
import { ProfileMenu } from '../components/ProfileMenu';
import { SEO } from '../components/SEO';
import { SiteFooter } from '../components/SiteFooter';
import type { ModelFormat } from '../services/modelFormatConversion';

export default function ModelFormatConverterPage({ inputFormat }: { inputFormat: ModelFormat }) {
  const isObj = inputFormat === 'obj';
  const input = inputFormat.toUpperCase();
  const output = isObj ? 'GLB' : 'OBJ';
  const path = `/${inputFormat}-to-${output.toLowerCase()}`;
  const reversePath = `/${output.toLowerCase()}-to-${inputFormat}`;
  const title = `${input} to ${output} Converter — Free Online | BrickBuilder AI`;
  const description = isObj
    ? 'Convert OBJ to GLB online for free. Turn a Wavefront OBJ mesh into a binary glTF 3D file in your browser. No signup or uploads. Download your GLB instantly.'
    : 'Convert GLB to OBJ online for free. Extract a static Wavefront OBJ mesh from a binary glTF 3D model in your browser. No signup or uploads. Download your OBJ.';
  const faqs = [
    { question: `How do I convert ${input} to ${output} online?`,
      answer: `Choose a .${inputFormat} file, click Convert to ${output}, and download the result. The converter runs locally in your browser and accepts files up to 50 MB. No account or software installation is needed.` },
    { question: `Is this ${input} to ${output} converter free?`,
      answer: 'Yes. File format conversion is free and does not require signup. LEGO model generation is a separate tool with its own usage limits.' },
    { question: 'Are my 3D files uploaded to a server?',
      answer: 'No. The converter reads and processes your model on your device. File contents and filenames are not sent to our servers. We record usage events such as conversion success and file size to improve the tool.' },
    { question: isObj ? 'Does OBJ to GLB preserve materials and textures?' : 'Does GLB to OBJ preserve materials and textures?',
      answer: isObj
        ? 'This converter accepts a standalone OBJ mesh. It preserves geometry, normals, UV coordinates, and embedded vertex colors when present. Companion MTL files and texture images are not loaded, so the resulting GLB does not include those external materials or textures.'
        : 'The OBJ download contains mesh geometry, normals, and UV coordinates. It does not include an MTL file, textures, material colors, or vertex colors. Keep the original GLB if you need its appearance, or export OBJ with materials from a full 3D editor.' },
    { question: isObj ? 'What is the difference between OBJ and GLB?' : 'Why convert a GLB model to OBJ?',
      answer: isObj
        ? 'OBJ is a text format for mesh geometry, often paired with separate material and texture files. GLB is the binary form of glTF 2.0 and can bundle a 3D scene and its resources into one file. GLB is useful for web viewers and apps that accept glTF models.'
        : 'OBJ is useful when a modeling, sculpting, or mesh editing tool accepts Wavefront geometry. GLB is designed to carry richer scene data in one binary file. Converting to OBJ gives you a static mesh for compatible editors, while animation and glTF material features remain in the original GLB.' },
    { question: 'Which models can I convert?',
      answer: isObj
        ? 'Use a standalone OBJ file with polygon faces, up to 50 MB and 2 million loaded vertices. Points-only files and invalid geometry are not supported. Large meshes may need simplification before conversion.'
        : 'Use a self-contained, uncompressed GLB 2.0 file with static meshes, up to 50 MB and 2 million loaded vertices. External resources, compressed meshes or textures, skinning, instances, and shape keys need to be embedded, decompressed, or applied in a 3D editor first. Animation tracks are not exported.' },
    { question: 'Can I turn my 3D model into a LEGO design?',
      answer: 'Yes. Open our GLB to LEGO tool to design a brick model from a 3D object. If your source file is OBJ, convert it to GLB first. You can also design LEGO-compatible models from images or text prompts. Use the links on this page to choose your starting point.' },
  ];
  const structuredData = [
    { '@context': 'https://schema.org', '@type': 'WebApplication', name: `${input} to ${output} Converter`,
      url: `https://brickbuilder.ai${path}`, description, applicationCategory: 'DesignApplication', operatingSystem: 'Web Browser',
      browserRequirements: 'Requires a modern browser with JavaScript enabled.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      creator: { '@type': 'Organization', name: 'BrickBuilder AI', url: 'https://brickbuilder.ai' },
      featureList: [`${input} to ${output} mesh conversion`, 'Local browser processing', 'No signup required', '3D file download'] },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(faq => ({
      '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'BrickBuilder AI', item: 'https://brickbuilder.ai/' },
      { '@type': 'ListItem', position: 2, name: `${input} to ${output} Converter`, item: `https://brickbuilder.ai${path}` },
    ] },
  ];
  const trackLink = (destination: string) => posthog.capture('model_format_converter_link_clicked', { page: path, destination });
  const designLinks = [
    { to: '/glb-to-lego', icon: Box, title: 'Start with a 3D object', body: 'Turn your GLB mesh into a LEGO-compatible brick model.' },
    { to: '/image-to-lego', icon: Image, title: 'Start with an image', body: 'Use a photo, sketch, or picture as your starting point.' },
    { to: '/?mode=all_parts', icon: Sparkles, title: 'Start with a text prompt', body: 'Describe your idea and let AI design it in bricks.' },
  ];

  return <div className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-white text-slate-900">
    <SEO title={title} description={description} keywords={`${inputFormat} to ${output.toLowerCase()}, ${inputFormat} to ${output.toLowerCase()} converter, convert ${inputFormat} to ${output.toLowerCase()}, free online 3d file converter`}
      url={`https://brickbuilder.ai${path}`} structuredData={structuredData} />
    <div className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col px-4 pb-10 pt-6 sm:px-6 md:px-8 lg:px-10">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" onClick={() => trackLink('/')} className="flex items-center gap-2"><img src="/brickbuilder-logo.PNG" alt="BrickBuilder" className="h-8 w-auto object-contain" /><span className="hidden text-sm font-semibold sm:inline">BrickBuilder</span></Link>
        <nav className="flex items-center gap-2">
          <Link to="/dashboard" onClick={() => trackLink('/dashboard')} aria-label="Dashboard" title="Dashboard" className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"><LayoutDashboard className="h-5 w-5" /></Link>
          <ProfileMenu />
        </nav>
      </header>
      <main className="flex flex-1 flex-col items-center py-10 text-center sm:py-16">
        <div className="w-full max-w-3xl">
          <Link to="/" onClick={() => trackLink('/')} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#f44336]"><ArrowLeft className="h-4 w-4" />Back</Link>
          <div className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#f44336]"><ArrowRightLeft className="h-4 w-4" />One model, another format</div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">{input} to {output} Converter</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">{isObj
            ? 'Turn your Wavefront OBJ mesh into a GLB 3D file, ready for compatible web viewers and apps. Convert for free, right in your browser.'
            : 'Turn your GLB 3D model into a Wavefront OBJ mesh for compatible modeling and mesh editing tools. Convert for free, right in your browser.'}</p>
          <div className="flex justify-center"><ModelFormatUploadCard key={inputFormat} inputFormat={inputFormat} /></div>
          <p className="mt-4 text-sm text-slate-500">Need the reverse? <Link to={reversePath} onClick={() => trackLink(reversePath)} className="font-medium text-[#f44336] underline">Convert {output} to {input}</Link></p>

          <section aria-labelledby="lego-design-heading" className="mt-10 rounded-2xl border border-red-100 bg-gradient-to-br from-red-50 to-white p-5 text-left sm:p-7">
            <span className="text-xs font-semibold uppercase tracking-widest text-[#f44336]">Take your idea further</span>
            <h2 id="lego-design-heading" className="mt-2 text-2xl font-bold">Try designing LEGO models with AI</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">Start with a 3D object, an image, or a text prompt. BrickBuilder AI turns your ideas into LEGO-compatible designs you can preview and edit.</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">{designLinks.map(({ to, icon: Icon, title: label, body }) =>
              <Link key={to} to={to} onClick={() => trackLink(to)} className="group rounded-xl border border-red-100 bg-white p-4 transition-colors hover:border-red-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500">
                <Icon className="h-5 w-5 text-[#f44336]" /><h3 className="mt-3 text-sm font-semibold">{label}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#f44336]">Try it <ArrowRight className="h-4 w-4" /></span>
              </Link>)}</div>
            <p className="mt-4 text-sm text-slate-600">Ready to build in bricks? Try <Link to="/glb-to-lego" onClick={() => trackLink('/glb-to-lego')} className="font-medium text-[#f44336] underline">GLB to LEGO</Link> with your 3D model.</p>
          </section>

          <section className="mt-12 text-left">
            <h2 className="text-2xl font-bold">{isObj ? 'Convert Wavefront OBJ to binary glTF' : 'Convert binary glTF to Wavefront OBJ'}</h2>
            <div className="mt-4 space-y-4 text-sm leading-7 text-slate-600 sm:text-base">
              <p>{isObj
                ? 'OBJ is widely used for polygon meshes from modeling, CAD, and sculpting tools. If an app expects a .glb file, this converter packages your mesh into the binary glTF 2.0 format. Choose your standalone OBJ, convert it, and download a single GLB file.'
                : 'GLB bundles a glTF 2.0 scene into a binary file. If your mesh editing workflow expects .obj geometry, this converter extracts the static meshes from the default scene and writes their positions, normals, and UV coordinates into a Wavefront OBJ file. Object transforms are applied to the exported geometry.'}</p>
              <p>{isObj
                ? 'The conversion keeps mesh geometry and embedded vertex colors when available. It does not load companion MTL files or texture images. For textured assets, use a 3D editor to import the OBJ together with its materials and then export GLB.'
                : 'OBJ has fewer scene features than GLB. This tool exports geometry without a companion MTL file, textures, colors, or animation tracks. For rigged or instanced assets, apply them to a static mesh in a 3D editor before converting. Keep your original GLB as the complete source asset.'}</p>
              <p>Changing the file format does not generate LEGO bricks. To build from a GLB model, open the dedicated <Link to="/glb-to-lego" onClick={() => trackLink('/glb-to-lego')} className="font-medium text-[#f44336] underline">GLB to LEGO converter</Link>.</p>
            </div>
          </section>
          <section aria-label="Conversion steps" className="mt-10 grid gap-4 text-left sm:grid-cols-3">
            {[[`Choose your ${input}`, `Select a .${inputFormat} file up to 50 MB.`], [`Convert to ${output}`, 'Process the mesh locally in your browser.'], [`Download your ${output}`, 'Save the result and import it into a compatible app.']].map(([label, body]) =>
              <article key={label} className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold">{label}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p></article>)}
          </section>
          <section className="mt-12 text-left"><h2 className="text-2xl font-bold">{input} to {output} FAQ</h2>
            <div className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
              {faqs.map(faq => <article key={faq.question} className="p-5"><h3 className="text-base font-semibold">{faq.question}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{faq.answer}</p></article>)}
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  </div>;
}
