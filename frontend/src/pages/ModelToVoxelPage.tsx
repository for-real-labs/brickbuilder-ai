import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Box, LayoutDashboard } from 'lucide-react';
import posthog from 'posthog-js';
import { ProfileMenu } from '../components/ProfileMenu';
import { SEO } from '../components/SEO';
import { SiteFooter } from '../components/SiteFooter';
import { LegoDesignCallout } from '../components/LegoDesignCallout';
import { VoxelUploadCard } from '../components/VoxelUploadCard';
import { VOXEL_CONVERTERS, VOXEL_FORMATS, type VoxelFormat } from '../voxelConverters';
import type { MeshFormat } from '../voxelConverters';

export default function ModelToVoxelPage({ input, output }: { input: MeshFormat; output: VoxelFormat }) {
  const format = VOXEL_FORMATS[output];
  const label = input.toUpperCase();
  const path = `/${input}-to-${output}`;
  const name = `${label} to ${format.name} Converter`;
  const description = `Convert ${label} to ${format.name} online. Upload a .${input} mesh, adjust voxel resolution, and download ${output === 'binvox' ? 'an occupancy grid' : 'colored voxels'} as a .${output} file.`;
  const sourceDescription = input === 'obj'
    ? 'Wavefront OBJ stores polygon mesh geometry and may contain vertex colors. This converter accepts standalone OBJ files. External MTL files and textures are not loaded; export a self-contained GLB when you need textured colors.'
    : 'GLB packages a glTF 3D scene into a single binary file. Use a GLB 2 model with embedded buffers and textures. Scene transforms are applied and mesh surfaces are sampled into voxels; external resources are not loaded.';
  const faqs = [
    { question: `How do I convert ${label} to ${format.name}?`, answer: `Upload a .${input} mesh up to 50 MB, set a voxel resolution from 8 to 64, and select Convert to ${format.name}. When processing finishes, download the .${output} file. Conversion runs on the backend without a separate desktop converter.` },
    { question: `What is a ${format.name} file used for?`, answer: format.use },
    { question: 'Will colors and textures be preserved?', answer: output === 'binvox'
      ? 'No. BINVOX version 1 records occupied and empty cells without RGB colors. Use VOX, QB, or XYZRGB for sampled colors.'
      : `The converter samples available vertex colors and embedded GLB textures. ${output === 'vox' ? 'VOX reduces these samples to a palette of up to 255 colors.' : 'QB and XYZRGB retain sampled RGB values.'} Standalone OBJ uploads do not include external MTL files or texture images. Transparency is not preserved.` },
    { question: 'Does the converter create solid or surface voxels?', answer: 'It voxelizes mesh surfaces rather than filling the interior. The output uses a Z-up voxel grid and does not retain the source model’s units, rigging, animation, or object hierarchy. Fine details depend on your resolution.' },
    { question: 'What model limits apply?', answer: 'Upload a nonempty file up to 50 MB with no more than 250,000 mesh faces, 500,000 vertices, and 256 scene instances. Very complex models may reach the 90-second conversion limit. Simplify the mesh or lower the resolution if conversion fails.' },
    { question: 'Can I turn the same 3D object into a LEGO design?', answer: 'Yes. Try the GLB to LEGO converter to create a LEGO-compatible model from a 3D object. Export an OBJ as a self-contained GLB first. You can also start a brick design from an image or a text prompt using BrickBuilder AI.' },
  ];
  const structuredData = [
    { '@context': 'https://schema.org', '@type': 'WebApplication', name,
      url: `https://brickbuilder.ai${path}`, description, applicationCategory: 'DesignApplication', operatingSystem: 'Web Browser',
      featureList: [`${label} mesh upload`, `${format.fullName} download`, 'Adjustable voxel resolution', format.colors],
      creator: { '@type': 'Organization', name: 'BrickBuilder AI', url: 'https://brickbuilder.ai' } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map(faq => ({ '@type': 'Question', name: faq.question, acceptedAnswer: { '@type': 'Answer', text: faq.answer } })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'BrickBuilder AI', item: 'https://brickbuilder.ai/' },
      { '@type': 'ListItem', position: 2, name, item: `https://brickbuilder.ai${path}` },
    ] },
  ];
  const trackLink = (destination: string) => posthog.capture('voxel_converter_link_clicked', { page: path, destination });
  return <div className="min-h-screen bg-gradient-to-b from-white via-slate-50 to-white text-slate-900">
    <SEO title={`${name} | ${format.fullName} Download | BrickBuilder AI`} description={description}
      keywords={`${input} to ${output}, ${input} to ${output} converter, ${label} voxelizer, mesh to voxels, ${format.fullName}`}
      url={`https://brickbuilder.ai${path}`} structuredData={structuredData} />
    <div className="mx-auto flex min-h-screen w-full max-w-screen-xl flex-col px-4 pb-10 pt-6 sm:px-6 md:px-8 lg:px-10">
      <header className="flex items-center justify-between gap-4">
        <Link to="/" onClick={() => trackLink('/')} className="flex items-center gap-2"><img src="/brickbuilder-logo.PNG" alt="BrickBuilder" className="h-8 w-auto object-contain" /><span className="hidden text-sm font-semibold sm:inline">BrickBuilder</span></Link>
        <nav className="flex items-center gap-2"><Link to="/dashboard" aria-label="Dashboard" onClick={() => trackLink('/dashboard')}
          className="inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-500 hover:bg-slate-100"><LayoutDashboard className="h-5 w-5" /></Link><ProfileMenu /></nav>
      </header>
      <main className="flex flex-1 flex-col items-center py-10 text-center sm:py-16">
        <div className="w-full max-w-3xl">
          <Link to="/" onClick={() => trackLink('/')} className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-[#f44336]"><ArrowLeft className="h-4 w-4" />Back</Link>
          <div className="mb-4 flex items-center justify-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#f44336]"><Box className="h-4 w-4" />Your model, in voxels</div>
          <h1 className="text-4xl font-extrabold leading-tight sm:text-5xl">{name}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">Turn your {label} 3D model into {format.fullName} voxels. Choose the detail level and download a .{output} file for your next project.</p>
          <div className="mx-auto max-w-2xl"><VoxelUploadCard input={input} output={output} /></div>
          <LegoDesignCallout page={path} />
          <section className="mt-12 text-left"><h2 className="text-2xl font-bold">Convert {label} meshes to {format.fullName}</h2>
            <div className="mt-4 space-y-4 text-sm leading-7 text-slate-600 sm:text-base"><p>{sourceDescription}</p><p>{format.description}</p><p>{format.use}</p><p>{format.limitation}</p></div>
          </section>
          <section aria-label="Conversion steps" className="mt-10 grid gap-4 text-left sm:grid-cols-3">
            {[[`Upload ${label}`, `Choose your .${input} file and inspect the original mesh in 3D.`], ['Set voxel detail', 'Pick a resolution between 8 and 64. Higher detail creates more occupied cells.'], [`Download ${format.name}`, `Convert the mesh and save your .${output} file for a compatible editor or pipeline.`]].map(([title, body]) =>
              <article key={title} className="rounded-xl border border-slate-200 bg-white p-5"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{body}</p></article>)}
          </section>
          <section className="mt-12 text-left"><h2 className="text-2xl font-bold">Choose a voxel file format</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">Use VOX for MagicaVoxel, QB for Qubicle interchange, BINVOX for occupancy grids, or XYZRGB for colored coordinate data.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">{VOXEL_CONVERTERS.filter(converter => converter.path !== path).map(converter =>
              <Link key={converter.path} to={converter.path} onClick={() => trackLink(converter.path)} className="rounded-xl border border-slate-200 bg-white p-4 hover:border-red-300">
                <span className="font-semibold text-[#c42d23]">{converter.input.toUpperCase()} to {VOXEL_FORMATS[converter.output].name}</span>
                <span className="mt-1 block text-sm text-slate-500">{VOXEL_FORMATS[converter.output].colors}</span>
              </Link>)}</div>
          </section>
          <section className="mt-12 text-left"><h2 className="text-2xl font-bold">{label} to {format.name} FAQ</h2>
            <div className="mt-4 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">{faqs.map(faq =>
              <article key={faq.question} className="p-5"><h3 className="text-base font-semibold">{faq.question}</h3><p className="mt-2 text-sm leading-6 text-slate-600">{faq.answer}</p></article>)}</div>
          </section>
        </div>
      </main><SiteFooter />
    </div>
  </div>;
}
