import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { McpServerState } from '../../src/shared/types';
import { serverCommand } from '../../src/renderer/components/flows/McpImportDialog';
import { MOCK_MCP_ENTRIES } from '../../src/renderer/mock/fixtures';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

function card(): HTMLElement {
  return screen.getByTestId('card-connectors');
}

function head(): HTMLButtonElement {
  return card().querySelector<HTMLButtonElement>('.rd-card__head')!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function openDialog(rendered: Rendered, action: 'Import from desktop' | 'Manage'): Promise<HTMLElement> {
  if (head().getAttribute('aria-expanded') !== 'true') await rendered.user.click(head());
  await rendered.user.click(within(card()).getByRole('button', { name: action }));
  return screen.findByTestId('mcp-dialog');
}

describe('connectors card', () => {
  it('shows what a server runs from the command and args, or the url', () => {
    expect(serverCommand({ transport: 'stdio', command: 'npx', args: ['-y', 'blockbench-mcp'] })).toBe('npx -y blockbench-mcp');
    expect(serverCommand({ transport: 'http', url: 'https://mcp.example.com/sse', command: 'ignored' })).toBe('https://mcp.example.com/sse');
  });

  it('read-only view: Relay’s own list without live status, open state remembered', async () => {
    const rendered = await renderApp({ mcpEntries: [...MOCK_MCP_ENTRIES] });
    const list = vi.spyOn(rendered.api.mcp, 'list');
    const status = vi.spyOn(rendered.api.engine, 'mcpStatus');
    expect(list).not.toHaveBeenCalled();
    await rendered.user.click(head());
    expect(head()).toHaveAttribute('aria-expanded', 'true');
    expect(JSON.parse(window.localStorage.getItem('relay.ui') ?? '{}').cards?.connectors).toBe(true);
    const rows = await within(card()).findAllByTestId('connector-row');
    expect(rows.map((row) => row.textContent)).toEqual(['BBlenderOn', 'BBlockbenchOn']);
    expect(within(card()).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(card()).getByTestId('blender-hint')).toHaveTextContent('compete for the Blender add-on connection');
    expect(status).not.toHaveBeenCalled();
    await rendered.user.click(head());
    expect(within(head()).getByText('2 enabled')).toHaveClass('rd-card__summary');
  });

  it('imports chosen desktop servers after a preview that shows env names only and says values are copied', async () => {
    const rendered = await renderApp();
    const importFromDesktop = vi.spyOn(rendered.api.mcp, 'importFromDesktop');
    await rendered.user.click(head());
    expect(await within(card()).findByText('Relay Desk has no MCP servers of its own yet.')).toBeInTheDocument();
    const dialog = await openDialog(rendered, 'Import from desktop');
    expect(within(dialog).getByRole('heading', { name: 'Import MCP servers from the desktop' })).toBeInTheDocument();
    expect(within(dialog).getByTestId('mcp-env-note')).toHaveTextContent(
      'The environment variable values of the chosen servers are copied into Relay Desk’s own settings.',
    );
    const rows = await within(dialog).findAllByTestId('mcp-preview-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('uvx blender-mcp');
    expect(rows[0]).toHaveTextContent('No environment variables');
    expect(rows[1]).toHaveTextContent('npx -y blockbench-mcp');
    expect(rows[1]).toHaveTextContent('Environment variables: BLOCKBENCH_PORT');
    expect(within(dialog).getByText(/compete for the Blender add-on connection/)).toBeInTheDocument();
    expect(within(dialog).getByText('Changes to Relay Desk’s list apply to sessions opened afterwards.')).toBeInTheDocument();

    await rendered.user.click(within(rows[1]!).getByRole('checkbox', { name: 'Import Blockbench' }));
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Import 1' }));
    await waitFor(() => expect(importFromDesktop).toHaveBeenCalledWith(['Blender']));

    // Afterwards the manage view lists the new entry, and the card follows.
    expect(await within(dialog).findByRole('heading', { name: 'Relay Desk MCP servers' })).toBeInTheDocument();
    const entries = await within(dialog).findAllByTestId('mcp-entry-row');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toHaveTextContent('Blender');
    expect(within(card()).getAllByTestId('connector-row').map((row) => row.textContent)).toEqual(['BBlenderOn']);

    // A second preview marks it as already imported and leaves it unticked.
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Import from desktop' }));
    const again = await within(dialog).findAllByTestId('mcp-preview-row');
    expect(again[0]).toHaveTextContent('Already imported');
    expect(within(again[0]!).getByRole('checkbox')).not.toBeChecked();
    expect(within(again[1]!).getByRole('checkbox')).toBeChecked();
  });

  it('manage view enables, disables and removes Relay’s servers', async () => {
    const rendered = await renderApp({ mcpEntries: [...MOCK_MCP_ENTRIES] });
    const setEnabled = vi.spyOn(rendered.api.mcp, 'setEnabled');
    const remove = vi.spyOn(rendered.api.mcp, 'remove');
    const dialog = await openDialog(rendered, 'Manage');
    const rows = await within(dialog).findAllByTestId('mcp-entry-row');
    expect(rows).toHaveLength(2);
    const toggle = within(rows[0]!).getByRole('switch', { name: 'Enable Blender' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await rendered.user.click(toggle);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith('Blender', false));
    await waitFor(() => expect(within(dialog).getByRole('switch', { name: 'Enable Blender' })).toHaveAttribute('aria-checked', 'false'));
    expect(within(card()).getAllByTestId('connector-row')[0]).toHaveTextContent('BlenderOff');
    await rendered.user.click(within(dialog).getByRole('button', { name: 'Remove Blockbench' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('Blockbench'));
    await waitFor(() => expect(within(dialog).getAllByTestId('mcp-entry-row')).toHaveLength(1));
    expect(setEnabled).toHaveBeenCalledTimes(1);
  });

  it('live session: status from the engine, per-server toggle and reconnect for a failed server', async () => {
    const rendered = await renderApp();
    const status = vi.spyOn(rendered.api.engine, 'mcpStatus');
    const toggle = vi.spyOn(rendered.api.engine, 'mcpToggle');
    const reconnect = vi.spyOn(rendered.api.engine, 'mcpReconnect');
    const handleId = await takeOverMain(rendered);
    expect(status).not.toHaveBeenCalled();
    await rendered.user.click(head());
    await waitFor(() => expect(status).toHaveBeenCalledWith(handleId));
    const rows = await within(card()).findAllByTestId('connector-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Blender');
    expect(rows[0]).toHaveTextContent('17 tools');
    expect(within(rows[0]!).getByRole('img', { name: 'Connected' })).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole('button', { name: 'Reconnect Blender' })).not.toBeInTheDocument();
    expect(rows[1]).toHaveAttribute('data-status', 'failed');
    expect(within(rows[1]!).getByRole('img', { name: 'Failed' })).toBeInTheDocument();

    await rendered.user.click(head());
    expect(within(head()).getByText('1 connected')).toHaveClass('rd-card__summary');
    await rendered.user.click(head());

    await rendered.user.click(within(card()).getByRole('button', { name: 'Reconnect Blockbench' }));
    await waitFor(() => expect(reconnect).toHaveBeenCalledWith(handleId, 'Blockbench'));
    await waitFor(() => expect(within(card()).getAllByTestId('connector-row')[1]).toHaveAttribute('data-status', 'connected'));

    await rendered.user.click(within(card()).getByRole('switch', { name: 'Use Blender in this session' }));
    await waitFor(() => expect(toggle).toHaveBeenCalledWith(handleId, 'Blender', false));
    await waitFor(() => expect(within(card()).getAllByTestId('connector-row')[0]).toHaveTextContent('Off'));
    expect(within(card()).getByRole('switch', { name: 'Use Blender in this session' })).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps connected engine events newer than an in-flight opening snapshot', async () => {
    const rendered = await renderApp();
    const snapshot = deferred<McpServerState[]>();
    vi.spyOn(rendered.api.engine, 'mcpStatus').mockReturnValueOnce(snapshot.promise);
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(head());
    expect(within(card()).getByText('Loading…')).toBeInTheDocument();

    const pending: McpServerState[] = [
      { name: 'Blockbench', status: 'pending', toolCount: 0, relay: true },
      { name: 'Blender', status: 'pending', toolCount: 0, relay: true },
    ];
    act(() => rendered.api.mock.emitEngine({ type: 'mcp', handleId, servers: pending }));
    expect(within(card()).queryByText('Loading…')).not.toBeInTheDocument();
    expect(within(card()).getAllByTestId('connector-row').map((row) => row.dataset.status)).toEqual(['pending', 'pending']);

    const connected: McpServerState[] = [
      { name: 'Blockbench', status: 'connected', toolCount: 23, relay: true },
      { name: 'Blender', status: 'pending', toolCount: 0, relay: true },
    ];
    act(() => rendered.api.mock.emitEngine({ type: 'mcp', handleId, servers: connected }));
    const rows = within(card()).getAllByTestId('connector-row');
    expect(rows[0]).toHaveTextContent('Blockbench23 tools');
    expect(rows[0]).toHaveAttribute('data-status', 'connected');
    expect(rows[1]).toHaveTextContent('Blender');
    expect(rows[1]).toHaveAttribute('data-status', 'pending');

    await act(async () => snapshot.resolve(pending));
    expect(within(card()).getAllByTestId('connector-row')[0]).toHaveAttribute('data-status', 'connected');
    expect(within(card()).getAllByTestId('connector-row')[0]).toHaveTextContent('23 tools');
    await rendered.user.click(head());
    expect(within(head()).getByText('1 connected')).toBeInTheDocument();
  });

  it('does not let a stale reconnect result overwrite a newer connected event', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(head());
    await within(card()).findByRole('button', { name: 'Reconnect Blockbench' });
    const reconnect = deferred<McpServerState[]>();
    vi.spyOn(rendered.api.engine, 'mcpReconnect').mockReturnValueOnce(reconnect.promise);
    await rendered.user.click(within(card()).getByRole('button', { name: 'Reconnect Blockbench' }));

    act(() => rendered.api.mock.emitEngine({
      type: 'mcp', handleId, servers: [{ name: 'Blockbench', status: 'connected', toolCount: 23, relay: true }],
    }));
    await act(async () => reconnect.resolve([{ name: 'Blockbench', status: 'pending', toolCount: 0, relay: true }]));
    const row = within(card()).getByTestId('connector-row');
    expect(row).toHaveAttribute('data-status', 'connected');
    expect(row).toHaveTextContent('23 tools');
    expect(within(row).getByRole('switch')).toBeEnabled();
  });

  it('keeps reconnect results and busy state scoped to the handle in view', async () => {
    const rendered = await renderApp();
    const firstHandle = await takeOverMain(rendered);
    await rendered.user.click(head());
    await within(card()).findByRole('button', { name: 'Reconnect Blockbench' });
    const first = deferred<McpServerState[]>();
    const second = deferred<McpServerState[]>();
    const reconnect = vi.spyOn(rendered.api.engine, 'mcpReconnect')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    await rendered.user.click(within(card()).getByRole('button', { name: 'Reconnect Blockbench' }));

    await act(async () => rendered.controller.newSession('D:\\connector-fixture'));
    const secondHandle = rendered.controller.currentView()!.handleId!;
    expect(secondHandle).not.toBe(firstHandle);
    const button = await within(card()).findByRole('button', { name: 'Reconnect Blockbench' });
    expect(button).toBeEnabled();
    await rendered.user.click(button);
    expect(reconnect).toHaveBeenLastCalledWith(secondHandle, 'Blockbench');
    expect(within(card()).getByRole('switch', { name: 'Use Blockbench in this session' })).toBeDisabled();

    await act(async () => first.resolve([{ name: 'Old handle only', status: 'connected', toolCount: 1, relay: true }]));
    expect(within(card()).queryByText('Old handle only')).not.toBeInTheDocument();
    expect(within(card()).getByRole('switch', { name: 'Use Blockbench in this session' })).toBeDisabled();
    expect(within(card()).getAllByTestId('connector-row')[1]).toHaveAttribute('data-status', 'failed');

    await act(async () => second.resolve([{ name: 'Blockbench', status: 'connected', toolCount: 23, relay: true }]));
    expect(within(card()).getByTestId('connector-row')).toHaveTextContent('Blockbench23 tools');
    expect(within(card()).getByRole('switch')).toBeEnabled();
  });

  it('clears the old handle status on reopen without losing MCP preferences or accepting late old results', async () => {
    const rendered = await renderApp();
    const firstHandle = await takeOverMain(rendered);
    const key = rendered.controller.currentView()!.key;
    await act(async () => rendered.controller.toggleMcp(key, 'Blender', false));
    const oldSnapshot = deferred<McpServerState[]>();
    const nextSnapshot = deferred<McpServerState[]>();
    vi.spyOn(rendered.api.engine, 'mcpStatus')
      .mockReturnValueOnce(oldSnapshot.promise)
      .mockReturnValueOnce(nextSnapshot.promise);
    await rendered.user.click(head());
    const oldServers: McpServerState[] = [{ name: 'Old handle only', status: 'connected', toolCount: 1, relay: true }];
    act(() => rendered.api.mock.emitEngine({ type: 'mcp', handleId: firstHandle, servers: oldServers }));
    expect(within(card()).getByTestId('connector-row')).toHaveTextContent('Old handle only');

    await act(async () => rendered.controller.closeSession(key));
    expect(rendered.controller.view(key)?.mcp).toBeUndefined();
    await act(async () => rendered.controller.openEngine(key, true));
    const nextHandle = rendered.controller.currentView()!.handleId!;
    expect(nextHandle).not.toBe(firstHandle);
    expect(rendered.controller.view(key)?.prefs?.mcp).toEqual({ Blender: false });
    expect(within(card()).getByText('Loading…')).toBeInTheDocument();
    expect(within(card()).queryByTestId('connector-row')).not.toBeInTheDocument();

    act(() => rendered.api.mock.emitEngine({ type: 'mcp', handleId: firstHandle, servers: oldServers }));
    await act(async () => oldSnapshot.resolve(oldServers));
    expect(within(card()).getByText('Loading…')).toBeInTheDocument();
    expect(within(card()).queryByTestId('connector-row')).not.toBeInTheDocument();

    await act(async () => nextSnapshot.resolve([{ name: 'New handle only', status: 'connected', toolCount: 7, relay: true }]));
    expect(within(card()).getByTestId('connector-row')).toHaveTextContent('New handle only7 tools');
  });

  it('shows an honest initial status load error and retries it', async () => {
    const rendered = await renderApp();
    const status = vi.spyOn(rendered.api.engine, 'mcpStatus').mockRejectedValueOnce(new Error('status unavailable'));
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(head());
    expect(await within(card()).findByText('Could not load the MCP servers.')).toBeInTheDocument();
    expect(within(card()).queryByText('Loading…')).not.toBeInTheDocument();
    await rendered.user.click(within(card()).getByRole('button', { name: 'Retry' }));
    expect(await within(card()).findAllByTestId('connector-row')).toHaveLength(2);
    expect(within(card()).queryByText('Could not load the MCP servers.')).not.toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenLastCalledWith(handleId);
  });

  it('preserves pending rows and offers retry when a reopened card cannot refresh status', async () => {
    const rendered = await renderApp();
    const retry = deferred<McpServerState[]>();
    const pending: McpServerState[] = [{ name: 'Blockbench', status: 'pending', toolCount: 0, relay: true }];
    const status = vi.spyOn(rendered.api.engine, 'mcpStatus')
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new Error('refresh unavailable'))
      .mockReturnValueOnce(retry.promise);
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(head());
    expect(await within(card()).findByTestId('connector-row')).toHaveAttribute('data-status', 'pending');
    await rendered.user.click(head());
    await rendered.user.click(head());

    expect(await within(card()).findByText('Could not load the MCP servers.')).toBeInTheDocument();
    expect(within(card()).getByTestId('connector-row')).toHaveAttribute('data-status', 'pending');
    await rendered.user.click(within(card()).getByRole('button', { name: 'Retry' }));
    expect(within(card()).queryByText('Could not load the MCP servers.')).not.toBeInTheDocument();
    expect(within(card()).getByTestId('connector-row')).toHaveAttribute('data-status', 'pending');

    await act(async () => retry.resolve([{ name: 'Blockbench', status: 'connected', toolCount: 23, relay: true }]));
    expect(within(card()).getByTestId('connector-row')).toHaveAttribute('data-status', 'connected');
    expect(within(card()).getByTestId('connector-row')).toHaveTextContent('Blockbench23 tools');
    expect(within(card()).queryByText('Could not load the MCP servers.')).not.toBeInTheDocument();
    expect(status).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenLastCalledWith(handleId);
  });

  it('ignores a failed opening snapshot after a live event supplies status', async () => {
    const rendered = await renderApp();
    const snapshot = deferred<McpServerState[]>();
    vi.spyOn(rendered.api.engine, 'mcpStatus').mockReturnValueOnce(snapshot.promise);
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(head());
    act(() => rendered.api.mock.emitEngine({
      type: 'mcp', handleId, servers: [{ name: 'Blockbench', status: 'connected', toolCount: 23, relay: true }],
    }));
    await act(async () => snapshot.reject(new Error('old snapshot unavailable')));
    expect(within(card()).getByTestId('connector-row')).toHaveTextContent('Blockbench23 tools');
    expect(within(card()).queryByText('Could not load the MCP servers.')).not.toBeInTheDocument();
  });

  it('a read-only session in view still shows Relay’s list, not a live status', async () => {
    const rendered = await renderApp({ mcpEntries: [MOCK_MCP_ENTRIES[1]!] });
    await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    await rendered.user.click(head());
    const rows = await within(card()).findAllByTestId('connector-row');
    expect(rows.map((row) => row.textContent)).toEqual(['BBlockbenchOn']);
    expect(within(card()).queryByTestId('blender-hint')).not.toBeInTheDocument();
  });
});
