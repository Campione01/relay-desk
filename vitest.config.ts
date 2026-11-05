import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { sharedAlias } from './vite.shared.ts';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: sharedAlias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/system/**/*.test.ts', 'tests/engine/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['tests/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['tests/renderer/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'mod',
          environment: 'node',
          include: ['mod/tests/**/*.test.ts'],
        },
      },
    ],
  },
});
