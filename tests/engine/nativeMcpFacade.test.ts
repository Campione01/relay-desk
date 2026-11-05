import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isJSONRPCRequest, ListToolsRequestSchema, type JSONRPCMessage, type JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpTransportFacade } from '../../src/main/native/mcpFacade/facade';
import { requestFacadeControl, serveFacadeControl } from '../../src/main/native/mcpFacade/control';
import { createFacadeUpstream, createProxyFetch, upstreamEnvironment } from '../../src/main/native/mcpFacade/upstream';

const initial = { protocolVersion: '2025-06-18', capabilities: {
  tools: {}, resources: { subscribe: true }, prompts: {}, logging: {}, experimental: { example: { unchanged: true } },
}, serverInfo: { name: 'actual-server', version: '1' }, instructions: 'Keep the real server instructions.', _meta: { fixture: 'preserved' } };
const init: JSONRPCRequest = { jsonrpc: '2.0', id: 'native-init', method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} },
  clientInfo: { name: 'claude-code', version: '2.1.302' },
} };
class Wire implements Transport {
  sent: JSONRPCMessage[] = [];
  closed = false;
  starts = 0;
  onmessage?: Transport['onmessage'];
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onSend?: (message: JSONRPCMessage) => void;
  async start() { this.starts++; }
  async close() { this.closed = true; this.onclose?.(); }
  async send(message: JSONRPCMessage) { if (this.closed) throw new Error('Closed wire'); this.sent.push(structuredClone(message)); this.onSend?.(message); }
  receive(message: JSONRPCMessage) { this.onmessage?.(structuredClone(message)); }
}
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 1000; count++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error('Fixture did not settle.');
}
async function fixture(options: { secondInit?: typeof initial; holdCalls?: boolean } = {}) {
  const downstream = new Wire(), upstreams: Wire[] = [];
  const facade = new McpTransportFacade({ name: 'original_server', downstream, timeoutMs: 500,
    createUpstream: () => {
      const wire = new Wire(); upstreams.push(wire);
      wire.onSend = (message) => {
        if (!isJSONRPCRequest(message)) return;
        if (message.method === 'tools/call' && options.holdCalls) return;
        let result: Record<string, unknown> = {};
        if (message.method === 'initialize') result = upstreams.length > 1 ? options.secondInit ?? initial : initial;
        if (message.method === 'tools/list') result = { tools: [{ name: 'echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], _meta: { raw: 'tools' } };
        if (message.method === 'resources/list') result = { resources: [{ uri: 'fixture://one', name: 'one' }] };
        if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ uriTemplate: 'fixture://{id}', name: 'template' }] };
        if (message.method === 'prompts/list') result = { prompts: [{ name: 'prompt', arguments: [{ name: 'arg', required: true }] }] };
        if (message.method === 'tools/call') result = { content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }], structuredContent: { result: 1 }, _meta: { test: 'unchanged' } };
        wire.receive({ jsonrpc: '2.0', id: message.id, result });
      };
      return wire;
    },
  });
  cleanups.push(() => facade.close());
  await facade.start(); downstream.receive(init);
  await until(() => downstream.sent.some((message) => 'id' in message && message.id === init.id));
  downstream.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { downstream, upstreams, facade };
}
async function request(downstream: Wire, method: string, params?: JSONRPCRequest['params'], id = randomBytes(4).toString('hex')) {
  downstream.receive({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  await until(() => downstream.sent.some((message) => 'id' in message && message.id === id));
  return downstream.sent.find((message) => 'id' in message && message.id === id)!;
}

describe('native MCP transport facade', () => {
  it('preserves real initialization identity/instructions/capabilities and adds listChanged only to existing surfaces', async () => {
    const { downstream, upstreams, facade } = await fixture();
    expect(upstreams[0].sent[0]).toMatchObject({ method: 'initialize', params: init.params });
    expect(downstream.sent[0]).toEqual({ jsonrpc: '2.0', id: init.id, result: {
      ...initial, capabilities: { ...initial.capabilities, tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true } },
    } });
    expect(facade.status()).toMatchObject({ name: 'original_server', status: 'connected', generation: 1, pid: process.pid, ppid: process.ppid });
  });

  it.each(['tools/list', 'resources/list', 'resources/templates/list', 'prompts/list', 'tools/call'])('forwards %s parameters and raw result intact', async (method) => {
    const { downstream, upstreams } = await fixture();
    const params = { name: 'echo', arguments: { value: 'x' }, _meta: { progressToken: 'p' } };
    const result = await request(downstream, method, params, 'request-1');
    expect(upstreams[0].sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 'request-1', method, params });
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 'request-1', result: expect.any(Object) });
    if (method === 'tools/call') expect(result).toHaveProperty('result.structuredContent.result', 1);
  });

  it('actually closes upstream while disabled; all four lists are empty and tool/control-lookalike calls do not reach it', async () => {
    const { downstream, upstreams, facade } = await fixture();
    const before = upstreams[0].sent.length;
    const status = await facade.setEnabled(false);
    expect(status).toMatchObject({ status: 'disabled', generation: 1 });
    expect(upstreams[0].closed).toBe(true); expect(downstream.closed).toBe(false);
    for (const [method, field] of Object.entries({ 'tools/list': 'tools', 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates', 'prompts/list': 'prompts' })) {
      expect(await request(downstream, method)).toHaveProperty(`result.${field}`, []);
    }
    expect(await request(downstream, 'tools/call', { name: 'relay_enable', arguments: {} })).toHaveProperty('error.code', -32000);
    expect(upstreams[0].sent).toHaveLength(before);
    expect(downstream.sent.filter((message) => 'method' in message && message.method.endsWith('/list_changed')).map((message) => 'method' in message && message.method))
      .toEqual(['notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/prompts/list_changed']);
  });

  it('reinitializes the same native client contract, preserves server namespace and keeps facade identity on enable', async () => {
    const { downstream, upstreams, facade } = await fixture();
    const pid = facade.status().pid;
    await facade.setEnabled(false); await facade.setEnabled(true);
    expect(upstreams).toHaveLength(2); expect(upstreams[1].starts).toBe(1);
    expect(upstreams[1].sent[0]).toMatchObject({ method: 'initialize', params: init.params });
    expect(upstreams[1].sent[1]).toEqual({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(facade.status()).toMatchObject({ name: 'original_server', pid, status: 'connected', generation: 2 });
    expect(await request(downstream, 'tools/list')).toHaveProperty('result.tools.0.name', 'echo');
  });

  it('forwards reverse roots/sampling/elicitation requests, notifications, progress and cancellation unchanged', async () => {
    const { downstream, upstreams } = await fixture();
    for (const method of ['roots/list', 'sampling/createMessage', 'elicitation/create']) {
      const requestMessage: JSONRPCRequest = { jsonrpc: '2.0', method, id: `reverse-${method}`, params: { fixture: true } };
      upstreams[0].receive(requestMessage);
      const delivered = downstream.sent.at(-1) as JSONRPCRequest;
      expect(delivered).toMatchObject({ method, params: requestMessage.params });
      const response: JSONRPCMessage = { jsonrpc: '2.0', id: delivered.id, result: { untouched: true } };
      downstream.receive(response); expect(upstreams[0].sent.at(-1)).toEqual({ ...response, id: requestMessage.id });
    }
    const progress: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'p', progress: 5, total: 9 } };
    upstreams[0].receive(progress); expect(downstream.sent.at(-1)).toEqual(progress);
    const cancel: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3, reason: 'stop' } };
    downstream.receive(cancel); expect(upstreams[0].sent.at(-1)).toEqual(cancel);
  });

  it('does not forward an old generation reply or retry an interrupted tool side effect', async () => {
    const { downstream, upstreams, facade } = await fixture({ holdCalls: true });
    downstream.receive({ jsonrpc: '2.0', id: 'write', method: 'tools/call', params: { name: 'write', arguments: {} } });
    await facade.setEnabled(false);
    expect(downstream.sent.find((message) => 'id' in message && message.id === 'write')).toHaveProperty('error.message', expect.stringContaining('outcome may be unknown'));
    const before = downstream.sent.length;
    upstreams[0].receive({ jsonrpc: '2.0', id: 'write', result: { success: true } });
    expect(downstream.sent).toHaveLength(before);
    await facade.setEnabled(true);
    expect(upstreams[1].sent.some((message) => 'method' in message && message.method === 'tools/call')).toBe(false);
  });

  it('restores accepted resource subscriptions/logging level, never replays unrelated calls', async () => {
    const { downstream, upstreams, facade } = await fixture();
    await request(downstream, 'resources/subscribe', { uri: 'fixture://one' });
    await request(downstream, 'resources/subscribe', { uri: 'fixture://two' });
    await request(downstream, 'resources/unsubscribe', { uri: 'fixture://two' });
    await request(downstream, 'logging/setLevel', { level: 'warning' });
    await facade.reconnect();
    expect(upstreams[1].sent.filter((message) => 'method' in message).map((message) => 'method' in message && message.method))
      .toEqual(['initialize', 'notifications/initialized', 'logging/setLevel', 'resources/subscribe']);
    expect(upstreams[1].sent.at(-1)).toMatchObject({ params: { uri: 'fixture://one' } });
    expect(downstream.sent.at(-1)).toEqual({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'fixture://one' } });
  });

  it('refuses capability/instruction drift instead of returning fake reconnect success', async () => {
    const { upstreams, facade } = await fixture({ secondInit: { ...initial, instructions: 'Changed contract' } });
    await expect(facade.reconnect()).rejects.toThrow('changed its negotiated contract');
    expect(facade.status().status).toBe('failed'); expect(upstreams[1].closed).toBe(true);
  });

  it('serializes repeated toggles without creating duplicate upstreams', async () => {
    const { upstreams, facade } = await fixture();
    await Promise.all([facade.setEnabled(false), facade.setEnabled(false), facade.setEnabled(true), facade.setEnabled(true)]);
    expect(upstreams).toHaveLength(2); expect(facade.status().status).toBe('connected');
  });

  it('does not send an old native reverse reply into a new upstream that reuses its request ID', async () => {
    const { downstream, upstreams, facade } = await fixture();
    upstreams[0].receive({ jsonrpc: '2.0', id: 1, method: 'roots/list' });
    const oldId = (downstream.sent.at(-1) as JSONRPCRequest).id;
    await facade.reconnect();
    expect(downstream.sent).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: oldId, reason: 'MCP upstream disconnected.' } });
    upstreams[1].receive({ jsonrpc: '2.0', id: 1, method: 'roots/list' });
    const newId = (downstream.sent.at(-1) as JSONRPCRequest).id;
    expect(newId).not.toBe(oldId);
    const before = upstreams[1].sent.length;
    downstream.receive({ jsonrpc: '2.0', id: oldId, result: { roots: [{ uri: 'file:///old' }] } });
    expect(upstreams[1].sent).toHaveLength(before);
    downstream.receive({ jsonrpc: '2.0', id: newId, result: { roots: [] } });
    expect(upstreams[1].sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 1, result: { roots: [] } });
  });

  it('never reports disabled or creates a replacement while prior transport closure is unconfirmed', async () => {
    const { facade, upstreams } = await fixture();
    const close = upstreams[0].close.bind(upstreams[0]);
    upstreams[0].close = async () => { throw new Error('close not confirmed'); };
    try {
      await expect(facade.setEnabled(false)).rejects.toThrow('close not confirmed');
      expect(facade.status().status).toBe('failed');
      await expect(facade.setEnabled(true)).rejects.toThrow('close not confirmed');
      expect(upstreams).toHaveLength(1);
    } finally { upstreams[0].close = close; }
    await facade.setEnabled(false);
    expect(facade.status().status).toBe('disabled'); expect(upstreams[0].closed).toBe(true);
  });

  it('reads actual paginated tool counts through control inspection, and sends nothing while disabled', async () => {
    const { facade, upstreams } = await fixture();
    const previous = upstreams[0].onSend;
    upstreams[0].onSend = (message) => {
      if (isJSONRPCRequest(message) && message.method === 'tools/list') {
        upstreams[0].receive({ jsonrpc: '2.0', id: message.id, result: message.params?.cursor === undefined
          ? { tools: [{ name: 'first' }], nextCursor: '' } : { tools: [{ name: 'second' }] } });
      } else previous?.(message);
    };
    expect(facade.status().toolCount).toBeUndefined();
    expect(await facade.inspect()).toMatchObject({ status: 'connected', toolCount: 2 });
    await facade.setEnabled(false);
    const before = upstreams[0].sent.length;
    expect(await facade.inspect()).toMatchObject({ status: 'disabled', toolCount: 0 });
    expect(upstreams[0].sent).toHaveLength(before);
  });

  it('keeps the control channel authenticated and separate from model tools', async () => {
    const { facade } = await fixture();
    const control = { pipe: `\\\\.\\pipe\\relay-mcp-${randomBytes(16).toString('hex')}`, token: randomBytes(32).toString('hex') };
    cleanups.push(await serveFacadeControl(control, facade));
    await expect(requestFacadeControl({ ...control, token: '0'.repeat(64) }, 'setEnabled', false)).rejects.toThrow('authentication');
    expect(facade.status().status).toBe('connected');
    expect(await requestFacadeControl(control, 'setEnabled', false)).toMatchObject({ status: 'disabled', pid: process.pid });
    expect(await requestFacadeControl(control, 'setEnabled', true)).toMatchObject({ status: 'connected', generation: 2 });
  });
});

describe('MCP upstream environment and proxy routing', () => {
  it('preserves protected inherited proxy variables despite the SDK whitelist and excludes private control credentials', () => {
    const env = upstreamEnvironment({ PATH: 'bin', Http_Proxy: 'http://127.0.0.1:5', HTTPS_PROXY: 'http://127.0.0.1:5', ALL_PROXY: 'http://127.0.0.1:5', NO_PROXY: 'localhost', RELAY_NATIVE_NONCE: 'private' }, { CUSTOM: 'value' });
    expect(env).toEqual({ PATH: 'bin', HTTP_PROXY: 'http://127.0.0.1:5', HTTPS_PROXY: 'http://127.0.0.1:5', ALL_PROXY: 'http://127.0.0.1:5', NO_PROXY: 'localhost', CUSTOM: 'value' });
    expect(() => upstreamEnvironment(env, { http_proxy: 'http://other' })).toThrow('override inherited HTTP_PROXY');
    expect(() => upstreamEnvironment(env, { no_proxy: '*' })).toThrow('override inherited NO_PROXY');
  });

  it('does not bypass a failing explicit proxy to reach even a loopback target', async () => {
    let direct = 0, proxyRequests = 0;
    const target = createServer((_request, response) => { direct++; response.end('direct'); });
    const proxy = createServer((_request, response) => { proxyRequests++; response.writeHead(502); response.end(); });
    proxy.on('connect', (_request, socket) => { proxyRequests++; socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const route = createProxyFetch({ HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, NO_PROXY: '' });
    try {
      await expect(route.fetch(`http://127.0.0.1:${(target.address() as AddressInfo).port}`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      expect(proxyRequests).toBeGreaterThan(0); expect(direct).toBe(0);
    } finally {
      await route.close();
      await new Promise<void>((resolve) => target.close(() => resolve()));
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('assigns the owned stdio tree before execution and retires its grandchild when the root exits', async () => {
    const helper = fileURLToPath(new URL('../../tools/native-mcp-facade/OwnedMcpJob.exe', import.meta.url));
    const code = "const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(JSON.stringify({pid:process.pid,child:child.pid})+'\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
    const processHandle = spawn(helper, [process.execPath, '-e', code], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const exited = new Promise<void>((resolve, reject) => { processHandle.once('error', reject); processHandle.once('close', () => resolve()); });
    try {
      processHandle.stdout.on('data', (chunk) => { output += chunk.toString(); });
      await until(() => output.includes('\n'));
      const ids = JSON.parse(output.slice(0, output.indexOf('\n'))) as { pid: number; child: number };
      expect(ids.pid).toBeGreaterThan(0); expect(ids.child).toBeGreaterThan(0);
      processHandle.stdin.end(); await exited;
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      await until(() => !alive(ids.pid) && !alive(ids.child));
      expect(alive(ids.child)).toBe(false);
    } finally {
      if (processHandle.exitCode === null) processHandle.kill();
      await exited;
    }
  });

  it.each(['http', 'sse'] as const)('closes the real local %s transport while disabled and reconnects with configured headers', async (kind) => {
    const sessions: Array<{ server: Server; transport: SSEServerTransport | StreamableHTTPServerTransport }> = [];
    const sockets = new Set<Socket>();
    let requests = 0;
    const headers: Array<string | string[] | undefined> = [];
    const fixtureServer = createServer((incoming, outgoing) => {
      requests++; headers.push(incoming.headers['x-fixture']);
      void (async () => {
        let session = kind === 'http'
          ? sessions.find((entry) => entry.transport.sessionId === incoming.headers['mcp-session-id'])
          : sessions.find((entry) => entry.transport.sessionId === new URL(incoming.url ?? '/', 'http://localhost').searchParams.get('sessionId'));
        if (!session && (kind === 'http' && incoming.method === 'POST' || kind === 'sse' && incoming.method === 'GET')) {
          const transport = kind === 'http' ? new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomBytes(16).toString('hex') })
            : new SSEServerTransport('/messages', outgoing);
          const server = new Server({ name: 'local-fixture', version: '1' }, { capabilities: { tools: {} } });
          server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'local', inputSchema: { type: 'object' } }] }));
          session = { server, transport }; sessions.push(session); await server.connect(transport);
          if (kind === 'sse') return;
        }
        if (!session) { outgoing.writeHead(404); outgoing.end(); return; }
        if (session.transport instanceof StreamableHTTPServerTransport) await session.transport.handleRequest(incoming, outgoing);
        else await session.transport.handlePostMessage(incoming, outgoing);
      })().catch(() => { outgoing.writeHead(500); outgoing.end(); });
    });
    fixtureServer.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
    const downstream = new Wire();
    const facade = new McpTransportFacade({ name: 'same-name', downstream, timeoutMs: 1_000,
      createUpstream: () => createFacadeUpstream({ type: kind, url: `http://127.0.0.1:${(fixtureServer.address() as AddressInfo).port}/mcp`, headers: { 'x-fixture': 'kept' } },
        { jobHelperPath: '', entryPath: '', configPath: '', cwd: process.cwd(), env: { HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' } }),
    });
    try {
      await facade.start(); downstream.receive(init);
      await until(() => downstream.sent.some((message) => 'id' in message && message.id === init.id));
      downstream.receive({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(await request(downstream, 'tools/list')).toHaveProperty('result.tools.0.name', 'local');
      await facade.setEnabled(false); await until(() => sockets.size === 0);
      const afterClose = requests;
      expect(await request(downstream, 'tools/list')).toHaveProperty('result.tools', []);
      expect(requests).toBe(afterClose);
      await facade.setEnabled(true);
      expect(await request(downstream, 'tools/list')).toHaveProperty('result.tools.0.name', 'local');
      expect(sessions).toHaveLength(2); expect(headers.every((value) => value === 'kept')).toBe(true);
    } finally {
      await facade.close();
      for (const session of sessions) await session.server.close();
      fixtureServer.closeAllConnections();
      await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
    }
  });
});
