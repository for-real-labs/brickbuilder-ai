import posthog from 'posthog-js';
import { Link } from 'react-router-dom';
import { ArrowLeft, Box, LayoutDashboard } from 'lucide-react';
import { GlbUploadCard } from '../components/GlbUploadCard';
import { ProfileMenu } from '../components/ProfileMenu';
import { SEO } from '../components/SEO';
import { SiteFooter } from '../components/SiteFooter';
import type { MeshFormat } from '../services/glbToBricksApi';

export default function ModelToLegoPage({ format }: { format: MeshFormat }) {
  const label = format.toUpperCase();
  const path = `/${format}-to-lego`;
  const otherFormat = format === 'glb' ? 'obj' : 'glb';
  const description = format === 'obj'
    ? 'Convert an OBJ 3D model into a LEGO-compatible brick model. Choose resizable voxel builds or all LEGO parts, then preview your model, parts list, and building files.'
    : 'Convert a GLB 3D model into a LEGO-compatible brick model with preview, building files, and a parts list. Choose voxel mode or all LEGO parts.';
  const faqs = [
    { question: `Can I convert ${format === 'obj' ? 'an' : 'a'} ${label} file to a LEGO-compatible model?`,
      answer: `Yes. Upload a .${format} file, preview it in your browser, and choose voxel mode or all LEGO parts. Voxel mode converts the mesh into a brick model; all-parts mode uses that voxelized model as the starting point for the AI builder.` },
    { question: 'What is the difference between voxel mode and all LEGO parts?',
      answer: 'Voxel mode preserves a blocky, pixel-like look and lets you adjust the model size. All LEGO parts uses the same full-parts AI builder as our homepage, with slopes, curves, plates, and other available pieces. You can start from an image or an uploaded 3D model.' },
    { question: 'Can I resize my voxel model?',
      answer: 'Yes. Set the size before converting, then use the Resize Model slider on the generated model page to make the same design smaller or larger. Size changes affect detail and the number of bricks.' },
    { question: format === 'obj' ? 'Do OBJ uploads need an MTL file or textures?' : 'Can I upload an OBJ file too?',
      answer: format === 'obj'
        ? 'Upload a standalone OBJ file up to 50 MB. Geometry and embedded vertex colors are supported. External MTL files and texture images are not included; use a GLB export when you want materials and textures bundled with your mesh.'
        : 'Yes. Use our dedicated OBJ to LEGO converter for standalone .obj files. GLB bundles geometry, materials, and textures in one file, which is useful for preserving colors.' },
    { question: 'Do I get instructions and a parts list?',
      answer: 'The generated model page provides a 3D preview, building files, and a parts list. Review the design and connections before building. All-parts instructions depend on the model passing the builder’s connection and assembly checks.' },
  ];
  const structuredData = [
    { '@context': 'https://schema.org', '@type': 'WebApplication',
      name: `${label} to LEGO Converter`, url: `https://brickbuilder.ai${path}`,
      description, applicationCategory: 'DesignApplication', operatingSystem: 'Web Browser',
      creator: { '@type': 'Organization', name: 'BrickBuilder AI', url: 'https://brickbuilder.ai' },
      featureList: [`${label} to LEGO-compatible brick model conversion`, 'Resizable voxel models',
        'All LEGO parts from image or 3D model', '3D model preview', 'Parts list', 'LDraw building files'] },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(faq => ({
      '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer },
    })) },
  ];
  const trackLink = (destination: string) => posthog.capture('model_converter_link_clicked', { page: path, destination });
  return <div className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-white text-slate-900">
    <SEO title={`${label} to LEGO Converter | 3D Model to LEGO | BrickBuilder AI`}
      description={description} keywords={`${format} to lego, ${format} to lego converter, 3d model to lego, 3d to lego, convert ${format} to bricks, lego model converter`}
      url={`https://brickbuilder.ai${path}`} structuredData={structuredData} />
    <div className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col px-4 pb-10 pt-6 sm:px-6 md:px-8 lg:px-10">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2"><img src="/brickbuilder-logo.PNG" alt="BrickBuilder" className="h-8 w-auto object-contain" /><span className="hidden text-sm font-semibold sm:inline">BrickBuilder</span></Link>
        <nav className="flex items-center gap-2">
          <Link to="/dashboard" aria-label="Dashboard" title="Dashboard" className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"><LayoutDashboard className="h-5 w-5" /></Link>
          <ProfileMenu />
        </nav>
      </header>
      <main className="flex flex-1 flex-col items-center py-10 text-center sm:py-16">
        <div className="w-full max-w-3xl">
          <Link to="/" className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#f44336]"><ArrowLeft className="h-4 w-4" />Back</Link>
          <div className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#f44336]"><Box className="h-4 w-4" />Your model, built in bricks</div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">{label} to LEGO Converter</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
            {format === 'obj'
              ? 'Turn your Wavefront OBJ mesh into a LEGO-compatible build. Keep its shape in adjustable voxels, or let AI redesign it with the full LEGO parts catalog.'
              : 'Turn your GLB 3D model into a LEGO-compatible build. Choose adjustable voxels or an AI redesign with the full LEGO parts catalog.'}
          </p>
          <div className="flex justify-center"><GlbUploadCard format={format} /></div>
          <section className="mt-12 text-left">
            <h2 className="text-2xl font-bold">Convert {label} 3D Models Into Bricks</h2>
            <div className="mt-4 space-y-4 text-sm leading-7 text-slate-600 sm:text-base">
              <p>{format === 'obj'
                ? 'OBJ is a widely supported format for polygon meshes from modeling, CAD, and sculpting tools. Upload your standalone .obj file directly, inspect the shape in 3D, and choose how to turn it into a brick model—no manual GLB conversion needed.'
                : 'GLB packages a 3D mesh and its materials into a single file. Upload your .glb model, inspect it in the browser, and convert its shape and colors into a brick design.'}</p>
              <p>Voxel mode maps your mesh to a colored grid and optimizes it into bricks. The size slider lets you balance detail and brick count. All LEGO parts starts with that voxelized reference and asks the full-parts builder to reinterpret it using a wider range of pieces. You can also choose an image as your starting point.</p>
              <p>Have a {otherFormat.toUpperCase()} file instead? Use the <Link to={`/${otherFormat}-to-lego`} onClick={() => trackLink(`/${otherFormat}-to-lego`)} className="font-medium text-[#f44336] underline">{otherFormat.toUpperCase()} to LEGO converter</Link>. Starting from a photo? Try <Link to="/image-to-lego" onClick={() => trackLink('/image-to-lego')} className="font-medium text-[#f44336] underline">image to LEGO</Link>.</p>
            </div>
          </section>
          <section className="mt-10 grid gap-4 text-left sm:grid-cols-3">
            {[[`Upload ${label}`, `Choose a .${format} model and inspect it in 3D.`], ['Choose your style', 'Keep resizable voxels or redesign with all LEGO parts.'], ['Build or edit', 'Review the brick model, download building files, and explore the parts list.']].map(([title, body]) =>
              <article key={title} className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p></article>)}
          </section>
          <section className="mt-12 text-left"><h2 className="text-2xl font-bold">{label} to LEGO FAQ</h2>
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
