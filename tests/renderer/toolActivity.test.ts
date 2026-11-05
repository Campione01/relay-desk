import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { createTranslator } from '../../src/renderer/i18n';
import { diffLines, diffStats } from '../../src/renderer/lib/diff';
import { formatElapsed, formatTokens, folderName } from '../../src/renderer/lib/format';
import { buildBlocks, groupDiffStats, summarizeActivity, summarizeTools, type ToolItem } from '../../src/renderer/lib/toolActivity';

const en = createTranslator('en');
const zh = createTranslator('zh-TW');

const tool = (id: string, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  toolUseId: `tu-${id}`,
  name,
  input: {},
  summary: `${name} ${id}`,
  status: 'done',
  ...extra,
});

describe('tool activity summary', () => {
  it('names the first three kinds of work and counts the rest (desktop copy pattern)', () => {
    const tools = [
      tool('1', 'Write'),
      tool('2', 'Bash'),
      tool('3', 'Bash'),
      tool('4', 'Bash'),
      tool('5', 'Read'),
      tool('6', 'Grep'),
      tool('7', 'Grep'),
      tool('8', 'Glob'),
      tool('9', 'WebFetch'),
      tool('10', 'Grep'),
      tool('11', 'WebSearch'),
    ];
    expect(summarizeTools(tools, en)).toBe('Created a file, ran 3 commands, read a file, and 6 more actions');
    expect(summarizeTools(tools, zh)).toBe('建立了 1 個檔案、執行了 3 個指令、讀取了 1 個檔案，以及其他 6 個動作');
  });

  it('reports failures and uses the single call summary for one tool', () => {
    expect(summarizeTools([tool('1', 'Bash'), tool('2', 'mcp__x__click', { status: 'error' }), tool('3', 'mcp__x__shot')], en)).toBe(
      'Ran a command, used 2 tools (1 failed)',
    );
    expect(summarizeTools([tool('1', 'Bash', { summary: 'Checked the SDK version' })], en)).toBe('Checked the SDK version');
  });

  it('groups consecutive tools, keeps thinking between them inside the group and feeds TodoWrite to the plan', () => {
    const items: TranscriptItem[] = [
      { kind: 'assistant', id: 'a1', text: 'start' },
      tool('t1', 'Bash'),
      { kind: 'thinking', id: 'th', text: 'hmm' },
      tool('t2', 'Read'),
      tool('plan', 'TodoWrite', { input: { todos: [{ content: 'one', status: 'in_progress' }] } }),
      { kind: 'assistant', id: 'a2', text: 'end' },
      { kind: 'user', id: 'u', text: 'next' },
    ];
    const { blocks, plan } = buildBlocks(items);
    expect(blocks.map((b) => (b.type === 'tools' ? `tools:${b.tools.map((t) => t.id).join('+')}` : b.item.id))).toEqual([
      'a1',
      'tools:t1+t2',
      'a2',
      'u',
    ]);
    const group = blocks[1];
    expect(group?.type === 'tools' && group.entries.map((e) => e.id)).toEqual(['t1', 'th', 't2']);
    expect(plan).toEqual({ toolId: 'plan', todos: [{ content: 'one', status: 'in_progress' }], stale: true });
  });

  it('folds thinking right before a tool run into that group, merged into one entry', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'go' },
      { kind: 'thinking', id: 'th1', text: 'first ' },
      { kind: 'thinking', id: 'th2', text: 'second' },
      tool('t1', 'Bash'),
      { kind: 'thinking', id: 'th3', text: 'between' },
      { kind: 'thinking', id: 'th4', text: 'still between' },
      tool('t2', 'Read'),
      { kind: 'assistant', id: 'a', text: 'done' },
    ];
    const { blocks } = buildBlocks(items);
    expect(blocks.map((b) => (b.type === 'tools' ? `tools:${b.tools.map((t) => t.id).join('+')}` : b.item.id))).toEqual([
      'u',
      'tools:t1+t2',
      'a',
    ]);
    const group = blocks[1]!;
    if (group.type !== 'tools') throw new Error('expected a tool group');
    expect(group.id).toBe('tools-t1');
    expect(group.entries.map((e) => e.id)).toEqual(['th1', 't1', 'th3', 't2']);
    expect(group.entries[0]).toEqual({ kind: 'thinking', id: 'th1', text: 'first\n\nsecond' });
    expect(group.entries[2]).toMatchObject({ kind: 'thinking', text: 'between\n\nstill between' });
  });

  it('merges any other run of thinking into one row and keeps it live while a part streams', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'go' },
      { kind: 'thinking', id: 'th1', text: 'one' },
      { kind: 'thinking', id: 'th2', text: '' },
      { kind: 'thinking', id: 'th3', text: 'three' },
      { kind: 'assistant', id: 'a', text: 'answer' },
      tool('t1', 'Bash'),
      { kind: 'assistant', id: 'a2', text: 'next' },
      { kind: 'thinking', id: 'th4', text: 'after' },
      { kind: 'thinking', id: 'th5', text: 'more', streaming: true },
    ];
    const { blocks } = buildBlocks(items);
    expect(blocks.map((b) => (b.type === 'tools' ? 'tools' : b.item.id))).toEqual(['u', 'th1', 'a', 'tools', 'a2', 'th4']);
    expect(blocks[1]).toEqual({ type: 'item', item: { kind: 'thinking', id: 'th1', text: 'one\n\nthree' } });
    expect(blocks[5]).toEqual({ type: 'item', item: { kind: 'thinking', id: 'th4', text: 'after\n\nmore', streaming: true } });
  });

  it('keeps thinking after the last call inside that line, so no row comes and goes between calls', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'go' },
      tool('t1', 'Bash'),
      { kind: 'thinking', id: 'th1', text: 'next' },
      { kind: 'thinking', id: 'th2', text: 'step', streaming: true },
    ];
    const { blocks } = buildBlocks(items);
    expect(blocks.map((b) => (b.type === 'tools' ? `tools:${b.entries.map((e) => e.id).join('+')}` : b.item.id))).toEqual([
      'u',
      'tools:t1+th1',
    ]);
    const group = blocks[1]!;
    if (group.type !== 'tools') throw new Error('expected a tool group');
    expect(group.entries[1]).toEqual({ kind: 'thinking', id: 'th1', text: 'next\n\nstep', streaming: true });
    expect(group.tools.map((t) => t.id)).toEqual(['t1']);
    // Once the reply text follows, that thinking is a row of its own again, as in a finished turn.
    const answered = buildBlocks([...items, { kind: 'assistant', id: 'a', text: 'done' }]).blocks;
    expect(answered.map((b) => (b.type === 'tools' ? `tools:${b.entries.map((e) => e.id).join('+')}` : b.item.id))).toEqual([
      'u',
      'tools:t1',
      'th1',
      'a',
    ]);
  });

  it('folds background-task notes into the activity line next to them, or into a line of their own', () => {
    const note = (id: string, status: string): TranscriptItem => ({
      kind: 'system',
      id,
      text: `Background task ${status}: x`,
      level: status === 'failed' ? 'warn' : 'info',
      tasks: [{ status, summary: 'x' }],
    });
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u', text: 'go' },
      tool('t1', 'Bash'),
      note('n1', 'completed'),
      { kind: 'thinking', id: 'th', text: 'hmm' },
      tool('t2', 'Read'),
      { kind: 'assistant', id: 'a', text: 'done' },
      note('n2', 'failed'),
      note('n3', 'completed'),
      { kind: 'system', id: 's', text: 'Interrupted', level: 'info' },
    ];
    const { blocks } = buildBlocks(items);
    expect(blocks.map((b) => (b.type === 'tools' ? `tools:${b.entries.map((e) => e.id).join('+')}` : b.item.id))).toEqual([
      'u',
      'tools:t1+n1+th+t2',
      'a',
      'tools:n2+n3',
      's',
    ]);
    const [, first, , second] = blocks;
    if (first?.type !== 'tools' || second?.type !== 'tools') throw new Error('expected two activity lines');
    expect(first.id).toBe('tools-t1');
    expect(second.id).toBe('tools-n2');
    const t = createTranslator('en');
    expect(summarizeActivity(first.tools, first.notes, t)).toBe('Ran a command, read a file · a background task finished');
    expect(summarizeActivity(second.tools, second.notes, t)).toBe('2 background tasks finished (1 failed)');
    expect(summarizeActivity([], [first.notes[0]!], t)).toBe('A background task finished');
    expect(summarizeActivity(first.tools, [], t)).toBe(summarizeTools(first.tools, t));
    expect(summarizeActivity(second.tools, second.notes, createTranslator('zh-TW'))).toBe('2 個背景工作結束（1 個失敗）');
  });

  it('diff chip counts changed lines of finished edits only', () => {
    const edit = tool('e', 'Edit', { input: { file_path: 'a.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc\nd' } });
    const write = tool('w', 'Write', { input: { file_path: 'b.ts', content: 'x\ny\n' } });
    const failed = tool('f', 'Edit', { status: 'error', input: { file_path: 'c.ts', old_string: 'q', new_string: 'r' } });
    expect(groupDiffStats([edit, write, failed])).toEqual({ added: 4, removed: 1 });
    expect(groupDiffStats([tool('b', 'Bash')])).toBeNull();
  });
});

describe('line diff', () => {
  it('marks removed lines before added ones and keeps context', () => {
    const lines = diffLines('one\ntwo\nthree', 'one\n2\nthree');
    expect(lines.map((l) => `${l.type}:${l.text}`)).toEqual(['context:one', 'del:two', 'add:2', 'context:three']);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });
});

describe('formatting', () => {
  it('formats elapsed time, tokens and folder labels like the desktop', () => {
    expect(formatElapsed(592_000)).toBe('9m 52s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatTokens(37_600)).toBe('37.6k');
    expect(formatTokens(103_000)).toBe('103k');
    expect(formatTokens(550)).toBe('550');
    expect(folderName('D:\\')).toBe('D:');
    expect(folderName('D:\\demos\\relay-desk\\')).toBe('relay-desk');
  });
});
