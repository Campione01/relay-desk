import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useT } from '../../i18n';
import type { SlashEntry } from '../../lib/slash';

interface SlashPopupProps {
  id: string;
  entries: SlashEntry[];
  active: number;
  onHover(index: number): void;
  onChoose(entry: SlashEntry): void;
}

/** Slash-command popup (§4.13): rows without the leading "/", description tooltip beside the highlighted row. */
export function SlashPopup({ id, entries, active, onHover, onChoose }: SlashPopupProps) {
  const t = useT();
  const listRef = useRef<HTMLUListElement>(null);
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);
  const [tipStyle, setTipStyle] = useState<CSSProperties | null>(null);
  const current = entries[active];

  useEffect(() => {
    rowRefs.current[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  useLayoutEffect(() => {
    const row = rowRefs.current[active];
    const list = listRef.current;
    if (!row || !list) {
      setTipStyle(null);
      return;
    }
    const top = row.offsetTop - list.scrollTop;
    setTipStyle({ top: Math.max(0, top) });
  }, [active, entries]);

  const description = current ? current.description || (current.argumentHint ? `/${current.name} ${current.argumentHint}` : '') : '';

  return (
    <div className="rd-slash" data-menu-layer="">
      <ul ref={listRef} id={id} role="listbox" aria-label={t('prompt.slashCommands')} className="rd-slash__list">
        {entries.map((entry, index) => (
          <li
            key={`${entry.source}-${entry.shortcutId ?? entry.name}`}
            id={`${id}-${index}`}
            ref={(el) => {
              rowRefs.current[index] = el;
            }}
            role="option"
            aria-selected={index === active}
            className="rd-slash__row"
            onPointerEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(entry);
            }}
          >
            <span className="rd-slash__name">{entry.name}</span>
            {entry.argumentHint ? <span className="rd-slash__arg">{entry.argumentHint}</span> : null}
            {entry.source === 'shortcut' ? <span className="rd-slash__tag">{t('prompt.fromShortcut')}</span> : null}
          </li>
        ))}
      </ul>
      {description && tipStyle ? (
        <div className="rd-slash__tip" style={tipStyle} role="tooltip">
          {description}
        </div>
      ) : null}
    </div>
  );
}
