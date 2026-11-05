import { SIGN_IN_REQUIRED } from '@shared/signIn';
import type { MessageKey, Params } from '../i18n';
import { TERMINAL_ONLY_COMMANDS } from './slash';

export interface FriendlyError {
  key: MessageKey;
  params?: Params;
}

type Rule = readonly [RegExp, (match: RegExpExecArray) => FriendlyError];

// First match wins: a failed modal is also a control gate, and an exit can carry the transport failure that caused it.
const RULES: readonly Rule[] = [
  [new RegExp(SIGN_IN_REQUIRED.replaceAll('.', '\\.')), () => ({ key: 'error.signInRequired' })],
  [/Relay Desk does not run Claude Code's own sign-in inside a session\. Run \/([\w:-]+) in a terminal\./,
    (match) => ({ key: 'slash.signInTerminal', params: { name: match[1]! } })],
  [/a prior native modal failed; input recovery is required/, () => ({ key: 'error.dialogOpen' })],
  [/Native interactive feature gate \[ui\.command\.busy\]|Finish \/[\w:-]+ before running another command\.|Another slash command is still running in the native CLI\./,
    () => ({ key: 'error.commandBusy' })],
  [/\/([\w:-]+) is handled by Relay, not the native CLI\./, (match) => TERMINAL_ONLY_COMMANDS.has(match[1]!.toLowerCase())
    ? { key: 'slash.terminalOnly' } : { key: 'slash.relayHandled', params: { name: match[1]! } }],
  [/Native interactive process exited|Native transport: (?:owned child exited|Mod receiver disconnected|runtime closed|session is not ready)/,
    () => ({ key: 'error.sessionEnded' })],
  [/Native transport: request timed out/, () => ({ key: 'error.timedOut' })],
  [/Native control gate \[[^\]]+\]: /, () => ({ key: 'error.notApplied' })],
];

/** Plain words for a native failure Relay knows; null keeps the message as it came. */
export function friendlyError(message: string): FriendlyError | null {
  for (const [pattern, describe] of RULES) {
    const match = pattern.exec(message);
    if (match) return describe(match);
  }
  return null;
}
