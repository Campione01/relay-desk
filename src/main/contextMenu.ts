import type { MenuItemConstructorOptions } from 'electron';
import type { AppSettings } from '@shared/types';

type Language = AppSettings['language'];

/** The parts of Electron's context-menu params this module reads. */
export interface ContextMenuParams {
  x: number;
  y: number;
  isEditable: boolean;
  selectionText: string;
  mediaType: string;
  linkURL: string;
  editFlags: { canCut: boolean; canCopy: boolean; canPaste: boolean; canSelectAll: boolean };
}

export interface ContextMenuActions {
  copyImage(x: number, y: number): void;
  copyText(text: string): void;
}

const LABELS: Record<Language, Record<'cut' | 'copy' | 'paste' | 'selectAll' | 'copyImage' | 'copyLink', string>> = {
  'zh-TW': { cut: '剪下', copy: '複製', paste: '貼上', selectAll: '全選', copyImage: '複製圖片', copyLink: '複製連結' },
  en: { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', copyImage: 'Copy Image', copyLink: 'Copy Link' },
};

const COPYABLE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Only web and mail links can be copied; anything else (file:, javascript:, app schemes) is not offered. */
export function copyableLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return COPYABLE_LINK_PROTOCOLS.has(parsed.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** Pure: the menu for one right-click, empty when there is nothing to offer. */
export function buildContextMenuTemplate(
  params: ContextMenuParams,
  language: Language,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const label = LABELS[language] ?? LABELS.en;
  const groups: MenuItemConstructorOptions[][] = [];

  const link = copyableLink(params.linkURL);
  if (link) groups.push([{ label: label.copyLink, click: () => actions.copyText(link) }]);

  if (params.mediaType === 'image') {
    groups.push([{ label: label.copyImage, click: () => actions.copyImage(params.x, params.y) }]);
  }

  const flags = params.editFlags;
  if (params.isEditable) {
    if (flags.canCut || flags.canCopy || flags.canPaste || flags.canSelectAll) {
      groups.push([
        { role: 'cut', label: label.cut, enabled: flags.canCut },
        { role: 'copy', label: label.copy, enabled: flags.canCopy },
        { role: 'paste', label: label.paste, enabled: flags.canPaste },
        { role: 'selectAll', label: label.selectAll, enabled: flags.canSelectAll },
      ]);
    }
  } else if (params.selectionText.trim()) {
    groups.push([
      { role: 'copy', label: label.copy },
      { role: 'selectAll', label: label.selectAll },
    ]);
  }

  return groups.flatMap((group, index) => (index === 0 ? group : [{ type: 'separator' as const }, ...group]));
}

export interface ContextMenuSource {
  on(event: 'context-menu', listener: (event: unknown, params: ContextMenuParams) => void): unknown;
  copyImageAt(x: number, y: number): void;
}

export interface ContextMenuDeps {
  getLanguage(): Promise<Language>;
  copyText(text: string): void;
  /** Builds and shows the menu; called only with a non-empty template. */
  popup(template: MenuItemConstructorOptions[]): void;
}

/** Shows the localised menu on right-click inside `contents`. */
export function installContextMenu(contents: ContextMenuSource, deps: ContextMenuDeps): void {
  contents.on('context-menu', (_event, params) => {
    void deps.getLanguage().then((language) => {
      const template = buildContextMenuTemplate(params, language, {
        copyImage: (x, y) => contents.copyImageAt(x, y),
        copyText: deps.copyText,
      });
      if (template.length > 0) deps.popup(template);
    });
  });
}
