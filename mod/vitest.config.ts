import { defineConfig } from 'vitest/config';

// The mod's pure helpers, outside the app's projects: npx vitest run --config mod/vitest.config.ts
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../node_modules/.vite/mod',
  test: {
    name: 'mod',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
