import type { McpServerState } from '../../shared/types';
import type { NativeRuntime } from './contract';
import { NativeControlGate, NativeMcpDialogControls, type NativeUiController } from './controls.ts';

export interface NativePersistentMcpOptions {
  runtime: Pick<NativeRuntime, 'request'>;
  serverNames: readonly string[] | (() => readonly string[]);
  assertPreferenceScope(): void | Promise<void>;
  ui: NativeUiController;
}

/** All changes use the real native command and remain behind the parent's physical account-scope guard. */
export function createNativePersistentMcpControls(options: NativePersistentMcpOptions) {
  const names = () => [...(typeof options.serverNames === 'function' ? options.serverNames() : options.serverNames)];
  const dialogs = new NativeMcpDialogControls(options.ui, {
    serverNames: names, assertPreferenceScope: options.assertPreferenceScope,
    // A reconnect lasts as long as the server takes to start; a deadline would only report a false failure.
    perform: (operation, name) => options.runtime.request('mcp.nativeAction', { operation, name }, { timeoutMs: null }),
  });
  let tail: Promise<unknown> = Promise.resolve(); let pending = 0;
  const serialize = <T>(run: () => Promise<T>): Promise<T> => {
    if (pending >= 32) return Promise.reject(new NativeControlGate('mcp.nativeAction', 'native MCP control queue is full.'));
    pending++;
    const result = tail.then(run).finally(() => { pending--; }); tail = result.catch(() => undefined); return result;
  };
  const states = (rows: NativeMcpDialogStatusArray): McpServerState[] => rows.map((row) => ({ name: row.name,
    status: row.status, toolCount: row.toolCount ?? 0, relay: names().includes(row.name), source: 'native-account-dialog', scope: 'relay-account-project' }));
  return {
    status: (): Promise<McpServerState[]> => serialize(async () => { await options.assertPreferenceScope(); return states(await dialogs.inspectCatalog(names())); }),
    setEnabled: (name: string, enabled: boolean): Promise<McpServerState[]> => serialize(async () => {
      if (typeof enabled !== 'boolean') throw new Error('Native MCP enabled must be boolean.');
      return states(await dialogs.performNativeAction(enabled ? 'enable' : 'disable', name));
    }),
    reconnect: (name: string): Promise<McpServerState[]> => serialize(async () => states(await dialogs.performNativeAction('reconnect', name))),
  };
}
type NativeMcpDialogStatusArray = Awaited<ReturnType<NativeMcpDialogControls['inspectCatalog']>>;
