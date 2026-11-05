import { randomUUID } from 'node:crypto';
import type { EngineSessionOptions } from '../engine/session';
import { buildChildEnv } from '../system/env';
import { toLocalAbsolutePath } from '../system/paths';
import type { NativeLaunch } from './contract';

export interface NativeLaunchPaths {
  binary: string;
  pluginDirectory: string;
  mcpConfigPath?: string;
  sessionId?: string;
  baseEnv?: NodeJS.ProcessEnv;
  persistentPreferences?: boolean;
}

/** The same account/settings intent, expressed as documented interactive CLI inputs. */
export function buildNativeLaunch(options: EngineSessionOptions, paths: NativeLaunchPaths): NativeLaunch {
  const binary = toLocalAbsolutePath(paths.binary);
  const cwd = toLocalAbsolutePath(options.request.cwd);
  const plugin = toLocalAbsolutePath(paths.pluginDirectory);
  if (!binary || !cwd || !plugin) throw new Error('Native backend paths must be absolute local paths.');
  const request = options.request;
  const env = { ...(options.buildEnv ? options.buildEnv(options.profile) : buildChildEnv(options.profile, paths.baseEnv)) };
  // A caller-supplied environment must obey the same identity isolation as the ordinary launcher.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'CLAUDE_CODE_ENTRYPOINT' || key.toUpperCase().startsWith('CLAUDE_AGENT_SDK_')) {
      throw new Error('Native interactive mode must not override client identity.');
    }
  }
  if (request.ephemeral) env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1';
  const settings: Record<string, unknown> = {
    ...(request.ephemeral ? { env: { CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' } } : {}),
    ...(options.codeContextSettings?.permissions !== undefined ? { permissions: structuredClone(options.codeContextSettings.permissions) } : {}),
    ...(options.codeContextSettings?.autoMemoryDirectory !== undefined ? { autoMemoryDirectory: options.codeContextSettings.autoMemoryDirectory } : {}),
    ...(options.codeContextSettings?.autoMemoryEnabled !== undefined ? { autoMemoryEnabled: options.codeContextSettings.autoMemoryEnabled } : {}),
    ...(request.ultracode !== undefined ? { ultracode: request.ultracode } : {}),
    ...(request.fastMode !== undefined && !paths.persistentPreferences ? { fastMode: request.fastMode } : {}),
    ...(request.workflows !== undefined && !paths.persistentPreferences ? { enableWorkflows: request.workflows === 'on' } : {}),
    ...(!paths.persistentPreferences || request.ephemeral ? { autoContinueAtUsageLimit: request.autoContinue !== false && request.ephemeral !== true } : {}),
  };
  const args = ['--plugin-dir', plugin, '--setting-sources', 'user,project,local', '--settings', JSON.stringify(settings)];
  if (request.model) args.push('--model', request.model);
  if (request.effort) args.push('--effort', request.effort);
  if (request.permissionMode) args.push('--permission-mode', request.permissionMode);
  if (request.resumeSessionId) args.push('--resume', request.resumeSessionId);
  else args.push('--session-id', paths.sessionId ?? randomUUID());
  if (request.forkSession) args.push('--fork-session');
  if (options.mcpServers && Object.keys(options.mcpServers).length) {
    const config = toLocalAbsolutePath(paths.mcpConfigPath);
    if (!config) throw new Error('Native MCP startup requires a protected session configuration file.');
    args.push('--mcp-config', config);
  }
  return { exe: binary, args, cwd, env: { ...env }, handleId: options.handleId, cols: 140, rows: 48 };
}
