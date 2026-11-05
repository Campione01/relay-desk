import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { initialOf } from '../../lib/format';

/** Lucide defaults used across the app (§4.1: 16 px glyph, 1.5 stroke). */
export const ICON = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;
export const ICON_SM = { size: 14, strokeWidth: 1.5, 'aria-hidden': true } as const;
export const ICON_XS = { size: 12, strokeWidth: 1.75, 'aria-hidden': true } as const;

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  label: string;
  /** Shortcut shown in the tooltip after the label. */
  shortcut?: string;
  icon: ReactNode;
  size?: 'default' | 'square' | 'small';
  muted?: boolean;
  tipPlace?: 'bottom' | 'top' | 'right' | 'left';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, icon, size = 'default', muted, tipPlace, className, type, ...rest },
  ref,
) {
  const classes = ['rd-iconbtn'];
  if (size === 'square') classes.push('rd-iconbtn--sq');
  if (size === 'small') classes.push('rd-iconbtn--sm');
  if (muted) classes.push('rd-iconbtn--muted');
  if (className) classes.push(className);
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      data-tip={label}
      data-tip-key={shortcut}
      data-tip-place={tipPlace}
      className={classes.join(' ')}
      {...rest}
    >
      {icon}
    </button>
  );
});

export function Spinner({ small, label }: { small?: boolean; label?: string }) {
  return (
    <span
      className={small ? 'rd-spinner rd-spinner--sm' : 'rd-spinner'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function MiniBar({ percent, high }: { percent: number; high?: boolean }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span className={high ? 'rd-minibar rd-minibar--high' : 'rd-minibar'} aria-hidden="true">
      <span className="rd-minibar__fill" style={{ width: `${clamped}%` }} />
    </span>
  );
}

export const HIGH_USAGE = 80;

/**
 * 14 px usage ring (§4.11): blue arc on a grey track; the whole ring turns red at high usage, and
 * limit red (as in desktop-light-07) when a plan window is at its limit.
 */
export function UsageRing({ percent, limit }: { percent: number | null; limit?: boolean }) {
  const r = 6;
  const circumference = 2 * Math.PI * r;
  const value = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const high = limit || (percent !== null && value >= HIGH_USAGE);
  const track = limit ? 'var(--rd-meter-high)' : high ? 'var(--rd-usage-ring-high)' : 'var(--rd-border)';
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="rd-ring" data-limit={limit || undefined}>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" stroke={track} />
      {!high && value > 0 ? (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          strokeWidth="2"
          stroke="var(--rd-usage-ring)"
          strokeLinecap="round"
          strokeDasharray={`${(value / 100) * circumference} ${circumference}`}
          transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="rd-toggle"
      onClick={() => onChange(!checked)}
    />
  );
}

export function Avatar({ name, square }: { name: string; square?: boolean }) {
  return (
    <span className={square ? 'rd-avatar rd-avatar--square' : 'rd-avatar'} aria-hidden="true">
      {initialOf(name)}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rd-kbd">{children}</kbd>;
}
