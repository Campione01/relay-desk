import { useT } from '../../i18n';
import { collapseContext } from '../../lib/diff';
import type { InputDiff } from '../../lib/toolActivity';

const MAX_ROWS = 400;

export function DiffChip({ added, removed }: { added: number; removed: number }) {
  const t = useT();
  return (
    <span className="rd-diffchip rd-mono rd-tnum" aria-label={t('diff.stats', { added, removed })}>
      <span className="rd-diffchip__add">+{added}</span>
      <span className="rd-diffchip__del">−{removed}</span>
    </span>
  );
}

/** Line diff with numbers and +/− markers (§4.7 code/diff blocks). */
export function DiffView({ diff, label }: { diff: InputDiff; label?: string }) {
  const t = useT();
  const rows = diff.isNewContent ? diff.lines : collapseContext(diff.lines, 3);
  const visible = rows.slice(0, MAX_ROWS);
  const hidden = rows.length - visible.length;
  return (
    <figure className="rd-diff" aria-label={label ?? diff.path ?? t('diff.label')}>
      {diff.path ? (
        <figcaption className="rd-diff__head">
          <span className="rd-diff__path rd-mono">{diff.path}</span>
          <span className="rd-diff__stats rd-mono rd-tnum">
            <span className="rd-diff__plus">+{diff.stats.added}</span>{' '}
            <span className="rd-diff__minus">−{diff.stats.removed}</span>
          </span>
        </figcaption>
      ) : null}
      <div className="rd-diff__body rd-mono rd-selectable" role="table">
        {visible.map((line, index) =>
          line === null ? (
            <div key={`gap-${index}`} className="rd-diff__gap" role="row">
              <span role="cell">⋯</span>
            </div>
          ) : (
            <div key={index} className={`rd-diff__line rd-diff__line--${line.type}`} role="row">
              <span className="rd-diff__no" role="cell">
                {line.type === 'del' ? line.oldNo : line.newNo}
              </span>
              <span className="rd-diff__mark" role="cell" aria-label={line.type === 'add' ? t('diff.added') : line.type === 'del' ? t('diff.removed') : undefined}>
                {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
              </span>
              <span className="rd-diff__text" role="cell">
                {line.text || ' '}
              </span>
            </div>
          ),
        )}
        {hidden > 0 ? (
          <div className="rd-diff__gap" role="row">
            <span role="cell">{t('diff.moreLines', { n: hidden })}</span>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
