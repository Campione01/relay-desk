import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { devCsp, fromRoot, sharedAlias } from './vite.shared.ts';

/** Installs the in-memory mock as window.relay before the app module runs. */
function injectMockApi(): Plugin {
  return {
    name: 'relay:inject-mock-api',
    transformIndexHtml() {
      return [{ tag: 'script', attrs: { type: 'module', src: '/mock/install.ts' }, injectTo: 'head-prepend' }];
    },
  };
}

// `npm run dev:web`: the renderer alone in a browser, backed by src/renderer/mock/api.ts.
export default defineConfig({
  root: fromRoot('./src/renderer'),
  resolve: { alias: sharedAlias },
  plugins: [react(), devCsp(), injectMockApi()],
  server: { host: '127.0.0.1', port: 5180 },
  build: { outDir: fromRoot('./out/web'), emptyOutDir: true },
});
