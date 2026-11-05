import type { AppSettings } from '@shared/types';

export type ThemePreference = AppSettings['theme'];
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, prefersDark = systemPrefersDark()): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference;
  return prefersDark ? 'dark' : 'light';
}

let mediaCleanup: (() => void) | null = null;

/**
 * Sets data-theme on <html>. 'system' follows prefers-color-scheme and keeps following it until
 * another preference is applied; a manual light/dark choice always wins.
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const root = document.documentElement;
  mediaCleanup?.();
  mediaCleanup = null;
  const resolved = resolveTheme(preference);
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  if (preference === 'system' && typeof window.matchMedia === 'function') {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = (): void => {
      root.dataset.theme = query.matches ? 'dark' : 'light';
    };
    query.addEventListener('change', onChange);
    mediaCleanup = () => query.removeEventListener('change', onChange);
  }
  return resolved;
}

export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;

export function clampFontScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(1.5, Math.max(0.8, scale));
}

export function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty('--rd-font-scale', String(clampFontScale(scale)));
}

export function applyLanguage(language: AppSettings['language']): void {
  document.documentElement.lang = language;
}
