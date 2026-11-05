import { describe, expect, it, vi } from 'vitest';
import { createNativeMcpControlSet, type NativeMcpControlSetOptions } from '../../src/main/native/mcpControls';
import type { McpFacadeConfig } from '../../src/main/native/mcpFacade/entry';
const observations = { toolsListRequests: 1, disabledToolsListReplies: 0, toolsListChangedSent: 0 };

function setup() {
  const configs: McpFacadeConfig[] = [];
  const states = new Map<string, 'connected' | 'disabled'>();
  const request = vi.fn<NonNullable<NativeMcpControlSetOptions['request']>>(async (control, method, enabled) => {
    const name = configs.find((config) => config.control.token === control.token)!.name;
    if (method === 'setEnabled') states.set(name, enabled ? 'connected' : 'disabled');
    if (method === 'reconnect') states.set(name, 'connected');
    return { name, status: states.get(name) ?? 'connected', generation: 1, pid: 101, ppid: 100, toolCount: 2, observations };
  });
  const options: NativeMcpControlSetOptions = {
    servers: { alpha: { command: 'node.exe', args: ['server.js'], env: { SYNTHETIC_SERVER_TOKEN: 'synthetic-secret' } },
      beta: { type: 'http', url: 'http://127.0.0.1:9000/mcp' } },
    nodeExecutable: 'C:\\fixture\\node.exe', entryPath: 'C:\\fixture\\facade.js', jobHelperPath: 'C:\\fixture\\OwnedMcpJob.exe', cwd: 'C:\\fixture\\project',
    env: { PATH: 'C:\\fixture', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1,localhost,[::1]', ANTHROPIC_API_KEY: 'private-account-secret', RELAY_NATIVE_PIPE_KEY: 'private-bridge-key' },
    writeConfig(config, index) { configs.push(config); return `C:\\fixture\\private\\mcp-${index}.json`; }, request,
  };
  return { configs, request, options, create: () => createNativeMcpControlSet(options) };
}
describe('native MCP coordinator', () => {
  it('preserves server namespaces and leaves process launch to the native CLI with private configs', () => {
    const h = setup(), controls = h.create();
    expect(Object.keys(controls.servers)).toEqual(['alpha', 'beta']);
    expect(h.configs[0].upstream).toEqual(h.options.servers.alpha);
    expect(h.configs[0].control).toMatchObject({ pipe: expect.stringMatching(/^\\\\\.\\pipe\\relay-mcp-/), token: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const descriptor = controls.servers.alpha;
    expect(descriptor).toMatchObject({ type: 'stdio', command: 'C:\\fixture\\node.exe', args: ['C:\\fixture\\facade.js', 'C:\\fixture\\private\\mcp-0.json'],
      env: { HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1' } });
    expect(JSON.stringify(descriptor)).not.toMatch(/synthetic-secret|private-account-secret|private-bridge-key/);
    expect(h.request).not.toHaveBeenCalled(); controls.close();
  });
  it('routes enable, disable and reconnect to the exact owned server and reports observed counts', async () => {
    const h = setup(), controls = h.create();
    expect(await controls.status()).toMatchObject([{ name: 'alpha', status: 'connected', toolCount: 2 }, { name: 'beta', status: 'connected', toolCount: 2 }]);
    expect(await controls.setEnabled('alpha', false)).toMatchObject([{ name: 'alpha', status: 'disabled', toolCount: 0 }, { name: 'beta', status: 'connected' }]);
    expect(await controls.setEnabled('alpha', true)).toMatchObject([{ name: 'alpha', status: 'connected', toolCount: 2 }, {}]);
    await controls.reconnect('beta');
    expect(h.request).toHaveBeenCalledWith(h.configs[1].control, 'reconnect');
    await expect(controls.setEnabled('unmanaged', false)).rejects.toThrow('not managed'); controls.close();
    await expect(controls.status()).rejects.toThrow('closed');
  });
  it('does not turn absent metadata or wrong identity into a connected zero-tool server', async () => {
    const h = setup(), controls = h.create();
    h.request.mockResolvedValueOnce({ name: 'alpha', status: 'connected', generation: 1, pid: 101, ppid: 100, observations });
    await expect(controls.status()).rejects.toThrow('not been observed');
    h.request.mockResolvedValueOnce({ name: 'other', status: 'disabled', generation: 1, pid: 101, ppid: 100, observations });
    await expect(controls.status()).rejects.toThrow('identity mismatch'); controls.close();
  });
  it('reports a not-yet-created owned control endpoint as pending, not as a successful connection', async () => {
    const h = setup(), controls = h.create();
    h.request.mockRejectedValueOnce(Object.assign(new Error('not started'), { code: 'ENOENT' }));
    expect(await controls.status()).toMatchObject([{ name: 'alpha', status: 'pending' }, { name: 'beta', status: 'connected' }]); controls.close();
  });
  it('rejects routing ambiguity and never accepts remote configuration paths', () => {
    const h = setup(); h.options.env.http_proxy = 'http://127.0.0.1:2';
    expect(h.create).toThrow('Conflicting'); delete h.options.env.http_proxy;
    h.options.writeConfig = () => '\\\\other-machine\\share\\config.json';
    expect(h.create).toThrow('private local storage');
  });
});
