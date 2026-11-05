// User-facing HandoffResult messages (English, the default UI language). Never include command output in them.

export const MSG = {
  loginConsoleOpened: 'The official Claude Code sign-in opened in its own console window. Complete it there; this account refreshes when that window closes.',
  loginFailed: (reason: string) => `Could not open the login window: ${reason}`,
  loggedOut: 'Logged out of this account.',
  logoutFailed: (code: number | null) => `Logout failed (exit code ${code ?? 'none'}).`,
  invalidEmail: 'Email address is not valid.',

  desktopDefaultOnly: 'Only the default account (which shares ~/.claude with desktop) can hand a session back to desktop.',
  desktopOpened: 'Handed this conversation to desktop.',
  desktopFolderOpened: 'Opened this folder in desktop.',
  desktopFailed: (code: number | null) => `The desktop handoff did not complete (exit code ${code ?? 'none'}). The exact reason is shown in the terminal window that just opened; press any key there to close it after reading. Common causes: the default account is not signed in with a Claude subscription, this conversation is open elsewhere (for example in another terminal or in desktop), desktop is not installed, or this account is restricted.`,
  closeFailed: (reason: string) => `Could not close this conversation in Relay first: ${reason}`,
  terminalOpened: 'Opened in a terminal. Tip: type /desktop in the terminal to hand the conversation to desktop.',
  terminalFailed: (reason: string) => `Could not open a terminal: ${reason}`,
  cloudOpened: 'Created a cloud session in a terminal.',
  teleportOpened: 'Pulled the session back from the cloud in a terminal.',
  remoteControlOpened: 'Started Remote Control in a terminal.',
  attachOpened: 'Attached to the background session in a terminal.',
  emptyTask: 'Enter the task to hand to the cloud first.',
  invalidSessionId: 'The conversation ID is not valid.',
  invalidBackgroundId: 'The background session ID is not valid.',
  invalidCloudSessionId: 'The cloud session ID is not valid.',
  invalidFolder: 'The folder path is not valid (it must be an absolute local path).',
  unknownProfile: (id: string) => `Account profile not found: ${id}`,
} as const;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
