import { Trash2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { McpImportPreview, McpServerEntry } from '@shared/types';
import { useT } from '../../i18n';
import { errorText } from '../../lib/format';
import { useController } from '../../state/context';
import { Dialog } from '../ui/Dialog';
import { ICON_SM, IconButton, Toggle } from '../ui/primitives';

export type McpDialogMode = 'import' | 'manage';

type Server = { transport: string; command?: string; args?: string[]; url?: string };

/** "uvx blender-mcp" / the URL: what the server runs, never its environment values. */
export function serverCommand(server: Server): string {
  if (server.transport !== 'stdio') return server.url ?? '';
  return [server.command ?? '', ...(server.args ?? [])].filter(Boolean).join(' ');
}

type Load<T> = { state: 'loading' } | { state: 'loaded'; data: T } | { state: 'error'; error: string };

function ImportView({ onImported }: { onImported(list: McpServerEntry[]): void }) {
  const controller = useController();
  const t = useT();
  const [preview, setPreview] = useState<Load<McpImportPreview>>({ state: 'loading' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setPreview({ state: 'loading' });
    controller.relay.mcp.previewDesktopImport().then(
      (data) => {
        setPreview({ state: 'loaded', data });
        setSelected(new Set(data.servers.filter((s) => !s.exists).map((s) => s.name)));
      },
      (reason: unknown) => setPreview({ state: 'error', error: errorText(reason) }),
    );
  }, [controller]);

  useEffect(() => load(), [load]);

  const toggle = (name: string, on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    if (preview.state !== 'loaded') return;
    const names = preview.data.servers.map((s) => s.name).filter((name) => selected.has(name));
    if (names.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      onImported(await controller.relay.mcp.importFromDesktop(names));
    } catch (reason) {
      setError(t('mcpImport.actionError', { error: errorText(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p>{t('mcpImport.intro')}</p>
      <p className="rd-mcp__callout" data-testid="mcp-env-note">
        <TriangleAlert {...ICON_SM} />
        <span>{t('mcpImport.envNote')}</span>
      </p>
      {preview.state === 'loading' ? <p role="status">{t('mcpImport.loading')}</p> : null}
      {preview.state === 'error' ? (
        <p role="alert" className="rd-field__error">
          {t('mcpImport.error', { error: preview.error })}{' '}
          <button type="button" className="rd-link" onClick={load}>
            {t('common.retry')}
          </button>
        </p>
      ) : null}
      {preview.state === 'loaded' ? (
        <>
          <p className="rd-context-path">{t('mcpImport.source', { path: preview.data.sourcePath })}</p>
          {preview.data.warnings.length > 0 ? (
            <ul className="rd-mcp__warnings" aria-label={t('mcpImport.warnings')}>
              {preview.data.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {preview.data.servers.length === 0 ? (
            <p className="rd-slist__empty">{t('mcpImport.none')}</p>
          ) : (
            <ul className="rd-slist" aria-label={t('mcpImport.title')}>
              {preview.data.servers.map((server) => (
                <li key={server.name} className="rd-slist__row rd-mcp__row" data-testid="mcp-preview-row">
                  <label className="rd-mcp__pick">
                    <input
                      type="checkbox"
                      checked={selected.has(server.name)}
                      aria-label={t('mcpImport.select', { name: server.name })}
                      onChange={(event) => toggle(server.name, event.currentTarget.checked)}
                    />
                  </label>
                  <span className="rd-slist__main">
                    <span className="rd-mcp__title">
                      <span className="rd-slist__label">{server.name}</span>
                      <span className="rd-badge">{server.transport}</span>
                      {server.exists ? (
                        <span className="rd-badge rd-badge--warning" data-tip={t('mcpImport.existsHint')}>
                          {t('mcpImport.exists')}
                        </span>
                      ) : null}
                    </span>
                    <code className="rd-mcp__cmd">{serverCommand(server)}</code>
                    <span className="rd-slist__detail">
                      {server.envKeys.length > 0 ? t('mcpImport.env', { names: server.envKeys.join(', ') }) : t('mcpImport.noEnv')}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
      <p className="rd-field__hint">{t('connectors.appliesLater')}</p>
      <p className="rd-field__hint">{t('connectors.blenderHint')}</p>
      {error ? (
        <p role="alert" className="rd-field__error">
          {error}
        </p>
      ) : null}
      <div className="rd-mcp__actions">
        <button
          type="button"
          className="rd-btn rd-btn--primary"
          disabled={busy || preview.state !== 'loaded' || selected.size === 0}
          onClick={() => void submit()}
        >
          {t('mcpImport.submit', { n: selected.size })}
        </button>
      </div>
    </>
  );
}

function ManageView({ onChanged, onImport }: { onChanged(list: McpServerEntry[]): void; onImport(): void }) {
  const controller = useController();
  const t = useT();
  const [list, setList] = useState<Load<McpServerEntry[]>>({ state: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setList({ state: 'loading' });
    controller.relay.mcp.list().then(
      (data) => setList({ state: 'loaded', data }),
      (reason: unknown) => setList({ state: 'error', error: errorText(reason) }),
    );
  }, [controller]);

  useEffect(() => load(), [load]);

  const run = async (name: string, action: () => Promise<McpServerEntry[]>): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      const data = await action();
      setList({ state: 'loaded', data });
      onChanged(data);
    } catch (reason) {
      setError(t('mcpImport.actionError', { error: errorText(reason) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <p>{t('mcpImport.manageIntro')}</p>
      {list.state === 'loading' ? <p role="status">{t('common.loading')}</p> : null}
      {list.state === 'error' ? (
        <p role="alert" className="rd-field__error">
          {list.error}{' '}
          <button type="button" className="rd-link" onClick={load}>
            {t('common.retry')}
          </button>
        </p>
      ) : null}
      {list.state === 'loaded' && list.data.length === 0 ? (
        <p className="rd-slist__empty">
          {t('mcpImport.manageEmpty')}{' '}
          <button type="button" className="rd-link" onClick={onImport}>
            {t('connectors.import')}
          </button>
        </p>
      ) : null}
      {list.state === 'loaded' && list.data.length > 0 ? (
        <ul className="rd-slist" aria-label={t('mcpImport.manageTitle')}>
          {list.data.map((entry) => (
            <li key={entry.name} className="rd-slist__row rd-mcp__row" data-testid="mcp-entry-row">
              <span className="rd-slist__main">
                <span className="rd-mcp__title">
                  <span className="rd-slist__label">{entry.name}</span>
                  <span className="rd-badge">{entry.transport}</span>
                </span>
                <code className="rd-mcp__cmd">{serverCommand(entry)}</code>
                {entry.envKeys.length > 0 ? (
                  <span className="rd-slist__detail">{t('mcpImport.env', { names: entry.envKeys.join(', ') })}</span>
                ) : null}
              </span>
              <Toggle
                checked={entry.enabled}
                disabled={busy === entry.name}
                label={t('mcpImport.enable', { name: entry.name })}
                onChange={(enabled) => void run(entry.name, () => controller.relay.mcp.setEnabled(entry.name, enabled))}
              />
              <IconButton
                label={t('mcpImport.remove', { name: entry.name })}
                icon={<Trash2 {...ICON_SM} />}
                size="small"
                muted
                tipPlace="left"
                disabled={busy === entry.name}
                onClick={() => void run(entry.name, () => controller.relay.mcp.remove(entry.name))}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <p className="rd-field__hint">{t('connectors.appliesLater')}</p>
      {error ? (
        <p role="alert" className="rd-field__error">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** "Import from desktop" preview and the small manage view of Relay's own MCP list (U7). */
export function McpImportDialog({
  mode,
  onModeChange,
  onClose,
  onChanged,
}: {
  mode: McpDialogMode;
  onModeChange(mode: McpDialogMode): void;
  onClose(): void;
  onChanged(list: McpServerEntry[]): void;
}) {
  const controller = useController();
  const t = useT();
  return (
    <Dialog
      open
      size="medium"
      title={mode === 'import' ? t('mcpImport.title') : t('mcpImport.manageTitle')}
      onClose={onClose}
      testId="mcp-dialog"
      footer={
        <>
          {mode === 'manage' ? (
            <button type="button" className="rd-btn rd-btn--ghost rd-dialog__foot-left" onClick={() => onModeChange('import')}>
              {t('connectors.import')}
            </button>
          ) : (
            <button type="button" className="rd-btn rd-btn--ghost rd-dialog__foot-left" onClick={() => onModeChange('manage')}>
              {t('connectors.manage')}
            </button>
          )}
          <button type="button" className="rd-btn rd-btn--secondary" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      {mode === 'import' ? (
        <ImportView
          onImported={(list) => {
            onChanged(list);
            controller.toast('info', t('mcpImport.done', { n: list.length }));
            onModeChange('manage');
          }}
        />
      ) : (
        <ManageView onChanged={onChanged} onImport={() => onModeChange('import')} />
      )}
    </Dialog>
  );
}
