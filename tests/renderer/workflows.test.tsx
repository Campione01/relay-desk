import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionRequest } from '@shared/types';
import { MOCK_AUTH, MOCK_USAGE, WORK_PROFILE_ID } from '../../src/renderer/mock/fixtures';
import { isProPlan, workflowsEnabled } from '../../src/renderer/state/plan';
import { renderApp, takeOverMain, type Rendered } from './helpers';

const PRO = { auth: { ...MOCK_AUTH, default: { ...MOCK_AUTH.default!, subscriptionType: 'pro' } }, usage: { ...MOCK_USAGE, subscriptionType: 'pro' } };

/** The session-only rule main's broker adds to a Workflow request the CLI suggests nothing for. */
const SESSION_RULE = { type: 'addRules', rules: [{ toolName: 'Workflow' }], behavior: 'allow', destination: 'session' } as const;

/** The script and request CLI 2.1.302 really sent for a Workflow launch. */
const SCRIPT = [
  'export const meta = {',
  "  name: 'relay-probe',",
  "  description: 'Two tiny agents in two phases',",
  "  phases: [{ title: 'Ask' }, { title: 'Check', detail: 'Second phase' }],",
  '}',
  "log('probe started')",
  "phase('Ask')",
  "const first = await agent('Reply with the single word: one', { label: 'first', phase: 'Ask', model: 'haiku', effort: 'low' })",
  'return { first }',
].join('\n');

async function openSettings({ controller }: Rendered): Promise<HTMLSelectElement> {
  act(() => controller.openSettings(true));
  const dialog = await screen.findByTestId('settings-dialog');
  return within(dialog).getByRole('combobox', { name: 'Dynamic workflows' }) as HTMLSelectElement;
}

const footer = (): HTMLElement => screen.getByTestId('prompt-footer');

async function effortMenu(user: Rendered['user']): Promise<HTMLElement> {
  if (!screen.queryByRole('menu', { name: 'Model' })) await user.click(footer().querySelector('.rd-promptfoot__model')!);
  const menu = await screen.findByRole('menu', { name: 'Model' });
  await user.click(within(menu).getByRole('menuitem', { name: /^Effort/ }));
  return screen.findByRole('menu', { name: 'Effort' });
}

describe('plan default for dynamic workflows (the CLI: off on Pro, on otherwise)', () => {
  it('reads both spellings of the Pro plan and lets the setting decide when set', () => {
    expect(isProPlan('pro')).toBe(true);
    expect(isProPlan('Claude Pro')).toBe(true);
    expect(isProPlan(' PRO ')).toBe(true);
    for (const plan of ['max', 'Claude Max', 'team', 'professional', 'pro_plus', undefined]) expect(isProPlan(plan)).toBe(false);
    expect(workflowsEnabled(undefined, 'pro')).toBe(false);
    expect(workflowsEnabled(undefined, 'max')).toBe(true);
    expect(workflowsEnabled(undefined, undefined)).toBe(true);
    expect(workflowsEnabled('on', 'Claude Pro')).toBe(true);
    expect(workflowsEnabled('off', 'max')).toBe(false);
  });
});

describe('Dynamic workflows setting (the CLI keeps Workflow off on Pro by default)', () => {
  it('saves the choice, sends it with every open and applies a change to open sessions at once', async () => {
    const rendered = await renderApp(PRO);
    const { api, controller, user } = rendered;
    const save = vi.spyOn(api.app, 'setSettings');
    const live = vi.spyOn(api.engine, 'setWorkflows');
    const open = vi.spyOn(api.engine, 'open');
    const handleId = await takeOverMain(rendered);
    expect(open.mock.calls[0]![0]).not.toHaveProperty('workflows');

    const select = await openSettings(rendered);
    expect(select.value).toBe('');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Plan default (off on Pro)', 'On', 'Off']);
    await user.selectOptions(select, 'on');
    await waitFor(() => expect(live).toHaveBeenCalledWith(handleId, 'on'));
    expect(save).toHaveBeenCalledWith({ workflows: 'on' });
    expect(controller.state.settings.workflows).toBe('on');
    expect(live).toHaveBeenCalledTimes(1);

    // The same choice again changes nothing for the open sessions.
    await act(async () => controller.updateSettings({ workflows: 'on' }));
    expect(live).toHaveBeenCalledTimes(1);

    await user.selectOptions(select, '');
    await waitFor(() => expect(live).toHaveBeenLastCalledWith(handleId, null));
    expect(controller.state.settings.workflows).toBeUndefined();

    await user.selectOptions(select, 'off');
    await waitFor(() => expect(live).toHaveBeenLastCalledWith(handleId, 'off'));
    act(() => controller.openSettings(false));
    await act(async () => {
      await controller.newSession('D:\\work\\fresh');
    });
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(open.mock.calls[1]![0]).toMatchObject({ workflows: 'off' });
  });

  it('brings a session that was still opening when the choice changed up to date', async () => {
    const rendered = await renderApp(PRO);
    const { api, controller } = rendered;
    const open = api.engine.open.bind(api.engine);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(api.engine, 'open').mockImplementationOnce(async (request) => {
      await gate;
      return open(request);
    });
    const live = vi.spyOn(api.engine, 'setWorkflows');
    let opened!: Promise<void>;
    act(() => {
      opened = controller.newSession('D:\\work\\fresh');
    });
    await act(async () => controller.updateSettings({ workflows: 'on' }));
    expect(live).not.toHaveBeenCalled();
    release();
    await act(async () => {
      await opened;
    });
    expect(live).toHaveBeenCalledWith(controller.currentView()!.handleId, 'on');
    expect(live).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved choice and says so when an open session refuses it', async () => {
    const rendered = await renderApp(PRO);
    const { api, controller, user } = rendered;
    await takeOverMain(rendered);
    vi.spyOn(api.engine, 'setWorkflows').mockRejectedValueOnce(new Error('The CLI refused the setting'));
    await user.selectOptions(await openSettings(rendered), 'on');
    expect(await screen.findByText('The CLI refused the setting')).toBeInTheDocument();
    expect(controller.state.settings.workflows).toBe('on');
  });

  it('does not sync an unsaved choice into a session that finishes opening while the save fails', async () => {
    const rendered = await renderApp(PRO);
    const { api, controller } = rendered;
    const open = api.engine.open.bind(api.engine);
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
    vi.spyOn(api.engine, 'open').mockImplementationOnce(async (request) => {
      await openGate;
      return open(request);
    });
    let opened!: Promise<void>;
    act(() => {
      opened = controller.newSession('D:\\work\\fresh');
    });
    // Let the folder's own save finish first, so nothing but the workflows save is pending.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    let failSave!: (error: Error) => void;
    vi.spyOn(api.app, 'setSettings').mockImplementationOnce(() => new Promise((_resolve, reject) => (failSave = reject)));
    const live = vi.spyOn(api.engine, 'setWorkflows');
    let saving!: Promise<void>;
    act(() => {
      saving = controller.updateSettings({ workflows: 'on' });
    });
    expect(controller.state.settings.workflows).toBe('on');
    releaseOpen();
    await act(async () => {
      await opened;
    });
    expect(controller.currentView()?.handleId).toBeTruthy();
    expect(live).not.toHaveBeenCalled();
    failSave(new Error('disk full'));
    await act(async () => {
      await saving;
    });
    expect(controller.state.settings.workflows).toBeUndefined();
    expect(live).not.toHaveBeenCalled();
  });

  it('opens a session started while a save is pending with the saved choice', async () => {
    const rendered = await renderApp(PRO);
    const { api, controller } = rendered;
    const open = api.engine.open.bind(api.engine);
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => (releaseOpen = resolve));
    const opens = vi.spyOn(api.engine, 'open').mockImplementation(async (request) => {
      await openGate;
      return open(request);
    });
    let failSave!: (error: Error) => void;
    const save = api.app.setSettings.bind(api.app);
    // Only the workflows save fails; opening a session also saves its folder as a recent one.
    vi.spyOn(api.app, 'setSettings').mockImplementation((patch) =>
      'workflows' in patch ? new Promise((_resolve, reject) => (failSave = reject)) : save(patch),
    );
    const live = vi.spyOn(api.engine, 'setWorkflows');
    let first!: Promise<void>;
    act(() => {
      first = controller.newSession('D:\\work\\first');
    });
    let saving!: Promise<void>;
    act(() => {
      saving = controller.updateSettings({ workflows: 'on' });
    });
    expect(controller.state.settings.workflows).toBe('on');
    // A session started while the choice is still being saved opens with the saved one.
    let second!: Promise<void>;
    act(() => {
      second = controller.newSession('D:\\work\\second');
    });
    releaseOpen();
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(opens.mock.calls.map(([request]) => request.workflows)).toEqual([undefined, undefined]);
    failSave(new Error('disk full'));
    await act(async () => {
      await saving;
    });
    expect(controller.state.settings.workflows).toBeUndefined();
    expect(live).not.toHaveBeenCalled();
  });

  it('touches no session when saving the choice fails', async () => {
    const rendered = await renderApp(PRO);
    const { api, controller, user } = rendered;
    await takeOverMain(rendered);
    vi.spyOn(api.app, 'setSettings').mockRejectedValueOnce(new Error('disk full'));
    const live = vi.spyOn(api.engine, 'setWorkflows');
    await user.selectOptions(await openSettings(rendered), 'on');
    expect(await screen.findByText('disk full')).toBeInTheDocument();
    expect(controller.state.settings.workflows).toBeUndefined();
    expect(live).not.toHaveBeenCalled();
  });
});

describe('Ultracode only where dynamic workflows are on (CLI /effort parity)', () => {
  it('is hidden on Pro at the plan default and offered once the setting turns workflows on', async () => {
    const rendered = await renderApp(PRO);
    const { user, controller } = rendered;
    await takeOverMain(rendered);
    let menu = await effortMenu(user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await act(async () => controller.updateSettings({ workflows: 'on' }));
    menu = await effortMenu(user);
    expect(within(menu).getByRole('menuitemradio', { name: /Ultracode/ })).toBeInTheDocument();
  });

  it('follows the plan Claude Code works with, not the newer plan it fetched after an upgrade', async () => {
    const rendered = await renderApp({ ...PRO, auth: { ...MOCK_AUTH, default: { ...MOCK_AUTH.default!, subscriptionType: 'pro', profilePlan: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x' } } } });
    await takeOverMain(rendered);
    const menu = await effortMenu(rendered.user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
  });

  it('follows the plan Claude Code stores, not the plan name a live session reports', async () => {
    const rendered = await renderApp(PRO);
    const { api, user } = rendered;
    const handleId = await takeOverMain(rendered);
    let menu = await effortMenu(user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // CLI 2.1.302 names the profile's plan here; its workflows default follows the plan stored at sign-in.
    act(() => api.mock.emitEngine({ type: 'account', handleId, subscriptionType: 'Claude Max 20x' }));
    menu = await effortMenu(user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Usage reports the stored plan, so a newer report does count.
    act(() => api.mock.emitEngine({ type: 'usage', usage: { ...MOCK_USAGE, profileId: 'default', subscriptionType: 'max', fetchedAt: Date.now() + 1_000 } }));
    menu = await effortMenu(user);
    expect(within(menu).getByRole('menuitemradio', { name: /Ultracode/ })).toBeInTheDocument();
  });

  it('uses the account of the session in view, not the active one', async () => {
    const work = { profileId: WORK_PROFILE_ID, loggedIn: true, authMethod: 'claude.ai', email: 'w@example.com', subscriptionType: 'pro' } as const;
    const rendered = await renderApp({ auth: { ...MOCK_AUTH, [WORK_PROFILE_ID]: work } });
    const { user, controller } = rendered;
    await act(async () => {
      await controller.newSession('D:\\work\\fresh', WORK_PROFILE_ID);
    });
    await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
    expect(controller.currentView()?.profileId).toBe(WORK_PROFILE_ID);
    expect(controller.state.activeProfileId).toBe('default');
    const menu = await effortMenu(user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
  });

  it('is hidden on Max when the setting turns workflows off, unless it is already on', async () => {
    // A stored active account, as after any first run, so the start saves nothing of its own.
    const rendered = await renderApp({ settings: { workflows: 'off', activeProfileId: 'default' } });
    const { api, user, controller } = rendered;
    const open = vi.spyOn(api.engine, 'open');
    await takeOverMain(rendered);
    // The choice saved before this start goes with the open.
    expect(open.mock.calls[0]![0]).toMatchObject({ workflows: 'off' });
    let menu = await effortMenu(user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await act(async () => controller.setUltracode(controller.state.currentKey!, true));
    menu = await effortMenu(user);
    expect(within(menu).getByRole('menuitemradio', { name: /Ultracode/ })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('workflow approval card (desktop: name, phases, usage caution)', () => {
  async function withWorkflow(extra: Partial<PermissionRequest> = {}) {
    const rendered = await renderApp({ settings: { workflows: 'on' } });
    const handleId = await takeOverMain(rendered);
    const respond = vi.spyOn(rendered.api.engine, 'respondPermission');
    const request: PermissionRequest = {
      requestId: 'wf-1',
      handleId,
      toolName: 'Workflow',
      displayName: 'Workflow',
      description: 'Two tiny agents in two phases',
      input: { script: SCRIPT },
      toolUseId: 'toolu_01SyntheticWorkflowRun02',
      ...extra,
    };
    act(() => rendered.api.mock.emitEngine({ type: 'permission', request }));
    const card = await screen.findByTestId('permission-card');
    return { ...rendered, card, respond };
  }

  it('names the workflow, lists its phases and the caution, and keeps the script folded', async () => {
    // As main sends it: for a script Claude wrote, the broker adds the session-only rule for every workflow.
    const { card, user, respond } = await withWorkflow({ suggestions: [SESSION_RULE] });
    expect(within(card).getByRole('heading')).toHaveTextContent('Run workflow relay-probe?');
    expect(card).toHaveTextContent('Two tiny agents in two phases');
    const phases = within(card).getByRole('list', { name: 'Phases' });
    expect(within(phases).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1Ask', '2CheckSecond phase']);
    expect(card).toHaveTextContent('A workflow runs many agents and can use a lot of your plan’s usage.');
    expect(card).not.toHaveTextContent('"script"');
    expect(within(card).queryByText('Arguments')).not.toBeInTheDocument();

    const toggle = within(card).getByRole('button', { name: 'Script' });
    const script = card.querySelector<HTMLElement>('.rd-perm__script')!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', script.id);
    expect(script).not.toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Script');
    expect(script).toBeVisible();
    expect(script.textContent).toBe(SCRIPT);
    await user.click(toggle);
    expect(script).not.toBeVisible();

    expect(within(card).getByRole('button', { name: 'Allow for this session' })).toBeInTheDocument();
    // Its buttons stay in view when the body scrolls (sticky, flows.css).
    expect(card).toHaveAttribute('data-workflow', 'true');
    await user.click(within(card).getByRole('button', { name: /Allow once/ }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith('wf-1', { behavior: 'allow', scope: 'once' }));
  });

  it('allows every workflow for the rest of the session from the card', async () => {
    const { card, user, respond } = await withWorkflow({ suggestions: [SESSION_RULE] });
    await user.click(within(card).getByRole('button', { name: 'Allow for this session' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith('wf-1', { behavior: 'allow', scope: 'session' }));
  });

  it('shows everything else the launch receives: arguments, script file, resumed run and the CLI reason', async () => {
    const { card } = await withWorkflow({
      decisionReason: 'This run hides its script; it resumes with its original script file only.',
      input: {
        scriptPath: 'C:\\Users\\u\\.claude\\projects\\p\\s\\workflows\\scripts\\audit-wf_0a1b2c3d-4e5.js',
        resumeFromRunId: 'wf_0a1b2c3d-4e5',
        args: { files: ['a.ts', 'b.ts'], depth: 2 },
      },
    });
    expect(within(card).getByRole('heading')).toHaveTextContent('Run workflow audit?');
    expect(card).toHaveTextContent('This run hides its script; it resumes with its original script file only.');
    expect(card).toHaveTextContent('Script file' + 'C:\\Users\\u\\.claude\\projects\\p\\s\\workflows\\scripts\\audit-wf_0a1b2c3d-4e5.js');
    expect(card).toHaveTextContent('Resumes run' + 'wf_0a1b2c3d-4e5');
    const args = within(card).getByText('Arguments').nextElementSibling;
    expect(args?.textContent).toBe(JSON.stringify({ files: ['a.ts', 'b.ts'], depth: 2 }, null, 2));
    // Without a script there is nothing to unfold.
    expect(within(card).queryByRole('button', { name: 'Script' })).not.toBeInTheDocument();
  });

  it('does not repeat the CLI reason when it is the subtitle already', async () => {
    const { card } = await withWorkflow({ description: undefined, decisionReason: 'Two tiny agents in two phases' });
    expect([...card.querySelectorAll('.rd-perm__sub')].map((p) => p.textContent)).toEqual(['Two tiny agents in two phases']);
  });

  it('offers the session-wide allow for a named workflow the CLI suggests a rule for', async () => {
    const { card, user, respond } = await withWorkflow({
      // Without a description from the CLI the card uses the script's own.
      description: undefined,
      input: { name: 'deep-research', args: { q: 'x' }, script: SCRIPT.replace("name: 'relay-probe'", "name: 'deep-research'") },
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Workflow', ruleContent: 'deep-research' }], behavior: 'allow', destination: 'localSettings' }],
    });
    expect(within(card).getByRole('heading')).toHaveTextContent('Run workflow deep-research?');
    expect(card.querySelector('.rd-perm__sub')).toHaveTextContent('Two tiny agents in two phases');
    await user.click(within(card).getByRole('button', { name: 'Allow for this session' }));
    await waitFor(() => expect(respond).toHaveBeenCalledWith('wf-1', { behavior: 'allow', scope: 'session' }));
  });

  it('falls back to a plain title when the script has no readable meta, and still shows the script', async () => {
    const { card, user } = await withWorkflow({ input: { script: 'const meta = build()' }, description: undefined });
    expect(within(card).getByRole('heading')).toHaveTextContent('Run a workflow?');
    expect(within(card).queryByRole('list', { name: 'Phases' })).not.toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Script' }));
    expect(card.querySelector('.rd-perm__script')?.textContent).toBe('const meta = build()');
  });

  it('leaves other tools as they were', async () => {
    const { card } = await withWorkflow({ toolName: 'Bash', displayName: undefined, description: undefined, input: { command: 'npm test' } });
    expect(within(card).getByRole('heading')).toHaveTextContent('Allow Bash: npm test?');
    expect(within(card).queryByTestId('workflow-approval')).not.toBeInTheDocument();
    expect(card).not.toHaveAttribute('data-workflow');
    expect(card.querySelector('pre')?.textContent).toBe('npm test');
  });
});
