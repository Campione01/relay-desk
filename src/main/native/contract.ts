/** Process transport boundary. This file must not import or start the Agent SDK. */
export interface NativeLaunch {
  exe: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  handleId: string;
  cols?: number;
  rows?: number;
}

export interface NativeReady {
  sessionId: string;
  isInteractive: boolean;
  surface: string | null;
  protocol: 1;
  capabilities: readonly string[];
  model?: string;
  cwd?: string;
}

export interface NativeEvent {
  event: string;
  sessionId: string;
  sequence: number;
  data: unknown;
}

export interface NativeRequestOptions {
  signal?: AbortSignal;
  /** Null waits for native completion; abort, transport loss and helper acknowledgements remain bounded. */
  timeoutMs?: number | null;
}

export interface NativeExitCause {
  readonly kind: 'transport';
  readonly message: string;
}

export interface NativeRuntime {
  start(launch: NativeLaunch): Promise<NativeReady>;
  request(method: string, args?: unknown, options?: NativeRequestOptions): Promise<unknown>;
  onEvent(listener: (event: NativeEvent) => void): () => void;
  onExit(listener: (code: number | null, cause?: NativeExitCause) => void): () => void;
  onTerminal(listener: (data: string) => void): () => void;
  writeTerminal(data: string): Promise<void>;
  /** Explicit menu keys accepted only until the native Mod hello. */
  writeStartup?(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export type NativeRuntimeFactory = () => NativeRuntime;
