import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { McpImportPreview, McpServerEntry, McpTransport } from '@shared/types';
import { createSerialQueue, quarantineFile, readJsonFile, writeJsonFileAtomic } from './jsonFile';

/** Relay's own MCP list (userData mcp.json), shared by every account. Env values never leave this module except as SDK configs. */
export interface McpStore {
  list(): Promise<McpServerEntry[]>;
  /** Reads only the mcpServers object of %APPDATA%\Claude\claude_desktop_config.json, and only when called (the R1 exception in docs/ARCHITECTURE.md). */
  previewDesktopImport(): Promise<McpImportPreview>;
  /** Copies the named servers (env values included) from the desktop config; replaces entries with the same name. */
  importFromDesktop(names: string[]): Promise<McpServerEntry[]>;
  setEnabled(name: string, enabled: boolean): Promise<McpServerEntry[]>;
  remove(name: string): Promise<McpServerEntry[]>;
  /** SDK `mcpServers` configs of the enabled servers, for the engine (main only). */
  enabledConfigs(): Promise<Record<string, McpServerConfig>>;
}

export interface McpStoreOptions {
  /** Path of claude_desktop_config.json; defaults to %APPDATA%\Claude\claude_desktop_config.json (resolved lazily). */
  desktopConfigPath?: string | (() => string | Promise<string>);
}

const FILE_VERSION = 1;
export const MAX_MCP_SERVERS = 200;
export const MAX_IMPORT_NAMES = 50;
const MAX_NAME = 100;
const MAX_TEXT = 8192;
const MAX_ARGS = 200;
const MAX_MAP_KEYS = 200;
const MAX_URL = 2048;
const MAX_DESKTOP_CONFIG_BYTES = 5 * 1024 * 1024;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A server as kept in mcp.json: env and header values live here and nowhere else. */
interface StoredServer {
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  source: 'desktop';
  importedAt: number;
}

type ParsedServer = Omit<StoredServer, 'enabled' | 'source' | 'importedAt'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

class McpValidationError extends Error {
  override name = 'McpValidationError';
}

const validName = (name: unknown): name is string =>
  typeof name === 'string' &&
  name.length >= 1 &&
  name.length <= MAX_NAME &&
  name === name.trim() &&
  !CONTROL.test(name) &&
  name !== '__proto__';

/** A name that is safe to put in a message even when the config is hostile. */
const printable = (name: string): string => name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, MAX_NAME);

function textValue(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\u0000') ? value : null;
}

/** string -> string map; `keyOk` decides which keys are allowed. Returns null on any violation. */
function stringMap(value: unknown, keyOk: (key: string) => boolean, valueOk: (value: string) => boolean): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_KEYS) return null;
  const result: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (key === '__proto__' || !keyOk(key) || typeof item !== 'string' || item.length > MAX_TEXT || !valueOk(item)) return null;
    result[key] = item;
  }
  return result;
}

const envKeyOk = (key: string): boolean => key.length > 0 && key.length <= 256 && !/[=\u0000]/.test(key);
const noNul = (value: string): boolean => !value.includes('\u0000');
const headerValueOk = (value: string): boolean => !/[\u0000\r\n]/.test(value);

function httpUrl(value: unknown): string | null {
  const text = textValue(value, MAX_URL);
  if (!text) return null;
  try {
    const url = new URL(text);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return text;
  } catch {
    return null;
  }
}

/** The URL as shown to the renderer: no query or fragment, which often carry tokens. */
function displayUrl(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

/** Pure: one server from the desktop config shape ({ type?, command, args, env } or { type, url, headers }), or a reason. */
function parseServer(name: string, raw: unknown): ParsedServer | string {
  if (!isRecord(raw)) return 'entry is not an object';
  const type = raw.type;
  if (type !== undefined && type !== 'stdio' && type !== 'sse' && type !== 'http') {
    return 'unsupported transport type';
  }
  if (type === 'sse' || type === 'http') {
    const url = httpUrl(raw.url);
    if (!url) return 'url must be an http(s) address without embedded credentials';
    const server: ParsedServer = { name, transport: type, url };
    if (raw.headers !== undefined) {
      const headers = stringMap(raw.headers, (key) => HEADER_NAME.test(key) && key.length <= 256, headerValueOk);
      if (!headers) return 'headers must map header names to strings';
      server.headers = headers;
    }
    return server;
  }
  const command = textValue(raw.command, MAX_TEXT);
  if (!command) return type === undefined && raw.url !== undefined ? 'no transport type given for a url entry' : 'command must be a non-empty string';
  const server: ParsedServer = { name, transport: 'stdio', command };
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.length > MAX_ARGS || !raw.args.every((arg) => typeof arg === 'string' && arg.length <= MAX_TEXT && noNul(arg))) {
      return 'args must be a list of strings';
    }
    server.args = [...(raw.args as string[])];
  }
  if (raw.env !== undefined) {
    const env = stringMap(raw.env, envKeyOk, noNul);
    if (!env) return 'env must map names to strings';
    server.env = env;
  }
  return server;
}

const secretKeys = (server: ParsedServer): string[] => Object.keys(server.transport === 'stdio' ? (server.env ?? {}) : (server.headers ?? {}));

/** Env variable names for stdio servers, header names for sse/http: names only, never values. */
function toEntry(server: StoredServer): McpServerEntry {
  const entry: McpServerEntry = {
    name: server.name,
    transport: server.transport,
    envKeys: secretKeys(server),
    enabled: server.enabled,
    source: server.source,
    importedAt: server.importedAt,
  };
  if (server.command !== undefined) entry.command = server.command;
  if (server.args) entry.args = [...server.args];
  if (server.url !== undefined) entry.url = displayUrl(server.url);
  return entry;
}

function toConfig(server: StoredServer): McpServerConfig {
  if (server.transport === 'stdio') {
    return {
      type: 'stdio',
      command: server.command!,
      ...(server.args ? { args: [...server.args] } : {}),
      ...(server.env ? { env: { ...server.env } } : {}),
    };
  }
  return {
    type: server.transport,
    url: server.url!,
    ...(server.headers ? { headers: { ...server.headers } } : {}),
  };
}

/** Pure, lenient (stored file): keeps the valid servers, drops invalid and duplicate ones; null when unusable. */
export function sanitizeMcpFile(value: unknown): StoredServer[] | null {
  if (!isRecord(value) || !Array.isArray(value.servers)) return null;
  const result: StoredServer[] = [];
  const names = new Set<string>();
  for (const item of value.servers.slice(0, MAX_MCP_SERVERS)) {
    if (!isRecord(item) || !validName(item.name) || names.has(item.name)) continue;
    const parsed = parseServer(item.name, { ...item, type: item.transport });
    if (typeof parsed === 'string') continue;
    names.add(item.name);
    result.push({
      ...parsed,
      enabled: item.enabled === true,
      source: 'desktop',
      importedAt: typeof item.importedAt === 'number' && Number.isFinite(item.importedAt) ? item.importedAt : 0,
    });
  }
  return result;
}

interface DesktopRead {
  servers: Map<string, ParsedServer>;
  warnings: string[];
}

export function createMcpStore(userDataDir: string, options: McpStoreOptions = {}): McpStore {
  const file = join(userDataDir, 'mcp.json');
  const serial = createSerialQueue();
  let cache: StoredServer[] | undefined;

  const save = async (servers: StoredServer[]): Promise<void> => {
    await writeJsonFileAtomic(file, { version: FILE_VERSION, servers });
    cache = servers;
  };

  const load = async (): Promise<StoredServer[]> => {
    if (cache) return cache;
    const read = await readJsonFile(file);
    if (read.state === 'missing') {
      cache = [];
      return cache;
    }
    const servers = read.state === 'ok' ? sanitizeMcpFile(read.value) : null;
    if (!servers) {
      await quarantineFile(file);
      cache = [];
      return cache;
    }
    cache = servers;
    return cache;
  };

  const entries = async (): Promise<McpServerEntry[]> => (await load()).map(toEntry);

  const desktopPath = async (): Promise<string> => {
    const configured = options.desktopConfigPath;
    if (typeof configured === 'string') return configured;
    if (configured) return configured();
    const { app } = await import('electron');
    return join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json');
  };

  /** Reads only the mcpServers object of the desktop config; every other key is ignored and nothing from the file is logged. */
  const readDesktop = async (path: string): Promise<DesktopRead> => {
    const result: DesktopRead = { servers: new Map(), warnings: [] };
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      result.warnings.push(code === 'ENOENT' ? 'Claude desktop config not found; nothing to import.' : 'Claude desktop config could not be read.');
      return result;
    }
    if (size > MAX_DESKTOP_CONFIG_BYTES) {
      result.warnings.push('Claude desktop config is too large to import.');
      return result;
    }
    let read;
    try {
      read = await readJsonFile(path);
    } catch {
      result.warnings.push('Claude desktop config could not be read.');
      return result;
    }
    if (read.state === 'missing') {
      result.warnings.push('Claude desktop config not found; nothing to import.');
      return result;
    }
    if (read.state === 'invalid') {
      result.warnings.push('Claude desktop config is not valid JSON.');
      return result;
    }
    const section = isRecord(read.value) ? read.value.mcpServers : undefined;
    if (!isRecord(section)) {
      result.warnings.push('Claude desktop config has no mcpServers object.');
      return result;
    }
    const keys = Object.keys(section);
    if (keys.length > MAX_MCP_SERVERS) result.warnings.push(`Only the first ${MAX_MCP_SERVERS} servers are considered.`);
    for (const name of keys.slice(0, MAX_MCP_SERVERS)) {
      if (!validName(name)) {
        result.warnings.push(`Skipped "${printable(name)}": the name must be 1-${MAX_NAME} characters without control characters.`);
        continue;
      }
      const parsed = parseServer(name, section[name]);
      if (typeof parsed === 'string') result.warnings.push(`Skipped "${name}": ${parsed}.`);
      else result.servers.set(name, parsed);
    }
    return result;
  };

  return {
    list: () => serial(entries),

    previewDesktopImport: () =>
      serial(async () => {
        const sourcePath = await desktopPath();
        const desktop = await readDesktop(sourcePath);
        const existing = new Set((await load()).map((server) => server.name));
        const servers: McpImportPreview['servers'] = [...desktop.servers.values()].map((server) => {
          const item: McpImportPreview['servers'][number] = {
            name: server.name,
            transport: server.transport,
            envKeys: secretKeys(server),
            exists: existing.has(server.name),
          };
          if (server.command !== undefined) item.command = server.command;
          if (server.args) item.args = [...server.args];
          if (server.url !== undefined) item.url = displayUrl(server.url);
          return item;
        });
        return { sourcePath, servers, warnings: desktop.warnings };
      }),

    importFromDesktop: (names) =>
      serial(async () => {
        if (!Array.isArray(names) || names.length > MAX_IMPORT_NAMES || !names.every(validName)) {
          throw new McpValidationError(`Server names must be a list of at most ${MAX_IMPORT_NAMES} valid names.`);
        }
        const wanted = [...new Set(names)];
        const desktop = await readDesktop(await desktopPath());
        const missing = wanted.filter((name) => !desktop.servers.has(name));
        if (missing.length > 0) {
          throw new McpValidationError(`Not found as a valid server in the desktop config: ${missing.map(printable).join(', ')}`);
        }
        const next = [...(await load())];
        const importedAt = Date.now();
        for (const name of wanted) {
          const server: StoredServer = { ...desktop.servers.get(name)!, enabled: true, source: 'desktop', importedAt };
          const at = next.findIndex((existing) => existing.name === name);
          if (at >= 0) next[at] = server;
          else next.push(server);
        }
        if (next.length > MAX_MCP_SERVERS) throw new McpValidationError(`At most ${MAX_MCP_SERVERS} MCP servers.`);
        await save(next);
        return entries();
      }),

    setEnabled: (name, enabled) =>
      serial(async () => {
        if (typeof enabled !== 'boolean') throw new McpValidationError('enabled must be a boolean.');
        const current = await load();
        if (!validName(name) || !current.some((server) => server.name === name)) {
          throw new McpValidationError(`Unknown MCP server: ${typeof name === 'string' ? printable(name) : ''}`);
        }
        await save(current.map((server) => (server.name === name ? { ...server, enabled } : server)));
        return entries();
      }),

    remove: (name) =>
      serial(async () => {
        const current = await load();
        if (!validName(name) || !current.some((server) => server.name === name)) {
          throw new McpValidationError(`Unknown MCP server: ${typeof name === 'string' ? printable(name) : ''}`);
        }
        await save(current.filter((server) => server.name !== name));
        return entries();
      }),

    enabledConfigs: () =>
      serial(async () => {
        const configs: Record<string, McpServerConfig> = {};
        for (const server of await load()) if (server.enabled) configs[server.name] = toConfig(server);
        return configs;
      }),
  };
}
