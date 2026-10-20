import { createReadStream, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const BASE = '/checkers/';

const TRAINING_TYPES: Record<string, string> = { '.json': 'application/json', '.bin': 'application/octet-stream' };

// Vite indexes public/ once at startup and the /mnt/c watcher misses new files, so files the
// trainer publishes later would fall through to the SPA fallback; serve them straight from disk.
function liveTrainingFiles(): Plugin {
  const prefix = `${BASE}training/`;
  return {
    name: 'live-training-files',
    configureServer(server) {
      const root = resolve(join(server.config.publicDir, 'training'));
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? '').split('?')[0];
        if (!pathname.startsWith(prefix)) return next();
        let file: string;
        try {
          file = resolve(root, decodeURIComponent(pathname.slice(prefix.length)));
        } catch {
          file = '';
        }
        let size = -1;
        if (file.startsWith(root + sep)) {
          try {
            const st = statSync(file);
            if (st.isFile()) size = st.size;
          } catch {
            size = -1;
          }
        }
        if (size < 0) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain');
          res.end('Not found');
          return;
        }
        res.setHeader('Content-Type', TRAINING_TYPES[extname(file)] ?? 'application/octet-stream');
        res.setHeader('Content-Length', size);
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).on('error', next).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [liveTrainingFiles()],
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 650,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }] } },
    },
  },
  worker: { format: 'es' },
  server: { watch: process.env.POLL ? { usePolling: true, interval: 300 } : undefined },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
  },
});
