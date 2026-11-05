import type { RelayApi } from '@shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload (Electron) or by mock/install.ts (dev:web, tests). */
    relay: RelayApi;
    /** Electron only (preload): local path of a dropped File, '' when it has none. Absent in dev:web and tests. */
    relayFiles?: { pathFor(file: File): string };
  }
}

export {};
