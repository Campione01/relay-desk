import { describe, expect, it, vi } from 'vitest';
import { createNativePersistentMcpControls } from '../../src/main/native/persistentMcp';
import { NATIVE_MCP_PENDING_SETTLE_MS, NativeUiWaitTimeout, type NativeUiController, type NativeUiSnapshot, type NativeUiTransaction } from '../../src/main/native/controls';

function fixture(style: 'legacy' | 'windows' | 'unicode' = 'legacy', history = '', trailing = '', knownNames: readonly string[] = ['alpha', 'beta server']) {
  const glyphs = style === 'unicode'
    ? { cursor: '\u276f', connected: '\u2714', warning: '\u26a0', failed: '\u2718', circle: '\u25ef', cached: '\u25c9' }
    : { cursor: '>', connected: '\u221a', warning: '\u203c', failed: style === 'windows' ? '\u00d7' : '\u2717', circle: '( )', cached: '(*)' };
  const icon = (status: string) => status === 'disabled' ? glyphs.circle : status === 'needs-auth' ? glyphs.warning
    : status === 'failed' ? glyphs.failed : status === 'pending' ? '\u2026' : status === 'cached' ? glyphs.cached : glyphs.connected;
  const servers = [{ name: 'alpha', status: 'connected', toolCount: 1 }, { name: 'beta server', status: 'disabled', toolCount: 0 },
    { name: 'inherited', status: 'needs-auth', toolCount: 0 }];
  let view = 'idle', selected = 0, revision = 0, active = false;
  const manager = () => `Manage MCP servers\n${servers.length} servers\n` + servers.map((server, index) => (index === selected ? glyphs.cursor + ' ' : '  ') +
    icon(server.status) + ' ' + server.name + (server.status === 'connected' ? (style === 'legacy' ? ' ' : '   ') + server.toolCount + ' tool' : '')).join('\n') + '\nEnter to confirm · Esc to cancel';
  const snapshot = (): NativeUiSnapshot => ({ sessionId: 's', cliSha256: 'pinned', revision: ++revision,
    text: history + (view === 'manager' ? manager() : view === 'detail' ? servers[selected].name + ' MCP Server\nStatus: ' +
      icon(servers[selected].status) + ' ' + (servers[selected].status === 'pending' ? 'connecting' : servers[selected].status === 'needs-auth' ? 'needs authentication' : servers[selected].status) +
      '\nTools: ' + servers[selected].toolCount + ' tools\n> 1. View tools\nEnter to select · Esc to back' : '> \n? for shortcuts') + trailing });
  const tx: NativeUiTransaction = {
    snapshot,
    wait: vi.fn(async (predicate) => { const value = snapshot(); if (!predicate(value)) throw new Error('wait failed'); return value; }),
    open: vi.fn(async (_command, _args, predicate) => { view = 'manager'; selected = 0; const value = snapshot(); if (!predicate(value)) throw new Error('open guard failed'); return value; }),
    key: vi.fn(async (key, guard, settled) => {
      if (!guard(snapshot())) throw new Error('unsafe key guard');
      if (key === '\x1b[B') selected = (selected + 1) % servers.length;
      else if (key === '\x1b[A') selected = (selected + servers.length - 1) % servers.length;
      else if (key === '\r') view = 'detail';
      else if (key === '\x1b') view = view === 'detail' ? 'manager' : 'idle';
      const value = snapshot(); if (!settled(value)) throw new Error('settled guard failed'); return value;
    }),
  };
  const ui = { run: vi.fn(async (_operation: string, run: (value: NativeUiTransaction) => Promise<unknown>) => { active = true; try { return await run(tx); } finally { active = false; } }) } as unknown as NativeUiController;
  const scope = vi.fn(async () => { expect(active || view === 'idle').toBe(true); });
  const runtime = { request: vi.fn(async (method: string, args?: unknown) => {
    expect(active).toBe(true); expect(method).toBe('mcp.nativeAction');
    const request = args as { operation: string; name: string }; const server = servers.find((server) => server.name === request.name)!;
    if (!server) throw new Error('unknown server'); server.status = request.operation === 'disable' ? 'disabled' : 'connected'; server.toolCount = server.status === 'connected' ? 1 : 0;
    return { text: 'native command result' };
  }) };
  const controls = createNativePersistentMcpControls({ runtime, serverNames: knownNames, assertPreferenceScope: scope, ui });
  return { controls, runtime, scope, ui, tx, servers };
}

describe('native account-persistent MCP controls', () => {
  it.each(['alpha MCP Server', 'alpha Enter to confirm \u00b7 Esc to cancel'])('does not mistake a valid failed server name for panel boundaries: %s', async (name) => {
    const f = fixture('windows', '', '', [name, 'beta server']);
    f.servers[0].name = name; f.servers[0].status = 'failed'; f.servers[0].toolCount = 0;
    const rows = await f.controls.status();
    expect(rows[0]).toMatchObject({ name, status: 'failed', toolCount: 0 });
    expect(rows.map((row) => row.name)).toEqual([name, 'beta server', 'inherited']);
    expect(f.runtime.request).not.toHaveBeenCalled();
  });
  it.each(['  \u221a historical-ghost 9 tools\n', '> \u221a historical-selection 9 tools\n'])('ignores historical status-like rows before the latest MCP catalog: %j', async (history) => {
    const f = fixture('windows', history);
    const rows = await f.controls.status();
    expect(rows.map((row) => row.name)).toEqual(['alpha', 'beta server', 'inherited']);
    expect(vi.mocked(f.tx.key).mock.calls.filter(([key]) => key === '\r')).toHaveLength(3);
    expect(f.runtime.request).not.toHaveBeenCalled();
  });
  it('reads counts and detail facts only inside their current panel and ignores rows after its footer', async () => {
    const f = fixture('windows', '999 servers\nStatus: \u00d7 failed\nTools: 999 tools\n', '\n  \u221a trailing-ghost 7 tools\n');
    const rows = await f.controls.status();
    expect(rows.map(({ name, status, toolCount }) => ({ name, status, toolCount }))).toEqual([
      { name: 'alpha', status: 'connected', toolCount: 1 }, { name: 'beta server', status: 'disabled', toolCount: 0 },
      { name: 'inherited', status: 'needs-auth', toolCount: 0 },
    ]);
    expect(f.runtime.request).not.toHaveBeenCalled();
  });
  it('never qualifies an older catalog or detail through a later opposite, foreign or incomplete MCP header', async () => {
    const f = fixture(); await f.controls.status();
    const catalog = 'Manage MCP servers\n1 server\n> \u221a alpha 1 tool\nEnter to confirm \u00b7 Esc to cancel';
    const detail = 'alpha MCP Server\nStatus: connected\nTools: 1 tool\n> 1. View tools\nEnter to select \u00b7 Esc to back';
    const frame = (text: string) => ({ ...f.tx.snapshot(), text });
    const opened = vi.mocked(f.tx.open).mock.calls[0][2];
    const cancel = vi.mocked(f.ui.run).mock.calls[0][2]!.cancelPanel!;
    const detailSettled = vi.mocked(f.tx.key).mock.calls.find(([key]) => key === '\r')![2];
    expect(opened(frame(catalog + '\n' + detail))).toBe(false);
    expect(cancel(frame(catalog + '\n' + detail))).toBe(false);
    expect(cancel(frame(catalog + '\nalpha MCP Server'))).toBe(false);
    expect(detailSettled(frame(detail + '\n' + catalog))).toBe(false);
    expect(detailSettled(frame(detail + '\n' + detail.replace('alpha MCP Server', 'foreign MCP Server')))).toBe(false);
    expect(opened(frame(detail + '\n' + catalog))).toBe(true);
    expect(detailSettled(frame(catalog + '\n' + detail))).toBe(true);
  });
  it('reports only scalar mismatch branches and never uses loose target presence to select an unverified row', async () => {
    const f = fixture('windows'); f.servers[0].name = 'alpha   PRIVATE_SUFFIX_CANARY'; f.servers[0].status = 'failed';
    const error = await f.controls.status().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('selectedRowCount=1'); expect(message).toContain('cycle=true');
    expect(message).toContain('targetRowMatchedCount=0'); expect(message).toContain('targetLiteralRowCount=1');
    expect(message).toContain('targetOrigin=configured; knownCount=2; observedCount=3');
    expect(message).not.toContain('alpha'); expect(message).not.toContain('PRIVATE_SUFFIX_CANARY');
    expect(vi.mocked(f.tx.key).mock.calls.some(([key]) => key === '\r')).toBe(false);
  });
  it('retains observed-target provenance without exposing its name if that row disappears', async () => {
    const f = fixture(), snapshot = f.tx.snapshot;
    f.tx.snapshot = () => {
      if (vi.mocked(f.tx.key).mock.calls.filter(([key]) => key === '\r').length >= 2) f.servers.splice(2);
      return snapshot();
    };
    const error = await f.controls.status().catch((reason: unknown) => reason);
    expect((error as Error).message).toContain('targetOrigin=observed; knownCount=2; observedCount=3');
    expect((error as Error).message).toContain('targetLiteralRowCount=0');
    expect((error as Error).message).not.toContain('inherited');
  });
  it.each(['windows', 'unicode'] as const)('keeps exact selection when discovered pending rows become failed/connected with pinned 308 %s glyphs', async (style) => {
    const f = fixture(style); f.servers.splice(2);
    f.servers[0].status = f.servers[1].status = 'pending'; f.servers[0].toolCount = 0; f.servers[1].toolCount = 3;
    const snapshot = f.tx.snapshot; let reads = 0;
    f.tx.snapshot = () => {
      // Count and catalog discovery see pending; the subsequent exact-target check sees settled native glyphs.
      if (++reads === 3) { f.servers[0].status = 'failed'; f.servers[1].status = 'connected'; }
      return snapshot();
    };
    const rows = await f.controls.status();
    expect(rows).toMatchObject([{ name: 'alpha', status: 'failed', toolCount: 0 }, { name: 'beta server', status: 'connected', toolCount: 3 }]);
    expect(vi.mocked(f.tx.key).mock.calls.filter(([key]) => key === '\r')).toHaveLength(2);
    expect(f.tx.open).toHaveBeenCalledOnce(); expect(f.tx.wait).not.toHaveBeenCalled();
    expect(f.runtime.request).not.toHaveBeenCalled(); expect(f.tx.snapshot().text).toContain('? for shortcuts');
  });
  it('does not select a similarly prefixed failed server when the exact configured name is absent', async () => {
    const f = fixture('windows'); f.servers.splice(2); f.servers[0].name = 'alpha-extra'; f.servers[0].status = 'failed';
    await expect(f.controls.status()).rejects.toThrow('exact server was not observable');
    expect(vi.mocked(f.tx.key).mock.calls.some(([key]) => key === '\r')).toBe(false);
    expect(f.runtime.request).not.toHaveBeenCalled();
  });
  it.each(['windows', 'unicode'] as const)('keeps unverified cached-state rows gated for %s glyphs', async (style) => {
    const f = fixture(style); f.servers.splice(2); f.servers.forEach((server) => { server.status = 'cached'; });
    await expect(f.controls.status()).rejects.toThrow('catalog was not completely observable');
    expect(f.tx.key).not.toHaveBeenCalled(); expect(f.runtime.request).not.toHaveBeenCalled();
  });
  it('discovers inherited servers and reports observed authentication state rather than inferring connected from tools', async () => {
    const f = fixture(); const rows = await f.controls.status();
    expect(rows.map((row) => [row.name, row.status])).toEqual([['alpha', 'connected'], ['beta server', 'disabled'], ['inherited', 'needs-auth']]);
    expect(rows.every((row) => row.scope === 'relay-account-project' && row.source === 'native-account-dialog')).toBe(true);
    expect(f.runtime.request).not.toHaveBeenCalled(); expect(f.scope).toHaveBeenCalledOnce();
    expect(f.tx.wait).not.toHaveBeenCalled();
  });
  it('observes a pending detail redraw within the same native catalog without reconnecting or reopening', async () => {
    const f = fixture(); f.servers[0].status = 'pending';
    vi.mocked(f.tx.wait).mockImplementationOnce(async (predicate, options) => {
      expect(f.tx.snapshot().text).toContain('Status: … connecting');
      expect(options?.timeoutMs).toBeLessThanOrEqual(NATIVE_MCP_PENDING_SETTLE_MS);
      f.servers[0].status = 'connected'; f.servers[0].toolCount = 7;
      const actual = f.tx.snapshot(); expect(predicate(actual)).toBe(true); return actual;
    });
    expect((await f.controls.status())[0]).toMatchObject({ name: 'alpha', status: 'connected', toolCount: 7 });
    expect(f.tx.open).toHaveBeenCalledOnce(); expect(f.tx.wait).toHaveBeenCalledOnce();
    expect(f.runtime.request).not.toHaveBeenCalled();
    expect(f.tx.snapshot().text).toContain('? for shortcuts');
  });
  it('shares one pending deadline across the catalog and safely returns unresolved pending rows on expiry', async () => {
    const f = fixture(); f.servers[0].status = f.servers[1].status = 'pending';
    let now = 1000; const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.mocked(f.tx.wait).mockImplementationOnce(async (_predicate, options) => {
      expect(options?.timeoutMs).toBe(NATIVE_MCP_PENDING_SETTLE_MS);
      now += options!.timeoutMs!;
      throw new NativeUiWaitTimeout('mcp.status.dialog', 'deadline');
    });
    try {
      const rows = await f.controls.status();
      expect(rows.map((row) => row.status)).toEqual(['pending', 'pending', 'needs-auth']);
      expect(f.tx.wait).toHaveBeenCalledOnce(); expect(f.tx.open).toHaveBeenCalledOnce();
      expect(f.tx.snapshot().text).toContain('? for shortcuts');
      expect(f.runtime.request).not.toHaveBeenCalled();
      f.servers[0].status = f.servers[1].status = 'connected';
      await expect(f.controls.status()).resolves.toHaveLength(3);
    } finally { clock.mockRestore(); }
  });
  it('runs one exact native action under scope/UI ownership and refreshes every real server state', async () => {
    const f = fixture(); const disabled = await f.controls.setEnabled('alpha', false);
    expect(f.runtime.request).toHaveBeenCalledExactlyOnceWith('mcp.nativeAction', { operation: 'disable', name: 'alpha' }, { timeoutMs: null });
    expect(disabled.find((row) => row.name === 'alpha')?.status).toBe('disabled'); expect(disabled).toHaveLength(3);
    const enabled = await f.controls.setEnabled('beta server', true); expect(enabled.find((row) => row.name === 'beta server')?.status).toBe('connected');
    await f.controls.reconnect('alpha'); expect(f.runtime.request.mock.calls.at(-1)?.[1]).toEqual({ operation: 'reconnect', name: 'alpha' });
  });
  it('allows a natively attested inherited target but rejects an unknown or reserved all target before mutation', async () => {
    const f = fixture(); await f.controls.setEnabled('inherited', false);
    expect(f.runtime.request).toHaveBeenCalledTimes(1); expect(f.servers[2].status).toBe('disabled');
    await expect(f.controls.setEnabled('unknown', false)).rejects.toThrow('not a configured'); expect(f.runtime.request).toHaveBeenCalledTimes(1);
    await expect(f.controls.reconnect('ALL')).rejects.toThrow('reserved'); expect(f.runtime.request).toHaveBeenCalledTimes(1);
  });
  it('stops on failed physical scope or native command without retry, hidden fallback or preference edits', async () => {
    const f = fixture(); f.scope.mockRejectedValueOnce(new Error('not a Relay independent profile'));
    await expect(f.controls.setEnabled('alpha', false)).rejects.toThrow('independent'); expect(f.runtime.request).not.toHaveBeenCalled();
    f.runtime.request.mockRejectedValueOnce(new Error('native command failed after dispatch'));
    await expect(f.controls.setEnabled('alpha', false)).rejects.toThrow('after dispatch'); expect(f.runtime.request).toHaveBeenCalledTimes(1);
  });
  it('rejects unsafe labels/case ambiguity and serializes concurrent mutations', async () => {
    const f = fixture(); await expect(f.controls.setEnabled('alpha\nother', false)).rejects.toThrow('ambiguous'); expect(f.runtime.request).not.toHaveBeenCalled();
    await Promise.all([f.controls.setEnabled('alpha', false), f.controls.setEnabled('alpha', true)]);
    expect(f.runtime.request.mock.calls.map((call) => (call[1] as { operation: string }).operation)).toEqual(['disable', 'enable']);
    expect(f.servers[0].status).toBe('connected');
  });
});
