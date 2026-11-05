import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SharedCodeContextReport } from '../../src/shared/types';
import { createTranslator } from '../../src/renderer/i18n';
import { mockCodeContext } from '../../src/renderer/mock/context';
import { MOCK_CONTEXT, MOCK_PROFILES } from '../../src/renderer/mock/fixtures';
import { createMockApi, renderApp, sidebar, takeOverMain } from './helpers';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const nativeReport = (cwd?: string): SharedCodeContextReport => mockCodeContext(MOCK_PROFILES[0]!, cwd);
const sharedReport = (cwd?: string): SharedCodeContextReport => mockCodeContext(MOCK_PROFILES[1]!, cwd);

describe('Code context parity UI', () => {
  it('inspection shows loading then native metadata, explicit unknowns and no runtime or cloud-memory claim', async () => {
    const { api, user } = await renderApp();
    const request = deferred<SharedCodeContextReport>();
    const report = nativeReport();
    report.memory = { shared: false };
    const inspect = vi.spyOn(api.app, 'inspectCodeContext').mockReturnValueOnce(request.promise);
    const open = vi.spyOn(api.engine, 'open');
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Loading');
    expect(within(dialog).getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(inspect).toHaveBeenCalledWith('default', undefined);
    await act(async () => request.resolve(report));
    expect(dialog).toHaveTextContent('Default account: uses native Claude Code locations.');
    expect(dialog).toHaveTextContent('New sessions select the full claude_code preset.');
    expect(dialog).toHaveTextContent('Resumed sessions preserve their native prompt snapshot;');
    expect(dialog).toHaveTextContent('only after compaction or a new session');
    expect(createTranslator('zh-TW')('codeContext.preset')).toContain('保留原生提示快照');
    expect(dialog).toHaveTextContent('Shared Code context does not share credentials.');
    expect(dialog).toHaveTextContent('Relay does not sync cloud-chat memory.');
    expect(dialog).toHaveTextContent('Allow 3 · Deny 1 · Ask 2');
    expect(within(dialog).getByTestId('context-entry-instructions')).toHaveTextContent('Native location');
    const memory = within(dialog).getByRole('region', { name: 'Expected project auto-memory configuration' });
    expect(memory).toHaveTextContent('No working folder; the project memory path cannot be determined.');
    expect(within(memory).getAllByText('Unknown / not reported')).toHaveLength(2);
    expect(memory).toHaveTextContent('not proof that this session loaded a memory file');
    expect(open).not.toHaveBeenCalled();
  });

  it('shared account inspection preserves missing, pending, conflict, false settings and warnings as metadata', async () => {
    const report = sharedReport('D:\\work\\business');
    report.entries[0]!.state = 'missing';
    report.entries[1]!.state = 'pending';
    report.entries[2]!.state = 'conflict';
    report.memory = { directory: 'G:\\shared Code\\memory', shared: true, enabled: false, indexExists: false };
    report.permissions = undefined;
    report.warnings = ['Synthetic path conflict; no file contents were read.'];
    const { api, user, controller } = await renderApp({ settings: { activeProfileId: 'profile-work' }, codeContexts: { 'profile-work': report } });
    const inspect = vi.spyOn(api.app, 'inspectCodeContext');
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    await waitFor(() => expect(dialog).toHaveTextContent('Separate account: shares the default account’s local Code context'));
    expect(inspect).toHaveBeenCalledWith('profile-work', undefined);
    expect(within(dialog).getByTestId('context-entry-instructions')).toHaveTextContent('Source missing');
    expect(within(dialog).getByTestId('context-entry-rules')).toHaveTextContent('Pending');
    expect(within(dialog).getByTestId('context-entry-skills')).toHaveTextContent('Path conflict');
    expect(within(dialog).getByTestId('context-entry-skills')).toHaveTextContent(report.entries[2]!.sourcePath);
    expect(within(dialog).getByTestId('context-entry-skills')).toHaveTextContent(report.entries[2]!.targetPath);
    const memory = within(dialog).getByRole('region', { name: 'Expected project auto-memory configuration' });
    expect(memory).toHaveTextContent('G:\\shared Code\\memory');
    expect(within(memory).getAllByText('No')).toHaveLength(2);
    expect(within(memory).getByText('Yes')).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: 'Shared permission rule counts' })).toHaveTextContent('Unknown / not reported');
    expect(within(dialog).getByRole('region', { name: 'Inspection warnings' })).toHaveTextContent(report.warnings[0]!);
    expect(controller.state.activeProfileId).toBe('profile-work');
  });

  it('inspection follows the viewed session account and folder rather than the new-session account selector', async () => {
    const { api, user, controller } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await act(async () => controller.setActiveProfile('profile-work'));
    const inspect = vi.spyOn(api.app, 'inspectCodeContext');
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    await waitFor(() => expect(controller.state.codeContext?.state).toBe('loaded'));
    expect(inspect.mock.calls).toEqual([['default', 'D:\\demos\\relay-desk']]);
    expect(screen.getByTestId('code-context-dialog')).toHaveTextContent('Account: Personal account (default)');
  });

  it('inspection errors stay in the scoped dialog and Retry performs the same read-only request', async () => {
    const { api, user } = await renderApp();
    const inspect = vi.spyOn(api.app, 'inspectCodeContext').mockRejectedValueOnce(new Error('metadata worker stopped'));
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('metadata worker stopped');
    await user.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(dialog).toHaveTextContent('Default account: uses native'));
    expect(inspect.mock.calls).toEqual([['default', undefined], ['default', undefined]]);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a late success for an old profile cannot replace the new profile inspection', async () => {
    const { api, user, controller } = await renderApp();
    const old = deferred<SharedCodeContextReport>();
    const current = deferred<SharedCodeContextReport>();
    const inspect = vi.spyOn(api.app, 'inspectCodeContext').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    await act(async () => controller.setActiveProfile('profile-work'));
    await waitFor(() => expect(inspect).toHaveBeenCalledWith('profile-work', undefined));
    await act(async () => current.resolve(sharedReport()));
    await act(async () => old.resolve(nativeReport()));
    expect(controller.state.codeContext?.report?.profileId).toBe('profile-work');
    expect(screen.getByTestId('code-context-dialog')).toHaveTextContent('Separate account:');
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('a late failure for an old working folder cannot replace the new folder report', async () => {
    const { api, user, controller } = await renderApp();
    const first = controller.state.sessions.find((session) => session.title === 'Relay Desk packaging plan')!;
    const second = controller.state.sessions.find((session) => session.title === 'Fix flaky test')!;
    await user.click(within(sidebar()).getByRole('button', { name: first.title }));
    const old = deferred<SharedCodeContextReport>();
    const current = deferred<SharedCodeContextReport>();
    const inspect = vi.spyOn(api.app, 'inspectCodeContext').mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    act(() => controller.openSummary(second));
    await waitFor(() => expect(inspect).toHaveBeenCalledWith('default', second.cwd));
    const report = nativeReport(second.cwd);
    await act(async () => current.resolve(report));
    await act(async () => old.reject(new Error('stale folder failure')));
    expect(controller.state.codeContext?.cwd).toBe(second.cwd);
    expect(controller.state.codeContext?.report?.memory.directory).toBe(report.memory.directory);
    expect(screen.queryByText('stale folder failure')).not.toBeInTheDocument();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('only the newest request for the same scope may update the inspection', async () => {
    const { api, controller } = await renderApp();
    const first = deferred<SharedCodeContextReport>();
    const second = deferred<SharedCodeContextReport>();
    vi.spyOn(api.app, 'inspectCodeContext').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => { a = controller.inspectCodeContext('default'); b = controller.inspectCodeContext('default'); });
    const newer = nativeReport();
    newer.warnings = ['Newest result'];
    await act(async () => { second.resolve(newer); await b; });
    const older = nativeReport();
    older.warnings = ['Old result'];
    await act(async () => { first.resolve(older); await a; });
    expect(controller.state.codeContext?.report?.warnings).toEqual(['Newest result']);
  });

  it('closing a pending inspection prevents a late result from reopening it', async () => {
    const { api, user, controller } = await renderApp();
    const request = deferred<SharedCodeContextReport>();
    vi.spyOn(api.app, 'inspectCodeContext').mockReturnValueOnce(request.promise);
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[1]!);
    await act(async () => request.resolve(nativeReport()));
    expect(controller.state.codeContext).toBeNull();
    expect(screen.queryByTestId('code-context-dialog')).not.toBeInTheDocument();
  });

  it('a mismatched account in an inspection reply becomes an error rather than displayed metadata', async () => {
    const { api, user } = await renderApp();
    vi.spyOn(api.app, 'inspectCodeContext').mockResolvedValueOnce(sharedReport());
    await user.click(screen.getByRole('button', { name: 'Inspect rules and memory' }));
    const dialog = await screen.findByTestId('code-context-dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The inspection returned a different account.');
    expect(dialog).not.toHaveTextContent('Separate account:');
  });

  it('missing native memory metadata is not confused with an explicitly empty native list', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(within(screen.getByTestId('card-context')).getByRole('button', { name: /Context/ }));
    const region = screen.getByRole('region', { name: 'Memory files reported by this session' });
    expect(region).toHaveTextContent('No native memory-file metadata has been observed.');
    expect(region).not.toHaveTextContent('returned an empty');
    act(() => rendered.api.mock.emitEngine({ type: 'context', handleId, usage: { ...MOCK_CONTEXT, memoryFiles: [] } }));
    expect(region).toHaveTextContent('The native context query returned an empty memory-file list.');
    expect(region).not.toHaveTextContent('No native memory-file metadata');
  });

  it('actual reported memory paths, types and token counts survive mock open and refresh', async () => {
    const memoryFiles = [
      { path: 'C:\\synthetic\\CLAUDE.md', type: 'project', tokens: 1234 },
      { path: 'C:\\synthetic\\memory\\MEMORY.md', type: 'auto', tokens: 57 },
    ];
    const rendered = await renderApp({ contextUsage: { ...MOCK_CONTEXT, memoryFiles } });
    const handleId = await takeOverMain(rendered);
    await rendered.user.click(within(screen.getByTestId('card-context')).getByRole('button', { name: /Context/ }));
    const region = screen.getByRole('region', { name: 'Memory files reported by this session' });
    expect(within(region).getAllByRole('listitem')).toHaveLength(2);
    expect(region).toHaveTextContent('C:\\synthetic\\CLAUDE.md');
    expect(region).toHaveTextContent('C:\\synthetic\\memory\\MEMORY.md');
    expect(region).toHaveTextContent('project · 1.2k tokens');
    expect(region).toHaveTextContent('auto · 57 tokens');
    expect(region).toHaveTextContent('not inferred from local files');
    expect((await rendered.api.engine.refreshContext(handleId))?.memoryFiles).toEqual(memoryFiles);
  });

  it('mock inspection models native and shared contexts without credential or file-content fields', async () => {
    const api = createMockApi();
    const native = await api.app.inspectCodeContext('default', 'D:\\project');
    const shared = await api.app.inspectCodeContext('profile-work', 'D:\\project');
    expect(native.mode).toBe('default');
    expect(native.entries.every((entry) => entry.state === 'native' && entry.sourcePath === entry.targetPath)).toBe(true);
    expect(shared.mode).toBe('shared');
    expect(shared.entries.every((entry) => entry.state === 'ready' && entry.sourcePath !== entry.targetPath)).toBe(true);
    expect(shared.memory.shared).toBe(true);
    expect(shared.memory.directory).toBe(native.memory.directory);
    expect(Object.keys(shared).sort()).toEqual(['configDirectory', 'entries', 'globalRoot', 'memory', 'mode', 'permissions', 'profileId', 'warnings']);
    await expect(api.app.inspectCodeContext('not-an-account')).rejects.toThrow('Unknown profile');
  });

  it('login opens the official sign-in in its own console and the accounts card has no text field', async () => {
    const { api, user } = await renderApp();
    const login = vi.spyOn(api.accounts, 'login').mockResolvedValue({ ok: true, message: '' });
    await user.click(screen.getByRole('button', { name: /Accounts/ }));
    const card = screen.getByTestId('card-accounts');
    expect(card).toHaveTextContent(/Log in opens the official Claude Code sign-in in its own console window/i);
    expect(card).toHaveTextContent(/never sees the sign-in URL, code or credentials/i);
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
    const rows = within(card).getAllByTestId('account-row');
    await user.click(within(rows[1]!).getByRole('button', { name: 'Actions for “Work account”' }));
    await user.click(within(await screen.findByRole('menu', { name: 'Actions for “Work account”' })).getByRole('menuitem', { name: 'Log in' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Subscription' }));
    expect(login).toHaveBeenCalledWith('profile-work', 'claudeai');
    expect(screen.getByRole('status')).toHaveTextContent('The official Claude Code sign-in opened in its own console window');
    const zh = createTranslator('zh-TW');
    expect(zh('accounts.note')).toContain('在獨立的主控台視窗開啟官方 Claude Code 登入');
    expect(zh('accounts.loginStarted')).toContain('已在獨立的主控台視窗開啟官方 Claude Code 登入');
  });
});
