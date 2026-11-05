import type { CanUseTool, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@shared/events';
import { PermissionBroker, QUESTION_DISMISSED_MESSAGE, denialMessage } from '../../src/main/engine/broker';

type Context = Parameters<CanUseTool>[2];

function setup() {
  const events: EngineEvent[] = [];
  const pending: number[] = [];
  const decisions: Array<{ toolUseId?: string; behavior: string }> = [];
  let next = 0;
  const broker = new PermissionBroker('h1', (event) => events.push(event), {
    onPendingChange: (count) => pending.push(count),
    onDecision: (info) => decisions.push(info),
    newRequestId: () => `req-${++next}`,
  });
  return { broker, events, pending, decisions };
}

function context(overrides: Partial<Context> = {}): Context {
  return { signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'cli-1', ...overrides };
}

const SUGGESTIONS: PermissionUpdate[] = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'localSettings' },
];

const ASK_INPUT = {
  questions: [
    {
      question: 'Which library should we use?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Small and modular' },
        { label: 'dayjs', description: 'Tiny', preview: '```ts\ndayjs()\n```' },
      ],
    },
  ],
};

describe('PermissionBroker permissions', () => {
  it('emits a permission request with the SDK prompt fields and allows once with the original input', async () => {
    const { broker, events, pending, decisions } = setup();
    const promise = broker.canUseTool(
      'Bash',
      { command: 'npm test' },
      context({
        suggestions: SUGGESTIONS,
        title: 'Claude wants to run npm test',
        displayName: 'Run command',
        description: 'Runs the test suite',
        decisionReason: 'No rule allows it',
        blockedPath: 'D:\\outside',
        agentID: 'agent-7',
        defaultToNo: true,
      }),
    );
    expect(events).toEqual([
      {
        type: 'permission',
        request: {
          requestId: 'req-1',
          handleId: 'h1',
          toolName: 'Bash',
          input: { command: 'npm test' },
          toolUseId: 'toolu_1',
          title: 'Claude wants to run npm test',
          displayName: 'Run command',
          description: 'Runs the test suite',
          decisionReason: 'No rule allows it',
          blockedPath: 'D:\\outside',
          agentId: 'agent-7',
          defaultToNo: true,
          suggestions: SUGGESTIONS,
        },
      },
    ]);
    expect(broker.has('req-1')).toBe(true);
    expect(pending).toEqual([1]);

    expect(broker.respondPermission('req-1', { behavior: 'allow', scope: 'once' })).toBe(true);
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      decisionClassification: 'user_temporary',
      toolUseID: 'toolu_1',
    });
    expect(events.at(-1)).toEqual({ type: 'requestClosed', handleId: 'h1', requestId: 'req-1' });
    expect(broker.has('req-1')).toBe(false);
    expect(pending).toEqual([1, 0]);
    expect(decisions).toEqual([{ toolUseId: 'toolu_1', behavior: 'allow' }]);
  });

  it('allow for session returns the SDK suggestions scoped to the session', async () => {
    const { broker } = setup();
    const promise = broker.canUseTool('Bash', { command: 'npm test' }, context({ suggestions: SUGGESTIONS }));
    broker.respondPermission('req-1', { behavior: 'allow', scope: 'session', updatedInput: { command: 'npm test -- --run' } });
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test -- --run' },
      updatedPermissions: [{ ...SUGGESTIONS[0], destination: 'session' }],
      decisionClassification: 'user_permanent',
      toolUseID: 'toolu_1',
    });
  });

  it('does not grant session scope when the SDK suppresses it or offers no suggestions', async () => {
    const { broker } = setup();
    const suppressed = broker.canUseTool('Edit', {}, context({ suggestions: SUGGESTIONS, suppressAlwaysAllowRule: true }));
    const none = broker.canUseTool('Edit', {}, context());
    broker.respondPermission('req-1', { behavior: 'allow', scope: 'session' });
    broker.respondPermission('req-2', { behavior: 'allow', scope: 'session' });
    for (const result of await Promise.all([suppressed, none])) {
      expect(result).toMatchObject({ behavior: 'allow', decisionClassification: 'user_temporary' });
      expect(result).not.toHaveProperty('updatedPermissions');
    }
  });

  it('lets any workflow launch be allowed for the session, as the desktop card does', async () => {
    const { broker, events } = setup();
    const script = "export const meta = { name: 'noop', description: 'd', phases: [] }";
    const inline = broker.canUseTool('Workflow', { script }, context({ description: 'd' }));
    const rule = { type: 'addRules', rules: [{ toolName: 'Workflow' }], behavior: 'allow', destination: 'session' };
    // CLI 2.1.302 suggests nothing for a script Claude wrote; Relay offers the tool-wide rule for this session only.
    expect(events.at(-1)).toMatchObject({ type: 'permission', request: { toolName: 'Workflow', suggestions: [rule] } });
    broker.respondPermission('req-1', { behavior: 'allow', scope: 'session' });
    await expect(inline).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { script },
      updatedPermissions: [rule],
      decisionClassification: 'user_permanent',
      toolUseID: 'toolu_1',
    });

    // A named workflow keeps the CLI's own rule, scoped to the session.
    const named: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'Workflow', ruleContent: 'deep-research' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    const byName = broker.canUseTool('Workflow', { name: 'deep-research' }, context({ suggestions: [named] }));
    expect(events.at(-1)).toMatchObject({ request: { suggestions: [named] } });
    broker.respondPermission('req-2', { behavior: 'allow', scope: 'session' });
    await expect(byName).resolves.toMatchObject({ updatedPermissions: [{ ...named, destination: 'session' }] });

    // A launch the CLI marks as never-always-allowed (a resumed run that hides its script) gets no rule.
    const hidden = broker.canUseTool('Workflow', { scriptPath: 'a.js', resumeFromRunId: 'wf_1' }, context({ suppressAlwaysAllowRule: true }));
    expect(events.at(-1)).toMatchObject({ request: { suppressAlwaysAllowRule: true } });
    expect((events.at(-1) as Extract<EngineEvent, { type: 'permission' }>).request).not.toHaveProperty('suggestions');
    broker.respondPermission('req-3', { behavior: 'allow', scope: 'session' });
    const result = await hidden;
    expect(result).toMatchObject({ behavior: 'allow', decisionClassification: 'user_temporary' });
    expect(result).not.toHaveProperty('updatedPermissions');

    // Other tools without a suggestion stay without one.
    void broker.canUseTool('Edit', {}, context());
    expect((events.at(-1) as Extract<EngineEvent, { type: 'permission' }>).request).not.toHaveProperty('suggestions');
  });

  it('deny passes the user message to the model in the CLI rejection wording', async () => {
    const { broker, decisions } = setup();
    const promise = broker.canUseTool('Write', { file_path: 'a.ts' }, context());
    broker.respondPermission('req-1', { behavior: 'deny', message: 'use b.ts instead' });
    const result = await promise;
    expect(result).toMatchObject({ behavior: 'deny', decisionClassification: 'user_reject' });
    expect(result?.behavior === 'deny' && result.message).toBe(denialMessage('use b.ts instead'));
    expect(denialMessage('use b.ts instead')).toMatch(/^The user doesn't want to proceed with this tool use\./);
    expect(denialMessage('use b.ts instead')).toContain('the user said:\nuse b.ts instead');
    expect(denialMessage()).toContain('STOP what you are doing');
    expect(decisions).toEqual([{ toolUseId: 'toolu_1', behavior: 'deny' }]);
  });

  it('ignores responses for unknown or mismatched requests', () => {
    const { broker } = setup();
    void broker.canUseTool('Bash', {}, context());
    expect(broker.respondPermission('nope', { behavior: 'allow', scope: 'once' })).toBe(false);
    expect(broker.respondQuestion('req-1', { a: 'b' })).toBe(false);
    expect(broker.has('req-1')).toBe(true);
  });
});

describe('PermissionBroker questions', () => {
  it('preserves multi-select answer strings, free text and the original question metadata', async () => {
    const { broker } = setup();
    const input = {
      questions: [
        { ...ASK_INPUT.questions[0], question: 'Features?', multiSelect: true },
        { ...ASK_INPUT.questions[0], question: 'Anything else?' },
      ],
      metadata: { source: 'synthetic-sdk-input' },
    };
    const answer = { 'Features?': 'date-fns, dayjs', 'Anything else?': 'A free-text answer' };
    const pending = broker.canUseTool('AskUserQuestion', input, context());
    broker.respondQuestion('req-1', answer);
    await expect(pending).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: answer },
      decisionClassification: 'user_temporary',
      toolUseID: 'toolu_1',
    });
  });

  it('turns AskUserQuestion into a question event and answers with the SDK answers shape', async () => {
    const { broker, events } = setup();
    const promise = broker.canUseTool('AskUserQuestion', ASK_INPUT, context({ toolUseID: 'toolu_q' }));
    expect(events).toEqual([
      {
        type: 'question',
        request: {
          requestId: 'req-1',
          handleId: 'h1',
          toolUseId: 'toolu_q',
          questions: [
            {
              question: 'Which library should we use?',
              header: 'Library',
              multiSelect: false,
              options: [
                { label: 'date-fns', description: 'Small and modular' },
                { label: 'dayjs', description: 'Tiny', preview: '```ts\ndayjs()\n```' },
              ],
            },
          ],
        },
      },
    ]);
    expect(broker.respondPermission('req-1', { behavior: 'allow', scope: 'once' })).toBe(false);
    expect(broker.respondQuestion('req-1', { 'Which library should we use?': 'dayjs' })).toBe(true);
    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...ASK_INPUT, answers: { 'Which library should we use?': 'dayjs' } },
      decisionClassification: 'user_temporary',
      toolUseID: 'toolu_q',
    });
    expect(events.at(-1)).toEqual({ type: 'requestClosed', handleId: 'h1', requestId: 'req-1' });
  });

  it('a dismissed question denies the tool call', async () => {
    const { broker } = setup();
    const promise = broker.canUseTool('AskUserQuestion', ASK_INPUT, context());
    broker.respondQuestion('req-1', null);
    await expect(promise).resolves.toMatchObject({ behavior: 'deny', message: QUESTION_DISMISSED_MESSAGE });
  });

  it('falls back to a permission prompt when the question input is malformed', () => {
    const { broker, events } = setup();
    void broker.canUseTool('AskUserQuestion', { questions: 'not a list' }, context());
    expect(events[0]?.type).toBe('permission');
  });
});

describe('PermissionBroker cancellation', () => {
  it('denies and closes a request when the SDK aborts it', async () => {
    const { broker, events, pending } = setup();
    const controller = new AbortController();
    const promise = broker.canUseTool('Bash', {}, context({ signal: controller.signal }));
    controller.abort();
    await expect(promise).resolves.toMatchObject({ behavior: 'deny', message: 'The request was cancelled.' });
    expect(events.at(-1)).toEqual({ type: 'requestClosed', handleId: 'h1', requestId: 'req-1' });
    expect(broker.has('req-1')).toBe(false);
    expect(pending).toEqual([1, 0]);
    expect(broker.respondPermission('req-1', { behavior: 'allow', scope: 'once' })).toBe(false);
  });

  it('denies an already aborted request without prompting', async () => {
    const { broker, events } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(broker.canUseTool('Bash', {}, context({ signal: controller.signal }))).resolves.toMatchObject({
      behavior: 'deny',
    });
    expect(events).toEqual([]);
  });

  it('cancelAll denies every pending request and emits requestClosed for each', async () => {
    const { broker, events, decisions } = setup();
    const first = broker.canUseTool('Bash', {}, context());
    const second = broker.canUseTool('AskUserQuestion', ASK_INPUT, context());
    broker.cancelAll('The session was closed.');
    await expect(first).resolves.toMatchObject({ behavior: 'deny', message: 'The session was closed.' });
    await expect(second).resolves.toMatchObject({ behavior: 'deny', message: 'The session was closed.' });
    expect(events.filter((e) => e.type === 'requestClosed').map((e) => e.type === 'requestClosed' && e.requestId)).toEqual([
      'req-1',
      'req-2',
    ]);
    expect(broker.pendingCount).toBe(0);
    expect(decisions).toEqual([]);
  });

  it('a settled request ignores a later abort', async () => {
    const { broker, events } = setup();
    const controller = new AbortController();
    const promise = broker.canUseTool('Bash', {}, context({ signal: controller.signal }));
    broker.respondPermission('req-1', { behavior: 'allow', scope: 'once' });
    controller.abort();
    await expect(promise).resolves.toMatchObject({ behavior: 'allow' });
    expect(events.filter((e) => e.type === 'requestClosed')).toHaveLength(1);
  });
});
