import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '@shared/events';
import type { TranscriptItem } from '@shared/types';
import { applyEngineEvent, createView, mergeLatestPage } from '../../src/renderer/state/sessionReducer';
import type { SessionView } from '../../src/renderer/state/types';
import { MAIN_SESSION_ID, renderApp, takeOverMain, type Rendered } from './helpers';

type SystemItem = Extract<TranscriptItem, { kind: 'system' }>;
const H = 'h-1';
const apply = (view: SessionView, ...events: EngineEvent[]): SessionView => events.reduce((v, e) => applyEngineEvent(v, e, 1_000), view);
const ids = (items: readonly TranscriptItem[]): string[] => items.map((item) => item.id);
const note = (id: string, text: string): SystemItem => ({ kind: 'system', id, text, level: 'info' });

// An earlier run of the same command, then more conversation: what a reload reads before the CLI wrote the new run's rows.
const EARLIER: TranscriptItem[] = [
  { kind: 'user', id: 'mcp-0', text: '/mcp' }, note('mcp-0-out', 'MCP dialog dismissed'),
  { kind: 'user', id: 'ask', text: 'A long conversation follows' }, { kind: 'assistant', id: 'answer', text: 'Many screens of answer' },
];
// main's read-back (session.ts showCommandResults): the CLI's rows under their own ids, chained after main's echo, each naming
// the CLI's <command-name> row of this run.
const READ_BACK: EngineEvent[] = [
  { type: 'item', handleId: H, afterId: 'send-1', anchorId: 'mcp-1', item: note('mcp-1-out', 'MCP dialog dismissed') },
  { type: 'item', handleId: H, afterId: 'mcp-1-out', anchorId: 'mcp-1', item: { kind: 'system', id: 'mcp-1-err', text: 'Failed to reconnect to beta', level: 'warn' } },
];

/** The view once main echoed the user's /mcp as send-1 and command.run answered. */
function answered(): SessionView {
  const view = apply(createView({ key: 'k', profileId: 'default', cwd: 'D:\\x', title: 't', handleId: H, engineState: 'running',
    items: [...EARLIER, { kind: 'user', id: 'local-1', text: '/mcp' }], localEchoes: ['local-1'],
    submissions: [{ id: 's1', handleId: H, echoId: 'local-1', command: 'mcp', phase: 'waiting', createdAt: 1 }] }),
  { type: 'item', handleId: H, item: { kind: 'user', id: 'send-1', text: '/mcp' } });
  expect(view.submissions[0]).toMatchObject({ nativeItemId: 'send-1' });
  return { ...view, submissions: view.submissions.map((entry) => ({ ...entry, phase: 'ended', settledAt: 3 })) };
}

describe('a command result read back from the transcript (reducer)', () => {
  it('goes right under main\'s echo of the command while it is shown, ahead of what came after the command', () => {
    const view = apply(answered(),
      { type: 'item', handleId: H, item: { kind: 'user', id: 'send-2', text: 'Typed while the command ran' } },
      { type: 'item', handleId: H, item: { kind: 'assistant', id: 'reply', text: 'Answer to it' } },
      ...READ_BACK);
    expect(ids(view.items)).toEqual([...ids(EARLIER), 'send-1', 'mcp-1-out', 'mcp-1-err', 'send-2', 'reply']);
  });

  it('goes right under the CLI command row when a reload replaced the echo with a page that has that row', () => {
    let view = answered();
    view = mergeLatestPage(view, { items: [...EARLIER, { kind: 'user', id: 'mcp-1', text: '/mcp' },
      { kind: 'user', id: 'next', text: 'Typed while the command ran' }, { kind: 'assistant', id: 'reply', text: 'Answer to it' }] }, new Set(ids(view.items)));
    expect(ids(view.items)).not.toContain('send-1');
    view = apply(view, ...READ_BACK);
    expect(ids(view.items)).toEqual([...ids(EARLIER), 'mcp-1', 'mcp-1-out', 'mcp-1-err', 'next', 'reply']);
  });

  it('goes at the end when neither is shown, never under an earlier run of the same command', () => {
    let view = answered();
    view = mergeLatestPage(view, { items: EARLIER }, new Set(ids(view.items)));
    view = apply(view, ...READ_BACK);
    expect(ids(view.items)).toEqual([...ids(EARLIER), 'mcp-1-out', 'mcp-1-err']);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

/** The saved conversation of the main fixture session; it already shows an earlier /mcp and /rewind with their results. */
const PAGE: TranscriptItem[] = [
  { kind: 'user', id: 'h-mcp', text: '/mcp' }, note('h-mcp-out', 'MCP dialog dismissed'),
  { kind: 'user', id: 'h-rewind', text: '/rewind' }, note('h-rewind-out', 'Rewound to “First question”'),
  { kind: 'user', id: 'h-ask', text: 'First question' }, { kind: 'assistant', id: 'h-answer', text: 'First answer' },
];

async function session() {
  const rendered = await renderApp({ history: { [MAIN_SESSION_ID]: PAGE } });
  const handleId = await takeOverMain(rendered);
  return { ...rendered, handleId, history: vi.spyOn(rendered.api.sessions, 'history') };
}

/** What main does for a slash command: its echo (the send's id), then command.run answers and send() resolves. */
async function run({ api, controller }: Rendered, handleId: string, text: string): Promise<void> {
  const reply = deferred<void>();
  vi.spyOn(api.engine, 'send').mockReturnValueOnce(reply.promise);
  let sent!: Promise<boolean>;
  act(() => { sent = controller.send(controller.state.currentKey!, text); });
  act(() => {
    api.mock.emitEngine({ type: 'item', handleId, item: { kind: 'user', id: 'send-1', text } });
    api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
  });
  await act(async () => {
    reply.resolve(undefined);
    expect(await sent).toBe(true);
    api.mock.emitEngine({ type: 'state', handleId, state: 'idle' });
  });
}

/** main's first transcript read, 100 ms after command.run answered (COMMAND_RESULT_READS_MS). */
const readBack = (): Promise<void> => act(() => new Promise<void>((resolve) => { setTimeout(resolve, 100); }));

/** The row shown right under the newest user line that reads `text`. */
const rowUnder = (text: string): Element | null | undefined =>
  screen.getAllByTestId('user-message').findLast((line) => line.textContent === text)?.nextElementSibling;

describe('a command result in the session (realistic order: echo, reply, read-back about 100 ms later)', () => {
  it('/compact keeps the typed line and shows its result right under it, without reading history again', async () => {
    const rendered = await session();
    await run(rendered, rendered.handleId, '/compact');
    await readBack();
    act(() => rendered.api.mock.emitEngine({ type: 'item', handleId: rendered.handleId, afterId: 'send-1', anchorId: 'command-1',
      item: { ...note('stdout-1', 'Compacted'), durationMs: 35_143 } }));
    expect(rendered.history).not.toHaveBeenCalled();
    expect(rowUnder('/compact')).toHaveTextContent(/^Compacted · took 35s$/);
    expect(ids(rendered.controller.currentView()!.items)).toEqual([...ids(PAGE), 'send-1', 'stdout-1']);
  });

  it('a dialog command shows its closing line under this run, not under the earlier /mcp on the page', async () => {
    const rendered = await session();
    await run(rendered, rendered.handleId, '/mcp');
    await readBack();
    act(() => rendered.api.mock.emitEngine({ type: 'item', handleId: rendered.handleId, afterId: 'send-1', anchorId: 'mcp-row',
      item: note('mcp-out', 'MCP dialog dismissed') }));
    expect(rendered.history).not.toHaveBeenCalled();
    expect(ids(rendered.controller.currentView()!.items)).toEqual([...ids(PAGE), 'send-1', 'mcp-out']);
    expect(rowUnder('/mcp')).toHaveTextContent('MCP dialog dismissed');
  });

  it.each(['/rewind', '/undo', '/checkpoint'])('%s reads the rewritten conversation again; its result then goes at the end, not under an earlier /rewind', async (text) => {
    const rendered = await session();
    // The CLI has not written this run's rows yet when the reload reads the file.
    const rewound = PAGE.slice(0, 4);
    rendered.history.mockResolvedValue({ items: rewound });
    await run(rendered, rendered.handleId, text);
    await waitFor(() => expect(ids(rendered.controller.currentView()!.items)).toEqual(ids(rewound)));
    expect(rendered.history).toHaveBeenCalledTimes(1);
    await readBack();
    act(() => rendered.api.mock.emitEngine({ type: 'item', handleId: rendered.handleId, afterId: 'send-1', anchorId: 'rewind-row',
      item: note('rewind-out', 'Rewound to “First question”') }));
    expect(ids(rendered.controller.currentView()!.items)).toEqual([...ids(rewound), 'rewind-out']);
  });

  it('a session command named exactly /undo is that command, not the rewind alias: no reload, its result under its line', async () => {
    const rendered = await session();
    act(() => rendered.api.mock.emitEngine({ type: 'commands', handleId: rendered.handleId,
      commands: [{ name: 'rewind', description: 'Restore the conversation' }, { name: 'undo', description: 'Undo my last edit' }] }));
    await run(rendered, rendered.handleId, '/undo');
    await readBack();
    act(() => rendered.api.mock.emitEngine({ type: 'item', handleId: rendered.handleId, afterId: 'send-1', item: note('undo-out', 'Edit undone') }));
    expect(rendered.history).not.toHaveBeenCalled();
    expect(rowUnder('/undo')).toHaveTextContent('Edit undone');
  });
});
