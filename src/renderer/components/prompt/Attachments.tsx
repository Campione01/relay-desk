import { FileText, X } from 'lucide-react';
import { useT, type Translate } from '../../i18n';
import { formatBytes, type AttachProblem, type DraftAttachment } from './attachmentFiles';

/** One inline line for the problems of a paste or drop (the first one says the most). */
export function problemText(problems: readonly AttachProblem[], t: Translate): string {
  const first = problems[0];
  if (!first) return '';
  let text: string;
  switch (first.kind) {
    case 'tooMany':
      text = t('attach.tooMany', { max: first.max });
      break;
    case 'tooLarge':
      text = t(first.pdf ? 'attach.pdfTooLarge' : 'attach.imageTooLarge', { name: first.name, limit: formatBytes(first.limit) });
      break;
    case 'unsupported':
      text = t('attach.unsupported', { name: first.name });
      break;
    default:
      text = t('attach.readFailed', { name: first.name });
  }
  return problems.length > 1 ? `${text} ${t('attach.moreProblems', { n: problems.length - 1 })}` : text;
}

/** Chips above the input inside the prompt box: image thumbnails and PDF tiles, each with a remove button. */
export function AttachmentChips({ items, onRemove }: { items: readonly DraftAttachment[]; onRemove(id: string): void }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <ul className="rd-attach" aria-label={t('attach.listLabel')} data-testid="prompt-attachments">
      {items.map((item) => {
        const info = `${item.name} · ${formatBytes(item.size)}`;
        return (
          <li key={item.id} className="rd-attach__item" data-kind={item.kind}>
            <span className="rd-attach__body" tabIndex={0} role="img" aria-label={info} data-tip={info} data-tip-place="top">
              {item.kind === 'image' ? (
                <img className="rd-attach__thumb" src={`data:${item.mediaType};base64,${item.data}`} alt="" draggable={false} />
              ) : (
                <>
                  <span className="rd-attach__icon">
                    <FileText size={16} strokeWidth={1.5} aria-hidden />
                  </span>
                  <span className="rd-attach__text">
                    <span className="rd-attach__name">{item.name}</span>
                    <span className="rd-attach__type">{t('attach.pdf')}</span>
                  </span>
                </>
              )}
            </span>
            <button
              type="button"
              className="rd-attach__remove"
              aria-label={t('attach.remove', { name: item.name })}
              data-tip={t('attach.removeTip')}
              data-tip-place="top"
              onClick={() => onRemove(item.id)}
            >
              <X size={10} strokeWidth={2.25} aria-hidden />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
