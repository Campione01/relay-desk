import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import { useController } from '../../state/context';
import type { SessionView } from '../../state/types';

/** UI that is not part of what the user reads: controls, icons, hidden labels, line numbers, status text. */
const SKIP =
  'button, input, textarea, select, svg, img, [aria-hidden="true"], .rd-visually-hidden, .rd-diff__no, .rd-diff__gap, .rd-sysrow__duration, .rd-user__queued, .rd-imgthumb, .rd-status, .rd-jump';
/** Elements shown with white-space: pre / pre-wrap. */
const PRESERVE = 'pre, .rd-user__bubble, .rd-thinking__body, .rd-toolrow__error, .rd-params__value, .rd-diff__text';
const PARAGRAPH = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TABLE', 'UL', 'OL', 'HR']);
const PARAGRAPH_CLASS = '.rd-assistant, .rd-user, .rd-thinking, .rd-tools, .rd-toolrow, .rd-sysrow, .rd-errrow, .rd-md__code, .rd-plan';
const LINE = new Set(['DIV', 'LI', 'TR', 'DT', 'DD', 'DL', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE', 'DETAILS', 'SUMMARY']);

const GAP = 6;
const MARGIN = 4;

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * Plain text of a transcript selection as the user sees it: block breaks become line breaks, collapsed white space
 * outside pre-formatted text, and no button labels, icons or visually hidden status words.
 */
export function selectionText(range: Range): string {
  const start = elementOf(range.commonAncestorContainer);
  if (start?.closest(SKIP)) return '';
  const out: string[] = [];
  let pending = 0;

  const append = (raw: string, preserve: boolean): void => {
    let text = preserve ? raw : raw.replace(/[ \t\r\n\f]+/g, ' ');
    if (!text) return;
    const last = out.length > 0 ? out[out.length - 1]! : '';
    if (out.length === 0 || pending > 0 || /[ \n]$/.test(last)) {
      if (!preserve) text = text.replace(/^ /, '');
      if (!text) return;
    }
    if (pending > 0 && out.length > 0) {
      out[out.length - 1] = last.replace(/[ \t]+$/, '');
      out.push('\n'.repeat(pending));
    }
    pending = 0;
    out.push(text);
  };

  const walk = (node: Node, preserve: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      append((node as Text).data, preserve);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.childNodes.forEach((child) => walk(child, preserve));
      return;
    }
    const el = node as Element;
    if (el.matches(SKIP)) return;
    if (el.tagName === 'BR') {
      append('\n', true);
      return;
    }
    if ((el.tagName === 'TD' || el.tagName === 'TH') && el.previousElementSibling) append('\t', true);
    const level = PARAGRAPH.has(el.tagName) || el.matches(PARAGRAPH_CLASS) ? 2 : LINE.has(el.tagName) ? 1 : 0;
    const keep = preserve || el.matches(PRESERVE);
    if (out.length > 0) pending = Math.max(pending, level);
    el.childNodes.forEach((child) => walk(child, keep));
    if (out.length > 0) pending = Math.max(pending, level);
  };

  walk(range.cloneContents(), Boolean(start?.closest(PRESERVE)));
  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/^\n+|\s+$/g, '');
}

interface Shown {
  text: string;
  rect: { top: number; bottom: number; left: number; right: number };
  range: Range;
}

function sameRange(a: Range | null, b: Range): boolean {
  return Boolean(
    a &&
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset,
  );
}

function rangeRect(range: Range): Shown['rect'] {
  if (typeof range.getBoundingClientRect !== 'function') return { top: 0, bottom: 0, left: 0, right: 0 };
  const { top, bottom, left, right } = range.getBoundingClientRect();
  return { top, bottom, left, right };
}

/**
 * Desktop-style pill over a transcript selection: "Start a side chat" | "Reply". Above the selection, below it when
 * there is no room, always inside the transcript; gone on scroll, collapse, Esc or a click elsewhere.
 */
export function SelectionMenu({
  view,
  rootRef,
  scrollerRef,
}: {
  view: SessionView;
  rootRef: RefObject<HTMLElement | null>;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const controller = useController();
  const menuRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const shownRef = useRef<Shown | null>(null);
  shownRef.current = shown;
  /** Selection the user dismissed (Esc, click elsewhere): it stays hidden until the selection changes. */
  const dismissedRef = useRef<Range | null>(null);
  const pointerDownRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const reasonId = useId();

  const hide = useCallback((dismiss: boolean): void => {
    if (dismiss && shownRef.current) dismissedRef.current = shownRef.current.range;
    shownRef.current = null;
    setShown(null);
  }, []);

  const evaluate = useCallback((): void => {
    const selection = document.getSelection();
    const root = rootRef.current;
    // While the keyboard is in the pill it acts on the text it captured, whatever focus did to the selection.
    if (shownRef.current && menuRef.current?.contains(document.activeElement)) return;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !root) {
      dismissedRef.current = null;
      hide(false);
      return;
    }
    const range = selection.getRangeAt(0);
    // Text fields keep their own selection; the document range never lies inside the transcript for them.
    if (!root.contains(range.commonAncestorContainer) || sameRange(dismissedRef.current, range)) {
      hide(false);
      return;
    }
    const text = selectionText(range);
    if (!text) {
      hide(false);
      return;
    }
    dismissedRef.current = null;
    const next: Shown = { text, rect: rangeRect(range), range: range.cloneRange() };
    shownRef.current = next;
    setShown(next);
  }, [hide, rootRef]);

  useEffect(() => {
    const onSelectionChange = (): void => {
      // While the mouse drags, the pill waits for the mouseup.
      if (pointerDownRef.current) hide(false);
      else evaluate();
    };
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return;
      pointerDownRef.current = event.button === 0;
      hide(true);
    };
    const onMouseUp = (): void => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      evaluate();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!shownRef.current || document.querySelector('[aria-modal="true"]')) return;
      const inside = menuRef.current?.contains(document.activeElement) ?? false;
      if (event.key === 'Escape') {
        hide(true);
        if (inside) {
          event.preventDefault();
          event.stopPropagation();
          returnFocusRef.current?.focus({ preventScroll: true });
        }
        return;
      }
      if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || inside) return;
      const active = document.activeElement as HTMLElement | null;
      const scroller = scrollerRef.current;
      if (active && active !== document.body && !(scroller && scroller.contains(active))) return;
      const first = menuRef.current?.querySelector<HTMLElement>('button');
      if (!first) return;
      event.preventDefault();
      returnFocusRef.current = active && active !== document.body ? active : null;
      first.focus();
    };
    const onScrollOrResize = (): void => hide(false);
    const scroller = scrollerRef.current;
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onScrollOrResize);
    scroller?.addEventListener('scroll', onScrollOrResize, { passive: true });
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onScrollOrResize);
      scroller?.removeEventListener('scroll', onScrollOrResize);
    };
  }, [evaluate, hide, scrollerRef]);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const scroller = scrollerRef.current;
    if (!shown || !menu || !scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const { rect } = shown;
    let top = rect.top - GAP - height;
    let placement: 'above' | 'below' = 'above';
    if (top < bounds.top + MARGIN) {
      top = rect.bottom + GAP;
      placement = 'below';
    }
    top = Math.max(bounds.top + MARGIN, Math.min(top, bounds.bottom - height - MARGIN));
    const center = (rect.left + rect.right) / 2;
    const left = Math.max(bounds.left + MARGIN, Math.min(center - width / 2, bounds.right - width - MARGIN));
    menu.dataset.placement = placement;
    setStyle({ top: Math.round(top), left: Math.round(left) });
  }, [shown, scrollerRef]);

  if (!shown) return null;
  const blocked = controller.sideChatBlocked(view.key);
  const finish = (): void => {
    document.getSelection()?.removeAllRanges();
    dismissedRef.current = null;
    hide(false);
    returnFocusRef.current = null;
  };

  return createPortal(
    <div
      ref={menuRef}
      className="rd-selmenu"
      role="toolbar"
      aria-label={t('selection.actions')}
      data-testid="selection-menu"
      style={style}
      onMouseDown={(event) => event.preventDefault()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) evaluate();
      }}
    >
      <button
        type="button"
        className="rd-selmenu__btn"
        aria-disabled={blocked ? 'true' : undefined}
        aria-describedby={blocked ? reasonId : undefined}
        data-tip={blocked ? t(blocked) : undefined}
        data-tip-place="top"
        onClick={() => {
          if (blocked) return;
          const { text } = shown;
          finish();
          void controller.startSideChat(view.key, text);
        }}
      >
        {t('selection.sideChat')}
      </button>
      {blocked ? (
        <span id={reasonId} className="rd-visually-hidden">
          {t(blocked)}
        </span>
      ) : null}
      <span className="rd-selmenu__divider" aria-hidden="true" />
      <button
        type="button"
        className="rd-selmenu__btn"
        onClick={() => {
          const { text } = shown;
          finish();
          controller.quoteIntoPrompt(view.key, text);
        }}
      >
        {t('selection.reply')}
      </button>
    </div>,
    document.body,
  );
}
