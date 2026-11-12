import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translate } from '../../src/renderer/i18n';
import { friendlyError } from '../../src/renderer/lib/errors';
import { errorText } from '../../src/renderer/lib/format';
import { SLASH_TEXT_REFUSAL } from '@shared/slashText';
import { renderApp, takeOverMain } from './helpers';

const ipc = (message: string): Error => new Error(`Error invoking remote method 'relay:engine:send': Error: ${message}`);

describe('friendly error text', () => {
  it.each([
    ['Native transport: request timed out', 'error.timedOut'],
    ['Queued native send abc was not delivered: Native transport: request timed out', 'error.timedOut'],
    ['Native interactive process exited (1).', 'error.sessionEnded'],
    ['Native transport: Mod receiver disconnected. Native interactive process exited (unknown).', 'error.sessionEnded'],
    ['Native transport: owned child exited', 'error.sessionEnded'],
    ['Native transport: runtime closed', 'error.sessionEnded'],
    ['Native transport: session is not ready', 'error.sessionEnded'],
    ['Native interactive feature gate [ui.command.busy]: a native modal or attachment owns terminal input; slash commands cannot interleave.', 'error.commandBusy'],
    ['Finish /compact before running another command.', 'error.commandBusy'],
    ['Another slash command is still running in the native CLI.', 'error.commandBusy'],
    ['Native control gate [settings.effort]: a prior native modal failed; input recovery is required before another send or control. Background work has not been stopped.', 'error.dialogOpen'],
    ['Native control gate [settings.model]: native UI did not reach the attested expected state before its deadline. [Local UI diagnostic v1: phase=wait]', 'error.notApplied'],
    ['/tui is handled by Relay, not the native CLI.', 'slash.terminalOnly'],
    [SLASH_TEXT_REFUSAL, 'slash.leadingSlash'],
    ['Native control gate [prompt.slash]: text that starts with "/" would run as a command; the native host refuses it as a model prompt.', 'slash.leadingSlash'],
    ['Queued native send abc was not delivered: Native control gate [prompt.slash]: text that starts with "/" would run as a command.', 'slash.leadingSlash'],
    ['Native control gate [prompt.command]: slash commands need the native command dispatcher, not a model prompt.', 'error.notApplied'],
    ['Attachment text contains unsafe terminal controls or a terminal command.', 'attach.unsafeText'],
  ] as const)('%s', (message, key) => {
    expect(friendlyError(errorText(ipc(message)))?.key).toBe(key);
  });

  it('names a Relay-handled command and leaves unknown messages alone', () => {
    expect(friendlyError('/config is handled by Relay, not the native CLI.')).toEqual({ key: 'slash.relayHandled', params: { name: 'config' } });
    expect(translate('en', 'slash.relayHandled', { name: 'config' })).toBe("Use Relay's own controls for /config.");
    for (const message of ['pipe closed', 'Native interactive feature gate [prompt.preempt]: the first native turn has not reported its identity yet.', 'worker exited']) {
      expect(friendlyError(message)).toBeNull();
    }
    expect(translate('zh-TW', 'error.timedOut')).toBe('Relay 沒有及時收到 CLI 的回應。');
    expect(translate('zh-TW', 'error.details')).toBe('詳細資訊');
  });
});

describe('error banner and toast', () => {
  it('a known send failure reads in plain words with the raw text under Details', async () => {
    const rendered = await renderApp();
    await takeOverMain(rendered);
    vi.spyOn(rendered.api.engine, 'send').mockRejectedValueOnce(ipc('Native transport: request timed out'));
    await act(async () => { await rendered.controller.send(rendered.controller.state.currentKey!, 'hello'); });
    const banner = screen.getByTestId('inline-error');
    expect(within(banner).getByText("Relay didn't get an answer from the CLI in time.")).toBeInTheDocument();
    const details = banner.querySelector('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('Details').tagName).toBe('SUMMARY');
    expect(within(details).getByText('Native transport: request timed out')).toBeInTheDocument();
    await rendered.user.click(within(details).getByText('Details'));
    expect(details).toHaveAttribute('open');
    expect(within(banner).getByRole('button', { name: 'Send again' })).toBeInTheDocument();
  });

  it('a "!" text with a file that main refuses reads as a translated note, the raw text under Details', async () => {
    const rendered = await renderApp();
    await takeOverMain(rendered);
    const reason = 'Attachment text contains unsafe terminal controls or a terminal command.';
    vi.spyOn(rendered.api.engine, 'send').mockRejectedValueOnce(ipc(reason));
    await act(async () => { await rendered.controller.send(rendered.controller.state.currentKey!, '!ls', false,
      [{ kind: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }]); });
    const banner = screen.getByTestId('inline-error');
    expect(within(banner).getByText("A message with files can't start with “!” or contain hidden control characters. Remove them to send it.")).toBeInTheDocument();
    expect(banner.querySelector('details')).toHaveTextContent(reason);
    expect(translate('zh-TW', 'attach.unsafeText')).toBe('附有檔案的訊息不能以「!」開頭，也不能含有隱藏的控制字元。請移除後再送出。');
  });

  it('a fatal exit event says the CLI session ended and still offers Reopen; an unknown one stays as it came', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => rendered.api.mock.emitEngine({ type: 'error', handleId, fatal: true,
      message: 'Native transport: Mod receiver disconnected. Native interactive process exited (1).' }));
    act(() => rendered.api.mock.emitEngine({ type: 'error', handleId, fatal: false, message: 'Native command reported a problem' }));
    const [ended, unknown] = screen.getAllByTestId('inline-error');
    expect(within(ended!).getByText('The CLI session ended. Reopen it to continue.')).toBeInTheDocument();
    expect(within(ended!).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(ended!.querySelector('details')).toHaveTextContent('Native interactive process exited (1).');
    expect(unknown!.querySelector('details')).toBeNull();
    expect(within(unknown!).getByText('Native command reported a problem')).toHaveClass('rd-errrow__text');
  });

  it('a refused setting toast says it could not be applied, with the reason under Details', async () => {
    const rendered = await renderApp();
    await takeOverMain(rendered);
    const key = rendered.controller.state.currentKey!;
    const reason = 'Native control gate [settings.effort]: native UI did not reach the attested expected state before its deadline.';
    vi.spyOn(rendered.api.engine, 'setEffort').mockRejectedValueOnce(ipc(reason));
    await act(async () => { await rendered.controller.setEffort(key, 'high'); });
    const toast = await screen.findByText("The CLI couldn't apply this setting.");
    const details = toast.closest('.rd-toast')!.querySelector('details')!;
    expect(details).toHaveTextContent(reason);
    vi.spyOn(rendered.api.engine, 'setFastMode').mockRejectedValueOnce(new Error('fast refused'));
    await act(async () => { await rendered.controller.setFastMode(key, true); });
    await waitFor(() => expect(screen.getByText('fast refused')).toHaveClass('rd-toast__text'));
  });
});
