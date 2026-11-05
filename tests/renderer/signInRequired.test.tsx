import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_COMMANDS, SIGN_IN_COMMANDS, SIGN_IN_REQUIRED, signInCommandRefusal } from '@shared/signIn';
import type { EngineHandle } from '@shared/types';
import { translate, type Language } from '../../src/renderer/i18n';
import { friendlyError } from '../../src/renderer/lib/errors';
import { errorText } from '../../src/renderer/lib/format';
import { slashRoute } from '../../src/renderer/lib/slash';
import { renderApp, takeOverMain } from './helpers';

const ipc = (message: string): Error => new Error(`Error invoking remote method 'relay:engine:open': Error: ${message}`);
const MESSAGE: Record<Language, string> = {
  en: SIGN_IN_REQUIRED,
  'zh-TW': '此帳號尚未登入 Claude Code。請在「帳號」中使用「登入」，再重新開啟工作階段。',
};
const TERMINAL_NOTE: Record<Language, (name: string) => string> = {
  en: (name) => `Relay Desk does not run Claude Code's own sign-in inside a session. Run /${name} in a terminal.`,
  'zh-TW': (name) => `Relay Desk 不會在工作階段中執行 Claude Code 自己的登入。請在終端機中執行 /${name}。`,
};
const TERMINAL_COMMANDS = [...SIGN_IN_COMMANDS].filter((name) => !ACCOUNT_COMMANDS.has(name));

describe('a session refused because its account is not signed in', () => {
  it('reads as the fixed sign-in message in both languages', () => {
    expect(friendlyError(errorText(ipc(SIGN_IN_REQUIRED)))).toEqual({ key: 'error.signInRequired' });
    for (const language of ['en', 'zh-TW'] as const) expect(translate(language, 'error.signInRequired')).toBe(MESSAGE[language]);
  });

  it.each(['en', 'zh-TW'] as const)('shows it in %s when a session cannot open, with Reopen offered', async (language) => {
    const rendered = await renderApp({ settings: { language } }, (api) => {
      vi.spyOn(api.engine, 'open').mockRejectedValue(ipc(SIGN_IN_REQUIRED));
    });
    await act(async () => { await rendered.controller.newSession('D:\\signin-fixture'); });
    const banner = await screen.findByTestId('inline-error');
    expect(banner.querySelector('.rd-errmsg > span')?.textContent).toBe(MESSAGE[language]);
    expect(within(banner).getByRole('button', { name: translate(language, 'error.reopen') })).toBeInTheDocument();
  });

  // Main answers a startup key only once the CLI has: a second press meanwhile reaches nothing and shows no error.
  it('ignores a second startup key pressed before the CLI answered the first, which its sign-in answers by closing the session', async () => {
    const fail: { open?: (error: Error) => void; key?: (error: Error) => void } = {};
    const rendered = await renderApp({}, (api) => {
      vi.spyOn(api.engine, 'open').mockReturnValueOnce(new Promise<EngineHandle>((_resolve, reject) => { fail.open = reject; }));
      vi.spyOn(api.engine, 'startupInput').mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail.key = reject; }));
    });
    let opening!: Promise<void>;
    act(() => { opening = rendered.controller.newSession('D:\\signin-fixture'); });
    const key = rendered.controller.state.currentKey!;
    const requestId = rendered.controller.view(key)!.openingRequestId!;
    const emit = (revision: number, text: string, phase: 'waiting' | 'closed' = 'waiting') => act(() => {
      rendered.api.mock.emitEngine({ type: 'startup', requestId, handleId: 'signin-fixture-handle', revision, text, phase });
    });
    const theme = 'Choose the text style that looks best with your terminal\n> 1. Dark mode\n  2. Light mode';
    emit(1, theme);
    const region = screen.getByRole('region', { name: 'Native startup screen' });
    fireEvent.keyDown(region, { key: 'Enter' });
    // Main shows the same screen under a new revision while the key waits for the CLI's answer.
    emit(2, theme);
    fireEvent.keyDown(region, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(screen.getByRole('button', { name: 'Enter' })).toBeDisabled();
    expect(rendered.api.engine.startupInput).toHaveBeenCalledExactlyOnceWith('signin-fixture-handle', requestId, { revision: 1, key: 'enter' });
    expect(within(screen.getByTestId('native-startup')).queryByRole('alert')).toBeNull();
    // The CLI's next frame is its sign-in: main ends the startup, then the key and the open fail with the sign-in message.
    emit(3, '', 'closed');
    await act(async () => {
      fail.key!(new Error(`Error invoking remote method 'relay:engine:startupInput': Error: ${SIGN_IN_REQUIRED}`));
      fail.open!(ipc(SIGN_IN_REQUIRED));
      await opening;
    });
    expect(rendered.api.engine.startupInput).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('native-startup')).toBeNull();
    const banner = await screen.findByTestId('inline-error');
    expect(banner.querySelector('.rd-errmsg > span')?.textContent).toBe(MESSAGE.en);
  });

  // Main shows the screen again under the next revision once it accepts a key, before it writes the key.
  it('shows why a key that main accepted could not be written, and re-arms the keys for the screen main shows', async () => {
    const fail: { open?: (error: Error) => void; key?: (error: Error) => void } = {};
    const rendered = await renderApp({}, (api) => {
      vi.spyOn(api.engine, 'open').mockReturnValueOnce(new Promise<EngineHandle>((_resolve, reject) => { fail.open = reject; }));
      vi.spyOn(api.engine, 'close').mockResolvedValue();
      vi.spyOn(api.engine, 'startupInput').mockReturnValueOnce(new Promise<void>((_resolve, reject) => { fail.key = reject; }));
    });
    let opening!: Promise<void>;
    act(() => { opening = rendered.controller.newSession('D:\\signin-fixture'); });
    const key = rendered.controller.state.currentKey!;
    const requestId = rendered.controller.view(key)!.openingRequestId!;
    const emit = (revision: number, text: string) => act(() => {
      rendered.api.mock.emitEngine({ type: 'startup', requestId, handleId: 'signin-fixture-handle', revision, text, phase: 'waiting' });
    });
    const theme = 'Choose the text style that looks best with your terminal\n> 1. Dark mode\n  2. Light mode';
    emit(1, theme);
    const region = screen.getByRole('region', { name: 'Native startup screen' });
    fireEvent.keyDown(region, { key: 'Enter' });
    emit(2, theme);
    await act(async () => {
      fail.key!(new Error('Error invoking remote method \'relay:engine:startupInput\': Error: Native transport: native operation rejected'));
    });
    const card = within(screen.getByTestId('native-startup'));
    expect(card.getByRole('alert')).toHaveTextContent('Native transport: native operation rejected');
    expect(screen.getByRole('button', { name: 'Enter' })).not.toBeDisabled();
    // The next key is for the screen main shows now, and the error goes away with it.
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(rendered.api.engine.startupInput).toHaveBeenLastCalledWith('signin-fixture-handle', requestId, { revision: 2, key: 'enter' });
    expect(card.queryByRole('alert')).toBeNull();
    await act(async () => { await rendered.controller.closeSession(key); fail.open!(new Error('cancelled')); await opening; });
  });
});

describe('the CLI sign-in commands in the window', () => {
  it('opens Accounts for /login, /logout and /design-login and keeps the other sign-in commands out of the session', () => {
    for (const name of ACCOUNT_COMMANDS) {
      expect(slashRoute(name, '')).toBe('accounts');
      expect(slashRoute(name.toUpperCase(), 'with arguments')).toBe('accounts');
    }
    for (const name of [...TERMINAL_COMMANDS, 'rc', 'tp', 'TP', 'Upgrade']) expect(slashRoute(name, '')).toBe('signIn');
    // A session command of exactly an alias's name is the session's own, as in the CLI.
    expect(slashRoute('tp', '', [{ name: 'tp', description: 'My own command' }])).toBeNull();
    expect(slashRoute('teleport', '', [{ name: 'teleport', description: 'Listed by the CLI' }])).toBe('signIn');
  });

  it('compares a session command with the typed name letter for letter, as the CLI, the main process and the plugin do', () => {
    for (const alias of ['tp', 'rc']) {
      expect(slashRoute(alias, '', [{ name: alias, description: 'My own command' }])).toBeNull();
      expect(slashRoute(alias.toUpperCase(), '', [{ name: alias, description: 'My own command' }])).toBe('signIn');
      expect(slashRoute(alias, '', [{ name: alias.toUpperCase(), description: 'My own command' }])).toBe('signIn');
    }
    expect(slashRoute('UPGRADE', '', [{ name: 'UPGRADE', description: 'My own command' }])).toBe('signIn');
  });

  it('reads the main process refusals as notes that never say the account is signed out', () => {
    for (const name of ['login', 'logout', 'design-login']) {
      expect(friendlyError(signInCommandRefusal(name))).toEqual({ key: 'slash.relayHandled', params: { name } });
    }
    for (const name of [...TERMINAL_COMMANDS, 'rc', 'tp']) {
      expect(friendlyError(errorText(new Error(signInCommandRefusal(name))))).toEqual({ key: 'slash.signInTerminal', params: { name } });
    }
    for (const language of ['en', 'zh-TW'] as const) {
      expect(translate(language, 'slash.signInTerminal', { name: 'upgrade' })).toBe(TERMINAL_NOTE[language]('upgrade'));
      expect(translate(language, 'slash.signInTerminal', { name: 'upgrade' })).not.toBe(MESSAGE[language]);
    }
  });

  it('never sends /design-login to the open session and opens Accounts instead', async () => {
    const rendered = await renderApp();
    await takeOverMain(rendered);
    const send = vi.spyOn(rendered.api.engine, 'send');
    act(() => rendered.controller.setCard('accounts', false));
    await act(async () => { await rendered.controller.send(rendered.controller.state.currentKey!, '/design-login'); });
    expect(send).not.toHaveBeenCalled();
    expect(rendered.controller.state.ui.rightPanel).toBe(true);
    expect(rendered.controller.state.ui.cards.accounts).toBe(true);
  });

  it.each(['/upgrade', '/usage-credits', '/rate-limit-options', '/install-github-app', '/rc', '/tp', '/Setup-Bedrock now'])(
    'never sends %s to the open session and says that Relay Desk does not run the CLI sign-in', async (text) => {
      const rendered = await renderApp();
      await takeOverMain(rendered);
      const key = rendered.controller.state.currentKey!;
      const send = vi.spyOn(rendered.api.engine, 'send');
      act(() => rendered.controller.setDraft(key, text));
      await act(async () => { expect(await rendered.controller.send(key, text)).toBe(false); });
      const name = text.slice(1).split(' ')[0]!.toLowerCase();
      await waitFor(() => expect(rendered.controller.state.toasts.at(-1)).toMatchObject({ kind: 'info', text: TERMINAL_NOTE.en(name) }));
      expect(rendered.controller.state.drafts[key]).toBe(text);
      expect(rendered.controller.view(key)).toMatchObject({ submissions: [], errors: [] });
      expect(send).not.toHaveBeenCalled();
    });
});
