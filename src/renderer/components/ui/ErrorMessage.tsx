import { useT } from '../../i18n';
import { friendlyError } from '../../lib/errors';

/** A known native failure in plain words, the original text under Details; any other message as it came. */
export function ErrorMessage({ message, className }: { message: string; className: string }) {
  const t = useT();
  const friendly = friendlyError(message);
  if (!friendly) return <span className={`${className} rd-selectable`}>{message}</span>;
  return (
    <div className={`${className} rd-errmsg`}>
      <span className="rd-selectable">{t(friendly.key, friendly.params)}</span>
      <details className="rd-errmsg__details">
        <summary className="rd-errmsg__summary">{t('error.details')}</summary>
        <span className="rd-errmsg__raw rd-selectable">{message}</span>
      </details>
    </div>
  );
}
