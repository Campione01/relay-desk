import { describe, expect, it } from 'vitest';
import {
  authenticationEnvironmentMetadata,
  captureLaunchAuthenticationEnvironment,
  getAuthenticationEnvironmentMetadata,
  getLaunchAuthenticationInputs,
  selectAuthenticationEnvironment,
  validateAuthenticationSource,
} from '../../src/main/system/authenticationEnvironment';
import { buildChildEnv, scrubEnv } from '../../src/main/system/env';

describe('launch authentication environment', () => {
  it('projects sorted canonical names only and excludes client identity, proxy, TLS, model and language variables', () => {
    const env = {
      claude_code_oauth_token: 'synthetic-oauth', ANTHROPIC_BASE_URL: 'https://synthetic.invalid',
      ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_AGENT_SDK_VERSION: 'synthetic-sdk',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', ANTHROPIC_MODEL: 'synthetic-model',
      HTTP_PROXY: 'http://127.0.0.1:9011', NODE_EXTRA_CA_CERTS: 'D:\\synthetic\\ca.pem', LANG: 'synthetic-language',
      CLAUDE_CODE_CLIENT_CERT: 'D:\\synthetic\\client.pem', CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'synthetic-transport-secret',
    };
    expect(authenticationEnvironmentMetadata(env)).toEqual({
      available: true, variableNames: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
    expect(JSON.stringify(authenticationEnvironmentMetadata(env))).not.toContain('synthetic');
    expect(selectAuthenticationEnvironment(env)).toEqual({ ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://synthetic.invalid', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' });
  });

  it('reports route-only inputs by name without advertising an available authentication selection', () => {
    expect(authenticationEnvironmentMetadata({ ANTHROPIC_BASE_URL: 'https://synthetic.invalid', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: synthetic' })).toEqual({
      available: false, variableNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS'],
    });
    expect(authenticationEnvironmentMetadata({ AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic' }).available).toBe(false);
    expect(authenticationEnvironmentMetadata({ ANTHROPIC_ORGANIZATION_ID: 'synthetic' }).available).toBe(false);
    expect(authenticationEnvironmentMetadata({ ANTHROPIC_ORGANIZATION_ID: 'synthetic', ANTHROPIC_FEDERATION_RULE_ID: 'synthetic' }).available).toBe(false);
    expect(authenticationEnvironmentMetadata({ ANTHROPIC_API_KEY: '   ' }).available).toBe(false);
    expect(authenticationEnvironmentMetadata({})).toEqual({ available: false, variableNames: [] });
  });

  it.each(['1', 'true', 'TRUE', 'yes', 'on'])('recognizes an explicit native provider selector %s without inventing credentials', (value) => {
    for (const provider of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      expect(authenticationEnvironmentMetadata({ [provider]: value })).toEqual({ available: true, variableNames: [provider] });
    }
  });

  it.each(['0', 'false', 'off', 'no', '', 'invalid'])('does not mistake a disabled or invalid selector %s for available authentication', (value) => {
    expect(authenticationEnvironmentMetadata({ CLAUDE_CODE_USE_BEDROCK: value }).available).toBe(false);
  });

  it('captures once before scrubbing, retains only auth inputs in memory and returns defensive copies', () => {
    const original = { ANTHROPIC_API_KEY: 'synthetic-original-key', HTTPS_PROXY: 'http://127.0.0.1:9011', CLAUDE_CODE_ENTRYPOINT: 'desktop' };
    captureLaunchAuthenticationEnvironment(original);
    scrubEnv(original);
    expect(original).toEqual({ HTTPS_PROXY: 'http://127.0.0.1:9011' });
    captureLaunchAuthenticationEnvironment({ ANTHROPIC_API_KEY: 'synthetic-later-key' });
    const inputs = getLaunchAuthenticationInputs();
    expect(inputs).toEqual({ ANTHROPIC_API_KEY: 'synthetic-original-key' });
    inputs.ANTHROPIC_API_KEY = 'synthetic-mutated-copy';
    expect(getAuthenticationEnvironmentMetadata()).toEqual({ available: true, variableNames: ['ANTHROPIC_API_KEY'] });
    expect(buildChildEnv({ id: 'default', name: 'Default', configDir: null, createdAt: 0, authenticationSource: 'launch-environment' }, original)).toEqual({
      HTTPS_PROXY: original.HTTPS_PROXY, ANTHROPIC_API_KEY: 'synthetic-original-key',
    });
    expect(buildChildEnv({ id: 'default', name: 'Default', configDir: null, createdAt: 0 }, original)).toEqual(original);
  });

  it('accepts only exact source identifiers without coercion', () => {
    expect(validateAuthenticationSource('cli-config')).toBe('cli-config');
    expect(validateAuthenticationSource('launch-environment')).toBe('launch-environment');
    for (const invalid of [undefined, null, false, {}, [], 'CLI-CONFIG', 'launch-environment ']) {
      expect(() => validateAuthenticationSource(invalid)).toThrow('Invalid authentication source.');
    }
  });
});
