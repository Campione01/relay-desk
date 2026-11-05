import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { focusWithoutScroll } from '../../lib/focus';
import { useAppState, useController } from '../../state/context';
import type { PanelCardId } from '../../state/types';
import { ICON_XS } from '../ui/primitives';

/** Right-panel card (§4.14): the whole header row toggles; summary on the right. */
export function PanelCard({
  id,
  title,
  summary,
  children,
}: {
  id: PanelCardId;
  title: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const controller = useController();
  const open = useAppState((s) => s.ui.cards[id] ?? false);
  const bodyId = useId();
  return (
    <section className="rd-card" data-open={open} data-testid={`card-${id}`}>
      <button
        type="button"
        className="rd-card__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onMouseDown={focusWithoutScroll}
        onClick={() => controller.setCard(id, !open)}
      >
        <span className="rd-card__title">{title}</span>
        {open ? <ChevronDown {...ICON_XS} className="rd-card__chev" /> : <ChevronRight {...ICON_XS} className="rd-card__chev" />}
        {!open && summary !== undefined && summary !== null ? <span className="rd-card__summary">{summary}</span> : null}
      </button>
      {open ? (
        <div id={bodyId} className="rd-card__body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
