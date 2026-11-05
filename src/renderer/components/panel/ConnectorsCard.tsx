import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { McpServerEntry, McpServerState } from '@shared/types';
import { plural, useT } from '../../i18n';
import { errorText } from '../../lib/format';
import { useAppState, useController, useCurrentView } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import { McpImportDialog, type McpDialogMode } from '../flows/McpImportDialog';
import { Avatar, ICON_SM, IconButton, Toggle } from '../ui/primitives';
import { PanelCard } from './PanelCard';


/** The desktop and Relay both start their own Blender MCP server, and the add-on accepts one connection. */
export function mentionsBlender(names: readonly string[]): boolean {
  return names.some((name) => /blender/i.test(name));
}

function LiveRow({
  server,
  busy,
  onToggle,
  onReconnect,
}: {
  server: McpServerState;
  busy: boolean;
  onToggle(enabled: boolean): void;
  onReconnect(): void;
}) {
  const t = useT();
  const status = t(`connectors.status.${server.status}`);
  const meta =
    server.status === 'connected'
      ? plural(t, 'connectors.tools.one', 'connectors.tools.other', server.toolCount)
      : status;
  const tip = [status, server.error, server.scope ? t('connectors.scope', { scope: server.scope }) : null].filter(Boolean).join('\n');
  return (
    <li className="rd-conn" data-testid="connector-row" data-status={server.status}>
      <Avatar name={server.name} square />
      <span className="rd-conn__name" data-tip={server.name.length > 18 ? server.name : undefined} data-tip-place="left">
        {server.name}
      </span>
      <span className="rd-conn__meta" data-tip={tip} data-tip-place="left">
        <span className={`rd-conn__dot rd-conn__dot--${server.status}`} role="img" aria-label={status} />
        <span className="rd-tnum">{meta}</span>
      </span>
      {server.status === 'failed' ? (
        <IconButton
          label={t('connectors.reconnect', { name: server.name })}
          icon={<RotateCw {...ICON_SM} />}
          size="small"
          muted
          tipPlace="left"
          disabled={busy}
          onClick={onReconnect}
        />
      ) : null}
      <Toggle
        checked={server.status !== 'disabled'}
        disabled={busy}
        label={t('connectors.toggle', { name: server.name })}
        onChange={onToggle}
      />
    </li>
  );
}

function ConfiguredRow({ entry }: { entry: McpServerEntry }) {
  const t = useT();
  return (
    <li className="rd-conn" data-testid="connector-row" data-status={entry.enabled ? 'enabled' : 'disabled'}>
      <Avatar name={entry.name} square />
      <span className="rd-conn__name">{entry.name}</span>
      <span className="rd-conn__meta">{entry.enabled ? t('connectors.on') : t('connectors.status.disabled')}</span>
    </li>
  );
}

/** U7: MCP servers of the session in view (live status and toggles) or Relay's own list on read-only views. */
export function ConnectorsCard() {
  const controller = useController();
  const t = useT();
  const view = useCurrentView();
  const open = useAppState((s) => s.ui.cards.connectors);
  const [dialog, setDialog] = useState<McpDialogMode | null>(null);
  const [live, setLive] = useState<{ handleId: string; servers: McpServerState[] } | null>(null);
  const [failedHandle, setFailedHandle] = useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = useState(0);
  const [configured, setConfigured] = useState<{ state: 'loading' | 'loaded' | 'error'; list: McpServerEntry[]; error?: string }>({
    state: 'loading',
    list: [],
  });
  const [busy, setBusy] = useState<{ handleId: string; name: string } | null>(null);
  const viewKey = view?.key;
  const handleId = view && hasOpenHandle(view) ? view.handleId : undefined;
  const engineServers = view?.mcp;

  const loadConfigured = useCallback(() => {
    setConfigured((prev) => ({ ...prev, state: 'loading', error: undefined }));
    controller.relay.mcp.list().then(
      (list) => setConfigured({ state: 'loaded', list }),
      (error: unknown) => setConfigured((prev) => ({ state: 'error', list: prev.list, error: errorText(error) })),
    );
  }, [controller]);

  // Live session: ask for the status when the card opens; engine `mcp` events keep it current afterwards.
  useEffect(() => {
    if (!open || !handleId || !viewKey) return;
    let cancelled = false;
    const previousServers = controller.view(viewKey)?.mcp;
    const isCurrent = () => {
      const current = controller.currentView();
      return !cancelled && current?.key === viewKey && current.handleId === handleId && current.mcp === previousServers;
    };
    setFailedHandle(null);
    controller.relay.engine.mcpStatus(handleId).then(
      (servers) => {
        // An event received after this request started owns the newer status.
        if (isCurrent()) setLive({ handleId, servers });
      },
      () => {
        if (isCurrent()) setFailedHandle(handleId);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [controller, open, handleId, viewKey, statusAttempt]);

  useEffect(() => {
    if (handleId && engineServers) {
      setLive({ handleId, servers: engineServers });
      setFailedHandle(null);
    }
  }, [handleId, engineServers]);

  useEffect(() => {
    if (open && !handleId) loadConfigured();
  }, [open, handleId, loadConfigured]);

  const servers = handleId ? (live?.handleId === handleId ? live.servers : (engineServers ?? null)) : null;

  const act = async (name: string, run: (id: string) => Promise<McpServerState[]>): Promise<void> => {
    if (!handleId || !viewKey) return;
    const operation = { handleId, name };
    const previousServers = controller.view(viewKey)?.mcp;
    setBusy(operation);
    try {
      const next = await run(handleId);
      const current = controller.currentView();
      if (current?.key === viewKey && current.handleId === handleId && current.mcp === previousServers) {
        setLive({ handleId, servers: next });
      }
    } catch (error) {
      controller.toast('error', errorText(error));
    } finally {
      setBusy((current) => current === operation ? null : current);
    }
  };

  const connected = servers ? servers.filter((s) => s.status === 'connected').length : 0;
  const summary = handleId
    ? servers
      ? t('connectors.connected', { n: connected })
      : undefined
    : configured.state === 'loaded' || configured.list.length > 0
      ? t('connectors.enabled', { n: configured.list.filter((e) => e.enabled).length })
      : undefined;
  const names = servers ? servers.map((s) => s.name) : configured.list.map((e) => e.name);

  return (
    <>
      <PanelCard
        id="connectors"
        title={t('connectors.title')}
        summary={summary}
      >
        {handleId && failedHandle === handleId ? (
          <p className="rd-card__note rd-task__error">
            <span>{t('connectors.loadError')}</span>
            <button type="button" className="rd-link" onClick={() => setStatusAttempt((attempt) => attempt + 1)}>
              {t('common.retry')}
            </button>
          </p>
        ) : null}
        {handleId ? (
          servers === null ? (
            failedHandle !== handleId ? (
              <p className="rd-card__note">{t('common.loading')}</p>
            ) : null
          ) : servers.length === 0 ? (
            <p className="rd-card__note">{t('connectors.empty')}</p>
          ) : (
            <ul className="rd-card__rows" aria-label={t('connectors.title')}>
              {servers.map((server) => (
                <LiveRow
                  key={server.name}
                  server={server}
                  busy={busy?.handleId === handleId && busy.name === server.name}
                  onToggle={(enabled) => void act(server.name, () => controller.toggleMcp(view!.key, server.name, enabled))}
                  onReconnect={() => void act(server.name, (id) => controller.relay.engine.mcpReconnect(id, server.name))}
                />
              ))}
            </ul>
          )
        ) : (
          <>
            {configured.state === 'loading' && configured.list.length === 0 ? (
              <p className="rd-card__note">{t('common.loading')}</p>
            ) : null}
            {configured.state === 'error' ? (
              <p className="rd-card__note rd-task__error">
                <span>{t('connectors.loadError')}</span>
                <button type="button" className="rd-link" onClick={loadConfigured}>
                  {t('common.retry')}
                </button>
              </p>
            ) : null}
            {configured.state === 'loaded' && configured.list.length === 0 ? (
              <p className="rd-card__note">{t('connectors.emptyRelay')}</p>
            ) : null}
            {configured.list.length > 0 ? (
              <ul className="rd-card__rows" aria-label={t('connectors.title')}>
                {configured.list.map((entry) => (
                  <ConfiguredRow key={entry.name} entry={entry} />
                ))}
              </ul>
            ) : null}
            {configured.list.length > 0 ? <p className="rd-card__note">{t('connectors.readOnlyNote')}</p> : null}
          </>
        )}
        {mentionsBlender(names) ? (
          <p className="rd-card__note" data-testid="blender-hint">
            {t('connectors.blenderHint')}
          </p>
        ) : null}
        <div className="rd-card__foot">
          <button type="button" className="rd-link" onClick={() => setDialog('manage')}>
            {t('connectors.manage')}
          </button>
          <button type="button" className="rd-link" onClick={() => setDialog('import')}>
            {t('connectors.import')}
          </button>
        </div>
      </PanelCard>
      {dialog ? (
        <McpImportDialog
          mode={dialog}
          onModeChange={setDialog}
          onClose={() => setDialog(null)}
          onChanged={(list) => setConfigured({ state: 'loaded', list })}
        />
      ) : null}
    </>
  );
}
