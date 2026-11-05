import { useEffect, useState, type RefObject } from 'react';
import type { RelayApi } from '@shared/ipc';

type ImageSource = Pick<RelayApi['sessions'], 'image'>;

/** Upper bound for the cached data URLs (characters), so a long session cannot grow the renderer without limit. */
const MAX_CHARS = 64 * 1024 * 1024;

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
let total = 0;

function remember(key: string, url: string): void {
  const old = cache.get(key);
  if (old !== undefined) {
    total -= old.length;
    cache.delete(key);
  }
  cache.set(key, url);
  total += url.length;
  for (const [oldest, value] of cache) {
    if (total <= MAX_CHARS || oldest === key) break;
    cache.delete(oldest);
    total -= value.length;
  }
}

/** Cached data URL of a transcript image (marks it as recently used), or undefined. */
export function cachedImage(key: string): string | undefined {
  const url = cache.get(key);
  if (url !== undefined) {
    cache.delete(key);
    cache.set(key, url);
  }
  return url;
}

/** data: URL of a transcript image from main; null when main no longer holds it. One request per key at a time. */
export function loadImage(api: ImageSource, key: string): Promise<string | null> {
  const hit = cachedImage(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const request = api
    .image(key)
    .then((url) => {
      if (typeof url === 'string' && url.startsWith('data:image/')) {
        remember(key, url);
        return url;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Test hook: forget every cached image. */
export function clearImageCache(): void {
  cache.clear();
  inflight.clear();
  total = 0;
}

/**
 * undefined while unknown/loading, null when unavailable, else the data URL. Loads once `element` scrolls near
 * the viewport (at once when `eager` or without IntersectionObserver).
 */
export function useImageUrl(
  api: ImageSource,
  key: string,
  element: RefObject<Element | null> | null,
  eager = false,
): string | null | undefined {
  const [state, setState] = useState<{ key: string; url: string | null | undefined }>(() => ({
    key,
    url: cachedImage(key),
  }));
  const url = state.key === key ? state.url : cachedImage(key);

  useEffect(() => {
    if (url !== undefined) return;
    let cancelled = false;
    const start = (): void => {
      void loadImage(api, key).then((next) => {
        if (!cancelled) setState({ key, url: next });
      });
    };
    const target = element?.current;
    if (eager || !target || typeof IntersectionObserver === 'undefined') {
      start();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          start();
        }
      },
      { rootMargin: '300px 0px' },
    );
    observer.observe(target);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [api, key, element, eager, url]);

  return url;
}
