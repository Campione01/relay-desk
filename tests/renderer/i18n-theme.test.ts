import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../../src/renderer/i18n/en';
import { translate } from '../../src/renderer/i18n';
import { zhTW } from '../../src/renderer/i18n/zh-TW';
import { applyFontScale, applyTheme, resolveTheme } from '../../src/renderer/theme/theme';

describe('i18n', () => {
  it('every zh-TW key has an English string and the other way round', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhTW).sort());
    for (const [key, value] of Object.entries(en)) expect(value, key).not.toBe('');
  });

  it('fills placeholders and keeps unknown ones', () => {
    expect(translate('en', 'sidebar.showOlder', { n: 3 })).toBe('Show older (3)');
    expect(translate('zh-TW', 'sidebar.showOlder', { n: 3 })).toBe('顯示較舊的（3）');
    expect(translate('en', 'sidebar.newInFolder')).toBe('New session in {folder}');
  });

  it('falls back to English when the chosen language lacks a string', () => {
    const dictionary = zhTW as unknown as Record<string, string>;
    const saved = dictionary['settings.title']!;
    delete dictionary['settings.title'];
    try {
      expect(translate('zh-TW', 'settings.title')).toBe('Settings');
    } finally {
      dictionary['settings.title'] = saved;
    }
    expect(translate('zh-TW', 'settings.title')).toBe('設定');
  });

  it('says that the launch-environment source can pass a subscription token', () => {
    expect(en['accounts.authenticationEnvironment']).toMatch(/token/);
    for (const dictionary of [en, zhTW] as Array<Record<string, string>>) {
      expect(dictionary['accounts.authenticationEnvironmentHint']).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(dictionary['accounts.authenticationWarning']).toContain('CLAUDE_CODE_OAUTH_TOKEN');
      expect(dictionary['accounts.authenticationWarning']).not.toMatch(/^API/);
    }
  });

  it('uses Taiwan wording in Traditional Chinese', () => {
    expect(zhTW['sidebar.search']).toBe('搜尋工作階段');
    expect(zhTW['settings.title']).toBe('設定');
    expect(zhTW['handoff.openInTerminal']).toBe('在終端機接續');
  });
});

describe('theme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('manual light/dark wins over the system preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('"system" follows prefers-color-scheme changes until another preference is applied', () => {
    let listener: (() => void) | null = null;
    const query = {
      matches: false,
      addEventListener: (_: string, cb: () => void) => {
        listener = cb;
      },
      removeEventListener: () => {
        listener = null;
      },
    };
    vi.stubGlobal('matchMedia', () => query);
    applyTheme('system');
    expect(document.documentElement.dataset.theme).toBe('light');
    query.matches = true;
    (listener as (() => void) | null)?.();
    expect(document.documentElement.dataset.theme).toBe('dark');
    applyTheme('light');
    expect(listener).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('font scale is a clamped CSS variable', () => {
    applyFontScale(1.25);
    expect(document.documentElement.style.getPropertyValue('--rd-font-scale')).toBe('1.25');
    applyFontScale(9);
    expect(document.documentElement.style.getPropertyValue('--rd-font-scale')).toBe('1.5');
  });
});
