import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport, FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import type { OwnedMcpTransport } from './facade.ts';

export type FacadeUpstreamConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> };
const protectedNetwork = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS'];

/** The SDK default whitelist omits proxy variables. Keep the inherited routing intent, case-insensitively. */
export function upstreamEnvironment(parent: NodeJS.ProcessEnv, configured: Record<string, string> = {}): Record<string, string> {
  const values = new Map<string, string>();
  const allowed = new Set([...DEFAULT_INHERITED_ENV_VARS, 'COMSPEC', 'PATHEXT', 'WINDIR', 'TMP', ...protectedNetwork].map((key) => key.toUpperCase()));
  for (const [key, value] of Object.entries(parent)) if (value !== undefined && allowed.has(key.toUpperCase())) {
    const normalized = key.toUpperCase();
    if (values.has(normalized) && values.get(normalized) !== value) throw new Error(`Conflicting inherited environment key: ${normalized}`);
    values.set(normalized, value);
  }
  for (const [key, value] of Object.entries(configured)) {
    const normalized = key.toUpperCase();
    if (protectedNetwork.includes(normalized) && values.get(normalized) !== value) throw new Error(`MCP server cannot override inherited ${normalized}.`);
    if (normalized.startsWith('RELAY_NATIVE_') || normalized.startsWith('RELAY_MCP_')) throw new Error('MCP server cannot set private control environment.');
    values.set(normalized, value);
  }
  return Object.fromEntries(values);
}

export function createProxyFetch(env: NodeJS.ProcessEnv): { fetch: FetchLike; close(): Promise<void> } {
  const normalized = new Map(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => [key.toUpperCase(), value]));
  const httpProxy = normalized.get('HTTP_PROXY') || normalized.get('ALL_PROXY');
  const httpsProxy = normalized.get('HTTPS_PROXY') || normalized.get('ALL_PROXY') || httpProxy;
  if (!httpProxy || !httpsProxy) throw new Error('HTTP/SSE MCP requires explicit inherited proxy routing.');
  const dispatcher = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: normalized.get('NO_PROXY') ?? '' });
  return { fetch: (url, init) => proxyFetch(url, { ...init, dispatcher } as Parameters<typeof proxyFetch>[1]) as unknown as Promise<Response>,
    close: () => dispatcher.destroy() };
}

function owned(transport: Transport, cleanup: () => Promise<void>, pid?: () => number | null): OwnedMcpTransport {
  const result: OwnedMcpTransport = {
    get pid() { return pid?.(); },
    async start() {
      transport.onmessage = (message, extra) => result.onmessage?.(message, extra);
      transport.onerror = (error) => result.onerror?.(error);
      transport.onclose = () => result.onclose?.();
      await transport.start();
    },
    send: (message, options) => transport.send(message, options),
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    async close() { try { await transport.close(); } finally { await cleanup(); } },
  };
  return result;
}

/** Called inside the facade descendant only, never in main. All stdio descendants belong to the helper's job. */
export function createFacadeUpstream(config: FacadeUpstreamConfig, options: {
  jobHelperPath: string; entryPath: string; configPath: string; cwd: string; env?: NodeJS.ProcessEnv;
}): OwnedMcpTransport {
  const env = options.env ?? process.env;
  if (config.type === 'http' || config.type === 'sse') {
    const proxy = createProxyFetch(env);
    const settings = { fetch: proxy.fetch, requestInit: { headers: config.headers }, redirectPolicy: 'same-origin' as const };
    const transport = config.type === 'http' ? new StreamableHTTPClientTransport(new URL(config.url), settings)
      : new SSEClientTransport(new URL(config.url), settings);
    return owned(transport, proxy.close);
  }
  if (process.platform !== 'win32') throw new Error('The owned MCP stdio job currently requires Windows.');
  // The runner uses SDK cross-spawn for .cmd/.bat/PATH behavior; the helper assigns it before its first instruction.
  const transport = new StdioClientTransport({ command: options.jobHelperPath,
    args: [process.execPath, options.entryPath, '--upstream', options.configPath], cwd: options.cwd,
    env: upstreamEnvironment(env), stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  let exited = false;
  let confirmExit!: () => void;
  const exit = new Promise<void>((resolve) => { confirmExit = resolve; });
  const wrapper = owned(transport, async () => {
    if (exited) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([exit, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Owned MCP job close was not confirmed.')), 5_000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
  }, () => transport.pid);
  const start = wrapper.start;
  wrapper.start = async () => {
    const onclose = wrapper.onclose;
    wrapper.onclose = () => { exited = true; confirmExit(); onclose?.(); };
    try { await start(); }
    catch (error) { exited = true; confirmExit(); throw error; }
  };
  return wrapper;
}

/** Runs inside the Windows Job. No control credentials are passed in the actual server's environment. */
export function createStdioRunner(config: FacadeUpstreamConfig, cwd: string): StdioClientTransport {
  if (!('command' in config)) throw new Error('The stdio runner cannot start a remote transport.');
  const transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd ?? cwd,
    env: upstreamEnvironment(process.env, config.env), stderr: 'pipe' });
  transport.stderr?.on('data', () => undefined);
  return transport;
}
