import { Check, ChevronRight } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { lastInputWasKeyboard } from '../../lib/inputModality';
import { ICON, ICON_SM } from './primitives';

export interface MenuItem {
  /** 'toggle': an on/off row (menuitemcheckbox) with a switch on the right; choosing it keeps the menu open. */
  type?: 'item' | 'toggle';
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  /** Right-aligned shortcut text; a checked row shows the check instead. A single letter also chooses the row. */
  shortcut?: string;
  /** Destructive row (Delete), in the danger color. */
  danger?: boolean;
  /** Right-aligned muted value, before the chevron of a submenu (for example the current effort). */
  value?: string;
  /** Small pill after the label (for example "Recommended"); part of the row's accessible name. */
  badge?: { text: string; tone: 'neutral' | 'warning' };
  checked?: boolean;
  disabled?: boolean;
  /** Tooltip explaining why the item is disabled; also the row's accessible description. */
  disabledReason?: string;
  /** Tooltip of an enabled item; also the row's accessible description. */
  tip?: string;
  onSelect?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry =
  | MenuItem
  | { type: 'separator'; id: string }
  | {
      type: 'section';
      id: string;
      label: string;
      /** The text is about the whole menu: it becomes the menu's accessible description (aria-describedby). */
      describes?: boolean;
    };

export type MenuPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right-start';

export type MenuCloseReason = 'escape' | 'outside' | 'select' | 'tab';

interface MenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose(reason: MenuCloseReason): void;
  entries: MenuEntry[];
  label: string;
  placement?: MenuPlacement;
  width?: number;
  offset?: number;
  /** Return focus to the anchor when closed by keyboard (default true). */
  restoreFocus?: boolean;
  /** Extra class for this menu and its submenus. */
  className?: string;
  /** Id of an item whose submenu opens together with the menu. */
  initialSubmenu?: string;
}

const isItem = (entry: MenuEntry): entry is MenuItem => entry.type === undefined || entry.type === 'item' || entry.type === 'toggle';

type Box = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right'>;

/**
 * Where a menu goes. `size` is the menu's own measured size (0 when unknown); only a submenu (right-start) uses it,
 * to open to the left of its row or upward when the window has no room to the right or below.
 */
export function menuPosition(
  rect: Box,
  placement: MenuPlacement,
  offset: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  width?: number,
): CSSProperties {
  const { width: vw, height: vh } = viewport;
  const style: CSSProperties = width ? { width } : {};
  const clampLeft = (left: number): number => Math.max(8, Math.min(left, vw - (width ?? 200) - 8));
  // An end-aligned menu wider than the space left of its anchor (the sidebar's session menu) stops at the window edge.
  const clampRight = (anchorRight: number): number => Math.max(8, Math.min(vw - anchorRight, vw - (width ?? 200) - 8));
  switch (placement) {
    case 'bottom-start':
      return { ...style, top: rect.bottom + offset, left: clampLeft(rect.left) };
    case 'bottom-end':
      return { ...style, top: rect.bottom + offset, right: clampRight(rect.right) };
    case 'top-start':
      return { ...style, bottom: vh - rect.top + offset, left: clampLeft(rect.left) };
    case 'top-end':
      return { ...style, bottom: vh - rect.top + offset, right: clampRight(rect.right) };
    case 'right-start': {
      const w = size.width || width || 200;
      const toRight = rect.right + 4;
      const toLeft = rect.left - 4 - w;
      const left = toRight + w <= vw - 8 ? Math.max(8, toRight) : toLeft >= 8 ? toLeft : Math.max(8, Math.min(toRight, vw - w - 8));
      // Upward the menu ends level with its row, as the desktop's "More models" does near the window bottom.
      const down = rect.top - 4;
      const top = size.height > 0 && down + size.height > vh - 8 ? rect.bottom - size.height : down;
      return { ...style, top: Math.max(8, top), left };
    }
    default:
      return style;
  }
}

/** Popover menu (§4.12): opens at an anchor, keyboard navigable (arrows, Home/End, 1-9, Enter, Esc). */
export function Menu({
  anchor,
  open,
  onClose,
  entries,
  label,
  placement = 'bottom-start',
  width,
  offset = 4,
  restoreFocus = true,
  className,
  initialSubmenu,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const items = entries.filter(isItem);
  const enabled = items.filter((item) => !item.disabled);
  const checkedIndex = items.findIndex((item) => item.checked && !item.disabled && item.type !== 'toggle');
  const initialIndex = Math.max(0, checkedIndex >= 0 ? checkedIndex : items.findIndex((item) => !item.disabled));
  const [active, setActive] = useState(initialIndex);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const [style, setStyle] = useState<CSSProperties>({});
  const itemRefs = useRef(new Map<string, HTMLDivElement>());

  const updatePosition = useCallback(() => {
    if (!open) return;
    const el = menuRef.current;
    const rect = anchor?.getBoundingClientRect() ?? { top: 0, bottom: 0, left: 0, right: 0 };
    const size = { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 };
    const next = menuPosition(rect, placement, offset, size, { width: window.innerWidth, height: window.innerHeight }, width);
    setStyle((previous) => previous.top === next.top && previous.bottom === next.bottom && previous.left === next.left
      && previous.right === next.right && previous.width === next.width ? previous : next);
  }, [open, anchor, placement, offset, width]);

  // React content changes can move an anchor without resizing it; placement must not reinitialize navigation.
  useLayoutEffect(updatePosition);

  useLayoutEffect(() => {
    if (!open) return;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updatePosition);
    if (menuRef.current) observer?.observe(menuRef.current);
    // A sibling can move the anchor when one of its layout containers changes size.
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement) observer?.observe(element);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      observer?.disconnect();
    };
  }, [open, anchor, updatePosition]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    const sub = initialSubmenu ? items.find((item) => item.id === initialSubmenu && item.submenu && !item.disabled) : undefined;
    setActive(sub ? items.indexOf(sub) : lastInputWasKeyboard() ? initialIndex : -1);
    setSubmenu(sub ? sub.id : null);
    if (!sub) el?.focus({ preventScroll: true });
  }, [open, initialSubmenu]);

  const close = useCallback(
    (reason: MenuCloseReason) => {
      onClose(reason);
      if (restoreFocus && (reason === 'escape' || reason === 'select')) anchor?.focus({ preventScroll: true });
    },
    [anchor, onClose, restoreFocus],
  );

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchor?.contains(target)) return;
      if ((target as Element).closest?.('[data-menu-layer]')) return;
      onClose('outside');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, anchor, onClose]);

  if (!open) return null;

  const select = (item: MenuItem): void => {
    if (item.disabled) return;
    if (item.submenu) {
      setSubmenu(item.id);
      return;
    }
    if (item.type === 'toggle') {
      item.onSelect?.();
      return;
    }
    close('select');
    item.onSelect?.();
  };

  const move = (delta: number): void => {
    if (enabled.length === 0) return;
    let index = active >= 0 ? active : delta > 0 ? -1 : items.length;
    for (let step = 0; step < items.length; step++) {
      index = (((index + delta) % items.length) + items.length) % items.length;
      if (!items[index]?.disabled) break;
    }
    setActive(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== menuRef.current) return;
    const current = items[active];
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActive(items.findIndex((item) => !item.disabled));
        break;
      case 'End': {
        event.preventDefault();
        const reversed = [...items].reverse().findIndex((item) => !item.disabled);
        if (reversed >= 0) setActive(items.length - 1 - reversed);
        break;
      }
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (current) select(current);
        break;
      case 'ArrowRight':
        if (current?.submenu && !current.disabled) {
          event.preventDefault();
          setSubmenu(current.id);
        }
        break;
      case 'ArrowLeft':
        if (placement === 'right-start') {
          event.preventDefault();
          close('escape');
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close('escape');
        break;
      case 'Tab':
        onClose('tab');
        break;
      default:
        if (/^[1-9]$/.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
          const item = enabled[Number(event.key) - 1];
          if (item) {
            event.preventDefault();
            setActive(items.indexOf(item));
            select(item);
          }
        } else if (/^[a-z]$/i.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
          // The letters the desktop's session menu shows (P, U, R, F, A, D).
          const item = enabled.find((entry) => entry.shortcut?.toLowerCase() === event.key.toLowerCase());
          if (item) {
            event.preventDefault();
            setActive(items.indexOf(item));
            select(item);
          }
        }
    }
  };

  const activeItem = items[active];
  const openSub = submenu ? items.find((item) => item.id === submenu) : undefined;
  const describedBy = entries.flatMap((entry) => (entry.type === 'section' && entry.describes ? [`${baseId}-${entry.id}`] : []));

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      aria-describedby={describedBy.length ? describedBy.join(' ') : undefined}
      tabIndex={-1}
      className={className ? `rd-menu ${className}` : 'rd-menu'}
      style={style}
      data-menu-layer=""
      aria-activedescendant={activeItem ? `${baseId}-${activeItem.id}` : undefined}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry) => {
        if (entry.type === 'separator') return <div key={entry.id} role="separator" className="rd-menu__sep" />;
        if (entry.type === 'section') {
          return (
            <div key={entry.id} id={`${baseId}-${entry.id}`} className="rd-menu__section" role="presentation">
              {entry.label}
            </div>
          );
        }
        const index = items.indexOf(entry);
        const toggle = entry.type === 'toggle';
        const hasCheck = !toggle && entry.checked !== undefined;
        const tip = entry.disabled ? entry.disabledReason : entry.tip;
        return (
          <div
            key={entry.id}
            id={`${baseId}-${entry.id}`}
            ref={(el) => {
              if (el) itemRefs.current.set(entry.id, el);
              else itemRefs.current.delete(entry.id);
            }}
            role={toggle ? 'menuitemcheckbox' : hasCheck ? 'menuitemradio' : 'menuitem'}
            aria-checked={toggle ? Boolean(entry.checked) : hasCheck ? entry.checked : undefined}
            aria-disabled={entry.disabled || undefined}
            aria-haspopup={entry.submenu ? 'menu' : undefined}
            aria-expanded={entry.submenu ? submenu === entry.id : undefined}
            data-active={index === active}
            data-tip={tip}
            data-tip-place="right"
            aria-description={tip}
            className={entry.danger ? 'rd-menu__item rd-menu__item--danger' : 'rd-menu__item'}
            onPointerEnter={() => {
              setActive(index);
              if (entry.submenu && !entry.disabled) setSubmenu(entry.id);
              else if (submenu) setSubmenu(null);
            }}
            onClick={() => select(entry)}
          >
            {entry.icon}
            <span className="rd-menu__label">
              {entry.label}
              {/* The space keeps the badge a separate word in the row's accessible name. */}
              {entry.badge ? ' ' : null}
              {entry.badge ? (
                <span className={entry.badge.tone === 'warning' ? 'rd-badge rd-badge--warning rd-menu__badge' : 'rd-badge rd-menu__badge'}>
                  {entry.badge.text}
                </span>
              ) : null}
              {entry.description ? <span className="rd-menu__desc">{entry.description}</span> : null}
            </span>
            {entry.shortcut && !entry.checked ? <span className="rd-menu__right">{entry.shortcut}</span> : null}
            {entry.submenu || entry.value ? (
              <span className="rd-menu__right">
                {entry.value ? <span className="rd-menu__value">{entry.value}</span> : null}
                {entry.submenu ? <ChevronRight {...ICON_SM} /> : null}
              </span>
            ) : null}
            {hasCheck && entry.checked ? (
              <span className="rd-menu__right rd-menu__check">
                <Check {...ICON} />
              </span>
            ) : null}
            {toggle ? (
              <span className="rd-menu__right">
                <span className="rd-toggle rd-menu__switch" aria-hidden="true" />
              </span>
            ) : null}
          </div>
        );
      })}
      {openSub?.submenu ? (
        <Menu
          anchor={itemRefs.current.get(openSub.id) ?? null}
          open
          placement="right-start"
          label={openSub.label}
          entries={openSub.submenu}
          restoreFocus={false}
          className={className}
          onClose={(reason) => {
            setSubmenu(null);
            if (reason === 'select' || reason === 'outside') onClose(reason);
            else menuRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}
