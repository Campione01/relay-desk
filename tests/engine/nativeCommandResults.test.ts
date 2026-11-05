import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cliCommandName, COMMAND_RESULT_READS_MS, nativeTranscriptFile, readCommandResults, scanCommandResults } from '../../src/main/native/commandResults';
import { projectFolderName } from '../../src/main/engine/transcriptReader';

vi.mock('@anthropic-ai/claude-agent-sdk', () => { throw new Error('The native read-back must not import the SDK runtime.'); });

// Synthetic transcripts in a temp folder only; the real ~/.claude is never read.
let folder = '';
beforeAll(async () => { folder = await mkdtemp(join(tmpdir(), 'relay-command-results-')); });
afterAll(async () => { await rm(folder, { recursive: true, force: true }); });

type Line = Record<string, unknown>;
const jsonl = (lines: readonly Line[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join('');
let count = 0;
async function transcript(lines: readonly Line[]): Promise<string> {
  const file = join(folder, `session-${++count}.jsonl`);
  await writeFile(file, jsonl(lines));
  return file;
}
const row = (type: string, uuid: string, parentUuid: string | null, timestamp: string, extra: Line = {}): Line =>
  ({ parentUuid, isSidechain: false, userType: 'external', sessionId: 's', version: '2.1.308', type, uuid, timestamp, ...extra });
const user = (uuid: string, parent: string | null, timestamp: string, content: string, extra: Line = {}) =>
  row('user', uuid, parent, timestamp, { message: { role: 'user', content }, ...extra });
const local = (uuid: string, parent: string | null, timestamp: string, content: string, extra: Line = {}) =>
  row('system', uuid, parent, timestamp, { subtype: 'local_command', content, level: 'info', isMeta: false, ...extra });
const commandName = (name: string, args = '') =>
  `<command-name>/${name}</command-name>\n            <command-message>${name}</command-message>\n            <command-args>${args}</command-args>`;
const caveat = '<local-command-caveat>Caveat: synthetic.</local-command-caveat>';

// CLI 2.1.308's rows of one manual /compact (synthetic text, the real layout and timestamps).
const SENT = Date.parse('2026-10-24T06:31:47.150Z');
const BEFORE = [
  user('ask', null, '2026-10-24T06:20:00.000Z', 'Earlier question'),
  row('assistant', 'answer', 'ask', '2026-10-24T06:20:05.000Z', { message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } }),
  user('typed', 'answer', '2026-10-24T06:31:47.170Z', '/compact', { origin: { kind: 'plugin', name: 'relay-native-bridge' } }),
];
const COMPACTED = [
  row('system', 'boundary', null, '2026-10-24T06:34:34.939Z', { subtype: 'compact_boundary', content: 'Conversation compacted',
    logicalParentUuid: 'typed', compactMetadata: { trigger: 'manual', preTokens: 20453 } }),
  user('summary', 'boundary', '2026-10-24T06:34:34.940Z', 'This session is being continued from a previous conversation. SUMMARY BODY',
    { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
  user('caveat', 'summary', '2026-10-24T06:31:47.192Z', caveat, { isMeta: true }),
  user('command', 'caveat', '2026-10-24T06:31:47.192Z', commandName('compact')),
  user('stdout', 'command', '2026-10-24T06:34:35.038Z', '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>'),
  row('attachment', 'reread', 'stdout', '2026-10-24T06:34:35.040Z', { attachment: { type: 'todo_reminder', content: [], itemCount: 0 } }),
];
const COMPACT_RESULT = { kind: 'system', id: 'stdout', text: 'Compacted', level: 'info', durationMs: 167_846 };
const query = { name: 'compact', since: SENT - 2_000 };

// CLI 2.1.308's rows of `/rename synthetic-name` (synthetic text in the CLI's layout): title entries, then its command
// and result rows as system `local_command` rows in one millisecond, then a meta user row.
const RENAME_SENT = Date.parse('2026-10-24T10:20:14.098Z');
const renamed = (parent: string): Line[] => [
  { type: 'custom-title', customTitle: 'synthetic-name', sessionId: 's' },
  { type: 'agent-name', agentName: 'synthetic-name', sessionId: 's' },
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-24T10:20:14.099Z', sessionId: 's', content: '/rename synthetic-name' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-24T10:20:14.106Z', sessionId: 's' },
  local('rename', parent, '2026-10-24T10:20:14.141Z', commandName('rename', 'synthetic-name')),
  local('rename-out', 'rename', '2026-10-24T10:20:14.141Z', '<local-command-stdout>Session renamed to: synthetic-name</local-command-stdout>'),
  user('rename-meta', 'rename-out', '2026-10-24T10:20:14.141Z', 'Synthetic meta note.', { isMeta: true }),
];
const RENAME_RESULT = { kind: 'system', id: 'rename-out', text: 'Session renamed to: synthetic-name', level: 'info' };
const renameQuery = { name: 'rename', since: RENAME_SENT - 2_000 };

function recorder(onWait?: (index: number) => Promise<void> | void) {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => { waits.push(ms); await onWait?.(waits.length); } };
}

describe('native command result read-back', () => {
  it('finds the transcript as the history reader does, in the config folder of the CLI environment, for a plain session id only', async () => {
    const configDir = join(folder, 'config'), cwd = 'D:\\work\\native', sessionId = 'eeeeeeee-8888-4888-8888-888888888888';
    const projects = join(configDir, 'projects'), own = join(projects, projectFolderName(cwd));
    await mkdir(own, { recursive: true });
    await writeFile(join(own, `${sessionId}.jsonl`), jsonl(BEFORE));
    await writeFile(join(projects, 'escape.jsonl'), jsonl(BEFORE));
    const env = { CLAUDE_CONFIG_DIR: configDir };
    await expect(nativeTranscriptFile(env, sessionId, cwd)).resolves.toBe(join(own, `${sessionId}.jsonl`));
    await expect(nativeTranscriptFile(env, '..\\escape', cwd)).resolves.toBeUndefined();
    await expect(nativeTranscriptFile(env, 'ffffffff-9999-4999-8999-999999999999', cwd)).resolves.toBeUndefined();
  });

  it('takes a 308 /compact result from its <command-name> row, not the typed echo, with the history running time', async () => {
    const file = await transcript([...BEFORE, ...COMPACTED]);
    await expect(scanCommandResults(file, query)).resolves.toEqual({ anchor: 'command', items: [COMPACT_RESULT], done: true });
  });

  it('takes a 308 /rename result from its system local_command rows below the turn before it, with no running time', async () => {
    const file = await transcript([
      user('ask', null, '2026-10-24T10:20:13.737Z', 'Earlier question'),
      row('assistant', 'answer', 'ask', '2026-10-24T10:20:13.865Z', { message: { id: 'msg_a', role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } }),
      row('system', 'turn-end', 'answer', '2026-10-24T10:20:13.901Z', { subtype: 'turn_duration', durationMs: 178, isMeta: false }),
      ...renamed('turn-end'),
    ]);
    await expect(scanCommandResults(file, renameQuery)).resolves.toEqual({ anchor: 'rename', items: [RENAME_RESULT], done: true });
  });

  it("reads a /compact of user rows and a /rename of system rows from one transcript, neither taking the other's line", async () => {
    const file = await transcript([...BEFORE, ...COMPACTED, ...renamed('reread')]);
    await expect(scanCommandResults(file, query)).resolves.toEqual({ anchor: 'command', items: [COMPACT_RESULT], done: true });
    await expect(scanCommandResults(file, renameQuery)).resolves.toEqual({ anchor: 'rename', items: [RENAME_RESULT], done: true });
  });

  it('follows notices and meta rows below a system-row command without showing them, and keeps its running time', async () => {
    const file = await transcript([
      local('slow', 'answer', '2026-10-24T09:00:00.000Z', commandName('rename', 'slow')),
      row('system', 'notice', 'slow', '2026-10-24T09:00:01.000Z', { subtype: 'informational', content: 'A synthetic notice', level: 'info', isMeta: false }),
      local('hidden', 'notice', '2026-10-24T09:00:02.000Z', '<local-command-stdout>Only in the CLI transcript view</local-command-stdout>',
        { isVisibleInTranscriptOnly: true }),
      local('meta', 'hidden', '2026-10-24T09:00:02.500Z', '<local-command-stdout>A meta line</local-command-stdout>', { isMeta: true }),
      local('failed', 'meta', '2026-10-24T09:00:03.500Z', '<local-command-stderr>\u001b[31mRename failed\u001b[39m</local-command-stderr>'),
    ]);
    await expect(scanCommandResults(file, { name: 'rename', since: Date.parse('2026-10-24T08:59:59.000Z') })).resolves.toEqual({ anchor: 'slow', done: true,
      items: [{ kind: 'system', id: 'failed', text: 'Rename failed', level: 'warn', durationMs: 3_500 }] });
  });

  it('follows parent links when the CLI wrote a dialog command line before its <command-name> row', async () => {
    const at = '2026-10-24T07:10:05.123Z';
    const file = await transcript([
      user('caveat', 'answer', at, caveat, { isMeta: true }),
      user('effort-out', 'effort', at, '<local-command-stdout>Set effort level to max (this session only)</local-command-stdout>'),
      user('effort', 'caveat', at, commandName('effort')),
    ]);
    await expect(scanCommandResults(file, { name: 'effort', since: Date.parse(at) - 2_000 })).resolves.toEqual({
      anchor: 'effort', done: true,
      items: [{ kind: 'system', id: 'effort-out', text: 'Set effort level to max (this session only)', level: 'info' }],
    });
  });

  it('reads once before the CLI wrote the rows and once after, then stops', async () => {
    const file = await transcript(BEFORE);
    const located = vi.fn(async () => file), anchored = vi.fn();
    const { waits, wait } = recorder(async (index) => { if (index === 2) await appendFile(file, jsonl(COMPACTED)); });
    const scan = await readCommandResults({ ...query, file: located, onAnchor: anchored, signal: new AbortController().signal, wait });
    expect(scan).toEqual({ anchor: 'command', items: [COMPACT_RESULT], done: true });
    expect(waits).toEqual([100, 150]);
    expect(located).toHaveBeenCalledOnce(); expect(anchored).toHaveBeenCalledExactlyOnceWith('command');
  });

  it('stops at once when the conversation went on past a silent command, and after the last read when no row comes', async () => {
    const at = '2026-10-24T08:00:00.000Z';
    const silent = await transcript([
      user('status', 'answer', at, commandName('status')),
      user('next', 'status', '2026-10-24T08:00:01.000Z', 'A message sent after the command'),
    ]);
    const first = recorder();
    await expect(readCommandResults({ name: 'status', since: Date.parse(at) - 2_000, file: async () => silent, signal: new AbortController().signal,
      wait: first.wait })).resolves.toEqual({ anchor: 'status', items: [], done: true });
    expect(first.waits).toEqual([100]);
    const never = recorder();
    await expect(readCommandResults({ name: 'status', since: Date.parse(at) + 60_000, file: async () => silent, signal: new AbortController().signal,
      wait: never.wait })).resolves.toEqual({ items: [], done: false });
    expect(never.waits).toEqual(COMMAND_RESULT_READS_MS.map((at, index) => at - (COMMAND_RESULT_READS_MS[index - 1] ?? 0)));
  });

  it('stops when the session closes, without reading rows written afterwards', async () => {
    const file = await transcript(BEFORE);
    const closed = new AbortController();
    const { waits, wait } = recorder(async (index) => {
      if (index === 2) { await appendFile(file, jsonl(COMPACTED)); closed.abort(); }
    });
    const scan = await readCommandResults({ ...query, file: async () => file, signal: closed.signal, wait });
    expect(scan.items).toEqual([]); expect(waits).toHaveLength(2);
  });

  it('reads only the file tail, growing it to its cap while the <command-name> row is not inside', async () => {
    const filler = (count: number) => Array.from({ length: count }, (_, index) =>
      row('attachment', `filler-${index}`, index ? `filler-${index - 1}` : 'stdout', '2026-10-24T06:34:36.000Z', { attachment: { type: 'todo_reminder', note: 'x'.repeat(120) } }));
    // About 350 bytes a row: the <command-name> row lies 1.6 KiB and 3.7 KiB before the end.
    const near = await transcript([...BEFORE, ...COMPACTED, ...filler(2)]);
    const far = await transcript([...BEFORE, ...COMPACTED, ...filler(8)]);
    const bytes = { first: 512, max: 2_048 };
    await expect(scanCommandResults(near, query, bytes)).resolves.toEqual({ anchor: 'command', items: [COMPACT_RESULT], done: true });
    await expect(scanCommandResults(far, query, bytes)).resolves.toEqual({ items: [], done: false });
  });

  it('shows a command error as a warning, takes the newest row of the command and skips older or owned ones', async () => {
    const file = await transcript([
      user('old', 'answer', '2026-10-24T09:00:00.000Z', commandName('mcp')),
      user('old-out', 'old', '2026-10-24T09:00:00.000Z', '<local-command-stdout>Old run</local-command-stdout>'),
      user('first', 'old-out', '2026-10-24T09:05:00.000Z', commandName('mcp')),
      user('first-out', 'first', '2026-10-24T09:05:00.000Z', '<local-command-stdout>Reconnected to alpha.</local-command-stdout>'),
      user('second', 'first-out', '2026-10-24T09:05:03.000Z', commandName('mcp')),
      user('second-err', 'second', '2026-10-24T09:05:03.000Z', '<local-command-stderr>\u001b[31mFailed to reconnect to beta\u001b[39m</local-command-stderr>'),
    ]);
    const since = Date.parse('2026-10-24T09:04:59.000Z');
    await expect(scanCommandResults(file, { name: 'mcp', since })).resolves.toEqual({ anchor: 'second', done: true,
      items: [{ kind: 'system', id: 'second-err', text: 'Failed to reconnect to beta', level: 'warn' }] });
    await expect(scanCommandResults(file, { name: 'mcp', since, taken: new Set(['second']) })).resolves.toMatchObject({ anchor: 'first',
      items: [{ id: 'first-out', text: 'Reconnected to alpha.' }] });
    await expect(scanCommandResults(file, { name: 'mcp', since, taken: new Set(['second', 'first']) })).resolves.toEqual({ items: [], done: false });
  });

  it('resolves a typed name as CLI 2.1.308 does: a listed command of that exact name first, then the command it is an alias of', () => {
    const listed = ['rename', 'usage', 'config', 'plugin', 'permissions', 'doctor', 'rewind', 'tasks', 'compact'];
    const aliases = { name: 'rename', cost: 'usage', stats: 'usage', settings: 'config', plugins: 'plugin', marketplace: 'plugin',
      'allowed-tools': 'permissions', checkup: 'doctor', undo: 'rewind', checkpoint: 'rewind', bashes: 'tasks' };
    for (const [alias, command] of Object.entries(aliases)) expect([alias, cliCommandName(alias, listed)]).toEqual([alias, command]);
    expect(cliCommandName('Cost', [])).toBe('usage');
    expect(cliCommandName('compact', listed)).toBe('compact');
    expect(cliCommandName('Unknown-Thing', listed)).toBe('unknown-thing');
    // A user's own /name runs instead of the built-in alias.
    expect(cliCommandName('name', [...listed, 'Name'])).toBe('name');
  });

  it('finds the rows of a typed alias under the command the CLI ran, which the typed name alone never matches', async () => {
    const file = await transcript([
      row('system', 'turn-end', null, '2026-10-24T10:20:13.901Z', { subtype: 'turn_duration', durationMs: 178, isMeta: false }),
      ...renamed('turn-end'),
    ]);
    await expect(scanCommandResults(file, { ...renameQuery, name: 'name' })).resolves.toEqual({ items: [], done: false });
    await expect(scanCommandResults(file, { ...renameQuery, name: 'name', resolved: 'rename' })).resolves.toEqual({ anchor: 'rename', items: [RENAME_RESULT], done: true });
    const { waits, wait } = recorder();
    await expect(readCommandResults({ ...renameQuery, name: 'name', resolved: 'rename', file: async () => file, signal: new AbortController().signal, wait }))
      .resolves.toEqual({ anchor: 'rename', items: [RENAME_RESULT], done: true });
    expect(waits).toEqual([100]);
  });

  it('claims nothing that a read stopped half-way found: the row may belong to the newer run that stopped it', async () => {
    const file = await transcript([...BEFORE, ...COMPACTED]);
    const stopped = new AbortController(), anchored = vi.fn();
    const scan = await readCommandResults({ ...query, signal: stopped.signal, onAnchor: anchored, wait: async () => undefined,
      // Stops the read-back while the file is being read.
      file: async () => { setImmediate(() => stopped.abort()); return file; } });
    expect(scan).toEqual({ items: [], done: false });
    expect(anchored).not.toHaveBeenCalled();
  });
});
