import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest, QuestionRequest } from '@shared/types';
import { answerFor } from '../../src/renderer/components/flows/QuestionCard';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

/** `focus` = where the focus is when the request arrives (the prompt after a take-over by default). */
async function withPermission(extra: Partial<PermissionRequest> = {}, focus?: () => void) {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  act(() => focus?.());
  const request: PermissionRequest = {
    requestId: 'perm-1',
    handleId,
    toolName: 'Edit',
    input: { file_path: 'D:\\demos\\relay-desk\\README.md', old_string: 'old line', new_string: 'new line\nsecond' },
    suggestions: [{ type: 'addRules' }],
    ...extra,
  };
  act(() => rendered.api.mock.emitEngine({ type: 'permission', request }));
  const card = await screen.findByTestId('permission-card');
  return { ...rendered, handleId, card };
}

describe('permission card', () => {
  it('shows the tool and target with a diff preview for edits', async () => {
    const { card } = await withPermission();
    expect(within(card).getByRole('heading')).toHaveTextContent('Allow Edit: README.md?');
    const diff = within(card).getByRole('figure', { name: 'D:\\demos\\relay-desk\\README.md' });
    expect(diff.querySelectorAll('.rd-diff__line--add')).toHaveLength(2);
    expect(diff.querySelectorAll('.rd-diff__line--del')).toHaveLength(1);
  });

  it('allow once answers the request and the card goes away', async () => {
    const { api, user, card } = await withPermission();
    const respond = vi.spyOn(api.engine, 'respondPermission');
    await user.click(within(card).getByRole('button', { name: /Allow once/ }));
    expect(respond).toHaveBeenCalledWith('perm-1', { behavior: 'allow', scope: 'once' });
    await waitFor(() => expect(screen.queryByTestId('permission-card')).not.toBeInTheDocument());
  });

  it('Ctrl+Enter inside the card allows once', async () => {
    const { api, user, card } = await withPermission();
    const respond = vi.spyOn(api.engine, 'respondPermission');
    within(card).getByRole('button', { name: 'Deny' }).focus();
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(respond).toHaveBeenCalledWith('perm-1', { behavior: 'allow', scope: 'once' });
  });

  it('"allow for this session" exists only with suggestions and without suppressAlwaysAllowRule', async () => {
    const { user, card, api } = await withPermission();
    const respond = vi.spyOn(api.engine, 'respondPermission');
    await user.click(within(card).getByRole('button', { name: 'Allow for this session' }));
    expect(respond).toHaveBeenCalledWith('perm-1', { behavior: 'allow', scope: 'session' });
  });

  it('hides session scope when the request suppresses it', async () => {
    const { card } = await withPermission({ suppressAlwaysAllowRule: true });
    expect(within(card).queryByRole('button', { name: 'Allow for this session' })).not.toBeInTheDocument();
  });

  it('deny with a reason sends the message', async () => {
    const { api, user, card } = await withPermission();
    const respond = vi.spyOn(api.engine, 'respondPermission');
    await user.click(within(card).getByRole('button', { name: 'Add a reason…' }));
    await user.type(within(card).getByRole('textbox', { name: 'Reason (optional)' }), 'use the other file{Enter}');
    expect(respond).toHaveBeenCalledWith('perm-1', { behavior: 'deny', message: 'use the other file' });
  });

  it('defaultToNo focuses Deny when nothing else holds the focus, and offers no one-key approve', async () => {
    const { card } = await withPermission({ defaultToNo: true }, () => (document.activeElement as HTMLElement).blur());
    expect(within(card).getByRole('button', { name: 'Deny' })).toHaveFocus();
    expect(within(card).getByRole('button', { name: 'Allow once' })).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('focuses Allow once when the focus is on the page', async () => {
    const { card } = await withPermission({}, () => (document.activeElement as HTMLElement).blur());
    expect(within(card).getByRole('button', { name: /Allow once/ })).toHaveFocus();
  });

  it('leaves the focus in an empty prompt, so Space and Enter there never answer the request', async () => {
    const { api, user, card } = await withPermission();
    const respond = vi.spyOn(api.engine, 'respondPermission');
    const box = screen.getByRole('textbox', { name: 'Message' });
    expect(box).toHaveValue('');
    expect(box).toHaveFocus();
    expect(within(card).getByRole('button', { name: /Allow once/ })).not.toHaveFocus();
    await user.keyboard(' ');
    expect(box).toHaveValue(' ');
    expect(respond).not.toHaveBeenCalled();
  });

  it('leaves the focus on a control outside the request stack', async () => {
    const settings = () => within(sidebar()).getByRole('button', { name: 'Settings' });
    const { card } = await withPermission({}, () => settings().focus());
    expect(settings()).toHaveFocus();
    expect(within(card).getByRole('button', { name: /Allow once/ })).not.toHaveFocus();
  });

  it('requestClosed from the engine removes the card', async () => {
    const { api, handleId } = await withPermission();
    act(() => api.mock.emitEngine({ type: 'requestClosed', handleId, requestId: 'perm-1' }));
    await waitFor(() => expect(screen.queryByTestId('permission-card')).not.toBeInTheDocument());
  });

  it('a failed answer keeps the card and shows the error', async () => {
    const { api, user, card } = await withPermission();
    vi.spyOn(api.engine, 'respondPermission').mockRejectedValueOnce(new Error("Error invoking remote method 'relay:engine:respondPermission': Error: broker gone"));
    await user.click(within(card).getByRole('button', { name: /Allow once/ }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('broker gone');
    expect(screen.getByTestId('permission-card')).toBeInTheDocument();
  });
});

const QUESTION = (handleId: string): QuestionRequest => ({
  requestId: 'q-1',
  handleId,
  questions: [
    {
      question: 'Which first?',
      header: 'Order',
      multiSelect: false,
      options: [{ label: 'Tests', description: 'run them' }, { label: 'Docs' }],
    },
    { question: 'Which files?', multiSelect: true, options: [{ label: 'README' }, { label: 'PLAN' }, { label: 'MOD' }] },
  ],
});

async function withQuestion(): Promise<Rendered & { card: HTMLElement }> {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  act(() => rendered.api.mock.emitEngine({ type: 'question', request: QUESTION(handleId) }));
  return { ...rendered, card: await screen.findByTestId('question-card') };
}

describe('question card', () => {
  it('builds the SDK answer: single label, multi labels joined with ", "', async () => {
    const { api, user, card } = await withQuestion();
    const respond = vi.spyOn(api.engine, 'respondQuestion');
    const submit = within(card).getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    await user.click(within(card).getByRole('radio', { name: /Tests/ }));
    await user.click(within(card).getByRole('checkbox', { name: 'README' }));
    await user.click(within(card).getByRole('checkbox', { name: 'MOD' }));
    await user.click(submit);
    expect(respond).toHaveBeenCalledWith('q-1', { 'Which first?': 'Tests', 'Which files?': 'README, MOD' });
    await waitFor(() => expect(screen.queryByTestId('question-card')).not.toBeInTheDocument());
  });

  it('free text under "Other" replaces the label', async () => {
    const { api, user, card } = await withQuestion();
    const respond = vi.spyOn(api.engine, 'respondQuestion');
    const first = within(card).getByRole('radiogroup', { name: 'Which first?' });
    await user.click(within(first).getByRole('radio', { name: 'Other' }));
    await user.type(within(card).getByRole('textbox', { name: 'Other answer for “Which first?”' }), 'Lint');
    await user.click(within(card).getByRole('checkbox', { name: 'PLAN' }));
    await user.click(within(card).getByRole('button', { name: 'Submit' }));
    expect(respond).toHaveBeenCalledWith('q-1', { 'Which first?': 'Lint', 'Which files?': 'PLAN' });
  });

  it('skip answers null', async () => {
    const { api, user, card } = await withQuestion();
    const respond = vi.spyOn(api.engine, 'respondQuestion');
    await user.click(within(card).getByRole('button', { name: 'Skip' }));
    expect(respond).toHaveBeenCalledWith('q-1', null);
  });

  it('answerFor combines selections and other text', () => {
    const multi = { question: 'q', multiSelect: true, options: [] };
    expect(answerFor(multi, { selected: ['A', 'B'], otherOn: true, other: ' C ' })).toBe('A, B, C');
    expect(answerFor({ ...multi, multiSelect: false }, { selected: ['A'], otherOn: false, other: 'x' })).toBe('A');
  });
});
