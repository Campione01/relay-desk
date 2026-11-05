import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { renderApp, sidebar } from './helpers';

const SESSION = {
  sessionId: '31111111-2222-4333-8444-555555555555',
  title: 'Thinking fixture',
  cwd: 'D:\\demos\\fixture',
  lastModified: Date.UTC(2026, 9, 16),
};

const ITEMS: TranscriptItem[] = [
  { kind: 'user', id: 'u1', text: 'Plan it' },
  { kind: 'thinking', id: 'th1', text: 'Reading the brief.' },
  { kind: 'thinking', id: 'th2', text: 'Weighing two options.' },
  { kind: 'assistant', id: 'a1', text: 'Here is the plan.' },
  { kind: 'thinking', id: 'th3', text: 'Need to run the tests first.' },
  { kind: 'tool', id: 't1', toolUseId: 'tu1', name: 'Bash', input: { command: 'npm test' }, summary: 'Ran npm test', status: 'done', output: 'ok' },
  { kind: 'assistant', id: 'a2', text: 'Tests pass.' },
  { kind: 'thinking', id: 'th4', text: 'Drafting the reply', streaming: true },
];

async function openFixture() {
  const rendered = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: ITEMS } });
  await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Thinking fixture' }));
  await screen.findAllByTestId('assistant-message');
  return rendered;
}

function topLevelThinking(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.rd-transcript > [data-testid="thinking"]')];
}

describe('thinking rows', () => {
  it('fold into one compact collapsed line per run and into the following tool group', async () => {
    const { user } = await openFixture();
    const rows = topLevelThinking();
    // th1+th2 merged; th3 folded into the Bash group; th4 still streaming.
    expect(rows).toHaveLength(2);
    const [done, live] = rows as [HTMLElement, HTMLElement];
    const head = within(done).getByRole('button', { name: 'Thought' });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(done).not.toHaveTextContent('Reading the brief.');
    expect(within(live).getByRole('button', { name: 'Thinking…' })).toHaveAttribute('aria-expanded', 'false');
    expect(live).not.toHaveTextContent('Drafting the reply');

    await user.click(head);
    const body = within(done).getByRole('region', { name: 'Thought' });
    expect(body).toHaveTextContent('Reading the brief.');
    expect(body).toHaveTextContent('Weighing two options.');
    expect(body).toHaveAttribute('tabindex', '0');
    await user.click(head);
    expect(within(done).queryByRole('region')).not.toBeInTheDocument();

    // A tool group that opens a single tool row by itself never opens the thinking inside it.
    const group = screen.getByTestId('tool-group');
    await user.click(within(group).getByRole('button', { name: /Ran npm test/ }));
    const inner = within(group).getByTestId('thinking');
    expect(within(inner).getByRole('button', { name: 'Thought' })).toHaveAttribute('aria-expanded', 'false');
    expect(group).not.toHaveTextContent('Need to run the tests first.');
    expect(within(group).getAllByTestId('tool-row')[0]!.querySelector('.rd-toolrow__head')).toHaveAttribute('aria-expanded', 'true');
  });

  it('caps an expanded body at about twelve lines with its own scroll', async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync(path: string, encoding: string): string }>('node:fs');
    const css = readFileSync('src/renderer/styles/transcript.css', 'utf8');
    const rule = css.match(/\.rd-thinking__body\s*\{([^}]+)\}/)![1]!;
    expect(rule).toMatch(/max-height:\s*calc\(12 \* var\(--rd-lh-20\)\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });
});
