import { X } from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n';
import { ICON_SM, IconButton } from './primitives';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  open: boolean;
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'default' | 'medium' | 'wide';
  /** Backdrop click and Esc close the dialog (default true). */
  dismissable?: boolean;
  role?: 'dialog' | 'alertdialog';
  icon?: ReactNode;
  testId?: string;
  /** Keep transient informational notices from obscuring sensitive auth dialogs; errors remain visible. */
  suppressInfoToasts?: boolean;
}

/** Modal dialog: focus moves in (first [data-autofocus] or focusable), Tab is trapped, focus returns on close. */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'default',
  dismissable = true,
  role = 'dialog',
  icon,
  testId,
  suppressInfoToasts = false,
}: DialogProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current;
    const target =
      root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>(FOCUSABLE) ?? root;
    target?.focus({ preventScroll: true });
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && dismissable) {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const sizeClass = size === 'wide' ? ' rd-dialog--wide' : size === 'medium' ? ' rd-dialog--medium' : '';

  return createPortal(
    <div
      className="rd-backdrop"
      data-menu-layer=""
      data-suppress-info-toasts={suppressInfoToasts ? '' : undefined}
      onMouseDown={(event) => {
        if (dismissable && event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`rd-dialog${sizeClass}`}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        <div className="rd-dialog__head">
          {icon}
          <h2 id={titleId} className="rd-dialog__title">
            {title}
          </h2>
          {dismissable ? (
            <IconButton label={t('common.close')} icon={<X {...ICON_SM} />} size="small" muted onClick={() => onCloseRef.current()} />
          ) : null}
        </div>
        <div className="rd-dialog__body">{children}</div>
        {footer ? <div className="rd-dialog__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
