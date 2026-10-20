import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';

export async function prerenderPublicPages() {
  const cache = resolve('node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(`${cache}/public-prerender-`);
  try {
    const shell = await readFile('dist/index.html', 'utf8');
    // A production SSR bundle converts the CommonJS router/helmet packages
    // consistently with the browser build, without starting a development server.
    await build({
      ssr: { noExternal: ['react-router-dom', 'react-router', 'react-helmet-async'] },
      build: {
        ssr: 'src/public-prerender.tsx', outDir: directory, emptyOutDir: true,
        rollupOptions: { output: { entryFileNames: 'render.mjs' } },
      },
    });
    const { publicPagePaths, renderPublicDocument } = await import(pathToFileURL(`${directory}/render.mjs`).href);
    for (const path of publicPagePaths) {
      const output = resolve('dist', path === '/' ? 'index.html' : `${path.slice(1)}.html`);
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, renderPublicDocument(shell, path));
    }
    await writeFile('dist/share-shell.html', await readFile('dist/index.html'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
