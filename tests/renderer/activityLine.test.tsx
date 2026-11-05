import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { createTranslator } from '../../src/renderer/i18n';
import { inflectDescription, summarizeTools, toolTitle, type ToolItem } from '../../src/renderer/lib/toolActivity';
import { STEP_DWELL_MS } from '../../src/renderer/components/transcript/Transcript';
import { renderApp, takeOverMain } from './helpers';

function tool(id: string, name: string, input: unknown, extra: Partial<ToolItem> = {}): ToolItem {
  return { kind: 'tool', id, toolUseId: id, name, input, summary: `Used ${name}`, status: 'done', ...extra };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop-style activity titles', () => {
  it('turns a command description into its running and finished forms', () => {
    expect(inflectDescription('Render the chart', true)).toBe('Rendering the chart');
    expect(inflectDescription('Render the chart', false)).toBe('Rendered the chart');
    expect(inflectDescription('List installed fonts (read-only)', false)).toBe('Listed installed fonts (read-only)');
    expect(inflectDescription('Run the tests', true)).toBe('Running the tests');
    expect(inflectDescription('Run the tests', false)).toBe('Ran the tests');
    expect(inflectDescription('Copy files', false)).toBe('Copied files');
    expect(inflectDescription('Copy files', true)).toBe('Copying files');
    expect(inflectDescription('Make a zip', true)).toBe('Making a zip');
    expect(inflectDescription('Remove the folder', true)).toBe('Removing the folder');
    expect(inflectDescription('Remove the folder', false)).toBe('Removed the folder');
    expect(inflectDescription('Free the port', true)).toBe('Freeing the port');
    expect(inflectDescription('show status', false)).toBe('showed status');
    // A first word that is not a known verb stays as written.
    expect(inflectDescription('Git log for recent commits', false)).toBe('Git log for recent commits');
    expect(inflectDescription('  ', false)).toBe('');
  });

  it('titles a call by its description, a read by the file name, anything else by its summary', () => {
    const bash = tool('b', 'Bash', { command: 'node x.js', description: 'Render the chart' }, { summary: 'Ran `node x.js`' });
    expect(toolTitle(bash)).toBe('Rendered the chart');
    expect(toolTitle(bash, true)).toBe('Rendering the chart');
    expect(toolTitle(tool('n', 'Bash', { command: 'ls' }, { summary: 'Ran `ls`' }), true)).toBe('Running `ls`');
    expect(toolTitle(tool('r', 'Read', { file_path: 'D:\\work\\shots\\zoom.png' }, { summary: 'Read shots\\zoom.png' }))).toBe('Read zoom.png');
    expect(toolTitle(tool('r2', 'Read', { file_path: '/tmp/a/b.ts' }), true)).toBe('Reading b.ts');
    expect(toolTitle(tool('e', 'Edit', { file_path: 'a.ts' }, { summary: 'Edited a.ts (+1 −1)' }), true)).toBe('Editing a.ts (+1 −1)');
    expect(toolTitle(tool('m', 'mcp__x__y', {}, { summary: 'x/y' }), true)).toBe('x/y');
  });

  it('names the file of a category with one call in a group line', () => {
    const t = createTranslator('en');
    const tools = [
      tool('b1', 'Bash', { command: 'a' }),
      tool('b2', 'Bash', { command: 'b' }),
      tool('r', 'Read', { file_path: 'D:\\x\\zoom.png' }),
    ];
    expect(summarizeTools(tools, t)).toBe('Ran 2 commands, read zoom.png');
    expect(summarizeTools([...tools, tool('r2', 'Read', { file_path: 'D:\\x\\b.png' })], t)).toBe('Ran 2 commands, read 2 files');
    expect(summarizeTools(tools, createTranslator('zh-TW'))).toBe('執行了 2 個指令、讀取了 zoom.png');
  });

  it('shows a running call as dots, its running title and the group time; thinking alone keeps the status line', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const start = Date.now();
    const emit = (event: Parameters<typeof rendered.api.mock.emitEngine>[0]): void => act(() => rendered.api.mock.emitEngine(event));
    emit({ type: 'state', handleId, state: 'running', startedAt: start, tokens: 6900 });
    expect(screen.getByTestId('status-line')).toHaveTextContent('0s · 6.9k tokens · Thinking');
    const running: TranscriptItem = {
      kind: 'tool',
      id: 'live-1',
      toolUseId: 'live-1',
      name: 'Bash',
      input: { command: 'node render.js', description: 'Render the chart' },
      summary: 'Ran `node render.js`',
      status: 'running',
      startedAt: start,
    };
    emit({ type: 'item', handleId, item: running });
    const line = screen.getAllByTestId('tool-group').at(-1)!;
    const head = within(line).getByRole('button');
    expect(head).toHaveTextContent('Rendering the chart');
    expect(within(head).getByRole('img', { name: 'Running' })).toBeInTheDocument();
    // The status row keeps its place, empty, so the transcript does not jump.
    expect(screen.getByTestId('status-line')).toHaveAttribute('data-hidden', 'true');
    expect(screen.getByTestId('status-line')).toBeEmptyDOMElement();
    act(() => { vi.advanceTimersByTime(65_000); });
    expect(within(head).getByTestId('tool-elapsed')).toHaveTextContent('1m 5s');
    emit({ type: 'item', handleId, item: { ...running, status: 'done', output: 'ok' } });
    expect(head).toHaveTextContent('Rendered the chart');
    expect(within(head).queryByTestId('tool-elapsed')).not.toBeInTheDocument();
    expect(within(head).queryByRole('img', { name: 'Running' })).not.toBeInTheDocument();
    expect(screen.getByTestId('status-line')).toHaveTextContent('1m 5s · 6.9k tokens · Thinking');
  });
});

describe('a steady live line (the line and the whole transcript once jumped while thinking)', () => {
  const call = (id: string, description: string, status: ToolItem['status']): TranscriptItem => ({
    kind: 'tool',
    id,
    toolUseId: id,
    name: 'Bash',
    input: { command: 'x', description },
    summary: 'Ran `x`',
    status,
    startedAt: Date.now(),
  });
  const line = (): HTMLElement => screen.getAllByTestId('tool-group').at(-1)!;
  const head = (): HTMLElement => within(line()).getByRole('button');
  const spinning = (): boolean => within(head()).queryByRole('img', { name: 'Running' }) !== null;
  const status = (): HTMLElement => screen.getByTestId('status-line');

  it('holds each step for the dwell, keeps the status row in place and switches both together', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const emit = (event: Parameters<typeof rendered.api.mock.emitEngine>[0]): void => act(() => rendered.api.mock.emitEngine(event));
    const wait = (ms: number): void => act(() => { vi.advanceTimersByTime(ms); });
    emit({ type: 'item', handleId, item: call('c0', 'Prepare the app', 'done') });
    emit({ type: 'item', handleId, item: { kind: 'assistant', id: 'steady-a', text: 'Prepared.' } });
    emit({ type: 'item', handleId, item: { kind: 'user', id: 'steady-u', text: 'go' } });
    emit({ type: 'state', handleId, state: 'running', startedAt: Date.now(), tokens: 100 });
    // A new line shows its first step at once.
    emit({ type: 'item', handleId, item: call('c1', 'Build the app', 'running') });
    expect(head()).toHaveTextContent('Building the app');
    expect(spinning()).toBe(true);
    expect(line()).toHaveAttribute('data-live', 'true');
    // Only that line: the earlier one keeps its own summary.
    expect(screen.getAllByText('Building the app')).toHaveLength(1);
    expect(screen.getByText('Prepared the app')).toBeInTheDocument();
    expect(status()).toHaveAttribute('data-hidden', 'true');
    // A quick finish, some thinking and the next call inside the dwell leave the line and the rows as they are.
    const thinkingRows = screen.queryAllByTestId('thinking').length;
    wait(200);
    emit({ type: 'item', handleId, item: call('c1', 'Build the app', 'done') });
    emit({ type: 'item', handleId, item: { kind: 'thinking', id: 'steady-th', text: 'next', streaming: true } });
    expect(head()).toHaveTextContent('Building the app');
    expect(spinning()).toBe(true);
    expect(status()).toHaveAttribute('data-hidden', 'true');
    expect(screen.queryAllByTestId('thinking')).toHaveLength(thinkingRows);
    emit({ type: 'item', handleId, item: call('c2', 'Test the app', 'running') });
    wait(STEP_DWELL_MS - 201);
    expect(head()).toHaveTextContent('Building the app');
    wait(1);
    expect(head()).toHaveTextContent('Testing the app');
    // The call ends: its step stays for the dwell, then the summary and the status line take over in one go.
    emit({ type: 'item', handleId, item: call('c2', 'Test the app', 'done') });
    wait(STEP_DWELL_MS - 1);
    expect(head()).toHaveTextContent('Testing the app');
    expect(spinning()).toBe(true);
    expect(status()).toHaveAttribute('data-hidden', 'true');
    wait(1);
    expect(head()).toHaveTextContent('Ran 2 commands');
    expect(spinning()).toBe(false);
    expect(status()).not.toHaveAttribute('data-hidden');
    expect(status()).toHaveTextContent('Thinking');
    // A call that starts right after shows only once the summary had its dwell.
    emit({ type: 'item', handleId, item: call('c3', 'Lint the app', 'running') });
    expect(head()).toHaveTextContent('Ran 2 commands');
    expect(status()).toHaveTextContent('Thinking');
    wait(STEP_DWELL_MS);
    expect(head()).toHaveTextContent('Linting the app');
    expect(status()).toHaveAttribute('data-hidden', 'true');
    // Waiting for the user is shown at once, by the status line alone.
    emit({ type: 'state', handleId, state: 'awaiting' });
    expect(spinning()).toBe(false);
    expect(head()).toHaveTextContent('Ran 3 commands');
    expect(status()).toHaveTextContent('Waiting for you');
    expect(line()).toHaveAttribute('data-live', 'true');
    // Back to work, the running step returns at once too.
    emit({ type: 'state', handleId, state: 'running' });
    expect(head()).toHaveTextContent('Linting the app');
    expect(status()).toHaveAttribute('data-hidden', 'true');
    // When the turn ends the line is a plain summary again.
    emit({ type: 'item', handleId, item: call('c3', 'Lint the app', 'done') });
    emit({ type: 'state', handleId, state: 'idle' });
    expect(line()).not.toHaveAttribute('data-live');
    expect(head()).toHaveTextContent('Ran 3 commands');
    expect(screen.queryByTestId('status-line')).not.toBeInTheDocument();
  });
});
