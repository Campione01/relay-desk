import { timingSafeEqual } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { McpFacadeStatus, McpTransportFacade } from './facade.ts';

export interface McpFacadeControl { pipe: string; token: string }
export type McpFacadeControlMethod = 'status' | 'setEnabled' | 'reconnect';
export function validateFacadeControl(control: McpFacadeControl): void {
  if (!/^\\\\\.\\pipe\\relay-mcp-[a-f0-9-]{16,100}$/.test(control.pipe) || !/^[a-f0-9]{64}$/.test(control.token)) throw new Error('Invalid private MCP control endpoint.');
}
export async function serveFacadeControl(control: McpFacadeControl, facade: McpTransportFacade): Promise<() => Promise<void>> {
  validateFacadeControl(control);
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => socket.destroy());
    socket.setTimeout(20_000, () => socket.destroy());
    let body = '', handled = false;
    socket.on('data', (data) => {
      if (handled) return;
      body += data.toString('utf8');
      if (Buffer.byteLength(body) > 65536) { socket.destroy(); return; }
      const end = body.indexOf('\n'); if (end < 0) return;
      handled = true;
      void (async () => {
        let id: unknown;
        try {
          const request = JSON.parse(body.slice(0, end)) as { id?: unknown; token?: unknown; method?: unknown; enabled?: unknown };
          id = request.id;
          if (typeof request.token !== 'string' || !/^[a-f0-9]{64}$/.test(request.token) ||
            !timingSafeEqual(Buffer.from(request.token), Buffer.from(control.token))) throw new Error('MCP control authentication failed.');
          if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid MCP control request identity.');
          let result: McpFacadeStatus;
          if (request.method === 'status') result = await facade.inspect();
          else if (request.method === 'reconnect') result = await facade.reconnect();
          else if (request.method === 'setEnabled' && typeof request.enabled === 'boolean') result = await facade.setEnabled(request.enabled);
          else throw new Error('Unsupported MCP control operation.');
          if (result.status === 'connected' && result.toolCount === undefined) result = await facade.inspect();
          socket.end(`${JSON.stringify({ id, result })}\n`);
        } catch (error) { socket.end(`${JSON.stringify({ id: typeof id === 'string' ? id : null,
          error: error instanceof Error ? error.message : 'MCP control failed.' })}\n`); }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(control.pipe, resolve); });
  return async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); };
}

export async function requestFacadeControl(control: McpFacadeControl, method: McpFacadeControlMethod, enabled?: boolean): Promise<McpFacadeStatus> {
  validateFacadeControl(control);
  return new Promise((resolve, reject) => {
    const socket = createConnection(control.pipe); let body = '', settled = false;
    const finish = (error?: Error, result?: McpFacadeStatus) => {
      if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result!);
    };
    socket.setTimeout(20_000, () => finish(new Error('MCP control deadline exceeded.')));
    socket.on('error', (error) => finish(error));
    socket.on('end', () => { if (!settled) finish(new Error('MCP control closed without a reply.')); });
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'control', token: control.token, method, ...(enabled !== undefined ? { enabled } : {}) })}\n`));
    socket.on('data', (data) => {
      body += data.toString('utf8');
      if (Buffer.byteLength(body) > 65536) { finish(new Error('MCP control reply too large.')); return; }
      const end = body.indexOf('\n'); if (end < 0) return;
      try {
        const reply = JSON.parse(body.slice(0, end)) as { id: string; error?: string; result?: McpFacadeStatus };
        if (reply.id !== 'control' || !reply.result && !reply.error) throw new Error('Invalid MCP control reply.');
        finish(reply.error ? new Error(reply.error) : undefined, reply.result);
      } catch { finish(new Error('Invalid MCP control reply.')); }
    });
  });
}
