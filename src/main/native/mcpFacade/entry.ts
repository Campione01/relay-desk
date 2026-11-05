import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpTransportFacade } from './facade.ts';
import { serveFacadeControl, validateFacadeControl, type McpFacadeControl } from './control.ts';
import { createFacadeUpstream, createStdioRunner, type FacadeUpstreamConfig } from './upstream.ts';

export interface McpFacadeConfig {
  version: 1;
  name: string;
  upstream: FacadeUpstreamConfig;
  control: McpFacadeControl;
  jobHelperPath: string;
  cwd: string;
}

async function load(path: string): Promise<McpFacadeConfig> {
  if (!isAbsolute(path)) throw new Error('Private MCP configuration must be absolute.');
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('Invalid private MCP configuration file.');
  const config = JSON.parse(await readFile(path, 'utf8')) as McpFacadeConfig;
  if (config.version !== 1 || typeof config.name !== 'string' || !config.name || !isAbsolute(config.cwd) || !isAbsolute(config.jobHelperPath)) throw new Error('Invalid private MCP configuration.');
  validateFacadeControl(config.control);
  if (!config.upstream || ![undefined, 'stdio', 'http', 'sse'].includes(config.upstream.type)) throw new Error('Unsupported MCP upstream transport.');
  return config;
}

async function main(): Promise<void> {
  const runner = process.argv[2] === '--upstream';
  const configPath = process.argv[runner ? 3 : 2];
  const config = await load(configPath);
  const downstream = new StdioServerTransport();
  if (runner) {
    const upstream = createStdioRunner(config.upstream, config.cwd);
    let closed = false;
    const close = async () => { if (closed) return; closed = true; try { await upstream.close(); await downstream.close(); process.exit(0); } catch { process.exit(1); } };
    downstream.onmessage = (message) => { void upstream.send(message).catch(close); };
    upstream.onmessage = (message) => { void downstream.send(message).catch(close); };
    upstream.onclose = () => { void close(); }; upstream.onerror = () => { void close(); };
    process.stdin.on('end', () => { void close(); });
    await upstream.start(); await downstream.start();
    return;
  }
  const facade = new McpTransportFacade({ name: config.name, downstream,
    createUpstream: () => createFacadeUpstream(config.upstream, { jobHelperPath: config.jobHelperPath,
      entryPath: fileURLToPath(import.meta.url), configPath, cwd: config.cwd }),
  });
  const closeControl = await serveFacadeControl(config.control, facade);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; let code = 0; try { await facade.close(); } catch { code = 1; } finally { await closeControl(); process.exit(code); } };
  process.stdin.on('end', () => { void close(); });
  process.on('SIGTERM', () => { void close(); });
  process.on('SIGINT', () => { void close(); });
  await facade.start();
}

void main().catch(() => { process.stderr.write('Native MCP facade startup failed.\n'); process.exitCode = 1; });
