import type { AppSettings } from '@shared/types';

/** The renderer tokens --rd-bg-app (title bar and window) and --rd-icon (caption glyphs). */
export const THEME_COLORS = {
  light: { background: '#fcfcfb', symbol: '#2b2b2b' },
  dark: { background: '#1f1f1f', symbol: '#d0d0d0' },
} as const;

/** Title bar 36 px; the native caption buttons come from titleBarOverlay. */
export const TITLE_BAR_HEIGHT = 36;

export function themeColors(dark: boolean): { background: string; symbol: string } {
  return dark ? THEME_COLORS.dark : THEME_COLORS.light;
}

export function titleBarOverlay(dark: boolean): { color: string; symbolColor: string; height: number } {
  const colors = themeColors(dark);
  return { color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT };
}

export interface ThemeTarget {
  nativeTheme: { themeSource: AppSettings['theme']; readonly shouldUseDarkColors: boolean };
  getWindow(): {
    isDestroyed(): boolean;
    setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void;
    setBackgroundColor(color: string): void;
  } | null;
}

/** Sets nativeTheme.themeSource and recolours the window background and caption buttons to match. */
export function applyTheme(theme: AppSettings['theme'], target: ThemeTarget): void {
  target.nativeTheme.themeSource = theme;
  syncWindowTheme(target);
}

/** Recolours the window for the current effective theme (also after an OS theme change). */
export function syncWindowTheme(target: ThemeTarget): void {
  const win = target.getWindow();
  if (!win || win.isDestroyed()) return;
  const dark = target.nativeTheme.shouldUseDarkColors;
  try {
    win.setTitleBarOverlay(titleBarOverlay(dark));
  } catch {
    // The window was created without an overlay (should not happen); the background still updates.
  }
  win.setBackgroundColor(themeColors(dark).background);
}
