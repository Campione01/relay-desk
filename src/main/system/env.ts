import { DEFAULT_PROFILE_ID, type Profile } from '@shared/types';
import { AUTHENTICATION_VARIABLES, authenticationEnvironmentMetadata, getLaunchAuthenticationInputs, selectAuthenticationEnvironment, validateAuthenticationSource } from './authenticationEnvironment';

/** Inherited host variables removed at startup and from every child env (rule R3 in docs/ARCHITECTURE.md). */
export const SCRUB_EXACT: readonly string[] = [
  // Inference-specific inputs must not silently override a saved account. Shared cloud credential chains
  // remain inherited for providers configured in CLI settings and for ordinary Bash/MCP tools.
  ...AUTHENTICATION_VARIABLES.filter((name) => name.startsWith('ANTHROPIC_')),
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CONFIG_DIR',
  // Not in the R3 list: the SDK derives the child's credential store from it, so an inherited value
  // would point a profile at another account's secure storage.
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
];
export const SCRUB_PREFIXES: readonly string[] = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_'];
// Native network controls stay inherited in both auth modes, never in the auth snapshot or UI metadata.
// https://code.claude.com/docs/en/network-config
export const PRESERVED_TRANSPORT: readonly string[] = [
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
  'CLAUDE_CODE_CERT_STORE',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_GZIP_REQUEST_BODIES',
  'CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION',
];

/**
 * Removes the R3 variables from `env` in place and returns it (works on process.env).
 * Names are compared case-insensitively because Windows env names are.
 */
export function scrubEnv<T extends Record<string, string | undefined>>(env: T): T {
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (PRESERVED_TRANSPORT.includes(upper)) continue;
    if (SCRUB_EXACT.includes(upper) || SCRUB_PREFIXES.some((p) => upper.startsWith(p))) {
      delete env[key];
    }
  }
  return env;
}

/**
 * Scrubbed copy of `base` plus CLAUDE_CONFIG_DIR for non-default profiles. `base` is never modified.
 * Only an explicitly selected launch source restores the original in-memory authentication inputs.
 * The optional third argument supplies a synthetic snapshot for pure tests; production uses the startup capture.
 * A non-default profile without a config dir throws: falling back to ~/.claude would run it as the default account.
 */
export function buildChildEnv(
  profile: Profile,
  base: NodeJS.ProcessEnv = process.env,
  launchEnvironment: Readonly<NodeJS.ProcessEnv> = getLaunchAuthenticationInputs(),
): NodeJS.ProcessEnv {
  const source = validateAuthenticationSource(profile.authenticationSource === undefined ? 'cli-config' : profile.authenticationSource);
  const env = scrubEnv({ ...base });
  if (source === 'launch-environment') {
    const inputs = selectAuthenticationEnvironment(launchEnvironment);
    if (!authenticationEnvironmentMetadata(inputs).available) throw new Error('No usable launch authentication source was available when Relay Desk started.');
    const replaced = new Set(Object.keys(inputs));
    for (const key of Object.keys(env)) {
      if (replaced.has(key.toUpperCase())) delete env[key];
    }
    Object.assign(env, inputs);
  }
  if (profile.id === DEFAULT_PROFILE_ID) return env;
  if (!profile.configDir) throw new Error(`Profile ${profile.id} has no config directory`);
  env.CLAUDE_CONFIG_DIR = profile.configDir;
  return env;
}
