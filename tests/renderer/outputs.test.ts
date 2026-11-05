import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { outputKind, outputsOf } from '../../src/renderer/lib/outputs';
import type { ToolItem } from '../../src/renderer/lib/toolActivity';

const write = (id: string, path: unknown, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  toolUseId: `tu-${id}`,
  name: 'Write',
  input: { file_path: path, content: 'x' },
  summary: `Wrote ${String(path)}`,
  status: 'done',
  ...extra,
});

const paths = (items: TranscriptItem[]): string[] => outputsOf(items).map((output) => output.path);

describe('outputsOf (desktop Outputs card)', () => {
  it('lists written files newest first by transcript position, with name and kind', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'plan the moves' },
      write('1', 'E:\\work\\plan_m2.py'),
      write('2', 'E:\\work\\plan_m1.py'),
      { kind: 'assistant', id: 'a1', text: 'next' },
      write('3', 'E:\\work\\plan_m3.py'),
      write('4', 'E:\\work\\scripts\\run_core_task.ps1'),
      write('5', 'E:/work/plan_pickup_2333.py'),
    ];
    expect(outputsOf(items)).toEqual([
      { path: 'E:/work/plan_pickup_2333.py', name: 'plan_pickup_2333.py', kind: 'code' },
      { path: 'E:\\work\\scripts\\run_core_task.ps1', name: 'run_core_task.ps1', kind: 'file' },
      { path: 'E:\\work\\plan_m3.py', name: 'plan_m3.py', kind: 'code' },
      { path: 'E:\\work\\plan_m1.py', name: 'plan_m1.py', kind: 'code' },
      { path: 'E:\\work\\plan_m2.py', name: 'plan_m2.py', kind: 'code' },
    ]);
  });

  it('keeps one row per file across slash styles and case; a later write moves it to the top, as the newest call wrote it', () => {
    const items: TranscriptItem[] = [
      write('1', 'D:\\Repo\\Notes.md'),
      write('2', 'D:\\repo\\b.ts'),
      write('3', 'd:/repo/NOTES.md'),
    ];
    expect(paths(items)).toEqual(['d:/repo/NOTES.md', 'D:\\repo\\b.ts']);
    expect(paths([...items, write('4', 'D:/REPO/B.TS')])).toEqual(['D:/REPO/B.TS', 'd:/repo/NOTES.md']);
  });

  it('skips failed, denied and running calls, other tools and inputs without a path', () => {
    const items: TranscriptItem[] = [
      write('ok', 'D:\\r\\kept.txt'),
      write('err', 'D:\\r\\error.txt', { status: 'error' }),
      write('den', 'D:\\r\\denied.txt', { status: 'denied' }),
      write('run', 'D:\\r\\running.txt', { status: 'running' }),
      write('empty', '  '),
      write('num', 42),
      write('none', undefined, { input: null }),
      { ...write('edit', 'D:\\r\\edited.txt'), name: 'Edit' },
      { ...write('read', 'D:\\r\\read.txt'), name: 'Read' },
    ];
    expect(paths(items)).toEqual(['D:\\r\\kept.txt']);
  });

  it('a failed rewrite does not move a file that an earlier call wrote', () => {
    const items: TranscriptItem[] = [
      write('1', 'D:\\r\\a.py'),
      write('2', 'D:\\r\\b.py'),
      write('3', 'D:\\r\\a.py', { status: 'error' }),
    ];
    expect(paths(items)).toEqual(['D:\\r\\b.py', 'D:\\r\\a.py']);
  });

  it('includes files that subagents wrote', () => {
    const items: TranscriptItem[] = [
      write('main', 'D:\\r\\main.py'),
      write('sub', 'D:\\r\\from_agent.py', { parentToolUseId: 'tu-agent' }),
    ];
    expect(paths(items)).toEqual(['D:\\r\\from_agent.py', 'D:\\r\\main.py']);
  });

  it('gives programming languages the code icon and everything else, shell scripts included, the file icon', () => {
    for (const name of ['a.py', 'b.TSX', 'c.mjs', 'd.go', 'e.rs', 'f.cpp', 'g.h', 'h.cs', 'i.r', 'j.sql', 'k.html', 'l.scss', 'm.vue', 'n.dart']) {
      expect([name, outputKind(name)]).toEqual([name, 'code']);
    }
    for (const name of ['run.ps1', 'run.sh', 'run.bat', 'run.cmd', 'README.md', 'notes.txt', 'data.json', 'ci.yml', 'Makefile', '.py', 'archive.py.bak']) {
      expect([name, outputKind(name)]).toEqual([name, 'file']);
    }
    expect(outputsOf([write('1', '/home/me/tool.Py')])[0]).toMatchObject({ name: 'tool.Py', kind: 'code' });
  });
});
