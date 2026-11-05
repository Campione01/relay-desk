import { describe, expect, it } from 'vitest';
import type { Profile } from '@shared/types';
import { buildChildEnv, scrubEnv, PRESERVED_TRANSPORT } from '../../src/main/system/env';
import { AUTHENTICATION_VARIABLES } from '../../src/main/system/authenticationEnvironment';

const hostEnv = (): NodeJS.ProcessEnv => ({
  PATH: 'C:\\Windows',
  ANTHROPIC_API_KEY: 'secret',
  ANTHROPIC_BASE_URL: 'https://proxy.invalid',
  CLAUDECODE: '1',
  claude_config_dir: 'C:\\desktop\\.claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'secret',
  CLAUDE_AGENT_SDK_VERSION: '9',
  CLAUDE_SECURESTORAGE_CONFIG_DIR: 'C:\\desktop\\store',
  CLAUDE_EFFORT: 'high',
});

describe('explicit authentication sources', () => {
  const optedIn: Profile = { ...work, authenticationSource: 'launch-environment' };

  it('isolates native inference selection without clearing shared cloud credential infrastructure', () => {
    const auth = Object.fromEntries(AUTHENTICATION_VARIABLES.map((key) => [key.toLowerCase(), `synthetic-${key}`]));
    const base: NodeJS.ProcessEnv = { ...auth, PATH: 'C:\\Windows', HTTPS_PROXY: 'http://127.0.0.1:9011', NODE_EXTRA_CA_CERTS: 'D:\\certs\\ca.pem' };
    const infrastructure = Object.fromEntries(Object.entries(auth).filter(([name]) => !name.startsWith('anthropic_') && !name.startsWith('claude_code_')));
    expect(buildChildEnv(work, base, { ANTHROPIC_API_KEY: 'original-synthetic' })).toEqual({
      ...infrastructure,
      PATH: base.PATH, HTTPS_PROXY: base.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: base.NODE_EXTRA_CA_CERTS,
      CLAUDE_CONFIG_DIR: work.configDir,
    });
    expect(base.anthropic_api_key).toBe('synthetic-ANTHROPIC_API_KEY');
  });

  it.each([
    { ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_BASE_URL: 'https://api.synthetic.invalid', ANTHROPIC_CUSTOM_HEADERS: 'Authorization: synthetic-custom' },
    { ANTHROPIC_AUTH_TOKEN: 'synthetic-auth-token' },
    { CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-oauth' },
    { CLAUDE_CODE_USE_BEDROCK: '1', AWS_ACCESS_KEY_ID: 'synthetic-id', AWS_SECRET_ACCESS_KEY: 'synthetic-secret', AWS_SESSION_TOKEN: 'synthetic-session', AWS_REGION: 'us-east-1' },
    { CLAUDE_CODE_USE_BEDROCK: 'true', AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bedrock', AWS_PROFILE: 'synthetic-profile' },
    { CLAUDE_CODE_USE_VERTEX: '1', ANTHROPIC_VERTEX_PROJECT_ID: 'synthetic-project', GOOGLE_APPLICATION_CREDENTIALS: 'D:\\synthetic\\credentials.json', CLOUD_ML_REGION: 'global' },
    { CLAUDE_CODE_USE_FOUNDRY: '1', ANTHROPIC_FOUNDRY_RESOURCE: 'synthetic-resource', ANTHROPIC_FOUNDRY_API_KEY: 'synthetic-foundry' },
    { CLAUDE_CODE_USE_FOUNDRY: 'yes', AZURE_CLIENT_ID: 'synthetic-client', AZURE_TENANT_ID: 'synthetic-tenant', AZURE_CLIENT_SECRET: 'synthetic-azure-secret' },
    { ANTHROPIC_PROFILE: 'synthetic-native-profile' },
    { ANTHROPIC_ORGANIZATION_ID: 'synthetic-org', ANTHROPIC_FEDERATION_RULE_ID: 'synthetic-rule', ANTHROPIC_SERVICE_ACCOUNT_ID: 'synthetic-account', ANTHROPIC_IDENTITY_TOKEN_FILE: 'D:\\synthetic\\token.jwt' },
  ])('passes only original opt-in inputs to the native CLI: %j', (launch) => {
    const base: NodeJS.ProcessEnv = { ...hostEnv(), ANTHROPIC_API_KEY: 'later-unrelated-key', HTTPS_PROXY: 'http://127.0.0.1:9011', NODE_EXTRA_CA_CERTS: 'D:\\certs\\ca.pem' };
    const snapshot = { ...launch, CLAUDE_CODE_ENTRYPOINT: 'desktop', CLAUDE_AGENT_SDK_VERSION: 'synthetic-sdk', CLAUDE_CONFIG_DIR: 'D:\\wrong-account', HTTPS_PROXY: 'http://wrong-proxy.invalid', LANG: 'wrong-language' };
    expect(buildChildEnv(optedIn, base, snapshot)).toEqual({
      PATH: base.PATH, CLAUDE_EFFORT: 'high', HTTPS_PROXY: base.HTTPS_PROXY, NODE_EXTRA_CA_CERTS: base.NODE_EXTRA_CA_CERTS,
      ...launch, CLAUDE_CONFIG_DIR: work.configDir,
    });
  });

  it('normalizes Windows authentication names without changing original values or overriding profile isolation', () => {
    const launch = { anthropic_api_key: '  synthetic-value  ', claude_securestorage_config_dir: 'D:\\wrong' };
    expect(buildChildEnv({ ...defaultProfile, authenticationSource: 'launch-environment' }, {}, launch)).toEqual({ ANTHROPIC_API_KEY: '  synthetic-value  ' });
    expect(() => buildChildEnv({ ...optedIn, configDir: null }, {}, launch)).toThrow(/no config directory/);
  });

  it('preserves AWS, Azure and Google tool credentials through startup scrub and default profile environments', () => {
    const infrastructure = {
      AWS_ACCESS_KEY_ID: 'synthetic-aws-id', aws_secret_access_key: 'synthetic-aws-secret', AWS_SESSION_TOKEN: 'synthetic-aws-session',
      AWS_BEARER_TOKEN_BEDROCK: 'synthetic-bedrock-token', AWS_REGION: 'us-east-1', AWS_PROFILE: 'synthetic-profile',
      AZURE_CLIENT_ID: 'synthetic-azure-id', AZURE_TENANT_ID: 'synthetic-tenant', AZURE_CLIENT_SECRET: 'synthetic-azure-secret',
      GOOGLE_APPLICATION_CREDENTIALS: 'D:\\synthetic\\credentials.json', GOOGLE_CLOUD_PROJECT: 'synthetic-project',
      CLOUD_ML_REGION: 'global', CLOUDSDK_CONFIG: 'D:\\synthetic\\gcloud',
    };
    const base = { ...infrastructure, ANTHROPIC_API_KEY: 'synthetic-inference-key', CLAUDE_CODE_USE_BEDROCK: '1' };
    expect(scrubEnv({ ...base })).toEqual(infrastructure);
    expect(buildChildEnv(defaultProfile, base)).toEqual(infrastructure);
    expect(buildChildEnv(work, base)).toEqual({ ...infrastructure, CLAUDE_CONFIG_DIR: work.configDir });
    expect(base.ANTHROPIC_API_KEY).toBe('synthetic-inference-key');
  });

  it('overlays captured cloud inputs case-insensitively only after explicit launch-source selection', () => {
    const base = { aws_profile: 'synthetic-current-profile', AZURE_CLIENT_SECRET: 'synthetic-tool-secret' };
    const original = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'synthetic-original-profile' };
    expect(buildChildEnv(work, base, original)).toEqual({ ...base, CLAUDE_CONFIG_DIR: work.configDir });
    expect(buildChildEnv(optedIn, base, original)).toEqual({
      ...original, AZURE_CLIENT_SECRET: base.AZURE_CLIENT_SECRET, CLAUDE_CONFIG_DIR: work.configDir,
    });
    expect(base.aws_profile).toBe('synthetic-current-profile');
  });

  it.each([{}, { ANTHROPIC_BASE_URL: 'https://synthetic.invalid' }, { ANTHROPIC_CUSTOM_HEADERS: 'Authorization: synthetic' }, { AWS_PROFILE: 'synthetic' }, { CLAUDE_CODE_USE_VERTEX: '0' }])(
    'refuses unavailable or route-only launch inputs rather than falling back to saved credentials: %j',
    (launch) => expect(() => buildChildEnv(optedIn, {}, launch)).toThrow(/No usable launch authentication source/),
  );

  it.each([null, '', 'environment', 'CLI-CONFIG', true, {}])('rejects malformed source %j', (authenticationSource) => {
    expect(() => buildChildEnv({ ...work, authenticationSource: authenticationSource as never }, {})).toThrow('Invalid authentication source.');
  });
});

const defaultProfile: Profile = { id: 'default', name: 'Default', configDir: null, createdAt: 1 };
const work: Profile = { id: 'work', name: 'Work', configDir: 'D:\\profiles\\work', createdAt: 2 };

describe('buildChildEnv (R3)', () => {
  it('default profile: scrubbed copy without CLAUDE_CONFIG_DIR, base untouched', () => {
    const base = hostEnv();
    const env = buildChildEnv(defaultProfile, base);
    expect(env).not.toBe(base);
    expect(env).toEqual({ PATH: 'C:\\Windows', CLAUDE_EFFORT: 'high' });
    expect(base.ANTHROPIC_API_KEY).toBe('secret');
    expect(base.claude_config_dir).toBe('C:\\desktop\\.claude');
  });

  it('non-default profile: scrubbed copy with its own CLAUDE_CONFIG_DIR replacing any inherited one', () => {
    const env = buildChildEnv(work, hostEnv());
    expect(env).toEqual({ PATH: 'C:\\Windows', CLAUDE_EFFORT: 'high', CLAUDE_CONFIG_DIR: 'D:\\profiles\\work' });
  });

  it('default profile ignores a stray configDir', () => {
    const env = buildChildEnv({ ...defaultProfile, configDir: 'D:\\x' }, hostEnv());
    expect(Object.keys(env).some((k) => k.toUpperCase() === 'CLAUDE_CONFIG_DIR')).toBe(false);
  });

  it('refuses a non-default profile without a config dir instead of falling back to ~/.claude', () => {
    expect(() => buildChildEnv({ ...work, configDir: null }, hostEnv())).toThrow(/no config directory/);
  });

  it('reads process.env by default at call time', () => {
    const env = buildChildEnv(defaultProfile);
    for (const key of Object.keys(env)) {
      expect(key.toUpperCase().startsWith('CLAUDE_CODE_') && !PRESERVED_TRANSPORT.includes(key.toUpperCase())).toBe(false);
      expect(key.toUpperCase()).not.toBe('ANTHROPIC_API_KEY');
    }
  });

  it('preserves proxy and certificate controls through startup and profile copies without preserving credentials', () => {
    const transport = {
      HTTP_PROXY: 'http://127.0.0.1:9010', https_proxy: 'http://127.0.0.1:9011',
      ALL_PROXY: 'socks5://127.0.0.1:9012', no_proxy: 'localhost,127.0.0.1',
      NODE_EXTRA_CA_CERTS: 'D:\\certs\\ca.pem', SSL_CERT_FILE: 'D:\\certs\\ca.pem', SSL_CERT_DIR: 'D:\\certs',
      claude_code_proxy_resolves_hosts: 'true',
      CLAUDE_CODE_CERT_STORE: 'bundled,system',
      CLAUDE_CODE_CLIENT_CERT: 'D:\\certs\\client.pem', claude_code_client_key: 'D:\\certs\\client.key',
      CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'synthetic-transport-passphrase',
      CLAUDE_CODE_GZIP_REQUEST_BODIES: '0', CLAUDE_CODE_DISABLE_MTLS_RELOAD_ON_STALE_CONNECTION: '1',
    };
    const base: NodeJS.ProcessEnv = { ...hostEnv(), ...transport };
    expect(scrubEnv({ ...base })).toEqual({ PATH: 'C:\\Windows', CLAUDE_EFFORT: 'high', ...transport });
    expect(buildChildEnv(work, base)).toEqual({ PATH: 'C:\\Windows', CLAUDE_EFFORT: 'high', ...transport, CLAUDE_CONFIG_DIR: work.configDir });
    expect(buildChildEnv({ ...work, authenticationSource: 'launch-environment' }, base, { ANTHROPIC_API_KEY: 'synthetic-opt-in-key' })).toEqual({
      PATH: 'C:\\Windows', CLAUDE_EFFORT: 'high', ...transport, CLAUDE_CONFIG_DIR: work.configDir, ANTHROPIC_API_KEY: 'synthetic-opt-in-key',
    });
    expect(base.ANTHROPIC_API_KEY).toBe('secret');
  });
});
