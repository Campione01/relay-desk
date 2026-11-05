import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { devCsp, fromRoot, sharedAlias } from './vite.shared.ts';

export default defineConfig({
  main: {
    resolve: { alias: sharedAlias },
    build: {
      // Every package in `dependencies` (the agent SDK included) stays external and is loaded
      // from node_modules at runtime; the SDK is ESM-only and spawns its bundled claude.exe.
      externalizeDeps: true,
      rolldownOptions: {
        input: {
          index: fromRoot('./src/main/index.ts'),
          nativePrototype: fromRoot('./src/main/nativePrototype.ts'),
          listingWorker: fromRoot('./src/main/engine/listingWorker.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      // Sandboxed preloads cannot require packages or run as ESM: bundle everything into one CJS file.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: fromRoot('./src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: fromRoot('./src/renderer'),
    resolve: { alias: sharedAlias },
    plugins: [react(), devCsp()],
    // IPv4 explicitly: `localhost` may bind ::1 while Electron connects to 127.0.0.1.
    server: { host: '127.0.0.1' },
    build: {
      rolldownOptions: { input: { index: fromRoot('./src/renderer/index.html') } },
    },
  },
});
