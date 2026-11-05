export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const PIPE_ENV = 'RELAY_NATIVE_PIPE';
export const NONCE_ENV = 'RELAY_NATIVE_NONCE';
export const HELPER_ENV = 'RELAY_NATIVE_HELPER';

export interface BridgeRequest {
  type: 'request';
  id: string;
  method: string;
  args?: unknown;
}

export interface BridgeReply {
  type: 'response';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

export interface BridgeEvent {
  type: 'event';
  event: string;
  sessionId: string;
  sequence: number;
  data: unknown;
}

export interface BridgeHello {
  type: 'hello';
  protocol: 1;
  sessionId: string;
  isInteractive: boolean;
  surface: string | null;
  capabilities: readonly string[];
  model?: string;
  cwd?: string;
}

export interface BridgeStartupError {
  type: 'startupError';
  protocol: 1;
  code: 'MOD_INIT_FAILED';
}

export type BridgeOutput = BridgeReply | BridgeEvent | BridgeHello | BridgeStartupError;
