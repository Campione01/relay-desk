import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { SystemRow } from '../../src/renderer/components/transcript/Rows';
import { selectionText } from '../../src/renderer/components/transcript/SelectionMenu';
import { I18nProvider } from '../../src/renderer/i18n';
import { renderApp, sidebar, type Rendered } from './helpers';

const SESSION = {
  sessionId: '41111111-2222-4333-8444-555555555555',
  title: 'Selection fixture',
  cwd: 'D:\\demos\\fixture',
  lastModified: Date.UTC(2026, 9, 16),
};

const ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'Line one\nLine two' },
  { kind: 'thinking', id: 'th1', text: 'Considering the options.' },
  { kind: 'tool', id: 't1', toolUseId: 'tu1', name: 'Bash', input: { command: 'npm test' }, summary: 'Ran npm test', status: 'done', output: 'all green' },
  {
    kind: 'assistant',
    id: 'a1',
    text: 'First paragraph with `code`.\n\nSecond paragraph.\n\n- item one\n- item two\n\n```ts\nconst x = 1;\n  return x;\n```',
  },
];

async function openFixture(language: 'en' | 'zh-TW' = 'en'): Promise<Rendered> {
  const rendered = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: ITEMS }, settings: { language } });
  await rendered.user.click(within(sidebar()).getByRole('button', { name: SESSION.title }));
  await screen.findByTestId('assistant-message');
  return rendered;
}

function textNode(el: Element, contains: string): Text {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node as Text).data.includes(contains)) return node as Text;
  }
  throw new Error(`no text node with ${contains}`);
}

function setSelection(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

/** A mouse drag: the pill waits for the mouseup. */
function dragSelect(startNode: Text, startOffset: number, endNode: Text, endOffset: number): void {
  const target = startNode.parentElement!;
  fireEvent.mouseDown(target);
  act(() => {
    setSelection(startNode, startOffset, endNode, endOffset);
    document.dispatchEvent(new Event('selectionchange'));
  });
  expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
  fireEvent.mouseUp(endNode.parentElement!);
}

/** Keyboard selection: only selectionchange events. */
function keySelect(startNode: Node, startOffset: number, endNode: Node, endOffset: number): void {
  act(() => {
    setSelection(startNode, startOffset, endNode, endOffset);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

function collapse(): void {
  act(() => {
    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange'));
  });
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe('selection text', () => {
  it('keeps block and line breaks, drops controls, icons and hidden labels', () => {
    const host = document.createElement('div');
    host.className = 'rd-transcript';
    host.innerHTML = [
      '<div class="rd-user"><div class="rd-user__bubble rd-selectable">Line one\nLine two</div>',
      '<div class="rd-user__queued"><span class="rd-badge">Queued</span><button>Send now</button></div></div>',
      '<div class="rd-tools"><div class="rd-tools__line"><button class="rd-tools__summary">Ran npm test</button></div></div>',
      '<div class="rd-assistant"><div class="rd-md rd-selectable"><p>First   paragraph\nwith <code>code</code>.</p>',
      '<ul>\n<li>item one</li>\n<li>item two</li>\n</ul>',
      '<div class="rd-md__code"><pre><code>const x = 1;\n  return x;</code></pre><button aria-label="Copy"><svg><text>icon</text></svg></button></div></div></div>',
      '<div class="rd-status"><span class="rd-visually-hidden">Thinking</span><span aria-hidden="true">3s</span></div>',
    ].join('');
    document.body.appendChild(host);
    const range = document.createRange();
    range.selectNodeContents(host);
    expect(selectionText(range)).toBe(
      'Line one\nLine two\n\nFirst paragraph with code.\n\nitem one\nitem two\n\nconst x = 1;\n  return x;',
    );

    // A selection inside one pre-formatted text node keeps its own white space.
    const code = host.querySelector('pre code')!.firstChild as Text;
    const inner = document.createRange();
    inner.setStart(code, 6);
    inner.setEnd(code, code.data.length);
    expect(selectionText(inner)).toBe('x = 1;\n  return x;');

    // Text inside a button is never quoted.
    const summary = host.querySelector('.rd-tools__summary')!.firstChild as Text;
    const label = document.createRange();
    label.setStart(summary, 0);
    label.setEnd(summary, 6);
    expect(selectionText(label)).toBe('');
    host.remove();
  });

  it('quotes a finished command result without its duration, as copying does', () => {
    const { container, unmount } = render(
      <I18nProvider language="en"><SystemRow item={{ kind: 'system', id: 's', text: 'Compacted', level: 'info', durationMs: 167_846 }} /></I18nProvider>,
    );
    const row = container.querySelector('.rd-sysrow')!;
    expect(row.textContent).toContain('took 2m 47s');
    const range = document.createRange();
    range.selectNodeContents(row);
    expect(selectionText(range)).toBe('Compacted');
    unmount();
  });
});

describe('selection pill', () => {
  it('appears after a mouse selection in assistant text; Reply quotes it into the prompt and clears the selection', async () => {
    const { user, controller } = await openFixture();
    const assistant = screen.getByTestId('assistant-message');
    const first = textNode(assistant, 'First paragraph');
    const second = textNode(assistant, 'Second paragraph');
    dragSelect(first, 0, second, 'Second paragraph'.length);

    const pill = await screen.findByRole('toolbar', { name: 'Selected text' });
    const buttons = within(pill).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Start a side chat', 'Reply']);
    expect(buttons[0]).not.toHaveAttribute('aria-disabled');

    await user.click(within(pill).getByRole('button', { name: 'Reply' }));
    const key = controller.state.currentKey!;
    expect(controller.state.drafts[key]).toBe('> First paragraph with code.\n>\n> Second paragraph\n\n');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('> First paragraph with code.\n>\n> Second paragraph\n\n');
    expect(document.getSelection()!.rangeCount).toBe(0);
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
  });

  it('works for user, thinking and tool output text, and quotes exactly what is seen', async () => {
    const { user, controller } = await openFixture();
    const quote = vi.spyOn(controller, 'quoteIntoPrompt');

    const bubble = screen.getByTestId('user-message');
    keySelect(textNode(bubble, 'Line one'), 0, textNode(bubble, 'Line one'), 'Line one\nLine two'.length);
    await user.click(within(await screen.findByTestId('selection-menu')).getByRole('button', { name: 'Reply' }));
    expect(quote).toHaveBeenLastCalledWith(controller.state.currentKey, 'Line one\nLine two');

    // The thinking right before the tool sits inside the tool group.
    const group = screen.getByTestId('tool-group');
    await user.click(within(group).getByRole('button', { name: /Ran npm test/ }));
    const thinking = within(group).getByTestId('thinking');
    await user.click(within(thinking).getByRole('button', { name: 'Thought' }));
    const thought = textNode(within(thinking).getByRole('region'), 'Considering');
    keySelect(thought, 0, thought, 11);
    await user.click(within(await screen.findByTestId('selection-menu')).getByRole('button', { name: 'Reply' }));
    expect(quote).toHaveBeenLastCalledWith(controller.state.currentKey, 'Considering');

    const output = textNode(group.querySelector('.rd-toolrow__output')!, 'all green');
    keySelect(output, 4, output, 9);
    await user.click(within(await screen.findByTestId('selection-menu')).getByRole('button', { name: 'Reply' }));
    expect(quote).toHaveBeenLastCalledWith(controller.state.currentKey, 'green');
  });

  it('does not appear for selections outside the transcript, inside a control label, or collapsed', async () => {
    const { user } = await openFixture();
    const prompt = screen.getByRole('textbox', { name: 'Message' });
    await user.type(prompt, 'draft text');
    keySelect(textNode(sidebar(), SESSION.title), 0, textNode(sidebar(), SESSION.title), 5);
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
    const note = textNode(screen.getByTestId('readonly-note'), 'Showing the transcript');
    keySelect(note, 0, note, 7);
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
    // From the transcript into the prompt area is not a transcript selection either.
    const reply = textNode(screen.getByTestId('assistant-message'), 'Second paragraph');
    keySelect(reply, 0, note, 7);
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();

    const summary = textNode(screen.getByTestId('tool-group'), 'Ran npm test');
    keySelect(summary, 0, summary, 3);
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();

    const assistant = screen.getByTestId('assistant-message');
    const text = textNode(assistant, 'Second paragraph');
    keySelect(text, 0, text, 6);
    expect(screen.getByTestId('selection-menu')).toBeInTheDocument();
    collapse();
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
  });

  it('hides on scroll, on Esc and on a click elsewhere; a new selection brings it back', async () => {
    await openFixture();
    const assistant = screen.getByTestId('assistant-message');
    const text = textNode(assistant, 'Second paragraph');

    keySelect(text, 0, text, 6);
    expect(screen.getByTestId('selection-menu')).toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId('transcript-scroller'));
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();

    keySelect(text, 0, text, 7);
    expect(screen.getByTestId('selection-menu')).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
    // The same selection reported again stays dismissed.
    act(() => {
      document.dispatchEvent(new Event('selectionchange'));
    });
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();

    keySelect(text, 0, text, 8);
    expect(screen.getByTestId('selection-menu')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('textbox', { name: 'Message' }));
    fireEvent.mouseUp(screen.getByRole('textbox', { name: 'Message' }));
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();

    dragSelect(text, 2, text, 9);
    expect(screen.getByTestId('selection-menu')).toBeInTheDocument();
  });

  it('is reachable with Tab and has keyboard-usable buttons', async () => {
    const { user, controller } = await openFixture();
    const quote = vi.spyOn(controller, 'quoteIntoPrompt');
    const text = textNode(screen.getByTestId('assistant-message'), 'Second paragraph');
    keySelect(text, 0, text, 6);
    const pill = screen.getByTestId('selection-menu');
    (document.activeElement as HTMLElement | null)?.blur();
    await user.tab();
    expect(within(pill).getByRole('button', { name: 'Start a side chat' })).toHaveFocus();
    await user.tab();
    expect(within(pill).getByRole('button', { name: 'Reply' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(quote).toHaveBeenCalledWith(controller.state.currentKey, 'Second');

    keySelect(text, 0, text, 6);
    (document.activeElement as HTMLElement | null)?.blur();
    await user.tab();
    expect(within(screen.getByTestId('selection-menu')).getByRole('button', { name: 'Start a side chat' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('selection-menu')).not.toBeInTheDocument();
  });

  it('sits centred above the selection, flips below without room and stays inside the transcript', async () => {
    await openFixture();
    const scroller = screen.getByTestId('transcript-scroller');
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 100, y: 100, width: 600, height: 500 }));
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(180);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(30);
    const rect = vi.fn(() => DOMRect.fromRect({ x: 300, y: 300, width: 200, height: 40 }));
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: rect });
    try {
      const text = textNode(screen.getByTestId('assistant-message'), 'Second paragraph');
      keySelect(text, 0, text, 6);
      let pill = screen.getByTestId('selection-menu');
      expect(pill.style.top).toBe(`${300 - 6 - 30}px`);
      expect(pill.style.left).toBe(`${400 - 90}px`);
      expect(pill.dataset.placement).toBe('above');

      rect.mockReturnValue(DOMRect.fromRect({ x: 640, y: 110, width: 50, height: 20 }));
      keySelect(text, 0, text, 7);
      pill = screen.getByTestId('selection-menu');
      expect(pill.dataset.placement).toBe('below');
      expect(pill.style.top).toBe(`${130 + 6}px`);
      expect(pill.style.left).toBe(`${700 - 180 - 4}px`);
    } finally {
      delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    }
  });

  it('disables the side chat with a reason until the session exists on disk, and speaks Traditional Chinese', async () => {
    const { controller } = await renderApp({ settings: { language: 'zh-TW' } });
    await act(async () => controller.newSession('D:\\demos\\demo-app'));
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    const start = vi.spyOn(controller, 'startSideChat');
    const note = textNode(document.querySelector('.rd-transcript')!, 'D:\\demos\\demo-app');
    keySelect(note, 0, note, 4);
    const pill = screen.getByRole('toolbar', { name: '選取的文字' });
    const side = within(pill).getByRole('button', { name: '開啟側聊' });
    expect(within(pill).getByRole('button', { name: '回覆' })).toBeInTheDocument();
    expect(side).toHaveAttribute('aria-disabled', 'true');
    expect(side).toHaveAttribute('data-tip', '第一個回合完成、對話儲存後才能開啟側聊');
    expect(side).toHaveAccessibleDescription('第一個回合完成、對話儲存後才能開啟側聊');
    fireEvent.click(side);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByTestId('selection-menu')).toBeInTheDocument();
  });
});
