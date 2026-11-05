import type { ImageRef } from '@shared/types';
import { isRecord } from './mapTranscript';

/** Transcript images stay in main; the renderer gets refs and asks for the bytes of the ones it shows. */
export interface ImageStore {
  put(key: string, mediaType: string, base64: string): ImageRef;
  /** data: URL, or null once evicted or never stored. */
  get(key: string): string | null;
}

const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DEFAULT_LIMIT_BYTES = 256 * 1024 * 1024;

/** LRU by total base64 length, so a long session with many screenshots cannot grow main without bound. */
export function createImageStore(limitBytes = DEFAULT_LIMIT_BYTES): ImageStore {
  const entries = new Map<string, { mediaType: string; data: string }>();
  let total = 0;
  return {
    put(key, mediaType, base64) {
      const old = entries.get(key);
      if (old) {
        total -= old.data.length;
        entries.delete(key);
      }
      entries.set(key, { mediaType, data: base64 });
      total += base64.length;
      for (const [oldest, entry] of entries) {
        if (total <= limitBytes || oldest === key) break;
        entries.delete(oldest);
        total -= entry.data.length;
      }
      return { key, mediaType };
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return `data:${entry.mediaType};base64,${entry.data}`;
    },
  };
}

/** Process-wide store shared by live sessions and history loads. */
export const imageStore: ImageStore = createImageStore();

/**
 * Stores every base64 image block of a message content array (also inside tool_result content)
 * under `${keyPrefix}:${n}` and returns the refs in order. Non-base64 or unknown media types are skipped.
 */
export function storeImageBlocks(content: unknown, keyPrefix: string, store: ImageStore = imageStore): ImageRef[] {
  const refs: ImageRef[] = [];
  const visit = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!isRecord(block)) continue;
      if (block.type === 'image' && isRecord(block.source) && block.source.type === 'base64') {
        const mediaType = block.source.media_type;
        const data = block.source.data;
        if (typeof mediaType === 'string' && MEDIA_TYPES.has(mediaType) && typeof data === 'string' && data) {
          refs.push(store.put(`${keyPrefix}:${refs.length}`, mediaType, data));
        }
      } else if (block.type === 'tool_result') {
        visit(block.content);
      }
    }
  };
  visit(content);
  return refs;
}
