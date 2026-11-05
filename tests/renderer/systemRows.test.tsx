import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { createTranslator } from '../../src/renderer/i18n';
import { taskLine } from '../../src/renderer/components/transcript/Rows';
import { renderApp } from './helpers';

const SESSION = {
  sessionId: '61111111-2222-4333-8444-555555555555',
  title: 'System rows fixture',
  cwd: 'D:\\codes\\fixture',
  lastModified: Date.UTC(2026, 9, 18),
};

const COMMAND =
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\\work\\scripts\\gm.ps1 -Tasks "verifyPhase3Contract,verifyPhase4Contract,verifyPhase5Contract,verifyFullClosureContract"';
const USAGE_TEXT = 'LONG You are currently using your subscription\nCurrent session: 57% used\nCurrent week (all models): 16% used\nLast 24h · 3405 requests';

const ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: '/usage' },
  { kind: 'system', id: 's1', text: USAGE_TEXT, level: 'info' },
  { kind: 'system', id: 's2', text: 'Interrupted', level: 'info' },
  {
    kind: 'system',
    id: 's3',
    text: `Background task completed: ${COMMAND}\nBackground task failed: npm test exited 1`,
    level: 'warn',
    tasks: [
      { status: 'completed', summary: COMMAND },
      { status: 'failed', summary: 'npm test exited 1' },
    ],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

async function openFixture(language: 'en' | 'zh-TW' = 'en') {
  // jsdom has no layout: the folded usage text reports more height than its three-line box.
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('rd-sysrow__text') && this.textContent?.startsWith('LONG') ? 120 : 20;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('rd-sysrow__text') ? (this.hasAttribute('data-folded') ? 60 : 120) : 20;
  });
  const rendered = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: ITEMS }, settings: { language } });
  await rendered.user.click(screen.getByRole('button', { name: SESSION.title }));
  await screen.findByText(/You are currently using|^LONG/);
  return rendered;
}

/** The activity line that holds the background tasks, expanded. */
async function openTasks({ user }: Awaited<ReturnType<typeof renderApp>>, summary: string | RegExp): Promise<HTMLElement> {
  const group = screen.getAllByTestId('tool-group').find((g) => within(g).queryByRole('button', { name: summary }))!;
  await user.click(within(group).getByRole('button', { name: summary }));
  return group;
}

describe('system rows', () => {
  it('names background tasks in the UI language, one line per task', () => {
    const en = createTranslator('en');
    expect(taskLine({ status: 'completed', summary: 'npm test' }, en)).toBe('Background task completed: npm test');
    expect(taskLine({ status: 'failed', summary: 'npm test' }, en)).toBe('Background task failed: npm test');
    expect(taskLine({ status: 'stopped', summary: '' }, en)).toBe('Background task stopped');
    expect(taskLine({ status: 'killed', summary: 'x' }, en)).toBe('Background task killed: x');
    const zh = createTranslator('zh-TW');
    expect(taskLine({ status: 'completed', summary: 'npm test' }, zh)).toBe('背景工作完成：npm test');
    expect(taskLine({ status: 'killed', summary: '' }, zh)).toBe('背景工作：killed');
  });

  it('folds background tasks into the activity line; expanded, each is one truncated line with the whole line in its tooltip', async () => {
    const rendered = await openFixture();
    expect(screen.queryAllByTestId('task-line')).toHaveLength(0);
    const group = await openTasks(rendered, '2 background tasks finished (1 failed)');
    expect(within(group).getAllByTestId('task-note-row')).toHaveLength(1);
    const lines = within(group).getAllByTestId('task-line');
    expect(lines.map((line) => line.textContent)).toEqual([`Background task completed: ${COMMAND}`, 'Background task failed: npm test exited 1']);
    expect(lines[0]).toHaveClass('rd-sysrow__task');
    expect(lines[0]).toHaveAttribute('data-tip', `Background task completed: ${COMMAND}`);
    expect(lines[0]!.closest('.rd-sysrow')).toHaveClass('rd-sysrow--warn');
    expect(screen.queryByText(/Background task completed: .*\nBackground task failed/)).not.toBeInTheDocument();
  });

  it('folds command output past three lines behind Show more, and leaves short notes alone', async () => {
    const { user } = await openFixture();
    const text = document.querySelector<HTMLElement>('.rd-sysrow__text[data-folded]')!;
    expect(text.textContent).toBe(USAGE_TEXT);
    const row = text.closest<HTMLElement>('.rd-sysrow')!;
    const more = within(row).getByRole('button', { name: 'Show more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(text).not.toHaveAttribute('data-folded');
    const less = within(row).getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    await user.click(less);
    expect(text).toHaveAttribute('data-folded', 'true');
    const short = screen.getByText('Interrupted').closest<HTMLElement>('.rd-sysrow')!;
    expect(within(short).queryByRole('button')).not.toBeInTheDocument();
  });

  it('uses the Chinese labels in a Chinese UI', async () => {
    const rendered = await openFixture('zh-TW');
    const group = await openTasks(rendered, '2 個背景工作結束（1 個失敗）');
    expect(within(group).getAllByTestId('task-line')[1]).toHaveTextContent('背景工作失敗：npm test exited 1');
    expect(screen.getByRole('button', { name: '展開' })).toBeInTheDocument();
  });
});
