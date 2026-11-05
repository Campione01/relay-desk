import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const rootDir = fileURLToPath(new URL('.', import.meta.url));
export const fromRoot = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** `@shared/*` -> src/shared/* for main, preload, renderer, web dev server and vitest. */
export const sharedAlias = { '@shared': fromRoot('./src/shared') };

/**
 * index.html carries the production CSP. The dev server needs the inline React refresh preamble
 * and the HMR websocket, so the policy is relaxed only while serving.
 */
export function devCsp(): Plugin {
  return {
    name: 'relay:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws: wss:");
    },
  };
}
