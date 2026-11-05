import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { NativeTranscriptMapper, nativeAgents, nativeCommandOutput, nativeContext, nativePlanUsage } from '../../src/main/native/mapping';
import { createImageStore, storeImageBlocks } from '../../src/main/engine/images';

function setup() {
  const items: TranscriptItem[] = [];
  const deltas: Array<{ id: string; text: string }> = [];
  const mapper = new NativeTranscriptMapper((item) => items.push(item), (id, text) => deltas.push({ id, text }), 'D:\\synthetic', () => 100);
  return { mapper, items, deltas };
}
const append = (uuid: string, type: string, content: unknown[], extra = {}) => ({ uuid, message: { type, content }, ...extra });

describe('native transcript projection', () => {
  it('uses the existing task-notice presentation without relabelling a real user message', () => {
    const raw = '<task-notification><task-id>one</task-id><status>completed</status><summary>Review finished</summary><diagnostics>internal detail</diagnostics></task-notification>';
    const h = setup();
    h.mapper.append(append('native-notice', 'user', [{ type: 'text', text: raw }], { door: 'prompt', origin: { kind: 'task-notification' } }));
    expect(h.items).toEqual([{ kind: 'system', id: 'native-notice', text: 'Background task completed: Review finished', level: 'info', tasks: [{ status: 'completed', summary: 'Review finished' }] }]);
    h.mapper.registerSend('human', raw);
    h.mapper.append(append('human-echo', 'user', [{ type: 'text', text: raw }], { door: 'prompt' }));
    expect(h.items.at(-1)).toEqual({ kind: 'user', id: 'human', text: raw });
  });

  it('retains actual native tool image bytes in session-scoped references for thumbnails and the viewer', () => {
    const images = createImageStore();
    const content = [{ type: 'tool_result', tool_use_id: 'read-pdf', content: [
      { type: 'text', text: 'PDF page 1' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'cGFnZQ==' } },
    ] }];
    const original = JSON.stringify(content);
    const keys: string[] = [];
    for (const sessionId of ['session-one', 'session-two']) {
      const items: TranscriptItem[] = [];
      const mapper = new NativeTranscriptMapper(item => items.push(item), () => {}, 'D:\\synthetic', () => 100,
        { store: (blocks, prefix) => storeImageBlocks(blocks, prefix, images), prefix: () => sessionId });
      mapper.tool({ id: 'read-pdf', name: 'Read', input: { file_path: 'page.pdf', pages: '1' } });
      mapper.append(append('result-id', 'user', content, { door: 'tool-result' }));
      const item = items.at(-1);
      expect(item).toMatchObject({ kind: 'tool', images: 1, imageRefs: [{ mediaType: 'image/jpeg' }] });
      if (item?.kind !== 'tool' || !item.imageRefs?.[0]) throw new Error('Native image reference missing');
      keys.push(item.imageRefs[0].key);
      expect(images.get(item.imageRefs[0].key)).toBe('data:image/jpeg;base64,cGFnZQ==');
      const count = items.length;
      mapper.append(append('result-id', 'user', content, { door: 'tool-result' }));
      expect(items).toHaveLength(count);
    }
    expect(keys[0]).not.toBe(keys[1]);
    expect(JSON.stringify(content)).toBe(original);
  });

  it('does not invent compaction for the real empty turn_duration notice', () => {
    const { mapper, items } = setup();
    mapper.append({ uuid: 'duration', door: 'notice', message: { type: 'system', name: 'turn_duration', content: [] } });
    mapper.append({ uuid: 'unknown', door: 'notice', message: { type: 'system', name: 'future_notice', content: [] } });
    expect(items).toEqual([]);
    mapper.append({ uuid: 'compacted', door: 'compaction', message: { type: 'system', content: [] } });
    expect(items).toEqual([{ kind: 'system', id: 'compacted', text: 'Conversation compacted', level: 'info' }]);
  });

  it('only describes a write as completed after the native tool result succeeds', () => {
    const { mapper, items } = setup();
    mapper.tool({ id: 'write-ok', name: 'Write', input: { file_path: 'okay.txt', content: 'one' } });
    expect(items.at(-1)).toMatchObject({ status: 'running', summary: expect.stringMatching(/^Write request:/) });
    mapper.append(append('done', 'user', [{ type: 'tool_result', tool_use_id: 'write-ok', content: 'success' }], { door: 'tool-result' }));
    expect(items.at(-1)).toMatchObject({ status: 'done', summary: expect.stringMatching(/^Wrote /) });
    mapper.tool({ id: 'write-no', name: 'Write', input: { file_path: 'never.txt', content: 'one' } });
    mapper.append(append('error', 'user', [{ type: 'tool_result', tool_use_id: 'write-no', content: 'interrupted', is_error: true }], { door: 'tool-result' }));
    expect(items.at(-1)).toMatchObject({ status: 'error', summary: expect.stringMatching(/^Write request:/) });
  });

  it('keeps thinking and assistant identities separate and reconciles final native UUIDs', () => {
    const { mapper, items, deltas } = setup();
    mapper.beginTurn('t1');
    mapper.step({ turnId: 't1', stepId: 's1', chunk: { kind: 'thinking', index: 0, text: 'Reason' } });
    mapper.step({ turnId: 't1', stepId: 's1', chunk: { kind: 'text', index: 1, text: 'Hel' } });
    mapper.step({ turnId: 't1', stepId: 's1', chunk: { kind: 'text', index: 1, text: 'lo' } });
    mapper.append(append('native-row', 'assistant', [{ type: 'thinking', thinking: 'Reason', signature: 's' }, { type: 'text', text: 'Hello' }]));
    mapper.append(append('native-row', 'assistant', [{ type: 'text', text: 'Hello' }]));
    expect(deltas).toEqual([{ id: 'native:t1:s1:main:1:assistant', text: 'lo' }]);
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
    expect(items.at(-1)).toEqual({ kind: 'assistant', id: 'native:t1:s1:main:1:assistant', text: 'Hello' });
  });

  it('does not content-dedupe identical answers across distinct turns', () => {
    const { mapper, items } = setup();
    for (const turnId of ['t1', 't2']) {
      mapper.beginTurn(turnId);
      mapper.step({ turnId, stepId: 0, chunk: { kind: 'text', index: 0, text: 'Same' } });
      mapper.append(append(`row-${turnId}`, 'assistant', [{ type: 'text', text: 'Same' }]));
    }
    expect(new Set(items.map((item) => item.id)).size).toBe(2);
  });

  it('ignores subagent text but maps streamed partial tool arguments and final results', () => {
    const { mapper, items } = setup();
    mapper.step({ turnId: 't', agentId: 'a', stepId: 0, chunk: { kind: 'text', index: 0, text: 'child' } });
    mapper.step({ turnId: 't', stepId: 0, chunk: { kind: 'tool', index: 1, id: 'tu1', name: 'Read' } });
    mapper.step({ turnId: 't', stepId: 0, chunk: { kind: 'input', index: 1, json: '{"file_path":' } });
    mapper.step({ turnId: 't', stepId: 0, chunk: { kind: 'input', index: 1, json: '"a.ts"}' } });
    mapper.append(append('tool-row', 'user', [{ type: 'tool_result', tool_use_id: 'tu1', content: 'hello' }], { door: 'tool-result' }));
    expect(items.filter((item) => item.kind === 'assistant')).toHaveLength(0);
    expect(items.at(-1)).toMatchObject({ kind: 'tool', toolUseId: 'tu1', input: { file_path: 'a.ts' }, status: 'done', output: 'hello' });
  });

  it('marks broker-denied tool results, reconciles queue echoes, and does not display meta injections', () => {
    const { mapper, items } = setup();
    mapper.registerSend('local', 'hello');
    mapper.acceptSend('local', true);
    mapper.append(append('native-human', 'user', [{ type: 'text', text: 'hello' }], { door: 'prompt' }));
    mapper.append(append('meta', 'user', [{ type: 'text', text: 'hidden' }], { door: 'hook-context' }));
    mapper.tool({ id: 'tu', name: 'Write', input: {} });
    mapper.markDenied('tu');
    mapper.append(append('deny-row', 'user', [{ type: 'tool_result', tool_use_id: 'tu', content: 'No', is_error: true }]));
    expect(items.filter((item) => item.kind === 'user')).toEqual([
      { kind: 'user', id: 'local', text: 'hello', queued: true }, { kind: 'user', id: 'local', text: 'hello' },
    ]);
    expect(items.at(-1)).toMatchObject({ kind: 'tool', status: 'denied' });
  });

  it('emits one result per main turn using actual per-turn counts and closes partial streams', () => {
    const { mapper, items } = setup();
    mapper.step({ turnId: 't', chunk: { kind: 'text', index: 0, text: 'partial' } });
    const data = { turnId: 't', reason: 'aborted', durationMs: 50, usage: { input_tokens: 2, cache_read_input_tokens: 10, cache_creation_input_tokens: 3, output_tokens: 4 } };
    mapper.complete({ ...data, agentId: 'child' });
    mapper.complete(data);
    mapper.complete(data);
    expect(items.filter((item) => item.kind === 'result')).toEqual([
      { kind: 'result', id: 'native-result:t', durationMs: 50, inputTokens: 15, outputTokens: 4, isError: false, text: 'Interrupted' },
    ]);
    expect(items.at(-2)).toMatchObject({ kind: 'assistant', text: 'partial' });
    expect(items.at(-2)).not.toHaveProperty('streaming');
  });
});

describe('native stream-only tools', () => {
  it('settles streamed tool_use blocks that never completed when their main turn ends, leaving appended tools alone', () => {
    const { mapper, items } = setup();
    mapper.step({ turnId: 't', stepId: 0, chunk: { kind: 'tool', index: 0, id: 'phantom', name: 'Read' } });
    mapper.step({ turnId: 't', stepId: 0, chunk: { kind: 'input', index: 0, json: '{"file_pa' } });
    mapper.step({ turnId: 't', stepId: 1, chunk: { kind: 'tool', index: 0, id: 'recorded', name: 'Bash' } });
    mapper.append(append('assistant-row', 'assistant', [{ type: 'tool_use', id: 'recorded', name: 'Bash', input: { command: 'sleep 1' } }], { turnId: 't' }));
    mapper.step({ turnId: 't', agentId: 'child', stepId: 0, parentToolUseId: 'recorded', chunk: { kind: 'tool', index: 0, id: 'child-tool', name: 'Grep' } });
    mapper.step({ turnId: 'later', stepId: 0, chunk: { kind: 'tool', index: 0, id: 'other-turn', name: 'Glob' } });
    mapper.complete({ turnId: 't', reason: 'aborted' });
    const last = (id: string) => items.filter((item) => item.id === id).at(-1);
    expect(last('phantom')).toMatchObject({ kind: 'tool', status: 'error', output: 'Interrupted', startedAt: 100 });
    expect(items.findIndex((item) => item.id === 'native-result:t')).toBeGreaterThan(items.findLastIndex((item) => item.id === 'phantom'));
    for (const id of ['recorded', 'child-tool', 'other-turn']) expect(last(id)).toMatchObject({ status: 'running' });
    mapper.step({ turnId: 't', stepId: 0, chunk: { kind: 'input', index: 0, json: 'th":"a.ts"}' } });
    expect(last('phantom')).toMatchObject({ status: 'error' });
    mapper.finalize();
    expect(last('child-tool')).toMatchObject({ status: 'error', output: 'Interrupted' });
    expect(last('other-turn')).toMatchObject({ status: 'error', output: 'Interrupted' });
    expect(last('recorded')).toMatchObject({ status: 'running' });
    const count = items.length; mapper.finalize(); expect(items).toHaveLength(count);
  });
});

describe('native local command output', () => {
  const caveat = { type: 'text', text: '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>' };
  const echo = { type: 'text', text: '<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args></command-args>' };
  const rows = (prefix: string, output: { type: 'user' | 'system'; text: string }) => [
    { uuid: `${prefix}-caveat`, door: 'command', message: { type: 'user', role: 'user', isMeta: true, content: [caveat] } },
    { uuid: `${prefix}-echo`, door: 'command', message: { type: 'user', role: 'user', content: [echo] } },
    { uuid: `${prefix}-out`, door: 'command', message: { type: output.type, role: 'user', ...(output.type === 'system' ? { name: 'local_command' } : {}), content: [{ type: 'text', text: output.text }] } },
  ];

  it('drops command rows outside a command, which come from Relay controls', () => {
    const { mapper, items } = setup();
    for (const row of [...rows('control', { type: 'system', text: '<local-command-stdout>native-capability-contr…: {}</local-command-stdout>' }),
      ...rows('effort', { type: 'user', text: '<local-command-stdout>Set effort level to max</local-command-stdout>' })]) mapper.append(row);
    expect(items).toEqual([]); expect(mapper.endCommand()).toBe(false);
  });

  it('shows only the cleaned output rows of the running command and reports that it did', () => {
    const { mapper, items } = setup();
    mapper.beginCommand();
    for (const row of rows('system', { type: 'system', text: '<local-command-stdout>\u001b[1mModel set\u001b[22m</local-command-stdout>' })) mapper.append(row);
    expect(items).toEqual([{ kind: 'system', id: 'system-out', text: 'Model set', level: 'info' }]);
    expect(mapper.endCommand()).toBe(true); expect(mapper.endCommand()).toBe(false);
    mapper.beginCommand();
    for (const row of rows('user', { type: 'user', text: '<local-command-stdout>Enabled plan mode</local-command-stdout>' })) mapper.append(row);
    mapper.append({ uuid: 'child-out', agentId: 'a', door: 'command', message: { type: 'user', content: [{ type: 'text', text: '<local-command-stdout>child</local-command-stdout>' }] } });
    expect(mapper.endCommand()).toBe(true);
    expect(items.at(-1)).toEqual({ kind: 'system', id: 'user-out', text: 'Enabled plan mode', level: 'info' });
    mapper.beginCommand();
    for (const row of rows('silent', { type: 'user', text: '<local-command-stdout>  </local-command-stdout>' })) mapper.append(row);
    expect(mapper.endCommand()).toBe(false); expect(items).toHaveLength(2);
  });

  it("shows the running command's echo before its first output row when that row comes before command.run answers", () => {
    const { mapper, items } = setup();
    mapper.registerSend('send-1', '/rename synthetic');
    mapper.beginCommand('send-1');
    for (const row of rows('rename', { type: 'system', text: '<local-command-stdout>Session renamed to: synthetic</local-command-stdout>' })) mapper.append(row);
    mapper.acceptSend('send-1', false);
    expect(mapper.endCommand()).toBe(true);
    expect(items).toEqual([{ kind: 'user', id: 'send-1', text: '/rename synthetic' },
      { kind: 'system', id: 'rename-out', text: 'Session renamed to: synthetic', level: 'info' }]);
  });

  it('cleans a command result text like a transcript row and gives nothing for empty output', () => {
    expect(nativeCommandOutput('\u001b[32mSet effort level to xhigh\u001b[39m\n', 'native-command:one'))
      .toEqual({ kind: 'system', id: 'native-command:one', text: 'Set effort level to xhigh', level: 'info' });
    expect(nativeCommandOutput('<local-command-stdout>Wrapped</local-command-stdout>', 'native-command:two'))
      .toEqual({ kind: 'system', id: 'native-command:two', text: 'Wrapped', level: 'info' });
    expect(nativeCommandOutput('', 'native-command:three')).toBeUndefined();
    expect(nativeCommandOutput(' \n', 'native-command:four')).toBeUndefined();
    expect(nativeCommandOutput('x'.repeat(5000), 'native-command:five')).toMatchObject({ text: expect.stringContaining('characters omitted') });
  });

  it('shows a command error row of the running command as a warning', () => {
    const { mapper, items } = setup();
    mapper.beginCommand();
    for (const row of rows('error', { type: 'user', text: '<local-command-stderr>\u001b[31mNo such server: beta\u001b[39m</local-command-stderr>' })) mapper.append(row);
    expect(items).toEqual([{ kind: 'system', id: 'error-out', text: 'No such server: beta', level: 'warn' }]);
    expect(mapper.endCommand()).toBe(true);
  });

  it('never prints the body of a live compaction summary, only the line history shows for it', () => {
    const { mapper, items } = setup();
    const body = 'This session is being continued from a previous conversation. Summary: PRIVATE SUMMARY BODY';
    mapper.append({ uuid: 'summary', door: 'compaction', message: { type: 'user', role: 'user', content: [{ type: 'text', text: body }] } });
    mapper.append({ uuid: 'boundary', door: 'compaction', message: { type: 'system', name: 'compact_boundary', content: [{ type: 'text', text: body }] } });
    expect(items).toEqual([
      { kind: 'system', id: 'summary', text: 'Conversation compacted', level: 'info' },
      { kind: 'system', id: 'boundary', text: 'Conversation compacted', level: 'info' },
    ]);
    expect(JSON.stringify(items)).not.toContain('PRIVATE SUMMARY BODY');
  });

  it('keeps compaction and other system rows as before while a command runs', () => {
    const { mapper, items } = setup();
    mapper.beginCommand();
    mapper.append({ uuid: 'boundary', door: 'notice', message: { type: 'system', name: 'compact_boundary', content: [] } });
    mapper.append({ uuid: 'notice', door: 'notice', message: { type: 'system', name: 'informational', content: [{ type: 'text', text: 'Hooks reloaded' }] } });
    mapper.append({ uuid: 'duration', door: 'notice', message: { type: 'system', name: 'turn_duration', content: [] } });
    expect(items).toEqual([
      { kind: 'system', id: 'boundary', text: 'Conversation compacted', level: 'info' },
      { kind: 'system', id: 'notice', text: 'Hooks reloaded', level: 'info' },
    ]);
    expect(mapper.endCommand()).toBe(false);
  });
});

describe('native read-only metadata mapping', () => {
  it('uses the actual breakdown window and categories, preserving unknown/missing readings', () => {
    expect(nativeContext({ context: { window: 1000 } })).toBeNull();
    expect(nativeContext({ context: { window: 1000, tokens: 100, breakdown: {
      totalTokens: 200, maxTokens: 800, percentage: 25, model: 'native-model',
      categories: [{ name: 'Messages', tokens: 200, kind: 'used' }, { name: 'Unknown', tokens: 1, kind: 'invented' }],
      memoryFiles: [{ path: 'D:\\fake\\CLAUDE.md', type: 'project', tokens: 20 }],
    } } })).toEqual({ usedTokens: 200, maxTokens: 800, percent: 25, model: 'native-model',
      categories: [{ name: 'Messages', tokens: 200, kind: 'used' }], memoryFiles: [{ path: 'D:\\fake\\CLAUDE.md', type: 'project', tokens: 20 }] });
  });
  it('does not interpret an empty rate-limit array as free quota or an API-key account', () => {
    expect(nativePlanUsage({ rateLimits: [] }, 'default', 1)).toBeNull();
    expect(nativePlanUsage({ rateLimits: [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-01-01T00:00:00Z' }] }, 'default', 1))
      .toMatchObject({ available: true, windows: [{ id: 'five_hour', percent: 23.5, resetsAt: Date.parse('2026-01-01T00:00:00Z') }] });
  });
  it('preserves native task states without fabricated timestamps or workflow claims', () => {
    expect(nativeAgents([{ id: 'a', status: 'killed', description: 'audit', type: 'Explore', parentId: 'p' }]))
      .toEqual([{ taskId: 'a', kind: 'agent', taskType: 'local_agent', status: 'stopped', description: 'audit', subagentType: 'Explore', parentTaskId: 'p' }]);
    expect(() => nativeAgents({})).toThrow('no list');
  });
});
