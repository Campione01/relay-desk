import { randomUUID } from 'node:crypto';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InitializeResultSchema, isJSONRPCRequest, isJSONRPCResultResponse, isJSONRPCErrorResponse,
  type JSONRPCMessage, type JSONRPCRequest, type InitializeResult, type RequestId } from '@modelcontextprotocol/sdk/types.js';

export interface OwnedMcpTransport extends Transport { readonly pid?: number | null }
export interface McpFacadeStatus {
  name: string;
  status: 'pending' | 'connected' | 'disabled' | 'failed' | 'closed';
  generation: number;
  pid: number;
  ppid: number;
  upstreamPid?: number;
  toolCount?: number;
  observations: { toolsListRequests: number; disabledToolsListReplies: number; toolsListChangedSent: number };
}
export interface McpFacadeOptions {
  name: string;
  downstream: Transport;
  createUpstream(): OwnedMcpTransport | Promise<OwnedMcpTransport>;
  timeoutMs?: number;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const signature = (result: InitializeResult) => canonical({ protocolVersion: result.protocolVersion,
  capabilities: result.capabilities, serverInfo: result.serverInfo, instructions: result.instructions });
const emptyLists: Record<string, string> = {
  'tools/list': 'tools', 'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates', 'prompts/list': 'prompts',
};

/** A transport switch, not an MCP tool implementation: enabled traffic stays bidirectional JSON-RPC. */
export class McpTransportFacade {
  private readonly options: McpFacadeOptions;
  private upstream?: OwnedMcpTransport;
  private unclosed?: OwnedMcpTransport;
  private closing?: Promise<void>;
  private phase: McpFacadeStatus['status'] = 'pending';
  private generation = 0;
  private nativeInitialize?: JSONRPCRequest;
  private negotiated?: InitializeResult;
  private initialized = false;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly incoming = new Map<RequestId, JSONRPCRequest>();
  private readonly reverse = new Map<RequestId, { id: RequestId; generation: number }>();
  private readonly internal = new Map<RequestId, { resolve(message: JSONRPCMessage): void; reject(error: Error): void }>();
  private readonly subscriptions = new Map<string, JSONRPCRequest['params']>();
  private logging?: JSONRPCRequest['params'];
  private toolCount?: number;
  private readonly listedTools = new Set<string>();
  private readonly observations = { toolsListRequests: 0, disabledToolsListReplies: 0, toolsListChangedSent: 0 };

  constructor(options: McpFacadeOptions) { this.options = options; }
  async start(): Promise<void> {
    const downstream = this.options.downstream;
    downstream.onmessage = (message) => { void this.receive(message).catch(() => this.fail()).catch(() => undefined); };
    downstream.onclose = () => { void this.close().catch(() => undefined); };
    downstream.onerror = () => { void this.close().catch(() => undefined); };
    await downstream.start();
  }
  status(): McpFacadeStatus {
    return { name: this.options.name, status: this.phase, generation: this.generation,
      pid: process.pid, ppid: process.ppid, ...(this.upstream?.pid ? { upstreamPid: this.upstream.pid } : {}),
      ...(this.phase === 'disabled' ? { toolCount: 0 } : this.phase === 'connected' && this.toolCount !== undefined ? { toolCount: this.toolCount } : {}),
      observations: { ...this.observations } };
  }
  inspect(): Promise<McpFacadeStatus> {
    return this.run(async () => {
      if (this.initialized && this.phase === 'connected' && this.toolCount === undefined) await this.readToolCount();
      return this.status();
    });
  }
  setEnabled(enabled: boolean): Promise<McpFacadeStatus> {
    return this.run(async () => {
      if (!this.initialized || !this.nativeInitialize || !this.negotiated) throw new Error('Native MCP initialization has not completed.');
      if (this.phase === 'closed') throw new Error('MCP facade is closed.');
      if (enabled && this.phase === 'connected' || !enabled && this.phase === 'disabled') return this.status();
      await this.disconnect();
      if (enabled) {
        try { await this.connect(this.nativeInitialize, true); }
        catch { this.phase = 'failed'; await this.disconnect(); await this.changed(); throw new Error('MCP upstream reconnect failed or changed its negotiated contract.'); }
      } else this.phase = 'disabled';
      await this.changed();
      return this.status();
    });
  }
  reconnect(): Promise<McpFacadeStatus> {
    return this.run(async () => {
      if (!this.initialized || !this.nativeInitialize || !this.negotiated || this.phase === 'closed') throw new Error('Native MCP initialization has not completed or facade is closed.');
      await this.disconnect();
      try { await this.connect(this.nativeInitialize, true); }
      catch { this.phase = 'failed'; await this.disconnect(); await this.changed(); throw new Error('MCP upstream reconnect failed or changed its negotiated contract.'); }
      await this.changed();
      return this.status();
    });
  }
  close(): Promise<void> {
    return this.run(async () => {
      if (this.phase === 'closed' && !this.unclosed) return;
      this.phase = 'closed';
      this.options.downstream.onclose = undefined;
      try { await this.disconnect(); }
      finally { await this.options.downstream.close(); }
    });
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const work = this.serial.then(action);
    this.serial = work.catch(() => undefined);
    return work;
  }
  private error(id: RequestId, message: string): Promise<void> {
    return this.options.downstream.send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }
  private async receive(message: JSONRPCMessage): Promise<void> {
    let outgoing = message;
    let reverseReply = false;
    if (isJSONRPCRequest(message) && message.method === 'initialize') {
      if (this.nativeInitialize) { await this.error(message.id, 'MCP facade is already initialized.'); return; }
      this.nativeInitialize = structuredClone(message);
      await this.run(async () => {
        try {
          const result = await this.connect(message, false);
          await this.options.downstream.send({ jsonrpc: '2.0', id: message.id, result: this.advertised(result) });
        } catch { this.phase = 'failed'; await this.disconnect(); await this.error(message.id, 'MCP upstream initialization failed.'); }
      });
      return;
    }
    if (isJSONRPCRequest(message)) {
      if (message.method === 'tools/list') this.observations.toolsListRequests++;
      if (this.phase !== 'connected' || !this.upstream) {
        const field = emptyLists[message.method];
        if (this.initialized && field) {
          await this.options.downstream.send({ jsonrpc: '2.0', id: message.id, result: { [field]: [] } });
          if (message.method === 'tools/list') this.observations.disabledToolsListReplies++;
        }
        else if (message.method === 'ping') await this.options.downstream.send({ jsonrpc: '2.0', id: message.id, result: {} });
        else await this.error(message.id, 'MCP upstream is disconnected. No operation was sent.');
        return;
      }
      this.incoming.set(message.id, message);
    } else if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      if (message.id === undefined) return;
      const request = this.reverse.get(message.id);
      if (!request || request.generation !== this.generation) return;
      this.reverse.delete(message.id);
      outgoing = { ...message, id: request.id };
      reverseReply = true;
    } else if (message.method === 'notifications/initialized') {
      this.initialized = true;
    }
    const upstream = this.upstream;
    if (!upstream || this.phase !== 'connected' && !reverseReply) return;
    try { await upstream.send(outgoing); }
    catch { await this.fail(); }
  }
  private async connect(nativeRequest: JSONRPCRequest, reconnect: boolean): Promise<InitializeResult> {
    if (this.unclosed) throw new Error('Prior MCP transport closure has not been confirmed.');
    this.phase = 'pending';
    this.toolCount = undefined; this.listedTools.clear();
    const upstream = await this.options.createUpstream();
    this.upstream = upstream;
    const generation = ++this.generation;
    upstream.onmessage = (message) => {
      if (this.upstream !== upstream || generation !== this.generation) return;
      let outgoing = message;
      if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
        if (message.id === undefined) { void this.options.downstream.send(message); return; }
        const pending = this.internal.get(message.id);
        if (pending) { this.internal.delete(message.id); pending.resolve(message); return; }
        const request = this.incoming.get(message.id);
        if (!request) return;
        this.incoming.delete(message.id);
        if (isJSONRPCResultResponse(message)) {
          if (request.method === 'tools/list' && Array.isArray(message.result.tools)) {
            if (request.params?.cursor === undefined) this.listedTools.clear();
            for (const tool of message.result.tools) if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string') this.listedTools.add(tool.name);
            this.toolCount = message.result.nextCursor !== undefined ? undefined : this.listedTools.size;
          }
          if (request.method === 'resources/subscribe' && typeof request.params?.uri === 'string') this.subscriptions.set(request.params.uri, structuredClone(request.params));
          if (request.method === 'resources/unsubscribe' && typeof request.params?.uri === 'string') this.subscriptions.delete(request.params.uri);
          if (request.method === 'logging/setLevel') this.logging = structuredClone(request.params);
        }
      } else if (isJSONRPCRequest(message)) {
        const id = `relay-mcp-reverse-${generation}-${randomUUID()}`;
        this.reverse.set(id, { id: message.id, generation });
        outgoing = { ...message, id };
      } else if (message.method === 'notifications/tools/list_changed') this.toolCount = undefined;
      else if (message.method === 'notifications/cancelled') {
        const match = [...this.reverse].find(([, request]) => request.generation === generation && request.id === message.params?.requestId);
        if (match) outgoing = { ...message, params: { ...message.params, requestId: match[0] } };
      }
      void this.options.downstream.send(outgoing).catch(() => this.close()).catch(() => undefined);
    };
    upstream.onclose = () => { if (this.upstream === upstream) void this.fail().catch(() => undefined); };
    upstream.onerror = () => { if (this.upstream === upstream) void this.fail().catch(() => undefined); };
    await upstream.start();
    const raw = await this.internalRequest(upstream, 'initialize', nativeRequest.params);
    InitializeResultSchema.parse(raw);
    const result = raw as InitializeResult;
    if (this.negotiated && signature(result) !== signature(this.negotiated)) throw new Error('MCP initialization contract changed.');
    this.negotiated ??= structuredClone(result);
    if (!result.capabilities.tools) this.toolCount = 0;
    upstream.setProtocolVersion?.(result.protocolVersion);
    if (reconnect) {
      await upstream.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      if (this.logging) await this.internalRequest(upstream, 'logging/setLevel', this.logging);
      for (const params of this.subscriptions.values()) await this.internalRequest(upstream, 'resources/subscribe', params);
    }
    if (this.upstream !== upstream) throw new Error('MCP upstream closed during initialization.');
    this.phase = 'connected';
    return result;
  }
  private async internalRequest(upstream: Transport, method: string, params: JSONRPCRequest['params'], timeoutMs = this.options.timeoutMs ?? 15_000): Promise<Record<string, unknown>> {
    const id = `relay-mcp-${randomUUID()}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = new Promise<JSONRPCMessage>((resolve, reject) => {
        this.internal.set(id, { resolve, reject });
        timer = setTimeout(() => { this.internal.delete(id); reject(new Error('MCP upstream deadline exceeded.')); }, timeoutMs);
      });
      void response.catch(() => undefined);
      await upstream.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      const reply = await response;
      if (!isJSONRPCResultResponse(reply)) throw new Error('MCP upstream refused a required lifecycle request.');
      return reply.result;
    } finally { if (timer) clearTimeout(timer); this.internal.delete(id); }
  }
  private async readToolCount(): Promise<void> {
    const upstream = this.upstream;
    if (!upstream || this.phase !== 'connected') return;
    if (!this.negotiated?.capabilities.tools) { this.toolCount = 0; return; }
    const names = new Set<string>(), cursors = new Set<string>();
    const deadline = Date.now() + (this.options.timeoutMs ?? 15_000);
    let cursor: string | undefined;
    do {
      if (Date.now() >= deadline || this.upstream !== upstream) throw new Error('MCP tool inspection interrupted.');
      const result = await this.internalRequest(upstream, 'tools/list', cursor !== undefined ? { cursor } : {}, Math.max(1, deadline - Date.now()));
      if (!Array.isArray(result.tools)) throw new Error('MCP tool inspection returned no list.');
      for (const tool of result.tools) {
        if (!tool || typeof tool !== 'object' || !('name' in tool) || typeof tool.name !== 'string') throw new Error('Invalid MCP tool identity.');
        names.add(tool.name);
      }
      if (result.nextCursor !== undefined && (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor))) throw new Error('Invalid MCP tool pagination.');
      cursor = result.nextCursor as string | undefined;
      if (cursor !== undefined) cursors.add(cursor);
    } while (cursor !== undefined);
    if (this.upstream !== upstream || this.phase !== 'connected') throw new Error('MCP tool inspection interrupted.');
    this.toolCount = names.size;
  }
  private advertised(result: InitializeResult): InitializeResult {
    const value = structuredClone(result);
    for (const key of ['tools', 'resources', 'prompts'] as const) if (value.capabilities[key]) value.capabilities[key] = { ...value.capabilities[key], listChanged: true };
    return value;
  }
  private async changed(): Promise<void> {
    if (!this.initialized) return;
    for (const key of ['tools', 'resources', 'prompts'] as const) if (this.negotiated?.capabilities[key]) {
      await this.options.downstream.send({ jsonrpc: '2.0', method: `notifications/${key}/list_changed` });
      if (key === 'tools') this.observations.toolsListChangedSent++;
    }
    if (this.phase === 'connected') for (const uri of this.subscriptions.keys()) {
      await this.options.downstream.send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } });
    }
  }
  private async disconnect(): Promise<void> {
    if (this.closing) return this.closing;
    const upstream = this.upstream ?? this.unclosed;
    this.upstream = undefined;
    this.unclosed = upstream;
    if (this.phase !== 'closed' && this.phase !== 'failed') this.phase = 'pending';
    for (const pending of this.internal.values()) pending.reject(new Error('MCP upstream disconnected.'));
    this.internal.clear();
    const pending = [...this.incoming.keys()];
    const reverse = [...this.reverse.keys()];
    this.incoming.clear(); this.reverse.clear();
    const closing = (async () => {
      for (const id of pending) await this.error(id, 'MCP upstream disconnected during this operation. Its outcome may be unknown; it was not retried.').catch(() => undefined);
      for (const requestId of reverse) await this.options.downstream.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'MCP upstream disconnected.' } }).catch(() => undefined);
      try { if (upstream) await upstream.close(); this.unclosed = undefined; }
      catch (error) { this.phase = 'failed'; throw error; }
    })();
    this.closing = closing;
    try { await closing; }
    finally { if (this.closing === closing) this.closing = undefined; }
  }
  private async fail(): Promise<void> {
    if (this.phase === 'closed' || this.phase === 'failed') return;
    this.phase = 'failed';
    await this.disconnect();
    await this.changed();
  }
}
