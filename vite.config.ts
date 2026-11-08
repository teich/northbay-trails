import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

const PORT = 5317;

// Short hash of everything in public/data/. src/data.ts adds it to the data URLs so a
// deploy that changes the data never pairs new code with an hour-old cached copy.
function dataVersion(): string {
  const hash = createHash('sha256');
  for (const name of readdirSync('public/data').sort()) hash.update(name).update(readFileSync(`public/data/${name}`));
  return hash.digest('hex').slice(0, 12);
}

// Publish the dev/preview server on the tailnet with `share <port>` (a wrapper
// around `tailscale serve`) for as long as it's running, and unpublish on exit.
function tailnetShare(port: number): Plugin {
  let shared = false;
  const run = (...args: string[]) => execFileSync('share', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

  const stop = () => {
    if (!shared) return;
    shared = false;
    try {
      run(String(port), 'off');
    } catch {
      // nothing useful to do while exiting
    }
  };

  const start = (httpServer: import('node:http').Server | null, log: (msg: string) => void) => {
    httpServer?.once('listening', () => {
      try {
        log(`  ➜  Tailnet: ${run(String(port)).split(/\s+/)[0]}`);
        shared = true;
      } catch (err) {
        log(`  ➜  Tailnet: not shared (${(err as Error).message.split('\n')[0]})`);
      }
    });
    httpServer?.once('close', stop);
    process.once('exit', stop);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        stop();
        process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[signal]);
      });
    }
  };

  return {
    name: 'tailnet-share',
    apply: 'serve',
    configureServer(server) {
      start(server.httpServer as import('node:http').Server | null, (m) => server.config.logger.info(m));
    },
    configurePreviewServer(server) {
      start(server.httpServer as import('node:http').Server, (m) => server.config.logger.info(m));
    },
  };
}

export default defineConfig({
  define: { __DATA_VERSION__: JSON.stringify(dataVersion()) },
  base: './',
  build: { chunkSizeWarningLimit: 800 }, // three.js is most of it
  // strictPort: the tailnet share points at this exact port
  server: { port: PORT, strictPort: true, allowedHosts: ['.ts.net'] },
  preview: { port: PORT, strictPort: true, allowedHosts: ['.ts.net'] },
  // cloudflare(): reads cloudflare.config.ts and writes Build Output for `cf deploy`
  plugins: [cloudflare(), tailnetShare(PORT)],
});
