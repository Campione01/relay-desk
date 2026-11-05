import { createOwnedAuthTerminalOpener, type OwnedAuthTerminalDeps, type OwnedAuthTerminalOpener } from './ownedAuthTerminal';

/** A login start failure whose message is safe to show to the user as the reason. */
export class LoginLaunchError extends Error {
  override name = 'LoginLaunchError';
}

/**
 * The official `claude auth login`, run unmodified in its own visible console owned by RelayAuthHost. The CLI reads and
 * writes that console directly and the host reports only its start and exit, so Relay Desk never receives an
 * authorization URL, code or credential. Callers pass the launch through as built: no added arguments or environment.
 */
export function createOfficialLoginOpener(deps: Omit<OwnedAuthTerminalDeps, 'visible'>): OwnedAuthTerminalOpener {
  return createOwnedAuthTerminalOpener({ ...deps, visible: true });
}
