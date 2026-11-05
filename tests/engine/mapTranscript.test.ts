import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import {
  AUTO_CONTINUE_PROMPT,
  applyToolResult,
  lineDiff,
  mapSessionMessages,
  patchCounts,
  summarizeTool,
  toolItemFromUse,
  truncateOutput,
  OUTPUT_LIMIT,
} from '../../src/main/engine/mapTranscript';
import { createImageStore, storeImageBlocks } from '../../src/main/engine/images';
import transcript from './fixtures/transcript-basic.json';

const messages = transcript as unknown as SessionMessage[];
const CWD = 'D:\\work\\demo';

function byId(items: TranscriptItem[], id: string): TranscriptItem | undefined {
  return items.find((item) => item.id === id);
}

describe('mapSessionMessages', () => {
  const items = mapSessionMessages(messages, { cwd: CWD });

  it('keeps transcript order, nests subagent tools after their Task and drops meta and tool_result-only entries', () => {
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual([
      'user:u-01',
      'thinking:a-01:0',
      'assistant:a-02:0',
      'tool:toolu_read',
      'tool:toolu_edit',
      'tool:toolu_bash',
      'tool:toolu_task',
      'tool:toolu_grep',
      'tool:toolu_mcp',
      'system:u-08',
      'user:u-09',
      'system:u-10',
      'user:u-11',
      'system:u-12',
      'system:a-08:0',
      'assistant:a-09:1',
    ]);
  });

  it('maps user text, thinking and assistant text', () => {
    expect(byId(items, 'u-01')).toEqual({ kind: 'user', id: 'u-01', text: 'Fix the failing test in src/app.ts' });
    expect(byId(items, 'a-01:0')).toEqual({ kind: 'thinking', id: 'a-01:0', text: 'I should read the file first.' });
    expect(byId(items, 'a-02:0')).toEqual({ kind: 'assistant', id: 'a-02:0', text: 'Let me look at the file.' });
    expect(byId(items, 'a-09:1')).toEqual({ kind: 'assistant', id: 'a-09:1', text: 'Done. The test passes now.' });
  });

  it('pairs tool_use with its tool_result: done, denied, error with ANSI stripped', () => {
    expect(byId(items, 'toolu_read')).toEqual({
      kind: 'tool',
      id: 'toolu_read',
      toolUseId: 'toolu_read',
      name: 'Read',
      input: { file_path: 'D:\\work\\demo\\src\\app.ts' },
      summary: 'Read src\\app.ts',
      status: 'done',
      output: '1\tconst x = 1;',
    });
    expect(byId(items, 'toolu_edit')).toMatchObject({ status: 'denied', summary: 'Edited src\\app.ts (+2 −1)' });
    expect(byId(items, 'toolu_bash')).toMatchObject({
      status: 'error',
      summary: 'Ran `npm test`',
      output: 'FAIL tests/app.test.ts\nExpected 2, received 1',
    });
    expect(byId(items, 'toolu_mcp')).toMatchObject({
      status: 'done',
      summary: 'github/create_issue',
      output: 'Created issue #12',
      images: 1,
    });
  });

  it('attaches subagent tool calls to the Task item and skips subagent text', () => {
    expect(byId(items, 'toolu_task')).toMatchObject({
      status: 'done',
      summary: 'Agent (Explore): Explore the tests',
      output: 'Found 1 test file.',
    });
    expect(byId(items, 'toolu_grep')).toMatchObject({
      status: 'done',
      parentToolUseId: 'toolu_task',
      summary: 'Searched for `describe\\(` in tests',
      output: 'tests/app.test.ts',
    });
    expect(JSON.stringify(items)).not.toContain('Subagent text');
  });

  it('turns interrupts, compaction, local commands and synthetic errors into readable notes', () => {
    expect(byId(items, 'u-08')).toEqual({ kind: 'system', id: 'u-08', text: 'Interrupted', level: 'info' });
    expect(byId(items, 'u-09')).toEqual({ kind: 'user', id: 'u-09', text: 'Here is a screenshot of the error', images: 1 });
    expect(byId(items, 'u-10')).toEqual({ kind: 'system', id: 'u-10', text: 'Conversation compacted', level: 'info' });
    expect(byId(items, 'u-11')).toEqual({ kind: 'user', id: 'u-11', text: '/compact keep the tests' });
    expect(byId(items, 'u-12')).toEqual({ kind: 'system', id: 'u-12', text: 'Compacted.', level: 'info' });
    expect(byId(items, 'a-08:0')).toEqual({ kind: 'system', id: 'a-08:0', text: 'API Error: 529 overloaded', level: 'error' });
  });

  it('never leaks meta text', () => {
    expect(JSON.stringify(items)).not.toContain('Synthetic meta note');
    expect(JSON.stringify(items)).not.toContain('This session is being continued');
    const reminder = {
      type: 'user',
      uuid: 'r-1',
      session_id: 's',
      message: { role: 'user', content: '<system-reminder>hidden</system-reminder>Visible request' },
      parent_tool_use_id: null,
      parent_agent_id: null,
    } satisfies SessionMessage;
    expect(mapSessionMessages([reminder])).toEqual([{ kind: 'user', id: 'r-1', text: 'Visible request' }]);
  });

  it('leaves a tool without a recorded result running and ignores results for unknown tools', () => {
    const partial = mapSessionMessages(messages.slice(0, 5));
    expect(byId(partial, 'toolu_read')).toMatchObject({ status: 'running', summary: 'Read D:\\work\\demo\\src\\app.ts' });
    expect(mapSessionMessages(messages.slice(5, 6))).toEqual([]);
  });
});

describe('mapSessionMessages history images (U3)', () => {
  const SID = '11111111-2222-4333-8444-555555555555';
  const image = (data: string, mediaType = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  const msg = (uuid: string, type: 'user' | 'assistant', content: unknown, parent: string | null = null): SessionMessage => ({
    type,
    uuid,
    session_id: 'other-session-id',
    message: { role: type, content },
    parent_tool_use_id: parent,
    parent_agent_id: null,
  });
  const history = [
    msg('a1', 'assistant', [{ type: 'tool_use', id: 'toolu_shot', name: 'Read', input: { file_path: 'D:\\work\\demo\\shot.png' } }]),
    msg('u1', 'user', [
      { type: 'tool_result', tool_use_id: 'toolu_shot', content: [{ type: 'text', text: 'image' }, image('SHOT', 'image/jpeg')] },
    ]),
    msg('u2', 'user', [
      { type: 'tool_result', tool_use_id: 'toolu_none', content: [image('ORPHAN')] },
      { type: 'text', text: 'Look at these' },
      image('P1'),
      image('P2', 'image/webp'),
    ]),
    msg('a2', 'assistant', [{ type: 'tool_use', id: 'toolu_sub', name: 'Agent', input: { description: 'x' } }]),
    msg('s1', 'assistant', [{ type: 'tool_use', id: 'toolu_subshot', name: 'mcp__browser__screenshot', input: {} }], 'toolu_sub'),
    msg('s2', 'user', [{ type: 'tool_result', tool_use_id: 'toolu_subshot', content: [image('SUB')] }], 'toolu_sub'),
  ];

  function recordingStore() {
    const store = createImageStore();
    const keys: string[] = [];
    const storeImages = (content: unknown, prefix: string) =>
      storeImageBlocks(content, prefix, {
        put: (key, mediaType, data) => {
          keys.push(key);
          return store.put(key, mediaType, data);
        },
        get: (key) => store.get(key),
      });
    return { store, keys, storeImages };
  }

  it('gives tool results and pasted user images refs keyed by session and item id, keeping the image count', () => {
    const { store, storeImages } = recordingStore();
    const items = mapSessionMessages(history, { sessionId: SID, storeImages });
    expect(byId(items, 'toolu_shot')).toMatchObject({
      status: 'done',
      images: 1,
      imageRefs: [{ key: `${SID}:toolu_shot:0`, mediaType: 'image/jpeg' }],
    });
    expect(byId(items, 'u2')).toEqual({
      kind: 'user',
      id: 'u2',
      text: 'Look at these',
      images: 2,
      imageRefs: [
        { key: `${SID}:u2:0`, mediaType: 'image/png' },
        { key: `${SID}:u2:1`, mediaType: 'image/webp' },
      ],
    });
    expect(byId(items, 'toolu_subshot')).toMatchObject({
      parentToolUseId: 'toolu_sub',
      imageRefs: [{ key: `${SID}:toolu_subshot:0`, mediaType: 'image/png' }],
    });
    expect(store.get(`${SID}:toolu_shot:0`)).toBe('data:image/jpeg;base64,SHOT');
    expect(store.get(`${SID}:u2:0`)).toBe('data:image/png;base64,P1');
    expect(store.get(`${SID}:toolu_subshot:0`)).toBe('data:image/png;base64,SUB');
    expect(JSON.stringify(items)).not.toContain('ORPHAN');
  });

  it('reuses the same keys when the same history loads again, so a reload replaces instead of duplicating', () => {
    const { keys, storeImages } = recordingStore();
    const first = mapSessionMessages(history, { sessionId: SID, storeImages });
    const firstKeys = [...keys];
    const second = mapSessionMessages(history, { sessionId: SID, storeImages });
    expect(second).toEqual(first);
    expect(keys.slice(firstKeys.length)).toEqual(firstKeys);
    expect(new Set(firstKeys).size).toBe(firstKeys.length);
  });

  it('falls back to the message session id and keeps only counts without a store', () => {
    const { keys, storeImages } = recordingStore();
    mapSessionMessages(history.slice(0, 2), { storeImages });
    expect(keys).toEqual(['other-session-id:toolu_shot:0']);
    const plain = mapSessionMessages(history);
    expect(byId(plain, 'u2')).toEqual({ kind: 'user', id: 'u2', text: 'Look at these', images: 2 });
    expect(byId(plain, 'toolu_shot')).not.toHaveProperty('imageRefs');
  });
});

describe('mapSessionMessages settleOpenTools (EC-3)', () => {
  const msg = (uuid: string, type: 'user' | 'assistant', content: unknown, parent: string | null = null): SessionMessage => ({
    type,
    uuid,
    session_id: 's',
    message: { role: type, content },
    parent_tool_use_id: parent,
    parent_agent_id: null,
  });
  const use = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: { command: id } });
  const result = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' });
  const history = [
    msg('a1', 'assistant', [use('t-lost'), use('t-ok')]),
    msg('u1', 'user', [result('t-ok')]),
    msg('a2', 'assistant', [use('t-agent', 'Agent')]),
    msg('u2', 'user', [result('t-agent')]),
    msg('a3', 'assistant', [{ type: 'text', text: 'Next step' }, use('t-live')]),
    msg('s1', 'assistant', [use('t-sub-ok'), use('t-sub-lost')], 't-agent'),
    msg('s2', 'user', [result('t-sub-ok')], 't-agent'),
  ];
  const statuses = (items: TranscriptItem[]) =>
    Object.fromEntries(items.flatMap((item) => (item.kind === 'tool' ? [[item.id, item.status]] : [])));

  it('settles tools the thread moved past and subagent tools of a finished agent to done, without output', () => {
    const items = mapSessionMessages(history, { settleOpenTools: true });
    expect(statuses(items)).toEqual({
      't-lost': 'done',
      't-ok': 'done',
      't-agent': 'done',
      't-sub-lost': 'done',
      't-sub-ok': 'done',
      't-live': 'running',
    });
    expect(byId(items, 't-lost')).not.toHaveProperty('output');
  });

  it('keeps the trailing tools of a still running agent running', () => {
    const items = mapSessionMessages([...history.slice(0, 3), ...history.slice(5)], { settleOpenTools: true });
    expect(statuses(items)).toMatchObject({ 't-lost': 'done', 't-agent': 'running', 't-sub-ok': 'done', 't-sub-lost': 'running' });
    const trailing = mapSessionMessages(
      [history[2]!, msg('s3', 'assistant', [use('t-sub-a'), use('t-sub-b')], 't-agent')],
      { settleOpenTools: true },
    );
    expect(statuses(trailing)).toEqual({ 't-agent': 'running', 't-sub-a': 'running', 't-sub-b': 'running' });
  });

  it('leaves every open tool running when the option is off (live sessions)', () => {
    expect(statuses(mapSessionMessages(history))).toMatchObject({ 't-lost': 'running', 't-sub-lost': 'running' });
  });

  it('settles every open tool of an older history page, whose thread went on in a newer page', () => {
    const items = mapSessionMessages(history, { settleOpenTools: true, settleTrailingTools: true });
    expect(statuses(items)).toEqual({
      't-lost': 'done',
      't-ok': 'done',
      't-agent': 'done',
      't-sub-lost': 'done',
      't-sub-ok': 'done',
      't-live': 'done',
    });
    const running = mapSessionMessages([...history.slice(0, 3), ...history.slice(5)], { settleOpenTools: true, settleTrailingTools: true });
    expect(statuses(running)).toMatchObject({ 't-agent': 'done', 't-sub-lost': 'done' });
    expect(statuses(mapSessionMessages(history, { settleTrailingTools: true }))).toMatchObject({ 't-live': 'running' });
  });
});

describe('mapSessionMessages history pages', () => {
  const msg = (uuid: string, type: SessionMessage['type'], content: unknown, parent: string | null = null): SessionMessage => ({
    type,
    uuid,
    session_id: 's',
    message: { role: type, content },
    parent_tool_use_id: parent,
    parent_agent_id: null,
  });

  it('never shows subagent messages whose Agent call is not among the messages', () => {
    const items = mapSessionMessages(
      [
        msg('a1', 'assistant', [{ type: 'tool_use', id: 't-agent', name: 'Agent', input: { description: 'Here' } }]),
        msg('u1', 'user', [{ type: 'tool_result', tool_use_id: 't-agent', content: 'done' }]),
        msg('s1', 'assistant', [{ type: 'tool_use', id: 't-sub', name: 'Read', input: {} }], 't-agent'),
        msg('o1', 'assistant', [{ type: 'tool_use', id: 't-orphan', name: 'Bash', input: { command: 'old' } }], 't-elsewhere'),
        msg('o2', 'user', [{ type: 'tool_result', tool_use_id: 't-orphan', content: 'old output' }], 't-elsewhere'),
      ],
      { settleOpenTools: true },
    );
    expect(items.map((item) => item.id)).toEqual(['t-agent', 't-sub']);
    expect(JSON.stringify(items)).not.toContain('old output');
  });

  it('shows one compaction row per compaction: the SDK boundary has no body, its summary makes the row', () => {
    const boundary = (uuid: string): SessionMessage => ({ type: 'system', uuid, session_id: 's', message: undefined, parent_tool_use_id: null, parent_agent_id: null });
    const summary = (uuid: string): SessionMessage => ({
      ...msg(uuid, 'user', 'This session is being continued from a previous conversation.'),
      isCompactSummary: true,
      is_meta: true,
    } as SessionMessage);
    const items = mapSessionMessages([
      msg('u1', 'user', 'First'),
      boundary('b1'),
      summary('c1'),
      msg('u2', 'user', 'Second'),
      boundary('b2'),
      summary('c2'),
      msg('u3', 'user', 'Third'),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: 'First' },
      { kind: 'system', id: 'c1', text: 'Conversation compacted', level: 'info' },
      { kind: 'user', id: 'u2', text: 'Second' },
      { kind: 'system', id: 'c2', text: 'Conversation compacted', level: 'info' },
      { kind: 'user', id: 'u3', text: 'Third' },
    ]);
  });
});

describe('mapSessionMessages local command results (native.13)', () => {
  // Shaped as the SDK hands CLI 2.1.308 rows over (meta rows such as the caveat filtered out), with the parent link
  // the listing worker carries through from the raw entries.
  const row = (uuid: string, type: SessionMessage['type'], content: unknown, extra: Record<string, unknown> = {}): SessionMessage =>
    ({ type, uuid, session_id: 's', message: type === 'system' ? undefined : { role: type, content }, parent_tool_use_id: null,
      parent_agent_id: null, ...extra }) as SessionMessage;
  const name = (command: string) => `<command-name>/${command}</command-name>\n            <command-message>${command}</command-message>\n            <command-args></command-args>`;

  it('shows a 308 /compact as its command, one compaction line and its result without the TUI hint, with the running time', () => {
    const items = mapSessionMessages([
      row('typed', 'user', '/compact', { timestamp: '2026-10-24T06:31:47.170Z', origin: { kind: 'plugin', name: 'relay-native-bridge' } }),
      row('boundary', 'system', undefined, { timestamp: '2026-10-24T06:34:34.939Z' }),
      row('summary', 'user', 'This session is being continued from a previous conversation. SUMMARY BODY',
        { isCompactSummary: true, is_meta: true, parentUuid: 'boundary', timestamp: '2026-10-24T06:34:34.940Z' }),
      row('command', 'user', name('compact'), { parentUuid: 'caveat', timestamp: '2026-10-24T06:31:47.192Z' }),
      row('stdout', 'user', '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>',
        { parentUuid: 'command', timestamp: '2026-10-24T06:34:35.038Z' }),
    ]);
    expect(items.slice(1)).toEqual([
      { kind: 'system', id: 'summary', text: 'Conversation compacted', level: 'info' },
      { kind: 'user', id: 'command', text: '/compact' },
      { kind: 'system', id: 'stdout', text: 'Compacted', level: 'info', durationMs: 167_846 },
    ]);
    expect(JSON.stringify(items)).not.toContain('SUMMARY BODY');
  });

  it('drops the summary key hint under any key and wherever it stands, keeping the lines the CLI puts after it', () => {
    // CLI 2.1.308: "Compacted " + [hint, userDisplayMessage?, tip?].join("\n"); the key follows the user's keybinding.
    const out = (uuid: string, body: string) => row(uuid, 'user', `<local-command-stdout>\u001b[2m${body}\u001b[22m</local-command-stdout>`);
    const items = mapSessionMessages([
      out('tipped', 'Compacted (ctrl+o to see full summary)\nTip: You have access to Opus 1M with 5x more context'),
      out('rebound', 'Compacted (ctrl+t to see full summary)'),
      out('message', 'Compacted (alt+shift+o to see full summary)\nSynthetic display message\nTip: Synthetic tip'),
    ]);
    expect(items).toEqual([
      { kind: 'system', id: 'tipped', text: 'Compacted\nTip: You have access to Opus 1M with 5x more context', level: 'info' },
      { kind: 'system', id: 'rebound', text: 'Compacted', level: 'info' },
      { kind: 'system', id: 'message', text: 'Compacted\nSynthetic display message\nTip: Synthetic tip', level: 'info' },
    ]);
  });

  it('shows a command error as a warning line instead of a raw-tag user bubble', () => {
    const items = mapSessionMessages([
      row('command', 'user', name('mcp'), { timestamp: '2026-10-24T07:00:00.000Z' }),
      row('stderr', 'user', '<local-command-stderr>\u001b[31mFailed to reconnect to alpha\u001b[39m</local-command-stderr>',
        { parentUuid: 'command', timestamp: '2026-10-24T07:00:00.000Z' }),
      row('empty', 'user', '<local-command-stderr>  </local-command-stderr>', { parentUuid: 'stderr', timestamp: '2026-10-24T07:00:00.000Z' }),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'command', text: '/mcp' },
      { kind: 'system', id: 'stderr', text: 'Failed to reconnect to alpha', level: 'warn' },
    ]);
  });

  it('maps 308 system local_command rows like their user twins, and every other system row as before', () => {
    // As the listing worker hands them over: the SDK's bare system row with the raw row's subtype, text and parent link.
    const local = (uuid: string, content: string, extra: Record<string, unknown>) => row(uuid, 'system', undefined, { subtype: 'local_command', content, ...extra });
    const items = mapSessionMessages([
      row('turn-end', 'system', undefined, { parentUuid: 'answer', timestamp: '2026-10-24T10:20:13.901Z' }),
      local('rename', '<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>synthetic-name</command-args>',
        { parentUuid: 'turn-end', timestamp: '2026-10-24T10:20:14.141Z' }),
      local('rename-out', '<local-command-stdout>Session renamed to: synthetic-name</local-command-stdout>', { parentUuid: 'rename', timestamp: '2026-10-24T10:20:14.141Z' }),
      local('caveat', '<local-command-caveat>Caveat: synthetic.</local-command-caveat>', { parentUuid: 'rename-out', timestamp: '2026-10-24T10:22:00.000Z' }),
      local('mcp', name('mcp'), { parentUuid: 'caveat', timestamp: '2026-10-24T10:22:00.000Z' }),
      local('hidden', '<local-command-stdout>Only in the CLI transcript view</local-command-stdout>', { is_meta: true, parentUuid: 'mcp', timestamp: '2026-10-24T10:22:01.000Z' }),
      local('mcp-err', '<local-command-stderr>\u001b[31mFailed to reconnect to beta\u001b[39m</local-command-stderr>', { parentUuid: 'mcp', timestamp: '2026-10-24T10:22:03.000Z' }),
      row('boundary', 'system', undefined, { subtype: 'compact_boundary', timestamp: '2026-10-24T10:23:00.000Z' }),
      row('notice', 'system', undefined, { subtype: 'informational', content: 'A synthetic notice', level: 'warning', timestamp: '2026-10-24T10:24:00.000Z' }),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'rename', text: '/rename synthetic-name' },
      { kind: 'system', id: 'rename-out', text: 'Session renamed to: synthetic-name', level: 'info' },
      { kind: 'user', id: 'mcp', text: '/mcp' },
      { kind: 'system', id: 'mcp-err', text: 'Failed to reconnect to beta', level: 'warn', durationMs: 3_000 },
      { kind: 'system', id: 'boundary', text: 'Conversation compacted', level: 'info' },
      { kind: 'system', id: 'notice', text: 'A synthetic notice', level: 'warn' },
    ]);
  });

  it('gives no running time to a dialog command whose rows share a millisecond, nor to a result without a parent link', () => {
    const items = mapSessionMessages([
      row('effort', 'user', name('effort'), { parentUuid: 'caveat', timestamp: '2026-10-24T07:10:05.123Z' }),
      row('effort-out', 'user', '<local-command-stdout>Set effort level to max</local-command-stdout>',
        { parentUuid: 'effort', timestamp: '2026-10-24T07:10:05.123Z' }),
      row('model', 'user', name('model'), { timestamp: '2026-10-24T07:11:00.000Z' }),
      row('model-out', 'user', '<local-command-stdout>Kept model as Opus 5.5</local-command-stdout>', { timestamp: '2026-10-24T07:11:09.000Z' }),
    ]);
    expect(items.filter((item) => item.kind === 'system')).toEqual([
      { kind: 'system', id: 'effort-out', text: 'Set effort level to max', level: 'info' },
      { kind: 'system', id: 'model-out', text: 'Kept model as Opus 5.5', level: 'info' },
    ]);
  });
});

describe('mapSessionMessages task notifications (FU-1)', () => {
  const user = (uuid: string, content: unknown): SessionMessage => ({
    type: 'user',
    uuid,
    session_id: 's',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    parent_agent_id: null,
  });
  const notice = (id: string, status: string, summary: string) =>
    `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`;

  it('shows a saved task notification as a system line instead of a user bubble with tags', () => {
    const items = mapSessionMessages([
      user('n1', notice('bg-1', 'completed', 'Agent &quot;Review&quot; finished')),
      user('n2', [{ type: 'text', text: `${notice('bg-2', 'failed', 'npm test exited 1')}\n${notice('bg-3', 'completed', 'Build done')}` }]),
    ]);
    expect(items).toEqual([
      {
        kind: 'system',
        id: 'n1',
        text: 'Background task completed: Agent "Review" finished',
        level: 'info',
        tasks: [{ status: 'completed', summary: 'Agent "Review" finished' }],
      },
      {
        kind: 'system',
        id: 'n2',
        text: 'Background task failed: npm test exited 1\nBackground task completed: Build done',
        level: 'warn',
        tasks: [
          { status: 'failed', summary: 'npm test exited 1' },
          { status: 'completed', summary: 'Build done' },
        ],
      },
    ]);
  });

  it('keeps ordinary user text that merely mentions the tag', () => {
    const items = mapSessionMessages([user('u1', 'What does <task-notification> mean?')]);
    expect(items).toEqual([{ kind: 'user', id: 'u1', text: 'What does <task-notification> mean?' }]);
  });
});

describe('mapSessionMessages automatic continue', () => {
  const user = (uuid: string, content: unknown, extra: Record<string, unknown> = {}, parent: string | null = null): SessionMessage =>
    ({
      type: 'user',
      uuid,
      session_id: 's',
      message: { role: 'user', content },
      parent_tool_use_id: parent,
      parent_agent_id: null,
      ...extra,
    }) as SessionMessage;
  const note = (id: string) => ({ kind: 'system', id, text: 'Usage limit reset · Claude is continuing your task', level: 'info' });

  it('shows the saved resume prompt as a system line, by its exact text and never for another origin', () => {
    expect(AUTO_CONTINUE_PROMPT).toBe(
      'Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.',
    );
    const items = mapSessionMessages([
      user('u1', 'Build the parser', { origin: { kind: 'human' } }),
      user('c1', AUTO_CONTINUE_PROMPT, { origin: { kind: 'auto-continuation' } }),
      user('c2', [{ type: 'text', text: AUTO_CONTINUE_PROMPT }]),
      user('c3', 'Carry on', { origin: { kind: 'auto-continuation' } }),
      user('c4', `<system-reminder>hidden</system-reminder>\n${AUTO_CONTINUE_PROMPT}\n`),
      user('c5', AUTO_CONTINUE_PROMPT, { is_meta: true, origin: { kind: 'auto-continuation' } }),
      user('h1', `${AUTO_CONTINUE_PROMPT} Then also fix the tests.`, { origin: { kind: 'human' } }),
      user('h2', 'Your claude.ai usage limit has reset.'),
      user('h3', AUTO_CONTINUE_PROMPT, { origin: { kind: 'human' } }),
    ]);
    expect(items).toEqual([
      { kind: 'user', id: 'u1', text: 'Build the parser' },
      note('c1'),
      note('c2'),
      // The CLI gives this origin to other prompts too (an approved plan, /goal).
      { kind: 'user', id: 'c3', text: 'Carry on' },
      note('c4'),
      note('c5'),
      { kind: 'user', id: 'h1', text: `${AUTO_CONTINUE_PROMPT} Then also fix the tests.` },
      { kind: 'user', id: 'h2', text: 'Your claude.ai usage limit has reset.' },
      { kind: 'user', id: 'h3', text: AUTO_CONTINUE_PROMPT },
    ]);
  });

  it('never puts the note into a subagent thread', () => {
    const items = mapSessionMessages([
      { type: 'assistant', uuid: 'a1', session_id: 's', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't-agent', name: 'Agent', input: {} }] }, parent_tool_use_id: null, parent_agent_id: null },
      user('s1', AUTO_CONTINUE_PROMPT, { origin: { kind: 'auto-continuation' } }, 't-agent'),
    ]);
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(['tool:t-agent']);
  });
});

describe('summarizeTool', () => {
  it.each([
    ['Read', { file_path: 'D:\\work\\demo\\src\\a.ts' }, 'Read src\\a.ts'],
    ['Read', { file_path: 'C:\\other\\b.ts' }, 'Read C:\\other\\b.ts'],
    ['Write', { file_path: 'D:/work/demo/new.ts', content: 'a\nb\nc\n' }, 'Wrote new.ts (+3 −0)'],
    ['Edit', { file_path: 'D:\\work\\demo\\x.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }, 'Edited x.ts (+1 −1)'],
    [
      'MultiEdit',
      {
        file_path: 'D:\\work\\demo\\x.ts',
        edits: [
          { old_string: 'one', new_string: 'one\ntwo' },
          { old_string: 'gone\nkeep', new_string: 'keep' },
        ],
      },
      'Edited x.ts (+1 −1)',
    ],
    ['Bash', { command: 'npm test -- --run' }, 'Ran `npm test -- --run`'],
    ['Bash', { command: 'git status\ngit diff' }, 'Ran `git status…`'],
    ['PowerShell', { command: 'Get-ChildItem' }, 'Ran `Get-ChildItem`'],
    ['Grep', { pattern: 'TODO' }, 'Searched for `TODO`'],
    ['Glob', { pattern: '**/*.ts', path: 'D:\\work\\demo\\src' }, 'Listed files `**/*.ts` in src'],
    ['WebFetch', { url: 'https://example.com/docs', prompt: 'x' }, 'Fetched https://example.com/docs'],
    ['WebSearch', { query: 'vitest fake timers' }, 'Searched the web for `vitest fake timers`'],
    ['Agent', { description: 'Review the diff', prompt: 'x' }, 'Agent: Review the diff'],
    ['Task', { description: 'Explore', subagent_type: 'Explore', prompt: 'x' }, 'Agent (Explore): Explore'],
    ['TodoWrite', { todos: [{}, {}] }, 'Updated the todo list (2 items)'],
    ['AskUserQuestion', { questions: [{ question: 'Which library?' }] }, 'Asked: Which library?'],
    ['NotebookEdit', { notebook_path: 'D:\\work\\demo\\n.ipynb', new_source: '' }, 'Edited notebook n.ipynb'],
    ['mcp__linear__create_issue', { title: 't' }, 'linear/create_issue'],
    ['mcp__my_server__do__thing', {}, 'my_server/do__thing'],
    ['Workflow', { script: "export const meta = { name: 'review-changes', description: 'd', phases: [] }\nphase('A')" }, 'Workflow: review-changes'],
    ['Workflow', { name: 'deep-research', args: { q: 'x' } }, 'Workflow: deep-research'],
    [
      'Workflow',
      { scriptPath: 'C:\\Users\\u\\.claude\\projects\\p\\s\\workflows\\scripts\\relay-probe-wf_b7fa872e-bb7.js' },
      'Workflow: relay-probe',
    ],
    ['Workflow', { scriptPath: 'D:/work/demo/flows/audit.js' }, 'Workflow: audit'],
    ['Workflow', { script: 'const meta = computed()' }, 'Ran a workflow'],
    // A broken escape once threw out of the parser and ended the session.
    ['Workflow', { script: "export const meta = { name: 'x\\u{-1}' }" }, 'Ran a workflow'],
    ['SomethingNew', { anything: 1 }, 'Used SomethingNew'],
    ['Read', null, 'Read a file'],
  ])('%s %j -> %s', (name, input, expected) => {
    expect(summarizeTool(name, input, CWD)).toBe(expected);
  });

  it('clips long arguments and prefers explicit line counts', () => {
    const summary = summarizeTool('Bash', { command: 'x'.repeat(200) });
    expect(summary.length).toBeLessThan(100);
    expect(summary.endsWith('…`')).toBe(true);
    expect(summarizeTool('Write', { file_path: 'a.ts', content: 'a' }, undefined, { added: 4, removed: 2 })).toBe(
      'Wrote a.ts (+4 −2)',
    );
  });
});

describe('block helpers', () => {
  it('lineDiff counts only changed lines', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nc\nd\ne')).toEqual({ added: 1, removed: 1 });
    expect(lineDiff('', 'x\ny')).toEqual({ added: 2, removed: 0 });
    expect(lineDiff('same', 'same')).toEqual({ added: 0, removed: 0 });
  });

  it('patchCounts reads structuredPatch hunks', () => {
    expect(patchCounts([{ lines: [' a', '-b', '+B', '+C'] }])).toEqual({ added: 2, removed: 1 });
    expect(patchCounts(undefined)).toBeUndefined();
  });

  it('truncateOutput keeps head and tail of long output', () => {
    const long = `HEAD${'x'.repeat(10_000)}TAIL`;
    const out = truncateOutput(long);
    expect(out.length).toBeLessThan(OUTPUT_LIMIT + 60);
    expect(out.startsWith('HEAD')).toBe(true);
    expect(out.endsWith('TAIL')).toBe(true);
    expect(out).toContain('characters omitted');
    expect(truncateOutput('short')).toBe('short');
  });

  it('applyToolResult marks denials, errors and images', () => {
    const item = toolItemFromUse({ id: 't1', name: 'Bash', input: { command: 'ls' } });
    expect(applyToolResult(item, { toolUseId: 't1', isError: false, text: 'ok', images: 2 })).toMatchObject({
      status: 'done',
      output: 'ok',
      images: 2,
    });
    expect(applyToolResult(item, { toolUseId: 't1', isError: true, text: 'boom', images: 0 }).status).toBe('error');
    expect(
      applyToolResult(item, { toolUseId: 't1', isError: true, text: 'Permission to use Bash has been denied.', images: 0 })
        .status,
    ).toBe('denied');
    expect(applyToolResult(item, { toolUseId: 't1', isError: true, text: 'custom', images: 0 }, { denied: true }).status).toBe(
      'denied',
    );
    expect(applyToolResult(item, { toolUseId: 't1', isError: false, text: '', images: 0 })).not.toHaveProperty('output');
  });
});
