// Scripted turn for dev:web: streaming text, a running tool, a permission request and a question.
import type { EngineEvent } from '@shared/events';
import type { PermissionDecision, QuestionAnswer, TranscriptItem } from '@shared/types';
import { MOCK_CONTEXT } from './fixtures';

export interface DemoHooks {
  emit(event: EngineEvent): void;
  /** Runs fn after ms while the handle is still open. */
  later(ms: number, fn: () => void): void;
  /** Resolves with the user's decision once the request is answered. */
  waitFor(requestId: string): Promise<unknown>;
  nextId(prefix: string): string;
}

const sleep = (hooks: DemoHooks, ms: number): Promise<void> => new Promise((resolve) => hooks.later(ms, resolve));

function chunks(text: string, size: number): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out;
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

const README_EDIT = {
  file_path: 'D:\\demos\\relay-desk\\README.md',
  old_string: '## Hand-off\n\nUse the desktop app to continue a session.\n',
  new_string:
    '## Hand-off\n\nPress “Continue in Relay Desk” in the desktop, work in Relay Desk,\nthen press “Hand back to desktop” to hand the session back.\n\nRelay Desk closes its own session before the desktop continues.\n',
};

export async function runDemoTurn(handleId: string, hooks: DemoHooks): Promise<void> {
  const { emit, nextId } = hooks;
  const tool = (item: Omit<ToolItem, 'kind' | 'toolUseId'>): void =>
    emit({ type: 'item', handleId, item: { kind: 'tool', toolUseId: `toolu_${item.id}`, ...item } });

  emit({ type: 'state', handleId, state: 'running', startedAt: Date.now() - 592_000, tokens: 37_600 });
  await sleep(hooks, 600);

  const intro = nextId('demo-assistant');
  const introText =
    'Checked: the SDK is `0.3.302`, and the desktop saves titles as `custom-title` records. Next I will update the hand-off notes in the README and confirm the checks to run before a hand-off.';
  emit({ type: 'item', handleId, item: { kind: 'assistant', id: intro, text: '', streaming: true } });
  for (const part of chunks(introText, 5)) {
    await sleep(hooks, 90);
    emit({ type: 'delta', handleId, itemId: intro, text: part });
  }
  emit({ type: 'item', handleId, item: { kind: 'assistant', id: intro, text: introText } });

  const log = nextId('demo-tool');
  tool({ id: log, name: 'Bash', input: { command: 'git log --oneline -5' }, summary: 'Checking recent commits', status: 'running' });
  emit({ type: 'state', handleId, state: 'running', tokens: 37_900 });
  await sleep(hooks, 1800);
  tool({
    id: log,
    name: 'Bash',
    input: { command: 'git log --oneline -5' },
    summary: 'Ran `git log --oneline -5`',
    status: 'done',
    output: 'a1b2c3d scaffold\n9f8e7d6 visual spec',
  });

  const edit = nextId('demo-tool');
  tool({ id: edit, name: 'Edit', input: README_EDIT, summary: 'Editing README.md', status: 'running' });
  const permissionId = nextId('demo-permission');
  emit({ type: 'state', handleId, state: 'awaiting', tokens: 38_400 });
  emit({
    type: 'permission',
    request: {
      requestId: permissionId,
      handleId,
      toolName: 'Edit',
      input: README_EDIT,
      displayName: 'Edit file',
      description: 'README.md',
      toolUseId: `toolu_${edit}`,
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit' }], behavior: 'allow', destination: 'session' }],
    },
  });
  const decision = (await hooks.waitFor(permissionId)) as PermissionDecision | undefined;
  const allowed = decision?.behavior === 'allow';
  tool({
    id: edit,
    name: 'Edit',
    input: README_EDIT,
    summary: allowed ? 'Edited README.md (+5 −1)' : 'Edit README.md',
    status: allowed ? 'done' : 'denied',
    ...(allowed ? {} : { output: decision?.behavior === 'deny' && decision.message ? decision.message : 'Denied by the user' }),
  });
  emit({ type: 'state', handleId, state: 'running', tokens: 39_100 });
  await sleep(hooks, 900);

  const questionId = nextId('demo-question');
  emit({ type: 'state', handleId, state: 'awaiting', tokens: 39_500 });
  emit({
    type: 'question',
    request: {
      requestId: questionId,
      handleId,
      questions: [
        {
          question: 'What should happen before handing back to the desktop?',
          header: 'Hand-off',
          multiSelect: false,
          options: [
            { label: 'Run the tests', description: 'npx vitest run; fix any failure first' },
            { label: 'Hand back now', description: 'No extra checks' },
          ],
        },
        {
          question: 'Which documents should be updated too?',
          header: 'Docs',
          multiSelect: true,
          options: [
            { label: 'README', description: 'Usage notes' },
            { label: 'CHANGELOG.md', description: 'Release notes' },
            { label: 'mod/README.md', description: 'Desktop mod install steps', preview: '### mod/README.md\n- Add the local marketplace\n- Install `relay-desk-handoff`' },
          ],
        },
      ],
    },
  });
  const answer = (await hooks.waitFor(questionId)) as QuestionAnswer | null | undefined;
  emit({ type: 'state', handleId, state: 'running', tokens: 40_300 });
  await sleep(hooks, 500);

  const outro = nextId('demo-assistant');
  const chosen = answer ? Object.values(answer).join('; ') : 'skipped';
  const outroText = `Got it (${chosen}). The README is updated; the hand-off notes go into CHANGELOG.md in the next turn.`;
  emit({ type: 'item', handleId, item: { kind: 'assistant', id: outro, text: '', streaming: true } });
  for (const part of chunks(outroText, 6)) {
    await sleep(hooks, 80);
    emit({ type: 'delta', handleId, itemId: outro, text: part });
  }
  emit({ type: 'item', handleId, item: { kind: 'assistant', id: outro, text: outroText } });
  emit({ type: 'item', handleId, item: { kind: 'result', id: nextId('demo-result'), durationMs: 604_000, outputTokens: 3_600 } });
  emit({ type: 'state', handleId, state: 'idle', tokens: 41_200 });
  emit({ type: 'context', handleId, usage: { ...MOCK_CONTEXT, usedTokens: 188_100, percent: 22 } });
}
