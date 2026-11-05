import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

/** The main fixture's history already wrote this file (mock/fixtures.ts). */
const HANDOFF = 'D:\\demos\\relay-desk\\docs\\handoff.md';

const write = (id: string, path: string, extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {}): TranscriptItem => ({
  kind: 'tool',
  id,
  toolUseId: `toolu_${id}`,
  name: 'Write',
  input: { file_path: path, content: 'print(1)' },
  summary: `Wrote ${path}`,
  status: 'done',
  ...extra,
});

/** Oldest first; the card lists them newest first like the desktop screenshot. */
const DESKTOP_WRITES: TranscriptItem[] = [
  write('o1', 'E:\\work\\plan_m2.py'),
  write('o2', 'E:\\work\\plan_m1.py'),
  write('o3', 'E:\\work\\plan_m3.py'),
  write('o4', 'E:\\work\\scripts\\run_core_task.ps1'),
  write('o5', 'E:\\work\\plan_pickup_2333.py'),
];

function card(): HTMLElement {
  return screen.getByTestId('card-outputs');
}

function rows(): HTMLElement[] {
  return within(card()).queryAllByTestId('output-row');
}

function names(): string[] {
  return rows().map((row) => row.textContent ?? '');
}

function emit({ api }: Rendered, handleId: string, items: TranscriptItem[]): void {
  act(() => {
    for (const item of items) api.mock.emitEngine({ type: 'item', handleId, item });
  });
}

describe('outputs card (desktop Outputs)', () => {
  it('is hidden while the view has no written files and sits right after Connectors once it has some', async () => {
    const rendered = await renderApp();
    expect(screen.getByTestId('right-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('card-outputs')).not.toBeInTheDocument();

    await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await waitFor(() => expect(rendered.controller.currentView()?.history).toBe('loaded'));
    expect(rendered.controller.currentView()!.items.length).toBeGreaterThan(0);
    expect(screen.queryByTestId('card-outputs')).not.toBeInTheDocument();

    await takeOverMain(rendered);
    expect(names()).toEqual(['handoff.md']);
    expect(card().previousElementSibling).toBe(screen.getByTestId('card-connectors'));
    expect(within(card()).getByRole('button', { name: /Outputs/ })).toHaveAttribute('aria-expanded', 'true');
    expect(within(card()).queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('shows five rows newest first with the code or file icon, then Show more and Show less', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    emit(rendered, handleId, DESKTOP_WRITES);
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(names()).toEqual(['plan_pickup_2333.py', 'run_core_task.ps1', 'plan_m3.py', 'plan_m1.py', 'plan_m2.py']);
    expect(rows().map((row) => row.getAttribute('data-kind'))).toEqual(['code', 'file', 'code', 'code', 'code']);
    expect(rows()[0]!.querySelector('svg.lucide-code-xml')).not.toBeNull();
    expect(rows()[1]!.querySelector('svg.lucide-file')).not.toBeNull();
    expect(rows()[1]!.querySelector('svg.lucide-code-xml')).toBeNull();
    expect(rows()[1]).toHaveAttribute('data-tip', 'E:\\work\\scripts\\run_core_task.ps1\nShow in File Explorer');
    expect(rows()[1]).toHaveAttribute('aria-description', 'Show in File Explorer');
    expect(within(card()).getByRole('list', { name: 'Outputs' })).toBeInTheDocument();

    const more = within(card()).getByRole('button', { name: 'Show more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await rendered.user.click(more);
    expect(names()).toEqual(['plan_pickup_2333.py', 'run_core_task.ps1', 'plan_m3.py', 'plan_m1.py', 'plan_m2.py', 'handoff.md']);
    expect(rows()[5]).toHaveAttribute('data-kind', 'file');
    const less = within(card()).getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    await rendered.user.click(less);
    expect(rows()).toHaveLength(5);
    expect(within(card()).getByRole('button', { name: 'Show more' })).toBeInTheDocument();

    const head = card().querySelector<HTMLButtonElement>('.rd-card__head')!;
    await rendered.user.click(head);
    expect(rows()).toHaveLength(0);
    expect(within(head).getByText('6')).toBeInTheDocument();
  });

  it('lists a write once it is done, moves a rewritten file to the top and leaves failed writes out', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    emit(rendered, handleId, [write('w1', 'D:\\demos\\relay-desk\\tools\\make.py', { status: 'running' })]);
    expect(names()).toEqual(['handoff.md']);
    emit(rendered, handleId, [write('w1', 'D:\\demos\\relay-desk\\tools\\make.py')]);
    await waitFor(() => expect(names()).toEqual(['make.py', 'handoff.md']));
    emit(rendered, handleId, [
      write('w2', 'D:/demos/relay-desk/docs/HANDOFF.md'),
      write('w3', 'D:\\demos\\relay-desk\\broken.py', { status: 'error' }),
      write('w4', 'D:\\demos\\relay-desk\\agent.py', { parentToolUseId: 'toolu_agent' }),
    ]);
    await waitFor(() => expect(names()).toEqual(['agent.py', 'HANDOFF.md', 'make.py']));
  });

  it('a click or Enter selects the file in Explorer; nothing opens or runs it', async () => {
    const rendered = await renderApp();
    const reveal = vi.spyOn(rendered.api.app, 'revealFile');
    const openFolder = vi.spyOn(rendered.api.app, 'revealPath');
    const openUrl = vi.spyOn(rendered.api.app, 'openExternal');
    const handleId = await takeOverMain(rendered);
    emit(rendered, handleId, [write('s1', 'E:\\work\\scripts\\run_core_task.ps1')]);
    await waitFor(() => expect(names()).toEqual(['run_core_task.ps1', 'handoff.md']));

    await rendered.user.click(rows()[0]!);
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('E:\\work\\scripts\\run_core_task.ps1'));
    rows()[1]!.focus();
    await rendered.user.keyboard('{Enter}');
    await waitFor(() => expect(reveal).toHaveBeenLastCalledWith(HANDOFF));
    expect(reveal).toHaveBeenCalledTimes(2);
    expect(openFolder).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('read-only history views list their outputs too, in the UI language', async () => {
    const session = { sessionId: '71111111-2222-4333-8444-555555555555', title: 'Outputs fixture', cwd: 'E:\\work', lastModified: Date.UTC(2026, 9, 18) };
    const { user } = await renderApp({
      sessions: [session],
      history: { [session.sessionId]: [...DESKTOP_WRITES, write('o6', 'E:\\work\\notes.md')] },
      settings: { language: 'zh-TW' },
    });
    await user.click(screen.getByRole('button', { name: session.title }));
    await waitFor(() => expect(rows()).toHaveLength(5));
    expect(within(card()).getByRole('button', { name: /輸出/ })).toHaveAttribute('aria-expanded', 'true');
    expect(names()[0]).toBe('notes.md');
    expect(rows()[0]).toHaveAttribute('data-tip', 'E:\\work\\notes.md\n在檔案總管中顯示');
    expect(within(card()).getByRole('button', { name: '顯示更多' })).toBeInTheDocument();
  });
});
