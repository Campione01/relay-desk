import { randomBytes } from 'node:crypto';
import { win32 } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpServerState } from '../../shared/types';
import type { NativeMcpControls } from './session';
import { requestFacadeControl, type McpFacadeControl, type McpFacadeControlMethod } from './mcpFacade/control';
import type { McpFacadeStatus } from './mcpFacade/facade';
import type { McpFacadeConfig } from './mcpFacade/entry';
import type { FacadeUpstreamConfig } from './mcpFacade/upstream';

type Request = (control: McpFacadeControl, method: McpFacadeControlMethod, enabled?: boolean) => Promise<McpFacadeStatus>;
export interface NativeMcpControlSetOptions {
  servers: Record<string, McpServerConfig>;
  nodeExecutable: string;
  entryPath: string;
  jobHelperPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  electronRunAsNode?: boolean;
  writeConfig(config: McpFacadeConfig, index: number): string;
  request?: Request;
}
const retainedEnvironment = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR',
  'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'NODE_USE_ENV_PROXY', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS']);

/** The CLI launches every facade. Main owns only authenticated control and private configuration. */
export function createNativeMcpControlSet(options: NativeMcpControlSetOptions): NativeMcpControls & {
  servers: Record<string, McpServerConfig>; close(): void;
} {
  for (const path of [options.nodeExecutable, options.entryPath, options.jobHelperPath, options.cwd]) {
    if (!win32.isAbsolute(path) || path.startsWith('\\\\') || /[\u0000-\u001f]/.test(path)) throw new Error('Native MCP paths must be absolute local paths.');
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) {
    if (value === undefined || !retainedEnvironment.has(key.toUpperCase())) continue;
    const normalized = key.toUpperCase();
    if (Object.hasOwn(env, normalized) && env[normalized] !== value) throw new Error('Conflicting native MCP environment keys.');
    env[normalized] = value;
  }
  if (options.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  const endpoints = new Map<string, McpFacadeControl>();
  const servers: Record<string, McpServerConfig> = Object.create(null);
  for (const [index, [name, config]] of Object.entries(options.servers).entries()) {
    if (!name || name.length > 100 || name === '__proto__' || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('Invalid native MCP server name.');
    if (config.type !== undefined && !['stdio', 'http', 'sse'].includes(config.type)) throw new Error('Native MCP facade supports configured stdio, HTTP and SSE transports only.');
    const control = { pipe: `\\\\.\\pipe\\relay-mcp-${randomBytes(16).toString('hex')}`, token: randomBytes(32).toString('hex') };
    const file = options.writeConfig({ version: 1, name, upstream: structuredClone(config) as FacadeUpstreamConfig,
      control, jobHelperPath: options.jobHelperPath, cwd: options.cwd }, index);
    if (!win32.isAbsolute(file) || file.startsWith('\\\\')) throw new Error('Native MCP configuration must use private local storage.');
    endpoints.set(name, control);
    servers[name] = { type: 'stdio', command: options.nodeExecutable, args: [options.entryPath, file], env: { ...env } };
  }
  let closed = false;
  const request = options.request ?? requestFacadeControl;
  const requireOpen = () => { if (closed) throw new Error('Native MCP controls are closed.'); };
  const endpoint = (name: string) => {
    requireOpen(); const result = endpoints.get(name);
    if (!result) throw new Error('This MCP server is not managed by the session transport facade.');
    return result;
  };
  const row = (name: string, actual: McpFacadeStatus): McpServerState => {
    if (actual.name !== name) throw new Error('Native MCP control identity mismatch.');
    if (actual.status === 'closed') return { name, status: 'failed', toolCount: 0, relay: true, source: 'native-facade', error: 'The owned MCP transport exited.' };
    const count = (actual as McpFacadeStatus & { toolCount?: number }).toolCount;
    if (actual.status === 'connected' && (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0)) {
      throw new Error('Native MCP tool count has not been observed; no zero count was fabricated.');
    }
    return { name, status: actual.status, toolCount: actual.status === 'connected' ? count! : 0, relay: true, scope: 'session', source: 'native-facade' };
  };
  const status = async (): Promise<McpServerState[]> => {
    requireOpen();
    const rows: McpServerState[] = [];
    for (const [name, control] of endpoints) {
      try { rows.push(row(name, await request(control, 'status'))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        rows.push({ name, status: 'pending', toolCount: 0, relay: true, source: 'native-facade' });
      }
    }
    requireOpen(); return rows;
  };
  return {
    servers, status,
    async setEnabled(name, enabled) {
      if (typeof enabled !== 'boolean') throw new Error('Invalid MCP enabled state.');
      await request(endpoint(name), 'setEnabled', enabled); return status();
    },
    async reconnect(name) { await request(endpoint(name), 'reconnect'); return status(); },
    close() { closed = true; endpoints.clear(); },
  };
}
