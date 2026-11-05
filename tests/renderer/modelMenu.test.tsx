import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOption } from '@shared/types';
import { menuPosition } from '../../src/renderer/components/ui/Menu';
import {
  MORE_MODELS,
  currentModelName,
  fastIndicator,
  fastRowVisible,
  modelLists,
  modelMenu,
  modelName,
  prettyModel,
} from '../../src/renderer/lib/models';
import { MAIN_SESSION_ID, MOCK_MODELS, MOCK_MODELS_BARE, MOCK_USAGE } from '../../src/renderer/mock/fixtures';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

const OPUS = MOCK_MODELS.find((m) => m.value === 'opus')!;
const SONNET = MOCK_MODELS.find((m) => m.value === 'sonnet')!;
const WITH_CREDITS = { ...MOCK_USAGE, extraUsage: { enabled: true, percent: 10, usedCredits: null, monthlyLimit: null, currency: null } };
const NATIVE_MODELS: ModelOption[] = [
  { value: 'sonnet', label: 'Sonnet 5.5', catalogSource: 'native-config', equivalentValues: ['sonnet', 'claude-sonnet-5-5'] },
  { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'] },
  { value: 'haiku', label: 'Haiku 5.5', catalogSource: 'native-config', equivalentValues: ['haiku', 'claude-haiku-5-5'] },
  { value: 'fable', label: 'Fable 5.1', catalogSource: 'native-config', equivalentValues: ['fable', 'claude-fable-5-1'] },
  { value: 'sonnet[1m]', label: 'Sonnet 5.5 (1M context)', catalogSource: 'native-config', equivalentValues: ['sonnet[1m]', 'claude-sonnet-5-5[1m]'] },
  { value: 'opus[1m]', label: 'Opus 5.5 (1M context)', catalogSource: 'native-config', equivalentValues: ['opus[1m]', 'claude-opus-5-5[1m]'] },
  { value: 'fable[1m]', label: 'Fable 5.1 (1M context)', catalogSource: 'native-config', equivalentValues: ['fable[1m]', 'claude-fable-5-1[1m]'] },
];

const footer = (): HTMLElement => screen.getByTestId('prompt-footer');
const modelButton = (): HTMLElement => footer().querySelector<HTMLElement>('.rd-promptfoot__model')!;
const bolt = (): HTMLElement | null => footer().querySelector<HTMLElement>('.rd-promptfoot__fast');

async function openModelMenu(user: Rendered['user']): Promise<HTMLElement> {
  await user.click(modelButton());
  return screen.findByRole('menu', { name: 'Model' });
}

/** One line per entry: "# header", "---", or "label right-side ✓ > [on|off]". */
function rowsOf(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"], :scope > [role="separator"], :scope > .rd-menu__section')].map((el) => {
    if (el.getAttribute('role') === 'separator') return '---';
    if (el.classList.contains('rd-menu__section')) return `# ${el.textContent}`;
    const label = el.querySelector('.rd-menu__label')!.textContent;
    const right = [...el.querySelectorAll('.rd-menu__right')].map((r) => r.textContent).filter(Boolean).join(' ');
    const marks = [
      el.querySelector('.rd-menu__check') ? '✓' : '',
      el.getAttribute('aria-haspopup') ? '>' : '',
      el.getAttribute('role') === 'menuitemcheckbox' ? `[${el.getAttribute('aria-checked') === 'true' ? 'on' : 'off'}]` : '',
    ];
    return [label, right, ...marks].filter(Boolean).join(' ');
  });
}

async function liveMain(options: Parameters<typeof renderApp>[0] = {}): Promise<Rendered & { handleId: string; key: string }> {
  const rendered = await renderApp(options);
  const handleId = await takeOverMain(rendered);
  const key = rendered.controller.state.currentKey!;
  await waitFor(() => expect(rendered.controller.view(key)?.models.length).toBeGreaterThan(0));
  return { ...rendered, handleId, key };
}

function reportFast(rendered: Rendered, handleId: string, fast: { state: 'off' | 'cooldown' | 'on'; reason?: string }): void {
  const view = rendered.controller.currentView()!;
  act(() => rendered.api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: view.model ?? 'opus', slashCommands: [], tools: [], cwd: view.cwd, fast }));
}

describe('model names (lib/models)', () => {
  it('uses native catalog identity, groups distinct 1M choices and never invents legacy models', () => {
    const menu = modelMenu('claude-opus-5-5', NATIVE_MODELS, 'Default model');
    expect(menu.main).toEqual([
      { value: 'opus', name: 'Opus 5.5' },
      { value: 'fable', name: 'Fable 5.1' },
      { value: 'sonnet', name: 'Sonnet 5.5' },
      { value: 'haiku', name: 'Haiku 5.5' },
    ]);
    expect(menu.more.map((row) => row.value)).toEqual(['opus[1m]', 'fable[1m]', 'sonnet[1m]']);
    expect(menu).toMatchObject({ current: 'Opus 5.5', currentValue: 'opus' });
    const extended = modelMenu('claude-opus-5-5[1m]', NATIVE_MODELS, 'Default model');
    expect(extended).toMatchObject({ current: 'Opus 5.5 (1M context)', currentValue: 'opus[1m]' });
    expect([...extended.main, ...extended.more]).toHaveLength(NATIVE_MODELS.length);
    expect(modelMenu('claude-opus-5-5', [], 'Default model', 'native-config').more).toEqual([]);
    expect(modelLists(NATIVE_MODELS.slice(0, 4)).more).toEqual([]);
  });

  it('retains native custom values and does not equate matching labels or unverified older IDs', () => {
    const custom: ModelOption[] = [
      { value: 'provider/first', label: 'Custom', catalogSource: 'native-config' },
      { value: 'provider/second', label: 'Custom', catalogSource: 'native-config' },
    ];
    const menu = modelMenu('provider/second', custom, 'Default model');
    expect(menu.main.map((row) => row.value)).toEqual(['provider/first', 'provider/second']);
    expect(menu).toMatchObject({ current: 'Custom', currentValue: 'provider/second', more: [] });
    const older = modelMenu('claude-opus-4-8', NATIVE_MODELS, 'Default model');
    expect(older.main.at(-1)).toEqual({ value: 'claude-opus-4-8', name: 'Opus 4.8' });
    expect(older.currentValue).toBe('claude-opus-4-8');
  });

  it('names SDK models and ids the way the desktop menu does', () => {
    // What a Relay session gets (settings loaded): the families, then the older models by full id.
    expect(modelLists(MOCK_MODELS).main).toEqual([
      { value: 'opus', name: 'Opus 5.5' },
      { value: 'fable', name: 'Fable 5.1' },
      { value: 'sonnet', name: 'Sonnet 5.5' },
      { value: 'haiku', name: 'Haiku 5.5' },
    ]);
    expect(modelLists(MOCK_MODELS).more.map((r) => r.name)).toEqual(MORE_MODELS.map((r) => r.name));
    expect(modelLists(MOCK_MODELS).more[0]).toEqual({ value: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' });
    // Older models were once listed twice. Each family keeps only its newest model on top, in the
    // desktop's order whatever order the SDK used.
    const shuffled = [MOCK_MODELS[0]!, MOCK_MODELS[1]!, MOCK_MODELS[3]!, MOCK_MODELS[2]!, ...MOCK_MODELS.slice(4)];
    expect(modelLists(shuffled).main.map((r) => r.name)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(modelLists([MOCK_MODELS[9]!, ...MOCK_MODELS.slice(1, 5)]).main.map((r) => r.name)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(modelLists([{ value: 'x', label: 'Custom' }, ...MOCK_MODELS]).main.map((r) => r.name)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5', 'Custom']);
    // The minor version decides between Fable 5 and Fable 5.1, whichever comes first.
    expect(modelLists([MOCK_MODELS[8]!, MOCK_MODELS[2]!])).toEqual({
      main: [{ value: 'fable', name: 'Fable 5.1' }],
      more: [{ value: 'claude-fable-5', name: 'Fable 5' }],
    });
    // Without settings sources the SDK lists the families only; More models falls back to the desktop's list.
    expect(modelLists(MOCK_MODELS_BARE)).toEqual({
      main: [
        { value: 'opus', name: 'Opus 5.5' },
        { value: 'claude-fable-5-1[1m]', name: 'Fable 5.1' },
        { value: 'sonnet', name: 'Sonnet 5.5' },
        { value: 'haiku', name: 'Haiku 5.5' },
      ],
      more: MORE_MODELS,
    });
    const extra: ModelOption[] = [
      { value: 'best', label: 'Best', description: 'Opus 5.5 · The most capable model available' },
      { value: 'opusplan', label: 'Opus Plan Mode', description: 'Use Opus in plan mode, Sonnet otherwise' },
      { value: 'claude-opus-5-5', label: 'Opus', description: 'Opus 5.5 · Same model by its full id' },
    ];
    expect(modelLists([...MOCK_MODELS_BARE, ...extra]).main.map((r) => r.name)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(modelName({ value: 'x', label: 'Custom', description: 'Quick drafts · cheap' })).toBe('Custom');
    expect(modelName({ value: 'x', label: 'Custom' })).toBe('Custom');

    expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5');
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4');
    expect(prettyModel('claude-sonnet-4-5@20250929')).toBe('Sonnet 4.5');
    expect(prettyModel('opus')).toBe('Opus');
    expect(prettyModel('gpt-x')).toBe('gpt-x');

    expect(currentModelName('opus', MOCK_MODELS)).toBe('Opus 5.5');
    expect(currentModelName(undefined, MOCK_MODELS)).toBe('Opus 5.5');
    expect(currentModelName('default', MOCK_MODELS)).toBe('Opus 5.5');
    expect(currentModelName('claude-opus-5-5[1m]', MOCK_MODELS)).toBe('Opus 5.5');
    expect(currentModelName('claude-opus-4-8', MOCK_MODELS)).toBe('Opus 4.8');
    expect(currentModelName('sonnet', [])).toBe('Sonnet');
    expect(currentModelName(undefined, [])).toBeUndefined();

    expect(MORE_MODELS.map((r) => r.name)).toEqual(['Haiku 4.5', 'Sonnet 5', 'Opus 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 4.6']);
    expect(modelMenu(undefined, [], 'Default model')).toMatchObject({ main: [{ value: 'default', name: 'Default model' }], current: 'Default model' });
    expect(modelMenu('claude-opus-4-8', MOCK_MODELS, 'Default model').main).toHaveLength(4);
    expect(modelMenu('claude-opus-4-1', MOCK_MODELS, 'Default model').main.at(-1)).toEqual({ value: 'claude-opus-4-1', name: 'Opus 4.1' });
  });

  it('decides the fast mode mark and switch', () => {
    expect(fastIndicator(false, { state: 'on' }, OPUS)).toBeNull();
    expect(fastIndicator(true, undefined, OPUS)).toEqual({ state: 'on' });
    expect(fastIndicator(true, undefined, undefined)).toEqual({ state: 'on' });
    expect(fastIndicator(true, { state: 'off', reason: 'sdk_opt_in_required' }, OPUS)).toEqual({ state: 'on' });
    expect(fastIndicator(true, { state: 'cooldown' }, OPUS)).toEqual({ state: 'cooldown' });
    expect(fastIndicator(true, { state: 'off', reason: 'extra_usage_disabled' }, OPUS)).toEqual({ state: 'unavailable', reason: 'extra_usage_disabled' });
    expect(fastIndicator(true, { state: 'on' }, SONNET)).toBeNull();

    expect(fastRowVisible(OPUS, true, false, { state: 'off', reason: 'sdk_opt_in_required' })).toBe(true);
    expect(fastRowVisible(OPUS, false, false, { state: 'off', reason: 'sdk_opt_in_required' })).toBe(false);
    expect(fastRowVisible(OPUS, undefined, true, undefined)).toBe(true);
    expect(fastRowVisible(OPUS, false, false, { state: 'cooldown' })).toBe(true);
    expect(fastRowVisible(OPUS, false, false, { state: 'on' })).toBe(true);
    expect(fastRowVisible(SONNET, true, true, { state: 'on' })).toBe(false);
    expect(fastRowVisible(undefined, true, true, { state: 'on' })).toBe(false);
  });
});

describe('menu position', () => {
  const viewport = { width: 1180, height: 788 };
  const row = { top: 700, bottom: 724, left: 905, right: 1030 };

  it('a submenu opens to the right of its row, to the left when the window has no room, upward near the bottom', () => {
    expect(menuPosition({ ...row, top: 300, bottom: 324, left: 400, right: 525 }, 'right-start', 4, { width: 128, height: 200 }, viewport)).toEqual({ top: 296, left: 529 });
    expect(menuPosition(row, 'right-start', 4, { width: 128, height: 200 }, viewport)).toEqual({ top: 524, left: 1034 });
    expect(menuPosition(row, 'right-start', 4, { width: 260, height: 60 }, viewport)).toEqual({ top: 696, left: 641 });
    expect(menuPosition(row, 'right-start', 4, { width: 260, height: 100 }, viewport)).toEqual({ top: 624, left: 641 });
    // No room on either side: kept inside the window.
    expect(menuPosition({ ...row, left: 100 }, 'right-start', 4, { width: 1100, height: 60 }, viewport)).toEqual({ top: 696, left: 72 });
    // Unmeasured (0): assumed 200 wide, never moved upward.
    expect(menuPosition({ ...row, top: 300, bottom: 324 }, 'right-start', 4, { width: 0, height: 0 }, viewport)).toEqual({ top: 296, left: 701 });
    expect(menuPosition({ top: 750, bottom: 774, left: 900, right: 1005 }, 'top-end', 6, { width: 132, height: 192 }, viewport)).toEqual({ bottom: 44, right: 175 });
  });
});

describe('footer model menu', () => {
  it('ignores a model catalog returned by a closed handle after the same view reopens', async () => {
    const rendered = await liveMain();
    const { api, controller, key, handleId } = rendered;
    let resolveOld!: (models: ModelOption[]) => void;
    const old = new Promise<ModelOption[]>((resolve) => { resolveOld = resolve; });
    const fresh: ModelOption[] = [{ value: 'provider/fresh', label: 'Fresh handle model', catalogSource: 'native-config' }];
    const models = vi.spyOn(api.engine, 'models').mockReturnValueOnce(old).mockResolvedValueOnce(fresh);
    let loading!: Promise<void>;
    act(() => { loading = controller.loadModels(key); });
    expect(models).toHaveBeenCalledWith(handleId);
    await act(async () => controller.closeSession(key));
    await act(async () => controller.openEngine(key, true));
    const nextHandle = controller.view(key)!.handleId!;
    expect(nextHandle).not.toBe(handleId);
    await waitFor(() => expect(controller.view(key)?.models).toEqual(fresh));
    expect(models).toHaveBeenLastCalledWith(nextHandle);

    await act(async () => { resolveOld([{ value: 'provider/stale', label: 'Old handle model' }]); await loading; });
    expect(controller.view(key)?.models).toEqual(fresh);
    expect(controller.state.modelCatalog.default).toEqual(fresh);
    expect(JSON.stringify(controller.state.modelCatalog)).not.toContain('provider/stale');
  });

  it('renders native alias catalog without a duplicate current model and preserves exact pending 1M intent', async () => {
    const rendered = await renderApp({}, (api) => { vi.spyOn(api.engine, 'models').mockResolvedValue(NATIVE_MODELS); });
    const handleId = await takeOverMain(rendered);
    const { api, user, controller } = rendered;
    await waitFor(() => expect(controller.currentView()?.models).toEqual(NATIVE_MODELS));
    const view = controller.currentView()!;
    act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: 'claude-opus-5-5', slashCommands: [], tools: [], cwd: view.cwd }));
    const setModel = vi.spyOn(api.engine, 'setModel');
    const setEffort = vi.spyOn(api.engine, 'setEffort');
    const effort = controller.currentView()?.effort;
    let menu = await openModelMenu(user);
    const choices = within(menu).getAllByRole('menuitemradio');
    expect(choices.map((row) => row.querySelector('.rd-menu__label')?.textContent)).toEqual(['Opus 5.5', 'Fable 5.1', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(choices.filter((row) => row.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(within(menu).getByRole('menuitemradio', { name: 'Opus 5.5' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitem', { name: 'More models' }));
    const more = await screen.findByRole('menu', { name: 'More models' });
    expect(rowsOf(more)).toEqual(['Opus 5.5 (1M context)', 'Fable 5.1 (1M context)', 'Sonnet 5.5 (1M context)']);
    expect(setModel).not.toHaveBeenCalled();
    expect(setEffort).not.toHaveBeenCalled();
    expect(controller.currentView()?.model).toBe('claude-opus-5-5');
    expect(controller.currentView()?.effort).toBe(effort);
    await user.keyboard('{Escape}{Escape}');

    await act(async () => controller.closeSession(view.key));
    menu = await openModelMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: 'More models' }));
    await user.click(within(await screen.findByRole('menu', { name: 'More models' })).getByRole('menuitemradio', { name: 'Opus 5.5 (1M context)' }));
    expect(controller.currentView()?.model).toBe('opus[1m]');
    expect(controller.currentView()?.effort).toBe(effort);
    expect(setModel).not.toHaveBeenCalled();
    expect(setEffort).not.toHaveBeenCalled();
  });

  it('one button shows the model and the muted effort; the menu has the desktop rows, numbers and the check', async () => {
    const { api, user, handleId } = await liveMain();
    expect(footer().querySelectorAll('.rd-promptfoot__btn')).toHaveLength(2);
    expect(modelButton()).toHaveAccessibleName('Opus 5.5 Default effort');
    expect(modelButton().querySelector('.rd-promptfoot__effort')).toHaveTextContent('Default effort');
    expect(bolt()).toBeNull();
    const menu = await openModelMenu(user);
    expect(modelButton()).toHaveAttribute('aria-expanded', 'true');
    expect(rowsOf(menu)).toEqual([
      '# Model · this session',
      'Opus 5.5 ✓',
      'Fable 5.1 2',
      'Sonnet 5.5 3',
      'Haiku 5.5 4',
      '---',
      'Effort Default effort >',
      '---',
      'More models >',
    ]);
    expect(within(menu).getByRole('menuitemradio', { name: 'Opus 5.5' })).toHaveAttribute('aria-checked', 'true');

    const setModel = vi.spyOn(api.engine, 'setModel');
    await user.keyboard('3');
    expect(setModel).toHaveBeenCalledWith(handleId, 'sonnet');
    expect(screen.queryByRole('menu', { name: 'Model' })).not.toBeInTheDocument();
    expect(modelButton()).toHaveAccessibleName('Sonnet 5.5 Default effort');
    expect(rowsOf(await openModelMenu(user)).slice(1, 5)).toEqual(['Opus 5.5 1', 'Fable 5.1 2', 'Sonnet 5.5 ✓', 'Haiku 5.5 4']);
  });

  it('the Effort row opens the levels with Ultracode; a level closes the whole menu', async () => {
    const { api, user, handleId } = await liveMain();
    const setEffort = vi.spyOn(api.engine, 'setEffort');
    const menu = await openModelMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /^Effort/ }));
    const levels = await screen.findByRole('menu', { name: 'Effort' });
    expect(within(levels).getAllByRole('menuitemradio').map((el) => el.querySelector('.rd-menu__label')!.firstChild!.textContent)).toEqual([
      'Low',
      'Medium',
      'High',
      'Extra',
      'Max',
      'Ultracode',
    ]);
    await user.click(within(levels).getByRole('menuitemradio', { name: 'High' }));
    expect(setEffort).toHaveBeenCalledWith(handleId, 'high');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(modelButton()).toHaveAccessibleName('Opus 5.5 High');
    expect(rowsOf(await openModelMenu(user))).toContain('Effort High >');
  });

  it('More models lists the older desktop models; a pick is sent by its full id and checked there', async () => {
    const rendered = await liveMain();
    const { api, user, handleId } = rendered;
    const setModel = vi.spyOn(api.engine, 'setModel');
    let menu = await openModelMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /^More models/ }));
    let more = await screen.findByRole('menu', { name: 'More models' });
    expect(rowsOf(more)).toEqual(MORE_MODELS.map((r) => r.name));
    await user.click(within(more).getByRole('menuitemradio', { name: 'Opus 4.8' }));
    expect(setModel).toHaveBeenCalledWith(handleId, 'claude-opus-4-8');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(modelButton()).toHaveAccessibleName('Opus 4.8 Default effort');

    menu = await openModelMenu(user);
    expect(rowsOf(menu).slice(1, 5)).toEqual(['Opus 5.5 1', 'Fable 5.1 2', 'Sonnet 5.5 3', 'Haiku 5.5 4']);
    await user.click(within(menu).getByRole('menuitem', { name: /^More models/ }));
    more = await screen.findByRole('menu', { name: 'More models' });
    expect(rowsOf(more)).toContain('Opus 4.8 ✓');
    await user.keyboard('{Escape}{Escape}');

    // The CLI reports a full id for an alias: the alias row still carries the check.
    reportFast(rendered, handleId, { state: 'off', reason: 'sdk_opt_in_required' });
    const view = rendered.controller.currentView()!;
    act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: 'claude-opus-5-5[1m]', slashCommands: [], tools: [], cwd: view.cwd }));
    expect(modelButton()).toHaveAccessibleName('Opus 5.5 Default effort');
    expect(rowsOf(await openModelMenu(user))[1]).toBe('Opus 5.5 ✓');
  });

  it('Ctrl+Shift+E opens the same menu with the Effort submenu showing; Ctrl+Shift+I opens it without', async () => {
    const { user, controller } = await liveMain();
    fireEvent.keyDown(window, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });
    const levels = await screen.findByRole('menu', { name: 'Effort' });
    expect(screen.getByRole('menu', { name: 'Model' })).toBeInTheDocument();
    expect(controller.state.ui.footerMenu).toBe('effort');
    expect(modelButton()).toHaveAttribute('aria-expanded', 'true');
    expect(levels).toHaveFocus();
    expect(within(screen.getByRole('menu', { name: 'Model' })).getByRole('menuitem', { name: /^Effort/ })).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: 'Effort' })).not.toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Model' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'I', code: 'KeyI', ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole('menu', { name: 'Model' })).toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Effort' })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole('menu', { name: 'Effort' })).toBeInTheDocument();
  });

  it('the fast mode switch shows for a fast model when usage credits are on; it toggles with the menu left open', async () => {
    const { api, user, handleId, controller, key } = await liveMain({ usage: WITH_CREDITS });
    const live = vi.spyOn(api.engine, 'setFastMode');
    const menu = await openModelMenu(user);
    expect(rowsOf(menu).slice(-2)).toEqual(['---', 'Fast mode [off]']);
    const row = within(menu).getByRole('menuitemcheckbox', { name: 'Fast mode' });
    expect(row).toHaveAttribute('data-tip', 'Faster Opus output, billed to usage credits');
    await user.click(row);
    expect(live).toHaveBeenLastCalledWith(handleId, true);
    expect(screen.getByRole('menu', { name: 'Model' })).toBe(menu);
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(controller.view(key)?.fastMode).toBe(true);
    expect(within(footer()).getByRole('img', { name: 'Fast mode on' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(live).toHaveBeenLastCalledWith(handleId, false);
    expect(row).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('menu', { name: 'Model' })).toBeInTheDocument();
    expect(bolt()).toBeNull();
    await user.keyboard('{Escape}');

    await act(async () => controller.setModel(key, 'sonnet'));
    expect(rowsOf(await openModelMenu(user))).not.toContain('Fast mode [off]');
  });

  it('offers a genuine native Fast control on first use without SDK model/credit metadata and does not invent serving speed', async () => {
    const rendered = await liveMain();
    const { api, user, controller, handleId } = rendered;
    const native = (requested: boolean, locked = false, status?: 'cooldown' | 'on') => {
      const view = controller.currentView()!;
      act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: 'sonnet', slashCommands: [], tools: [], cwd: view.cwd,
        nativeFast: { source: 'native-config', available: true, requested, locked, label: 'Fast mode (Opus 5.5)', ...(!requested ? { state: 'off' as const } : {}) },
        ...(status ? { fast: { state: status } } : {}),
      }));
    };
    native(false);
    expect(controller.currentView()?.fastMode).toBe(false);
    const menu = await openModelMenu(user);
    const row = within(menu).getByRole('menuitemcheckbox', { name: 'Fast mode (Opus 5.5)' });
    expect(row).toHaveAttribute('aria-checked', 'false');
    const live = vi.spyOn(api.engine, 'setFastMode').mockImplementation(async (_handle, requested) => native(requested));
    await user.click(row);
    expect(live).toHaveBeenCalledWith(handleId, true);
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(bolt()).toBeNull();
    native(true, false, 'cooldown'); expect(bolt()).toHaveAttribute('data-state', 'cooldown');
    native(true, false, 'on'); expect(bolt()).toHaveAttribute('data-state', 'on');
    native(false, true); expect(row).toHaveAttribute('aria-checked', 'false'); expect(row).toHaveAttribute('aria-disabled', 'true');
    await user.click(row); expect(live).toHaveBeenCalledTimes(1);
    const view = controller.currentView()!;
    act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: 'sonnet', slashCommands: [], tools: [], cwd: view.cwd,
      nativeFast: { source: 'native-config', available: false } }));
    expect(within(menu).queryByRole('menuitemcheckbox', { name: /Fast mode/ })).toBeNull();
  });

  it('uses editable pending Fast intent after a native handle closes instead of stale readback or locks', async () => {
    const { api, user, controller, handleId, key } = await liveMain();
    const view = controller.currentView()!;
    act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model: 'sonnet', slashCommands: [], tools: [], cwd: view.cwd,
      nativeFast: { source: 'native-config', available: true, requested: true, locked: true, label: 'Fast mode (Opus 5.5)' }, fast: { state: 'on' } }));
    act(() => api.mock.emitEngine({ type: 'state', handleId, state: 'closed' }));
    const live = vi.spyOn(api.engine, 'setFastMode');
    const menu = await openModelMenu(user);
    const row = within(menu).getByRole('menuitemcheckbox', { name: 'Fast mode (Opus 5.5)' });
    expect(row).not.toHaveAttribute('aria-disabled', 'true');
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(bolt()).toBeNull();
    await user.click(row);
    expect(controller.view(key)?.fastMode).toBe(false);
    expect(row).toHaveAttribute('aria-checked', 'false');
    await user.click(row);
    expect(controller.view(key)?.fastMode).toBe(true);
    expect(row).toHaveAttribute('aria-checked', 'true');
    expect(live).not.toHaveBeenCalled();
  });

  it('without usage credits the switch shows only while fast mode is asked for, and stays until the menu closes', async () => {
    const { user, controller, key } = await liveMain();
    expect(rowsOf(await openModelMenu(user)).at(-1)).toBe('More models >');
    await user.keyboard('{Escape}');
    await act(async () => controller.setFastMode(key, true));
    const menu = await openModelMenu(user);
    expect(rowsOf(menu).at(-1)).toBe('Fast mode [on]');
    await user.click(within(menu).getByRole('menuitemcheckbox', { name: 'Fast mode' }));
    expect(controller.view(key)?.fastMode).toBe(false);
    expect(rowsOf(menu).at(-1)).toBe('Fast mode [off]');
    await user.keyboard('{Escape}');
    expect(rowsOf(await openModelMenu(user)).at(-1)).toBe('More models >');
  });

  it('the footer bolt is on, gray while cooling down, and struck with the reason when the CLI refuses', async () => {
    const rendered = await liveMain({ fastBlockedReason: 'extra_usage_disabled' });
    const { controller, key, handleId } = rendered;
    await act(async () => controller.setFastMode(key, true));
    await waitFor(() => expect(bolt()).toHaveAttribute('data-state', 'unavailable'));
    expect(bolt()).toHaveAccessibleName('Fast mode is unavailable: usage credits are turned off');
    expect(bolt()).toHaveAttribute('data-tip', 'Fast mode is unavailable: usage credits are turned off');
    expect(bolt()!.querySelector('.lucide-zap-off')).not.toBeNull();
    // The bolt sits right after the model name, before the effort.
    expect([...modelButton().children].map((el) => el.className)).toEqual(['rd-promptfoot__name', 'rd-promptfoot__fast', 'rd-promptfoot__effort']);

    reportFast(rendered, handleId, { state: 'cooldown' });
    expect(bolt()).toHaveAttribute('data-state', 'cooldown');
    expect(bolt()).toHaveAccessibleName('Fast mode is cooling down after a rate limit; standard speed meanwhile');
    reportFast(rendered, handleId, { state: 'on' });
    expect(bolt()).toHaveAttribute('data-state', 'on');
    expect(bolt()).toHaveAccessibleName('Fast mode on');
    expect(bolt()!.querySelector('.lucide-zap')).not.toBeNull();
    reportFast(rendered, handleId, { state: 'off', reason: 'sdk_opt_in_required' });
    expect(bolt()).toHaveAttribute('data-state', 'on');
    reportFast(rendered, handleId, { state: 'off', reason: 'brand_new_reason' });
    expect(bolt()).toHaveAccessibleName('Fast mode is unavailable: brand_new_reason');

    await act(async () => controller.setModel(key, 'sonnet'));
    expect(bolt()).toBeNull();
    await act(async () => controller.setModel(key, 'opus'));
    expect(bolt()).not.toBeNull();
    await act(async () => controller.setFastMode(key, false));
    expect(bolt()).toBeNull();
  });

  it('a closed view offers the account’s last model list and keeps a pick and a level for the open', async () => {
    const rendered = await renderApp();
    const { api, user, controller } = rendered;
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    expect(modelButton()).toHaveAccessibleName('Default model Default effort');
    expect(rowsOf(await openModelMenu(user))).toEqual([
      '# Model · this session',
      'Default model ✓',
      '---',
      'Effort Default effort >',
      '---',
      'More models >',
    ]);
    await user.keyboard('{Escape}');

    await takeOverMain(rendered);
    await waitFor(() => expect(controller.state.modelCatalog.default).toHaveLength(MOCK_MODELS.length));
    await user.click(within(sidebar()).getByRole('button', { name: 'Finish the open tasks' }));
    await screen.findByTestId('readonly-note');
    const key = controller.state.currentKey!;
    expect(controller.view(key)?.models).toEqual([]);
    const setModel = vi.spyOn(api.engine, 'setModel');
    const setEffort = vi.spyOn(api.engine, 'setEffort');
    let menu = await openModelMenu(user);
    expect(rowsOf(menu).slice(1, 5)).toEqual(['Opus 5.5 ✓', 'Fable 5.1 2', 'Sonnet 5.5 3', 'Haiku 5.5 4']);
    await user.click(within(menu).getByRole('menuitemradio', { name: /^Fable 5\.1/ }));
    expect(controller.view(key)?.model).toBe('fable');
    expect(modelButton()).toHaveAccessibleName('Fable 5.1 Default effort');
    menu = await openModelMenu(user);
    await user.click(within(menu).getByRole('menuitem', { name: /^Effort/ }));
    const high = within(await screen.findByRole('menu', { name: 'Effort' })).getByRole('menuitemradio', { name: 'High Recommended' });
    expect(high).not.toHaveAttribute('aria-disabled');
    await user.click(high);
    expect(controller.view(key)?.effort).toBe('high');
    expect(setModel).not.toHaveBeenCalled();
    expect(setEffort).not.toHaveBeenCalled();

    const open = vi.spyOn(api.engine, 'open');
    const took = controller.takeOver(key);
    await waitFor(() => expect(controller.state.takeover).not.toBeNull());
    act(() => controller.confirmTakeover());
    await act(async () => { await took; });
    expect(open.mock.calls.at(-1)![0]).toMatchObject({ model: 'fable', effort: 'high' });
    expect(open.mock.calls.at(-1)![0].resumeSessionId).not.toBe(MAIN_SESSION_ID);
  });
});
