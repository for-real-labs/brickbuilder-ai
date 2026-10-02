import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';

export async function prerenderLegalPages() {
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(`${cache}/legal-prerender-`);
  try {
    const shell = await readFile('dist/index.html', 'utf8');
    // A production SSR bundle converts the CommonJS router/helmet packages
    // consistently with the browser build, without starting a development server.
    await build({
      ssr: { noExternal: ['react-router-dom', 'react-router', 'react-helmet-async'] },
      build: {
        ssr: 'src/legal-prerender.tsx', outDir: directory, emptyOutDir: true,
        rollupOptions: { output: { entryFileNames: 'render.mjs' } },
      },
    });
    const { legalPages, renderLegalDocument } = await import(pathToFileURL(`${directory}/render.mjs`).href);
    for (const page of legalPages) {
      await writeFile(`dist/${page.path}.html`, renderLegalDocument(shell, page.path));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
