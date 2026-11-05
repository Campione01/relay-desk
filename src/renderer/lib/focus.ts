import type { MouseEvent } from 'react';

/** Keep a clipped scroll-container button under the pointer until its click completes. */
export function focusWithoutScroll(event: MouseEvent<HTMLButtonElement>): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.currentTarget.focus({ preventScroll: true });
}
