import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import {defineConfig, type Plugin} from 'vite';

/**
 * A short id for "this version of the code": a hash of the source files (src, public, index.html, package.json).
 * The same code always gives the same id, on any machine, so redeploying unchanged code never looks like an update.
 */
function computeBuildId(): string {
  const root = path.resolve(import.meta.dirname || '.');
  const hash = crypto.createHash('sha256');
  const walk = (dir: string, rel: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
      else if (entry.isFile() && !/\.(zip|DS_Store)$/.test(entry.name)) {
        hash.update(r);
        // normalise line endings so Windows/Mac/Linux checkouts agree
        hash.update(fs.readFileSync(path.join(dir, entry.name), 'utf8').replace(/\r\n/g, '\n'));
      }
    }
  };
  walk(path.join(root, 'src'), 'src');
  walk(path.join(root, 'public'), 'public');
  for (const f of ['index.html', 'package.json']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) { hash.update(f); hash.update(fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')); }
  }
  return hash.digest('hex').slice(0, 12);
}

const BUILD_ID = computeBuildId();

/**
 * After the build, stamp public/sw.js (copied into dist) with a build id and the list of built
 * JS/CSS files, so the whole app — including lazy-loaded screens — is cached for offline use.
 */
function injectServiceWorker(): Plugin {
  let outDir = '';
  return {
    name: 'inject-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      try {
        // The site's own statement of "this is the build I am serving". The running app compares it with the build it was made from.
        fs.writeFileSync(path.join(outDir, 'version.json'), JSON.stringify({ build: BUILD_ID }));
        const swFile = path.join(outDir, 'sw.js');
        if (!fs.existsSync(swFile)) return;
        const assets: string[] = [];
        const walk = (dir: string, rel: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = `${rel}/${entry.name}`;
            if (entry.isDirectory()) walk(path.join(dir, entry.name), r);
            else if (/\.(js|css)$/.test(entry.name)) assets.push(r);
          }
        };
        const assetsDir = path.join(outDir, 'assets');
        if (fs.existsSync(assetsDir)) walk(assetsDir, '/assets');
        assets.sort();
        const src = fs
          .readFileSync(swFile, 'utf8')
          .replaceAll('__BUILD_ID__', BUILD_ID)
          .replaceAll('__PRECACHE_LIST__', JSON.stringify(assets));
        fs.writeFileSync(swFile, src);
      } catch (e) {
        console.warn('Could not stamp service worker:', e);
      }
    },
  };
}

export default defineConfig(() => {
  return {
    define: { __APP_BUILD__: JSON.stringify(BUILD_ID) },
    plugins: [react(), tailwindcss(), injectServiceWorker()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname || '.', '.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
