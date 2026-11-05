import type { NativeLaunch, NativeRuntime } from './contract';

/** The synthetic loopback provider of the isolated fixtures: a local model origin and a proxy that refuses everything. */
export type NativeNetworkBoundary = { kind: 'local-fixture'; origin: string; denyProxy: string };

export function assertFixtureLaunch(launch: NativeLaunch, origin: string, denyProxy: string): void {
  const local = (value: string) => {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Native fixture endpoints must be numeric loopback origins.');
    return url.origin;
  };
  const expectedOrigin = local(origin), expectedProxy = local(denyProxy);
  const env = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(launch.env)) {
    if (env.has(key.toUpperCase())) throw new Error('Ambiguous case-duplicate native environment.');
    env.set(key.toUpperCase(), value);
  }
  if (env.get('ANTHROPIC_API_KEY') !== 'native-acceptance-fake-key-not-a-real-credential' || env.get('ANTHROPIC_AUTH_TOKEN') ||
      env.get('ANTHROPIC_BASE_URL') !== expectedOrigin ||
      ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].some((key) => env.get(key) !== expectedProxy) ||
      env.get('NO_PROXY') !== '127.0.0.1,localhost,[::1]') throw new Error('Native fixture environment no longer matches its isolated provider.');
}

/** Refuses a fixture launch whose environment could reach a real provider, and closes the owned runtime on failure. */
export function guardNativeRuntime(runtime: NativeRuntime, boundary: NativeNetworkBoundary): NativeRuntime {
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { closed = true; await runtime.close(); })().catch((error) => { closing = undefined; throw error; });
  const verify = () => { if (closed) throw new Error('Native network admission is closed.'); };
  return {
    ...runtime,
    async start(launch) {
      try {
        assertFixtureLaunch(launch, boundary.origin, boundary.denyProxy);
        verify();
        const ready = await runtime.start(launch);
        verify();
        return ready;
      } catch (error) { await close(); throw error; }
    },
    async request(method, args, options) { verify(); return runtime.request(method, args, options); },
    async writeTerminal(data) { verify(); return runtime.writeTerminal(data); },
    ...(runtime.writeStartup ? { async writeStartup(data: string) { verify(); return runtime.writeStartup!(data); } } : {}),
    close,
  };
}
