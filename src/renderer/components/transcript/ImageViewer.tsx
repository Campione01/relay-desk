import { ChevronLeft, ChevronRight, Image as ImageIcon, X } from 'lucide-react';
import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ImageRef, TranscriptItem } from '@shared/types';
import { useT } from '../../i18n';
import { useController } from '../../state/context';
import { useImageUrl } from './imageCache';

const FOCUSABLE = 'button:not([disabled])';

/** Source label of a tool's images: the tool name, "server · tool" for MCP tools. */
export function imageSourceLabel(toolName: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return mcp ? `${mcp[1]} · ${mcp[2]}` : toolName;
}

/** One page of the viewer: an image of a transcript item (`index` within that item) and its source label. */
export interface GalleryImage {
  image: ImageRef;
  label: string;
  itemId: string;
  index: number;
}

/** Every image of the conversation in transcript order: pasted user images and tool images, collapsed or not. */
export function collectImages(items: readonly TranscriptItem[], pastedLabel: string): GalleryImage[] {
  const out: GalleryImage[] = [];
  for (const item of items) {
    if (item.kind !== 'user' && item.kind !== 'tool') continue;
    const label = item.kind === 'user' ? pastedLabel : imageSourceLabel(item.name);
    (item.imageRefs ?? []).forEach((image, index) => out.push({ image, label, itemId: item.id, index }));
  }
  return out;
}

/** Opens the conversation-wide viewer at an item's image; provided by the transcript. */
export const ImageGalleryContext = createContext<((itemId: string, index: number) => void) | null>(null);

function Thumb({
  image,
  index,
  total,
  variant,
  onOpen,
}: {
  image: ImageRef;
  index: number;
  total: number;
  variant: 'tool' | 'user';
  onOpen(index: number): void;
}) {
  const t = useT();
  const controller = useController();
  const ref = useRef<HTMLButtonElement>(null);
  const url = useImageUrl(controller.relay.sessions, image.key, ref);
  const state = url === undefined ? 'loading' : url === null ? 'missing' : 'loaded';
  return (
    <button
      ref={ref}
      type="button"
      className={`rd-imgthumb rd-imgthumb--${variant}`}
      data-state={state}
      data-testid="image-thumb"
      aria-label={total > 1 ? t('image.openOf', { n: index + 1, total }) : t('image.open')}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(index);
      }}
    >
      {url ? <img src={url} alt="" draggable={false} /> : null}
      {url === null ? <ImageIcon size={variant === 'user' ? 18 : 12} strokeWidth={1.5} aria-hidden="true" /> : null}
    </button>
  );
}

/**
 * Real thumbnails of one transcript item. Inside the transcript (`itemId` set) a click opens the viewer over every
 * image of the conversation at this one; elsewhere over this item's images. `limit` caps the visible thumbnails.
 */
export function ImageThumbs({
  images,
  label,
  variant,
  limit,
  itemId,
}: {
  images: readonly ImageRef[];
  label: string;
  variant: 'tool' | 'user';
  limit?: number;
  itemId?: string;
}) {
  const gallery = useContext(ImageGalleryContext);
  const [open, setOpen] = useState<number | null>(null);
  if (images.length === 0) return null;
  const shown = limit === undefined ? images : images.slice(0, Math.max(0, limit));
  const onOpen = gallery && itemId !== undefined ? (index: number) => gallery(itemId, index) : setOpen;
  return (
    <>
      {shown.map((image, index) => (
        <Thumb key={`${index}:${image.key}`} image={image} index={index} total={images.length} variant={variant} onOpen={onOpen} />
      ))}
      {open !== null ? (
        <ImageViewer
          images={images.map((image, index) => ({ image, label, itemId: itemId ?? '', index }))}
          start={open}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}

/** Grey placeholders for images whose bytes never reached the renderer (count only). */
export function ImagePlaceholders({ count, variant }: { count: number; variant: 'tool' | 'user' }) {
  if (count <= 0) return null;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`rd-imgthumb rd-imgthumb--${variant}`} data-state="missing" aria-hidden="true">
          <ImageIcon size={variant === 'user' ? 18 : 12} strokeWidth={1.5} />
        </span>
      ))}
    </>
  );
}

/** Full-window image viewer (desktop-light-08): dimmed overlay, fitted image, close, source label and pager. */
export function ImageViewer({
  images,
  start,
  onClose,
}: {
  images: readonly GalleryImage[];
  start: number;
  onClose(): void;
}) {
  const t = useT();
  const controller = useController();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [index, setIndex] = useState(() => Math.min(Math.max(0, start), images.length - 1));
  /** Natural aspect ratio of the shown image once it decoded; null when it failed to decode. */
  const [fit, setFit] = useState<{ key: string; ratio: number | null } | null>(null);
  const { image, label } = images[index]!;
  const url = useImageUrl(controller.relay.sessions, image.key, null, true);
  const total = images.length;
  const ratio = fit?.key === image.key ? fit.ratio : undefined;
  const shown = ratio === null ? null : url;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  const go = (next: number): void => {
    if (next >= 0 && next < total) setIndex(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      event.stopPropagation();
      go(index + (event.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    if (event.key !== 'Tab' || !rootRef.current) return;
    const focusable = [...rootRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const inside = rootRef.current.contains(document.activeElement);
    if (event.shiftKey && (document.activeElement === first || !inside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !inside)) {
      event.preventDefault();
      first.focus();
    }
  };

  const imgStyle = ratio ? ({ '--rd-img-ratio': String(ratio) } as CSSProperties) : undefined;

  return createPortal(
    <div
      ref={rootRef}
      className="rd-imgview"
      role="dialog"
      aria-modal="true"
      aria-label={t('image.viewer', { label })}
      data-testid="image-viewer"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        if (target === event.currentTarget || target.classList.contains('rd-imgview__stage')) onCloseRef.current();
      }}
    >
      <div className="rd-imgview__stage">
        {shown ? (
          <img
            key={image.key}
            className="rd-imgview__img"
            data-fitted={ratio ? 'true' : undefined}
            style={imgStyle}
            src={shown}
            alt={total > 1 ? `${label} · ${t('image.position', { n: index + 1, total })}` : label}
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              setFit({ key: image.key, ratio: naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : null });
            }}
            onError={() => setFit({ key: image.key, ratio: null })}
          />
        ) : (
          <div className="rd-imgview__missing" role={shown === null ? 'status' : undefined}>
            {shown === null ? (
              <>
                <ImageIcon size={28} strokeWidth={1.25} aria-hidden="true" />
                <span>{t('image.missing')}</span>
              </>
            ) : null}
          </div>
        )}
      </div>
      <button
        ref={closeRef}
        type="button"
        className="rd-imgview__close"
        aria-label={t('common.close')}
        onClick={() => onCloseRef.current()}
      >
        <X size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
      <div className="rd-imgview__source">{label}</div>
      {total > 1 ? (
        <div className="rd-imgview__pager">
          <button
            type="button"
            className="rd-imgview__nav"
            aria-label={t('image.prev')}
            aria-disabled={index === 0 || undefined}
            onClick={() => go(index - 1)}
          >
            <ChevronLeft size={24} strokeWidth={1.5} aria-hidden="true" />
          </button>
          <span className="rd-imgview__count rd-tnum" aria-live="polite">
            {t('image.position', { n: index + 1, total })}
          </span>
          <button
            type="button"
            className="rd-imgview__nav"
            aria-label={t('image.next')}
            aria-disabled={index === total - 1 || undefined}
            onClick={() => go(index + 1)}
          >
            <ChevronRight size={24} strokeWidth={1.5} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
