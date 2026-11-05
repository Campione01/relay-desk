import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { renderApp, sidebar, takeOverMain } from './helpers';

const SESSION = {
  sessionId: '11111111-2222-4333-8444-555555555555',
  title: 'Mapping fixture',
  cwd: 'D:\\demos\\fixture',
  lastModified: Date.UTC(2026, 9, 16),
};

const ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'Please fix it' },
  {
    kind: 'assistant',
    id: 'a1',
    text: 'Run `npm test` then read [the docs](https://example.com). <b>raw</b>\n\n```ts\nconst x = 1;\n```',
  },
  { kind: 'tool', id: 't1', toolUseId: 'tu1', name: 'Bash', input: { command: 'npm test' }, summary: 'Ran `npm test`', status: 'done', output: 'ok' },
  {
    kind: 'tool',
    id: 't2',
    toolUseId: 'tu2',
    name: 'mcp__computer__click',
    input: { coordinate: [222, 851], action_summary: 'Restores the window from the taskbar' },
    summary: 'Clicked',
    status: 'error',
    output: 'The click would land on the desktop shell.',
  },
  {
    kind: 'tool',
    id: 't3',
    toolUseId: 'tu3',
    name: 'Edit',
    input: { file_path: 'D:\\demos\\fixture\\a.ts', old_string: 'one', new_string: 'one\ntwo\nthree' },
    summary: 'Edited a.ts',
    status: 'done',
  },
  { kind: 'system', id: 's1', text: 'Conversation compacted', level: 'info' },
  { kind: 'result', id: 'r1', isError: true, text: 'API Error: overloaded' },
];

async function openFixture() {
  const rendered = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: ITEMS } });
  await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Mapping fixture' }));
  await screen.findByTestId('assistant-message');
  return rendered;
}

describe('transcript mapping', () => {
  it('renders user bubbles and assistant markdown without raw HTML', async () => {
    await openFixture();
    expect(screen.getByTestId('user-message')).toHaveTextContent('Please fix it');
    const assistant = screen.getByTestId('assistant-message');
    expect(within(assistant).getByText('npm test').tagName).toBe('CODE');
    expect(within(assistant).getByRole('link', { name: 'the docs' })).toHaveAttribute('href', 'https://example.com');
    expect(assistant.querySelector('b')).toBeNull();
    expect(assistant.querySelector('pre code.language-ts')).not.toBeNull();
  });

  it('collapses consecutive tools into one summary line with a diff chip', async () => {
    await openFixture();
    const groups = screen.getAllByTestId('tool-group');
    expect(groups).toHaveLength(1);
    const summary = within(groups[0]!).getByRole('button', { expanded: false });
    // A category with one file names it, like the desktop's activity line.
    expect(summary).toHaveTextContent('Ran a command, used a tool, edited a.ts (1 failed)');
    expect(within(summary).getByLabelText('2 lines added, 0 lines removed')).toHaveTextContent('+2−0');
  });

  it('expands into the tool card with the failed row open, its error and its params', async () => {
    const { user } = await openFixture();
    await user.click(within(screen.getByTestId('tool-group')).getByRole('button', { expanded: false }));
    const rows = screen.getAllByTestId('tool-row');
    expect(rows).toHaveLength(3);
    const failed = rows[1]!;
    expect(failed).toHaveAttribute('data-status', 'error');
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    expect(within(failed).getByRole('alert')).toHaveTextContent('The click would land on the desktop shell.');
    expect(within(failed).getByText('coordinate:')).toBeInTheDocument();
    expect(within(failed).getByText('[222,851]')).toBeInTheDocument();
    expect(within(failed).getByText('Restores the window from the taskbar')).not.toHaveClass('rd-mono');
    expect(within(rows[0]!).queryByText('ok')).not.toBeInTheDocument();
    await user.click(within(rows[2]!).getByRole('button', { name: /Edited a\.ts/ }));
    expect(within(rows[2]!).getByRole('figure', { name: 'D:\\demos\\fixture\\a.ts' })).toHaveTextContent('+2');
  });

  it('shows system notes and failed results inline', async () => {
    await openFixture();
    expect(screen.getByText('Conversation compacted')).toBeInTheDocument();
    expect(screen.getByText('API Error: overloaded')).toBeInTheDocument();
  });

  it('streams deltas into the live assistant message and shows the status line while running', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => {
      rendered.api.mock.emitEngine({ type: 'state', handleId, state: 'running', startedAt: Date.now() - 592_000, tokens: 37_600 });
      rendered.api.mock.emitEngine({ type: 'delta', handleId, itemId: 'live-1', text: 'Hello ' });
      rendered.api.mock.emitEngine({ type: 'delta', handleId, itemId: 'live-1', text: 'world' });
    });
    await waitFor(() =>
      expect(screen.getAllByTestId('assistant-message').at(-1)).toHaveTextContent('Hello world'),
    );
    expect(screen.getAllByTestId('assistant-message').at(-1)).toHaveAttribute('data-streaming', 'true');
    expect(screen.getByTestId('status-line')).toHaveTextContent(/9m 5\ds · 37\.6k tokens · Thinking/);
    act(() => rendered.api.mock.emitEngine({ type: 'state', handleId, state: 'idle' }));
    await waitFor(() => expect(screen.queryByTestId('status-line')).not.toBeInTheDocument());
    expect(screen.getAllByTestId('assistant-message').at(-1)).not.toHaveAttribute('data-streaming');
  });

  it('marks queued messages and offers "Send now" while a turn runs', async () => {
    const rendered = await renderApp();
    const handleId = await takeOverMain(rendered);
    act(() => {
      rendered.api.mock.emitEngine({ type: 'state', handleId, state: 'running' });
      rendered.api.mock.emitEngine({ type: 'item', handleId, item: { kind: 'user', id: 'q1', text: 'later please', queued: true } });
    });
    const queued = (await screen.findAllByTestId('user-message')).at(-1)!;
    expect(queued).toHaveAttribute('data-queued', 'true');
    expect(within(queued).getByText('Queued')).toBeInTheDocument();
    expect(within(queued).getByRole('button', { name: 'Send now' })).toBeInTheDocument();
  });

  it('keeps closed queued intent through an in-app history reopen with an honest passive delivery badge', async () => {
    const rendered = await renderApp();
    const { api, controller, user } = rendered;
    const handleId = await takeOverMain(rendered);
    const key = controller.currentView()!.key;
    const send = vi.spyOn(api.engine, 'send');
    const open = vi.spyOn(api.engine, 'open');
    const interrupt = vi.spyOn(api.engine, 'interrupt');
    const history = vi.spyOn(api.sessions, 'history');
    const queued = { kind: 'user' as const, id: 'queued-closed', text: 'Keep the queued request for review', queued: true,
      imageRefs: [{ key: 'queued-preview', mediaType: 'image/png' }] };
    act(() => {
      controller.setDraft(key, 'Leave my existing draft alone');
      api.mock.emitEngine({ type: 'state', handleId, state: 'running' });
      api.mock.emitEngine({ type: 'item', handleId, item: queued });
    });
    expect(screen.getByText('Queued')).toBeInTheDocument();
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'closed' }));
    let row = screen.getByText(queued.text).closest('[data-testid="user-message"]')!;
    expect(within(row as HTMLElement).getByText('Delivery not confirmed')).toBeInTheDocument();
    expect(row).not.toHaveAttribute('data-queued');
    expect(within(row as HTMLElement).queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();

    act(() => controller.showHome());
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await waitFor(() => expect(history).toHaveBeenCalled());
    await waitFor(() => expect(controller.view(key)?.history).toBe('loaded'));
    row = screen.getByText(queued.text).closest('[data-testid="user-message"]')!;
    expect(within(row as HTMLElement).getByText('Delivery not confirmed')).toBeInTheDocument();
    expect(controller.view(key)?.items.find((item) => item.id === queued.id)).toMatchObject({
      text: queued.text, imageRefs: queued.imageRefs, queued: undefined, deliveryUnconfirmed: true,
    });
    expect(controller.state.drafts[key]).toBe('Leave my existing draft alone');
    await act(async () => controller.updateSettings({ language: 'zh-TW' }));
    expect(within(row as HTMLElement).getByText('未確認送達')).toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('pins the latest plan with the "before your last message" header', async () => {
    const { user } = await renderApp();
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    const plan = await screen.findByTestId('plan-card');
    expect(plan).toHaveTextContent('Plan from before your last message');
    expect(within(plan).getAllByRole('listitem')).toHaveLength(8);
  });
});

describe('rows that grow (opening a long newest result once pulled the view past it)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  /**
   * jsdom has no layout: every transcript row is 100 px, an opened LONG result `growth` px more, and other rows grow by what
   * `resize` adds (an image loading); folded, LONG text overflows its box. `browser` stands in for scrollIntoView's scrolling.
   */
  async function open(items: TranscriptItem[], growth: number, view: number,
    options: { language?: 'en' | 'zh-TW'; browser?: (scroller: HTMLElement) => void } = {}) {
    const observers: Array<{ targets: Set<Element>; notify: () => void }> = [];
    vi.stubGlobal('ResizeObserver', class {
      readonly targets = new Set<Element>();
      constructor(readonly notify: () => void) { observers.push(this); }
      observe(target: Element) { this.targets.add(target); }
      unobserve(target: Element) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    });
    const kept: Array<{ element: Element; how: unknown }> = [];
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value(this: Element, how: unknown) {
      kept.push({ element: this, how });
      options.browser?.(screen.getByTestId('transcript-scroller'));
    } });
    let extra = 0;
    const long = (element: Element) => element.classList.contains('rd-sysrow__text') && (element.textContent ?? '').startsWith('LONG');
    const isScroller = (element: Element) => element.getAttribute('data-testid') === 'transcript-scroller';
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
      if (long(this)) return 2_000;
      if (!isScroller(this)) return 20;
      return this.querySelectorAll('.rd-transcript > *').length * 100 + this.querySelectorAll('.rd-sysrow__text:not([data-folded])').length * growth + extra;
    });
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      if (long(this)) return this.hasAttribute('data-folded') ? 60 : 2_000;
      return isScroller(this) ? view : 20;
    });
    const { user } = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: items }, settings: { language: options.language ?? 'en' } });
    await user.click(screen.getByRole('button', { name: SESSION.title }));
    await screen.findByRole('button', { name: options.language === 'zh-TW' ? '展開' : 'Show more' });
    const scroller = screen.getByTestId('transcript-scroller');
    const column = scroller.querySelector('.rd-transcript')!;
    /** The resize the browser reports once rows changed height, `px` of it from rows other than a fold. */
    const resize = (px = 0) => act(() => {
      extra += px;
      for (const observer of observers) if (observer.targets.has(column)) observer.notify();
    });
    const toBottom = () => {
      scroller.scrollTop = scroller.scrollHeight - view;
      fireEvent.scroll(scroller);
    };
    return { user, scroller, kept, resize, toBottom };
  }

  it('keeps the fold the user opens or closes in view instead of pulling the view to the bottom past it', async () => {
    // A 4000-character /context-like output opens about 1500 px taller in a 600 px view.
    const items: TranscriptItem[] = [...Array.from({ length: 20 }, (_, i): TranscriptItem => ({ kind: 'user', id: `u${i}`, text: `Question ${i}` })),
      { kind: 'system', id: 'long', text: `LONG ${'line\n'.repeat(60)}`, level: 'info' }];
    const { user, scroller, kept, resize, toBottom } = await open(items, 1_500, 600);
    toBottom();
    resize(200);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    toBottom();
    const at = scroller.scrollTop;
    const more = screen.getByRole('button', { name: 'Show more' });
    const fold = more.closest('.rd-sysrow__body');
    expect(kept).toEqual([]);

    await user.click(more);
    resize();
    expect(scroller.scrollTop).toBe(at);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.element).toBe(fold);
    expect(kept[0]!.how).toEqual({ block: 'nearest' });
    // Now above the bottom: other rows that grow leave the view where it is.
    resize(200);
    expect(scroller.scrollTop).toBe(at);

    await user.click(screen.getByRole('button', { name: 'Show less' }));
    resize();
    expect(scroller.scrollTop).toBe(at);
    expect(kept).toHaveLength(2);
    expect(kept[1]!.element).toBe(fold);
    expect(kept[1]!.how).toEqual({ block: 'nearest' });

    toBottom();
    resize(100);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it('shows all of a short fold opened at the bottom, its duration included, and goes on following there', async () => {
    const result: TranscriptItem = { kind: 'system', id: 'long-result', text: 'LONG result\nLine 2\nLine 3\nLine 4', level: 'info', durationMs: 12_000 };
    // The fold is the last row: the browser's 'nearest' brings its bottom to the bottom of the 300 px view.
    const { user, scroller, kept, resize, toBottom } = await open([...ITEMS, result], 52, 300,
      { language: 'zh-TW', browser: (element) => { element.scrollTop = element.scrollHeight - 300; } });
    const more = screen.getByRole('button', { name: '展開' });
    const row = more.closest<HTMLElement>('.rd-sysrow')!;
    expect(row.textContent).toBe('LONG result\nLine 2\nLine 3\nLine 4展開 · 耗時 12s');
    toBottom();
    const height = scroller.scrollHeight;

    await user.click(more);
    expect(row.textContent).toBe('LONG result\nLine 2\nLine 3\nLine 4 · 耗時 12s收合');
    expect(kept.map((entry) => entry.element)).toEqual([row.querySelector('.rd-sysrow__body')]);
    resize();
    expect(scroller.scrollHeight).toBe(height + 52);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    resize(100);
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });
});
