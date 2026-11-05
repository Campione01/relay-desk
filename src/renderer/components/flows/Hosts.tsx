import { CircleAlert, Info, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { useAppState, useController } from '../../state/context';
import type { ConfirmRequest, TextRequest } from '../../state/types';
import { Dialog } from '../ui/Dialog';
import { ErrorMessage } from '../ui/ErrorMessage';
import { ICON, ICON_SM, IconButton } from '../ui/primitives';

/** Renders controller.confirm() requests. */
export function ConfirmHost() {
  const request = useAppState((s) => s.confirm);
  return request ? <ConfirmDialog key={request.id} request={request} /> : null;
}

function ConfirmDialog({ request }: { request: ConfirmRequest }) {
  const controller = useController();
  const t = useT();
  const [checked, setChecked] = useState(false);
  return (
    <Dialog
      open
      role="alertdialog"
      title={request.title}
      onClose={() => controller.resolveConfirm(false)}
      footer={
        <>
          <button type="button" className="rd-btn rd-btn--secondary" onClick={() => controller.resolveConfirm(false)}>
            {request.cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="button"
            data-autofocus=""
            className={request.danger ? 'rd-btn rd-btn--danger' : 'rd-btn rd-btn--primary'}
            onClick={() => controller.resolveConfirm(true, checked)}
          >
            {request.confirmLabel}
          </button>
        </>
      }
    >
      <p className="rd-prewrap">{request.body}</p>
      {request.checkboxLabel ? (
        <label className="rd-check">
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>{request.checkboxLabel}</span>
        </label>
      ) : null}
    </Dialog>
  );
}

function TextDialog({ request }: { request: TextRequest }) {
  const controller = useController();
  const t = useT();
  const [value, setValue] = useState(request.initial ?? '');
  useEffect(() => setValue(request.initial ?? ''), [request.id, request.initial]);
  const canSubmit = request.optional || value.trim().length > 0;
  const submit = (): void => {
    if (canSubmit) controller.resolveText(value);
  };
  const inputId = `text-${request.id}`;
  return (
    <Dialog
      open
      title={request.title}
      onClose={() => controller.resolveText(null)}
      footer={
        <>
          <button type="button" className="rd-btn rd-btn--secondary" onClick={() => controller.resolveText(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="rd-btn rd-btn--primary" disabled={!canSubmit} onClick={submit}>
            {request.confirmLabel}
          </button>
        </>
      }
    >
      <form
        className="rd-field"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label className="rd-field__label" htmlFor={inputId}>
          {request.label}
        </label>
        {request.multiline ? (
          <textarea
            id={inputId}
            data-autofocus=""
            className="rd-textarea"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        ) : (
          <input
            id={inputId}
            data-autofocus=""
            className="rd-input"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
        {request.hint ? <span className="rd-field__hint">{request.hint}</span> : null}
      </form>
    </Dialog>
  );
}

/** Renders controller.askText() requests. */
export function TextRequestHost() {
  const request = useAppState((s) => s.textRequest);
  return request ? <TextDialog key={request.id} request={request} /> : null;
}

export function Toasts() {
  const controller = useController();
  const t = useT();
  const toasts = useAppState((s) => s.toasts);
  return (
    <div className="rd-toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={toast.kind === 'error' ? 'rd-toast rd-toast--error' : 'rd-toast'}>
          {toast.kind === 'error' ? (
            <CircleAlert {...ICON} color="var(--rd-danger-text)" />
          ) : (
            <Info {...ICON} color="var(--rd-icon-muted)" />
          )}
          {toast.kind === 'error' ? (
            <ErrorMessage className="rd-toast__text" message={toast.text} />
          ) : (
            <span className="rd-toast__text">{toast.text}</span>
          )}
          {toast.retry ? (
            <button
              type="button"
              className="rd-link"
              onClick={() => {
                controller.dismissToast(toast.id);
                toast.retry?.();
              }}
            >
              {t('common.retry')}
            </button>
          ) : null}
          <IconButton
            label={t('common.dismiss')}
            icon={<X {...ICON_SM} />}
            size="small"
            muted
            onClick={() => controller.dismissToast(toast.id)}
          />
        </div>
      ))}
    </div>
  );
}
