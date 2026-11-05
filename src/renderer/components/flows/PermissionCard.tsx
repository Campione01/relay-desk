import { CornerDownLeft } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PermissionDecision, PermissionRequest } from '@shared/types';
import { useT } from '../../i18n';
import { errorText, folderName } from '../../lib/format';
import { inputDiff } from '../../lib/toolActivity';
import { useController } from '../../state/context';
import { DiffView } from '../transcript/DiffView';
import { WorkflowApproval, workflowLaunch } from './WorkflowApproval';

const MAX_DETAIL = 1200;

function isEditable(element: Element | null): boolean {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return true;
  return element instanceof HTMLElement
    && (element.isContentEditable || element.closest('[contenteditable]:not([contenteditable="false"])') !== null);
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

/** Short target for the title: file name, first line of a command, or the URL. */
export function permissionTarget(request: PermissionRequest): string | undefined {
  const input = inputRecord(request.input);
  if (typeof input.file_path === 'string') return folderName(input.file_path);
  if (typeof input.notebook_path === 'string') return folderName(input.notebook_path);
  if (typeof input.command === 'string') {
    const line = input.command.split('\n')[0] ?? '';
    return line.length > 60 ? `${line.slice(0, 59)}…` : line;
  }
  if (typeof input.url === 'string') return input.url;
  if (typeof input.path === 'string') return input.path;
  if (request.blockedPath) return folderName(request.blockedPath);
  return undefined;
}

function detailText(request: PermissionRequest): string | null {
  const input = inputRecord(request.input);
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (request.blockedPath) return request.blockedPath;
  if (typeof input.url === 'string') return input.url;
  if (request.input === undefined || request.input === null) return null;
  const json = JSON.stringify(request.input, null, 2) ?? '';
  return json.length > MAX_DETAIL ? `${json.slice(0, MAX_DETAIL)}…` : json;
}

/** Inline permission prompt above the prompt box (§4.18). */
export function PermissionCard({ viewKey, request }: { viewKey: string; request: PermissionRequest }) {
  const controller = useController();
  const t = useT();
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const diff = inputDiff(request.toolName, request.input);
  const launch = workflowLaunch(request);
  const target = permissionTarget(request);
  const tool = request.displayName ?? request.toolName;
  const title =
    request.title ??
    (launch
      ? launch.name
        ? t('permission.workflow.title', { name: launch.name })
        : t('permission.workflow.titleUnnamed')
      : target
        ? t('permission.titleTarget', { tool, target })
        : t('permission.title', { tool }));
  const subtitle = request.description ?? launch?.description ?? request.decisionReason;
  // A workflow shows its phases and the script on request instead of the raw input.
  const detail = diff || launch ? null : detailText(request);
  const allowSession = !request.suppressAlwaysAllowRule && (request.suggestions?.length ?? 0) > 0;

  // A focused field (even an empty prompt) keeps the focus: the next Space or Enter would otherwise answer the request.
  useEffect(() => {
    const active = document.activeElement;
    if (isEditable(active) || document.querySelector('[aria-modal="true"]')) return;
    const stack = cardRef.current?.closest('.rd-bottom__stack');
    if (active && active !== document.body && !stack?.contains(active)) return;
    (request.defaultToNo ? denyRef : allowRef).current?.focus({ preventScroll: true });
  }, [request.requestId, request.defaultToNo]);

  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  const respond = async (decision: PermissionDecision): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.respondPermission(viewKey, request.requestId, decision);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  const deny = (): void => {
    const message = reason.trim();
    void respond(message ? { behavior: 'deny', message } : { behavior: 'deny' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !request.defaultToNo && !denying) {
      event.preventDefault();
      void respond({ behavior: 'allow', scope: 'once' });
    }
  };

  return (
    <section
      ref={cardRef}
      className="rd-perm"
      aria-label={title}
      data-testid="permission-card"
      data-workflow={launch ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="rd-perm__title">
        <span className="rd-perm__dot" aria-hidden="true" />
        <h3 className="rd-perm__heading">{title}</h3>
        {request.agentId ? <span className="rd-badge rd-badge--warning">{t('permission.subagent')}</span> : null}
      </div>
      {subtitle ? <p className="rd-perm__sub">{subtitle}</p> : null}
      {diff ? <DiffView diff={diff} /> : null}
      {launch ? (
        <WorkflowApproval
          launch={launch}
          note={request.decisionReason && request.decisionReason !== subtitle ? request.decisionReason : undefined}
        />
      ) : null}
      {detail ? <pre className="rd-perm__detail rd-mono rd-selectable">{detail}</pre> : null}
      {denying ? (
        <label className="rd-field">
          <span className="rd-field__label">{t('permission.reasonLabel')}</span>
          <input
            ref={reasonRef}
            className="rd-input"
            value={reason}
            placeholder={t('permission.reasonPlaceholder')}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                deny();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setDenying(false);
              }
            }}
          />
        </label>
      ) : null}
      {error ? (
        <p className="rd-field__error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="rd-perm__actions">
        {denying ? (
          <>
            <button type="button" className="rd-btn rd-btn--secondary" disabled={busy} onClick={() => setDenying(false)}>
              {t('common.back')}
            </button>
            <span className="rd-perm__spacer" />
            <button type="button" className="rd-btn rd-btn--danger" disabled={busy} onClick={deny}>
              {t('permission.denySend')}
            </button>
          </>
        ) : (
          <>
            <button
              ref={denyRef}
              type="button"
              className={request.defaultToNo ? 'rd-btn rd-btn--primary' : 'rd-btn rd-btn--secondary'}
              disabled={busy}
              onClick={() => void respond({ behavior: 'deny' })}
            >
              {t('permission.deny')}
            </button>
            <button type="button" className="rd-btn rd-btn--ghost" disabled={busy} onClick={() => setDenying(true)}>
              {t('permission.denyWithReason')}
            </button>
            <span className="rd-perm__spacer" />
            {allowSession ? (
              <button
                type="button"
                className="rd-btn rd-btn--secondary"
                disabled={busy}
                onClick={() => void respond({ behavior: 'allow', scope: 'session' })}
              >
                {t('permission.allowSession')}
              </button>
            ) : null}
            <button
              ref={allowRef}
              type="button"
              className={request.defaultToNo ? 'rd-btn rd-btn--secondary' : 'rd-btn rd-btn--primary'}
              disabled={busy}
              aria-keyshortcuts={request.defaultToNo ? undefined : 'Control+Enter'}
              onClick={() => void respond({ behavior: 'allow', scope: 'once' })}
            >
              {t('permission.allowOnce')}
              {request.defaultToNo ? null : (
                <span className="rd-btn__kbd" aria-hidden="true">
                  Ctrl
                  <CornerDownLeft size={12} strokeWidth={2} />
                </span>
              )}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
