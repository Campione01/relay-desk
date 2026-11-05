import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

type Place = 'bottom' | 'top' | 'right' | 'left';

interface TipState {
  text: string;
  shortcut?: string;
  rect: DOMRect;
  place: Place;
}

const SHOW_DELAY = 500;
const SKIP_DELAY_WINDOW = 300;
const GAP = 3;

function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

/**
 * One tooltip for the whole app (§4.15): any element with data-tip="label" (and optional data-tip-key,
 * data-tip-place) gets it after 500 ms of hover, or at once on keyboard focus.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: HTMLElement | null = null;
    let lastHidden = 0;

    const read = (el: HTMLElement): TipState | null => {
      const text = el.dataset.tip;
      if (!text) return null;
      const place = (el.dataset.tipPlace as Place | undefined) ?? 'bottom';
      return { text, shortcut: el.dataset.tipKey || undefined, rect: el.getBoundingClientRect(), place };
    };
    const hide = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (current) lastHidden = Date.now();
      current = null;
      setTip(null);
    };
    const showFor = (el: HTMLElement, immediate: boolean): void => {
      if (timer) clearTimeout(timer);
      current = el;
      const delay = immediate || Date.now() - lastHidden < SKIP_DELAY_WINDOW ? 0 : SHOW_DELAY;
      timer = setTimeout(() => {
        timer = null;
        if (current === el && el.isConnected) setTip(read(el));
      }, delay);
    };
    const onOver = (event: PointerEvent): void => {
      const el = (event.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
      if (el === current) return;
      if (current) hide();
      if (el) showFor(el, false);
    };
    const onOut = (event: PointerEvent): void => {
      if (!current) return;
      const next = event.relatedTarget as Node | null;
      if (next && current.contains(next)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent): void => {
      const el = (event.target as Element | null)?.closest?.<HTMLElement>('[data-tip]') ?? null;
      if (el && isFocusVisible(el)) showFor(el, true);
    };
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', hide, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    window.addEventListener('blur', hide);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', hide, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { rect, place } = tip;
    let left: number;
    let top: number;
    if (place === 'right') {
      left = rect.right + GAP + 3;
      top = rect.top + (rect.height - box.height) / 2;
    } else if (place === 'left') {
      left = rect.left - box.width - GAP - 3;
      top = rect.top + (rect.height - box.height) / 2;
    } else if (place === 'top') {
      left = rect.left + (rect.width - box.width) / 2;
      top = rect.top - box.height - GAP;
    } else {
      left = rect.left + (rect.width - box.width) / 2;
      top = rect.bottom + GAP;
      if (top + box.height > vh - 4) top = rect.top - box.height - GAP;
    }
    left = Math.max(4, Math.min(left, vw - box.width - 4));
    top = Math.max(4, Math.min(top, vh - box.height - 4));
    setStyle({ left, top });
  }, [tip]);

  if (!tip) return null;
  const multi = tip.text.length > 40 || tip.text.includes('\n');
  return createPortal(
    <div ref={ref} role="tooltip" className={multi ? 'rd-tooltip rd-tooltip--multi' : 'rd-tooltip'} style={style}>
      {tip.text}
      {tip.shortcut ? <span className="rd-tooltip__key">{tip.shortcut}</span> : null}
    </div>,
    document.body,
  );
}
