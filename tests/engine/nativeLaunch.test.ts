import { describe, expect, it } from 'vitest';
import type { EngineSessionOptions } from '../../src/main/engine/session';
import { buildNativeLaunch } from '../../src/main/native/launch';

const profile = { id: 'second', name: 'Synthetic', configDir: 'C:\\fixture\\account', createdAt: 0 };
function options(extra: Partial<EngineSessionOptions> = {}): EngineSessionOptions {
  return { handleId: 'owned', profile, request: { profileId: profile.id, cwd: 'C:\\fixture\\project', model: 'claude-opus-5-5', effort: 'xhigh', workflows: 'on' }, emit: () => {}, broker: {} as EngineSessionOptions['broker'], ...extra };
}
const paths = { binary: 'C:\\fixture\\claude.exe', pluginDirectory: 'C:\\fixture\\native-mod', sessionId: '10000000-0000-4000-8000-000000000001' };

describe('native interactive launch', () => {
  it('preserves effort, model, shared settings and account isolation without a programmatic entrypoint', () => {
    const baseEnv = { HTTPS_PROXY: 'http://127.0.0.1:9988', ALL_PROXY: 'socks5://127.0.0.1:9989', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: 'C:\\fixture\\ca.pem', ANTHROPIC_API_KEY: 'synthetic-host-key', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' };
    const result = buildNativeLaunch(options({ codeContextSettings: { permissions: { deny: ['Read(secret)'] }, autoMemoryDirectory: 'C:\\fixture\\shared-memory', autoMemoryEnabled: false } }), { ...paths, baseEnv });
    expect(result.exe).toBe(paths.binary);
    expect(result.env).toMatchObject({ HTTPS_PROXY: baseEnv.HTTPS_PROXY, ALL_PROXY: baseEnv.ALL_PROXY, NO_PROXY: baseEnv.NO_PROXY, NODE_EXTRA_CA_CERTS: baseEnv.NODE_EXTRA_CA_CERTS, CLAUDE_CONFIG_DIR: profile.configDir });
    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(baseEnv.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts');
    expect(result.args).toContain('xhigh');
    expect(result.args).toContain('claude-opus-5-5');
    expect(result.args).not.toContain('-p');
    expect(result.args).not.toContain('--print');
    expect(result.args).not.toContain('--input-format');
    expect(result.args).not.toContain('--output-format');
    const settings = JSON.parse(result.args[result.args.indexOf('--settings') + 1]!);
    expect(settings).toMatchObject({ permissions: { deny: ['Read(secret)'] }, autoMemoryDirectory: 'C:\\fixture\\shared-memory', autoMemoryEnabled: false, enableWorkflows: true });
  });

  it('uses the verified interactive no-history control without the print-only flag', () => {
    const base = options();
    const result = buildNativeLaunch(options({ request: { ...base.request, resumeSessionId: paths.sessionId, forkSession: true, ephemeral: true } }), paths);
    expect(result.args).toContain('--resume');
    expect(result.args).toContain('--fork-session');
    expect(result.args).not.toContain('--no-session-persistence');
    expect(result.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY).toBe('1');
    expect(result.args).not.toContain('--session-id');
    expect(JSON.parse(result.args[result.args.indexOf('--settings') + 1]!).autoContinueAtUsageLimit).toBe(false);
    expect(JSON.parse(result.args[result.args.indexOf('--settings') + 1]!).env).toEqual({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' });
  });

  it('does not mask saved native workflow changes with an immutable startup flag', () => {
    const result = buildNativeLaunch(options(), { ...paths, persistentPreferences: true });
    const settings = JSON.parse(result.args[result.args.indexOf('--settings') + 1]!);
    expect(settings.enableWorkflows).toBeUndefined();
    expect(settings.fastMode).toBeUndefined();
    expect(settings.autoContinueAtUsageLimit).toBeUndefined();
    expect(result.args).toContain('xhigh');
    expect(result.args).toContain('claude-opus-5-5');
  });

  it('rejects caller-forged identity and unprotected MCP arguments', () => {
    expect(() => buildNativeLaunch(options({ buildEnv: () => ({ CLAUDE_CODE_ENTRYPOINT: 'cli' }) }), paths)).toThrow('identity');
    expect(() => buildNativeLaunch(options({ buildEnv: () => ({ CLAUDE_AGENT_SDK_VERSION: '0.3.302' }) }), paths)).toThrow('identity');
    expect(() => buildNativeLaunch(options({ buildEnv: () => ({ claude_agent_sdk_client_app: 'relay' }) }), paths)).toThrow('identity');
    expect(() => buildNativeLaunch(options({ mcpServers: { sample: { command: 'sample.exe', env: { TOKEN: 'synthetic' } } } }), paths)).toThrow('protected');
    const result = buildNativeLaunch(options({ mcpServers: { sample: { command: 'sample.exe', env: { TOKEN: 'synthetic' } } } }), { ...paths, mcpConfigPath: 'C:\\fixture\\private\\mcp.json' });
    expect(result.args).toContain('C:\\fixture\\private\\mcp.json');
    expect(result.args.join(' ')).not.toContain('TOKEN');
    expect(result.args.join(' ')).not.toContain('synthetic');
  });
});
