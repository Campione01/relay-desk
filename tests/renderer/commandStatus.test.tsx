import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { SystemRow } from '../../src/renderer/components/transcript/Rows';
import { I18nProvider, type Language } from '../../src/renderer/i18n';
import { renderApp, takeOverMain } from './helpers';

async function ready() {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  // A native send settles only when the CLI accepts it (a command: when it ends); these stay pending.
  vi.spyOn(rendered.api.engine, 'send').mockReturnValue(new Promise<void>(() => undefined));
  return { ...rendered, handleId, key: rendered.controller.state.currentKey! };
}

/** The visible text of the status line: elapsed time, tokens and the state word. */
const statusText = (): string | null | undefined => screen.getByTestId('status-line').querySelector('.rd-status__text')?.textContent;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a send scrolls the transcript to the latest (nothing once showed during /compact)', () => {
  it('goes to the bottom and sticks there when the user sends while scrolled up; other new content leaves the reader in place', async () => {
    const { api, controller, key, handleId, user } = await ready();
    const scroller = screen.getByTestId('transcript-scroller');
    const ROW = 100;
    // jsdom has no layout: every child of the transcript column counts as one 100 px row.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scroller.querySelectorAll('.rd-transcript > *').length * ROW });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 150 });
    const scrollUp = (): void => {
      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
    };
    scrollUp();
    act(() => api.mock.emitEngine({ type: 'item', handleId, item: { kind: 'assistant', id: 'while-reading', text: 'Output that arrives while reading' } }));
    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Show me the end{Enter}');
    expect(screen.getAllByTestId('user-message').at(-1)).toHaveTextContent('Show me the end');
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    const height = scroller.scrollHeight;
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() }));
    expect(scroller.scrollHeight).toBeGreaterThan(height);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);

    scrollUp();
    act(() => { void controller.send(key, '/compact', true); });
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
  });
});

describe('a pending slash command counts from its submission (a /compact can run for minutes)', () => {
  it('shows 2m 47s 167 s after /compact was sent', async () => {
    const { api, controller, key, handleId } = await ready();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    act(() => {
      void controller.send(key, '/compact');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
    });
    expect(statusText()).toBe('0s · Compacting conversation…');
    act(() => { vi.advanceTimersByTime(167_000); });
    expect(statusText()).toBe('2m 47s · Compacting conversation…');
  });

  it('keeps counting from its submission when the turn it was sent behind ends', async () => {
    const { api, controller, key, handleId } = await ready();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const wait = (ms: number): void => act(() => { vi.advanceTimersByTime(ms); });
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() }));
    wait(30_000);
    expect(statusText()).toBe('30s · Thinking');
    act(() => { void controller.send(key, '/compact', true); });
    expect(statusText()).toBe('0s · Compacting conversation…');
    wait(60_000);
    expect(statusText()).toBe('1m 0s · Compacting conversation…');
    // The turn ends: the engine restarts its clock for the command that waited (native session turn.complete).
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() }));
    expect(statusText()).toBe('1m 0s · Compacting conversation…');
    wait(107_000);
    expect(statusText()).toBe('2m 47s · Compacting conversation…');
  });

  it('keeps its status line while a running tool call is the last line', async () => {
    const { api, controller, key, handleId } = await ready();
    const call: TranscriptItem = { kind: 'tool', id: 'review-call', toolUseId: 'review-call', name: 'Bash',
      input: { command: 'node render.js', description: 'Render the chart' }, summary: 'Ran `node render.js`', status: 'running', startedAt: Date.now() };
    act(() => {
      void controller.send(key, '/review');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() });
      api.mock.emitEngine({ type: 'item', handleId, item: call });
    });
    const head = within(screen.getAllByTestId('tool-group').at(-1)!).getByRole('button');
    expect(head).toHaveTextContent('Rendering the chart');
    expect(within(head).getByRole('img', { name: 'Running' })).toBeInTheDocument();
    const line = screen.getByTestId('status-line');
    expect(line).not.toHaveAttribute('data-hidden');
    expect(statusText()).toBe('0s · Running /review…');
    expect(within(line).getByRole('status')).toHaveTextContent('Running /review…');
  });
});

describe('a finished command names its duration', () => {
  const COMPACTED: Extract<TranscriptItem, { kind: 'system' }> = {
    kind: 'system', id: 'compact-result', text: 'Compacted (ctrl+o to see full summary)', level: 'info', durationMs: 167_846,
  };
  const row = (item: Extract<TranscriptItem, { kind: 'system' }>, language: Language): HTMLElement =>
    render(<I18nProvider language={language}><SystemRow item={item} /></I18nProvider>).container.querySelector<HTMLElement>('.rd-sysrow')!;

  it('adds a muted "took 2m 47s" to the same row in English and "耗時 2m 47s" in Chinese, read by screen readers', () => {
    const en = row(COMPACTED, 'en');
    expect(en.textContent).toBe('Compacted (ctrl+o to see full summary) · took 2m 47s');
    const suffix = en.querySelector('.rd-sysrow__duration')!;
    expect(suffix.textContent).toBe(' · took 2m 47s');
    expect(suffix.closest('[aria-hidden]')).toBeNull();
    const text = en.querySelector('.rd-sysrow__text')!;
    expect(text).toContainElement(suffix as HTMLElement);
    expect(text).toHaveClass('rd-selectable');
    expect(text).toHaveAttribute('data-folded', 'true');
    expect(en).toHaveClass('rd-sysrow--info');
    expect(row(COMPACTED, 'zh-TW').textContent).toBe('Compacted (ctrl+o to see full summary) · 耗時 2m 47s');
    const failed = row({ ...COMPACTED, id: 'failed', level: 'error', text: 'Compaction failed' }, 'en');
    expect(failed).toHaveAttribute('role', 'alert');
    expect(failed.textContent).toBe('Compaction failed · took 2m 47s');
    expect(row({ ...COMPACTED, durationMs: 2_000 }, 'en').textContent).toBe('Compacted (ctrl+o to see full summary) · took 2s');
  });

  it('keeps the duration visible next to "Show more" while long output is folded', () => {
    const LONG = 'Compacted\nSummary line 1\nSummary line 2\nSummary line 3\nSummary line 4';
    // jsdom has no layout: folded, the long text reports more height than its three-line box.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('rd-sysrow__text') ? 100 : 20;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('rd-sysrow__text') && this.hasAttribute('data-folded') ? 60 : 100;
    });
    const long = row({ ...COMPACTED, text: LONG }, 'en');
    const text = long.querySelector<HTMLElement>('.rd-sysrow__text')!;
    const more = within(long).getByRole('button', { name: 'Show more' });
    const suffix = (): Element => long.querySelector('.rd-sysrow__duration')!;
    expect(text).toHaveAttribute('data-folded', 'true');
    expect(text.textContent).toBe(LONG);
    expect(suffix().textContent).toBe(' · took 2m 47s');
    expect(suffix().previousElementSibling).toBe(more);
    expect(suffix().closest('[aria-hidden]')).toBeNull();

    more.focus();
    fireEvent.click(more);
    expect(text).not.toHaveAttribute('data-folded');
    expect(text).toContainElement(suffix() as HTMLElement);
    expect(text.textContent).toBe(`${LONG} · took 2m 47s`);
    expect(within(long).getByRole('button', { name: 'Show less' })).toBe(more);
    expect(more).toHaveFocus();
    expect(long.querySelectorAll('.rd-sysrow__duration')).toHaveLength(1);

    fireEvent.click(more);
    expect(text.textContent).toBe(LONG);
    expect(suffix().previousElementSibling).toBe(more);
    expect(more).toHaveFocus();
  });

  it.each([undefined, 0, 1_999])('adds nothing for a duration of %s ms', (durationMs) => {
    const plain = row({ ...COMPACTED, durationMs }, 'en');
    expect(plain.textContent).toBe('Compacted (ctrl+o to see full summary)');
    expect(plain.querySelector('.rd-sysrow__duration')).toBeNull();
    expect(row({ ...COMPACTED, durationMs }, 'zh-TW').textContent).toBe('Compacted (ctrl+o to see full summary)');
  });
});
