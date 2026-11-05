import { describe, expect, it, vi } from 'vitest';
import {
  buildContextMenuTemplate,
  copyableLink,
  installContextMenu,
  type ContextMenuParams,
  type ContextMenuSource,
} from '../../src/main/contextMenu';

const noFlags = { canCut: false, canCopy: false, canPaste: false, canSelectAll: false };
const params = (overrides: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  x: 12,
  y: 34,
  isEditable: false,
  selectionText: '',
  mediaType: 'none',
  linkURL: '',
  editFlags: noFlags,
  ...overrides,
});

const actions = () => ({ copyImage: vi.fn(), copyText: vi.fn() });
const labels = (template: Array<{ label?: string; type?: string }>) => template.map((item) => item.label ?? item.type);
const click = (item: { click?: unknown }) => (item.click as () => void)();

describe('buildContextMenuTemplate', () => {
  it('offers nothing on plain content', () => {
    expect(buildContextMenuTemplate(params(), 'zh-TW', actions())).toEqual([]);
    expect(buildContextMenuTemplate(params({ selectionText: '   ' }), 'en', actions())).toEqual([]);
  });

  it('gives an editable field Cut, Copy, Paste and Select All as roles, enabled by the edit flags', () => {
    const template = buildContextMenuTemplate(
      params({ isEditable: true, editFlags: { canCut: false, canCopy: true, canPaste: true, canSelectAll: true } }),
      'zh-TW',
      actions(),
    );
    expect(labels(template)).toEqual(['剪下', '複製', '貼上', '全選']);
    expect(template.map((item) => item.role)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
    expect(template.map((item) => item.enabled)).toEqual([false, true, true, true]);
  });

  it('falls back to English for a language it does not know', () => {
    expect(labels(buildContextMenuTemplate(params({ selectionText: 'hello' }), 'fr' as never, actions()))).toEqual(['Copy', 'Select All']);
  });

  it('offers no menu for an editable field whose flags are all off', () => {
    expect(buildContextMenuTemplate(params({ isEditable: true }), 'en', actions())).toEqual([]);
  });

  it('gives selected text outside a field Copy and Select All', () => {
    const template = buildContextMenuTemplate(params({ selectionText: 'hello' }), 'en', actions());
    expect(labels(template)).toEqual(['Copy', 'Select All']);
    expect(template.map((item) => item.role)).toEqual(['copy', 'selectAll']);
  });

  it('copies an image at the click position', () => {
    const a = actions();
    const template = buildContextMenuTemplate(params({ mediaType: 'image' }), 'zh-TW', a);
    expect(labels(template)).toEqual(['複製圖片']);
    click(template[0]!);
    expect(a.copyImage).toHaveBeenCalledWith(12, 34);
  });

  it('copies http, https and mailto links only', () => {
    const a = actions();
    const template = buildContextMenuTemplate(params({ linkURL: 'https://example.com/a?b=1' }), 'en', a);
    expect(labels(template)).toEqual(['Copy Link']);
    click(template[0]!);
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/a?b=1');
    for (const url of ['http://example.com', 'mailto:a@example.com']) {
      expect(copyableLink(url)).toBe(url);
    }
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'relaydesk://resume?session=x', 'not a url', '']) {
      expect(copyableLink(url)).toBeNull();
      expect(buildContextMenuTemplate(params({ linkURL: url }), 'en', a)).toEqual([]);
    }
  });

  it('separates the groups when a selected link is right-clicked', () => {
    const template = buildContextMenuTemplate(params({ linkURL: 'https://example.com', selectionText: 'x' }), 'zh-TW', actions());
    expect(labels(template)).toEqual(['複製連結', 'separator', '複製', '全選']);
  });
});

describe('installContextMenu', () => {
  function setup(language: 'zh-TW' | 'en') {
    let listener: ((event: unknown, p: ContextMenuParams) => void) | undefined;
    const contents: ContextMenuSource = {
      on: (_event, fn) => void (listener = fn),
      copyImageAt: vi.fn(),
    };
    const deps = { getLanguage: async () => language, copyText: vi.fn(), popup: vi.fn() };
    installContextMenu(contents, deps);
    return { contents, deps, fire: (p: ContextMenuParams) => listener!({}, p) };
  }

  it('pops up the localised menu and routes the actions to the web contents and clipboard', async () => {
    const { contents, deps, fire } = setup('en');
    fire(params({ mediaType: 'image', linkURL: 'https://example.com' }));
    await vi.waitFor(() => expect(deps.popup).toHaveBeenCalledTimes(1));
    const template = deps.popup.mock.calls[0]![0] as Array<{ label?: string; click?: unknown }>;
    expect(labels(template)).toEqual(['Copy Link', 'separator', 'Copy Image']);
    click(template[0]!);
    expect(deps.copyText).toHaveBeenCalledWith('https://example.com');
    click(template[2]!);
    expect(contents.copyImageAt).toHaveBeenCalledWith(12, 34);
  });

  it('does not pop up anything when there is nothing to offer', async () => {
    const { deps, fire } = setup('zh-TW');
    fire(params());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(deps.popup).not.toHaveBeenCalled();
  });
});
