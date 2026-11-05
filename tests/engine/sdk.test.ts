import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AccountInfo,
  CanUseTool,
  EffortLevel,
  ModelInfo,
  PermissionMode as SdkPermissionMode,
  SDKControlGetContextUsageResponse,
  SDKSessionInfo,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk';
import type { AskUserQuestionInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@shared/events';
import {
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type ContextCategoryKind,
  type Effort,
  type PermissionMode,
  type PermissionRequest,
  type Question,
  type QuestionAnswer,
  type QuestionOption,
  type SessionSummary,
  type SlashCommandInfo,
} from '@shared/types';
import { scrubEnv } from '../../src/main/system/env';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const sdkDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
const binary = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assignable<From, To> = [From] extends [To] ? true : false;

type SdkQuestion = AskUserQuestionInput['questions'][number];
type SessionInfoKeys = 'sessionId' | 'lastModified' | 'createdAt' | 'gitBranch' | 'firstPrompt' | 'fileSize' | 'tag';
type PermissionPromptKeys =
  | 'title'
  | 'displayName'
  | 'description'
  | 'decisionReason'
  | 'blockedPath'
  | 'defaultToNo'
  | 'suppressAlwaysAllowRule';

// Checked by `npm run typecheck`: any drift between src/shared and the pinned SDK typings is a type error here.
const contractMatchesSdk: [
  Equal<PermissionMode, SdkPermissionMode>,
  Equal<Effort, EffortLevel>,
  Equal<NonNullable<ModelInfo['supportedEffortLevels']>[number], Effort>,
  Equal<ContextCategoryKind, SDKControlGetContextUsageResponse['categories'][number]['kind']>,
  Equal<QuestionAnswer, NonNullable<AskUserQuestionInput['answers']>>,
  Assignable<SdkQuestion['options'][number], QuestionOption>,
  Assignable<Pick<SdkQuestion, 'question' | 'header' | 'multiSelect'>, Omit<Question, 'options'>>,
  Assignable<Pick<SDKSessionInfo, SessionInfoKeys>, Pick<SessionSummary, SessionInfoKeys>>,
  Assignable<Pick<SlashCommand, 'name' | 'description' | 'argumentHint' | 'aliases'>, SlashCommandInfo>,
  Assignable<
    Pick<AccountInfo, 'email' | 'subscriptionType' | 'organization'>,
    Omit<Extract<EngineEvent, { type: 'account' }>, 'type' | 'handleId'>
  >,
  Assignable<Pick<Parameters<CanUseTool>[2], PermissionPromptKeys>, Pick<PermissionRequest, PermissionPromptKeys>>,
] = [true, true, true, true, true, true, true, true, true, true, true];

describe('agent SDK availability', () => {
  it('matches the shared contract', () => {
    expect(contractMatchesSdk.every(Boolean)).toBe(true);
    expect(PERMISSION_MODES).toHaveLength(6);
    expect(EFFORT_LEVELS).toHaveLength(5);
  });

  it('is pinned to 0.3.302 with CLI 2.1.302', () => {
    const pkg = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')) as {
      version: string;
      claudeCodeVersion: string;
    };
    expect(pkg.version).toBe('0.3.302');
    expect(pkg.claudeCodeVersion).toBe('2.1.302');
  });

  it('imports as ESM and exposes query and the session helpers', async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    expect(typeof sdk.query).toBe('function');
    expect(typeof sdk.listSessions).toBe('function');
    expect(typeof sdk.getSessionMessages).toBe('function');
    expect(typeof sdk.renameSession).toBe('function');
  });

  it('ships the bundled win32-x64 CLI binary', () => {
    expect(statSync(binary).size).toBeGreaterThan(1_000_000);
  });

  it('imports under the Electron runtime from the project root', () => {
    const electronExe = require('electron') as string;
    const script =
      "import('@anthropic-ai/claude-agent-sdk').then((m) => process.stdout.write(JSON.stringify(" +
      '{ query: typeof m.query, listSessions: typeof m.listSessions, electron: process.versions.electron, node: process.versions.node }' +
      '))).catch((e) => { console.error(e); process.exit(1); })';
    const result = spawnSync(electronExe, ['-e', script], {
      cwd: root,
      env: scrubEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '1' }),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ query: 'function', listSessions: 'function', electron: '44.9.0' });
  }, 90_000);
});
