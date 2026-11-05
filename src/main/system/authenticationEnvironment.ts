import type { AuthenticationEnvironmentMetadata, AuthenticationSource } from '@shared/types';

/** Authentication/provider inputs only; never a blanket provider prefix, client identity, proxy or TLS snapshot.
 * Native variables: https://code.claude.com/docs/en/env-vars and the Bedrock, Vertex and Foundry setup guides.
 */
export const AUTHENTICATION_VARIABLES: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_CONFIG_DIR',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_WORKSPACE_ID',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'CLOUDSDK_CONFIG',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_AUTHORITY_HOST',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_CONFIG_DIR',
];

const allowed = new Set(AUTHENTICATION_VARIABLES);
let launchInputs: Readonly<NodeJS.ProcessEnv> | undefined;

export function validateAuthenticationSource(source: unknown): AuthenticationSource {
  if (source !== 'cli-config' && source !== 'launch-environment') throw new Error('Invalid authentication source.');
  return source;
}

/** Pure main-process helper. Returned values are sensitive and belong only in a child environment. */
export function selectAuthenticationEnvironment(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const canonical = name.toUpperCase();
    if (allowed.has(canonical) && typeof value === 'string') selected[canonical] = value;
  }
  return selected;
}

/** Called once before scrubOnLoad removes inherited authentication. Never rereads the OS/user environment. */
export function captureLaunchAuthenticationEnvironment(env: Readonly<NodeJS.ProcessEnv>): void {
  launchInputs ??= Object.freeze(selectAuthenticationEnvironment(env));
}

/** Pure names-only projection; callers cannot recover values from this renderer-safe result. */
export function authenticationEnvironmentMetadata(env: Readonly<NodeJS.ProcessEnv>): AuthenticationEnvironmentMetadata {
  const inputs = selectAuthenticationEnvironment(env);
  const variableNames = Object.keys(inputs).sort();
  const present = (key: string): boolean => Boolean(inputs[key]?.trim());
  const enabled = (key: string): boolean => ['1', 'true', 'yes', 'on'].includes(inputs[key]?.trim().toLowerCase() ?? '');
  // Endpoint/header/region-only input must not silently fall back to the profile's saved subscription.
  const available = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_PROFILE'].some(present)
    || (present('ANTHROPIC_ORGANIZATION_ID') && present('ANTHROPIC_FEDERATION_RULE_ID') && present('ANTHROPIC_SERVICE_ACCOUNT_ID')
      && (present('ANTHROPIC_IDENTITY_TOKEN') || present('ANTHROPIC_IDENTITY_TOKEN_FILE')))
    || ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'].some(enabled);
  return { available, variableNames };
}

export function getAuthenticationEnvironmentMetadata(): AuthenticationEnvironmentMetadata {
  return authenticationEnvironmentMetadata(launchInputs ?? {});
}

/** Main-only copy for buildChildEnv. Never expose this through IPC, logs, settings or launch arguments. */
export function getLaunchAuthenticationInputs(): NodeJS.ProcessEnv {
  return { ...launchInputs };
}
