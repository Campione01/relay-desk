import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EffortGuide, ModelOption } from '@shared/types';
import { createTranslator } from '../../src/renderer/i18n';
import { effortGuideDescription, effortGuideFor, localizeGuideText } from '../../src/renderer/lib/effortGuide';
import { MOCK_MODELS } from '../../src/renderer/mock/fixtures';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

// The CLI model catalog's texts.
const DESCRIPTION = 'Higher effort means more thorough responses, but takes longer and uses your limits faster.';
const MAX_TIP = 'May use excessive tokens resulting in long response times and may hit token limits. Use sparingly for the hardest tasks.';
const OPUS_MAX_TIP = 'Claude thinks longer with Max effort and can consume 3.5× or more usage than Medium.';

const OPUS_GUIDE: EffortGuide = {
  description: DESCRIPTION,
  levels: {
    medium: { badge: { message: 'Recommended', tone: 'neutral' } },
    max: { badge: { message: '3.5× or more usage', tone: 'warning' }, tooltip: OPUS_MAX_TIP },
  },
};
const FABLE_GUIDE: EffortGuide = {
  description: DESCRIPTION,
  levels: { high: { badge: { message: 'Recommended', tone: 'neutral' } }, max: { tooltip: MAX_TIP } },
};
const NATIVE: ModelOption[] = [
  { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'], effortGuide: OPUS_GUIDE },
  { value: 'fable', label: 'Fable 5.1', catalogSource: 'native-config', equivalentValues: ['fable', 'claude-fable-5-1'], effortGuide: FABLE_GUIDE },
  { value: 'opus[1m]', label: 'Opus 5.5 (1M context)', catalogSource: 'native-config', equivalentValues: ['opus[1m]', 'claude-opus-5-5[1m]'] },
  { value: 'provider/custom', label: 'Custom', catalogSource: 'native-config' },
];

const en = createTranslator('en');
const zh = createTranslator('zh-TW');

describe('effort guide (lib/effortGuide)', () => {
  it('finds the current model’s notes, the base model’s for a 1M id, and none for the CLI default', () => {
    expect(effortGuideFor('claude-opus-5-5', NATIVE)).toBe(OPUS_GUIDE);
    expect(effortGuideFor('fable', NATIVE)).toBe(FABLE_GUIDE);
    // opus[1m] is listed without notes of its own; fable[1m] is not listed at all.
    expect(effortGuideFor('claude-opus-5-5[1m]', NATIVE)).toBe(OPUS_GUIDE);
    expect(effortGuideFor('opus[1m]', NATIVE)).toBe(OPUS_GUIDE);
    expect(effortGuideFor('claude-fable-5-1[1m]', NATIVE)).toBe(FABLE_GUIDE);
    const ownNotes: EffortGuide = { levels: { low: { tooltip: 'Own notes' } } };
    expect(effortGuideFor('opus[1m]', NATIVE.map((o) => (o.value === 'opus[1m]' ? { ...o, effortGuide: ownNotes } : o)))).toBe(ownNotes);

    expect(effortGuideFor(undefined, NATIVE)).toBeUndefined();
    expect(effortGuideFor('default', NATIVE)).toBeUndefined();
    expect(effortGuideFor('provider/custom', NATIVE)).toBeUndefined();
    expect(effortGuideFor('claude-opus-4-8[1m]', NATIVE)).toBeUndefined();
    expect(effortGuideFor('claude-opus-5-5', [])).toBeUndefined();

    // The SDK's list: the default entry carries notes only when the main process gave it some.
    const sdk: ModelOption[] = [
      { value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { value: 'opus', label: 'Opus 5.5', description: 'For complex work', effortGuide: OPUS_GUIDE },
    ];
    expect(effortGuideFor(undefined, sdk)).toBeUndefined();
    expect(effortGuideFor('claude-opus-5-5[1m]', sdk)).toBe(OPUS_GUIDE);
    expect(effortGuideFor('default', [{ ...sdk[0]!, effortGuide: FABLE_GUIDE }, sdk[1]!])).toBe(FABLE_GUIDE);
  });

  it('describes the levels with the current model’s line, else the line every model with notes shares', () => {
    expect(effortGuideDescription(OPUS_GUIDE, NATIVE)).toBe(DESCRIPTION);
    expect(effortGuideDescription({ description: 'Own line', levels: {} }, NATIVE)).toBe('Own line');
    // A model with notes but no line does not borrow another model's.
    expect(effortGuideDescription({ levels: {} }, NATIVE)).toBeUndefined();

    expect(effortGuideDescription(undefined, NATIVE)).toBe(DESCRIPTION);
    expect(effortGuideDescription(undefined, [])).toBeUndefined();
    expect(effortGuideDescription(undefined, [{ value: 'x', label: 'X' }])).toBeUndefined();
    const differing = [...NATIVE, { value: 'y', label: 'Y', effortGuide: { description: 'Another line', levels: {} } }];
    expect(effortGuideDescription(undefined, differing)).toBeUndefined();
    const missing = [...NATIVE, { value: 'y', label: 'Y', effortGuide: { levels: {} } }];
    expect(effortGuideDescription(undefined, missing)).toBeUndefined();
  });

  it('translates the known catalog texts, with the usage multiple the catalog gives', () => {
    expect(localizeGuideText(DESCRIPTION, en)).toBe(DESCRIPTION);
    expect(localizeGuideText('Recommended', en)).toBe('Recommended');
    expect(localizeGuideText('3.5× or more usage', en)).toBe('3.5× or more usage');
    expect(localizeGuideText(OPUS_MAX_TIP, en)).toBe(OPUS_MAX_TIP);
    expect(localizeGuideText(MAX_TIP, en)).toBe(MAX_TIP);

    expect(localizeGuideText(DESCRIPTION, zh)).toBe('強度越高，回應越周全，但需要較長時間，也會更快用掉額度。');
    expect(localizeGuideText('Recommended', zh)).toBe('建議');
    expect(localizeGuideText('3.5× or more usage', zh)).toBe('用量 3.5 倍以上');
    expect(localizeGuideText('4× or more usage', zh)).toBe('用量 4 倍以上');
    expect(localizeGuideText(OPUS_MAX_TIP, zh)).toBe('最高強度會讓 Claude 思考更久，用量可能是「中」的 3.5 倍以上。');
    expect(localizeGuideText('Claude thinks longer with Max effort and can consume 4× or more usage than Medium.', zh))
      .toBe('最高強度會讓 Claude 思考更久，用量可能是「中」的 4 倍以上。');
    expect(localizeGuideText(MAX_TIP, zh)).toBe('可能耗用大量 token，回應時間會變長，也可能達到 token 上限。請只用在最困難的任務。');
  });

  it('shows a text the catalog added later, or a variant of a known one, as the catalog wrote it', () => {
    for (const text of [
      'New',
      'Experimental',
      '3.5x or more usage',
      'About 3.5× or more usage',
      '3.5× or more usage today',
      'Recommended for long tasks',
      'Claude thinks longer with Max effort and can consume many× or more usage than Medium.',
      'constructor',
    ]) {
      expect(localizeGuideText(text, zh)).toBe(text);
    }
  });
});

const footer = (): HTMLElement => screen.getByTestId('prompt-footer');

/** Opens the footer's model menu and its Effort submenu, by the names of the UI language. */
async function openEffort(user: Rendered['user'], names = { model: 'Model', effort: 'Effort' }): Promise<HTMLElement> {
  await user.click(footer().querySelector<HTMLElement>('.rd-promptfoot__model')!);
  const menu = await screen.findByRole('menu', { name: names.model });
  await user.click(within(menu).getByRole('menuitem', { name: new RegExp(`^${names.effort}`) }));
  return screen.findByRole('menu', { name: names.effort });
}

/** One line per entry: "# section", "---", or the label with its badge in brackets. */
function rowsOf(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"], :scope > [role="separator"], :scope > .rd-menu__section')].map((el) => {
    if (el.getAttribute('role') === 'separator') return '---';
    if (el.classList.contains('rd-menu__section')) return `# ${el.textContent}`;
    const badge = el.querySelector('.rd-menu__badge');
    return [el.querySelector('.rd-menu__label')!.firstChild!.textContent, badge ? `[${badge.textContent}]` : ''].filter(Boolean).join(' ');
  });
}

const levelTips = (menu: HTMLElement): Array<string | null> =>
  within(menu).getAllByRole('menuitemradio').slice(0, 5).map((row) => row.getAttribute('data-tip'));

/** What a screen reader gets in place of the hover text. */
const levelDescriptions = (menu: HTMLElement): Array<string | null> =>
  within(menu).getAllByRole('menuitemradio').slice(0, 5).map((row) => row.getAttribute('aria-description'));

async function liveMain(beforeStart?: Parameters<typeof renderApp>[1]): Promise<Rendered & { key: string; handleId: string }> {
  const rendered = await renderApp({}, beforeStart);
  const handleId = await takeOverMain(rendered);
  const key = rendered.controller.state.currentKey!;
  await waitFor(() => expect(rendered.controller.view(key)?.models.length).toBeGreaterThan(0));
  return { ...rendered, key, handleId };
}

describe('the Effort submenu shows the CLI model catalog’s notes', () => {
  it('Opus 5.5: the catalog’s line first, Medium recommended, Max with its usage warning and hover text', async () => {
    const { api, user, handleId } = await liveMain();
    const levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual([
      `# ${DESCRIPTION}`,
      'Low',
      'Medium [Recommended]',
      'High',
      'Extra',
      'Max [3.5× or more usage]',
      '---',
      'Ultracode',
    ]);
    expect(levels.firstElementChild).toHaveClass('rd-menu__section');
    const medium = within(levels).getByRole('menuitemradio', { name: 'Medium Recommended' });
    expect(medium.querySelector('.rd-menu__badge')).toHaveClass('rd-badge');
    expect(medium.querySelector('.rd-menu__badge')).not.toHaveClass('rd-badge--warning');
    const max = within(levels).getByRole('menuitemradio', { name: 'Max 3.5× or more usage' });
    expect(max.querySelector('.rd-menu__badge')).toHaveClass('rd-badge', 'rd-badge--warning');
    expect(levelTips(levels)).toEqual([null, null, null, null, OPUS_MAX_TIP]);

    // Without a mouse: the line describes the levels menu, the hover text its row; the model menu's header is only a header.
    expect(levels).toHaveAccessibleDescription(DESCRIPTION);
    expect(max).toHaveAccessibleDescription(OPUS_MAX_TIP);
    expect(levelDescriptions(levels)).toEqual([null, null, null, null, OPUS_MAX_TIP]);
    const model = screen.getByRole('menu', { name: 'Model' });
    expect(model).not.toHaveAttribute('aria-describedby');
    expect(model).not.toHaveAccessibleDescription();

    // The line is not a row: the digits still pick the levels in order.
    await user.keyboard('{Escape}{Escape}');
    const setEffort = vi.spyOn(api.engine, 'setEffort');
    fireEvent.keyDown(window, { key: 'E', code: 'KeyE', ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole('menu', { name: 'Effort' })).toHaveFocus();
    await user.keyboard('2');
    expect(setEffort).toHaveBeenCalledWith(handleId, 'medium');
  });

  it('Fable 5.1 recommends High; Sonnet 5.5 recommends Medium and keeps why Max is unavailable as its hover text', async () => {
    const { user, controller, key } = await liveMain();
    await act(async () => controller.setModel(key, 'fable'));
    let levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual([`# ${DESCRIPTION}`, 'Low', 'Medium', 'High [Recommended]', 'Extra', 'Max', '---', 'Ultracode']);
    expect(within(levels).getByRole('menuitemradio', { name: 'High Recommended' }).querySelector('.rd-menu__badge')).not.toHaveClass('rd-badge--warning');
    expect(levelTips(levels)).toEqual([null, null, null, null, MAX_TIP]);
    await user.keyboard('{Escape}{Escape}');

    await act(async () => controller.setModel(key, 'sonnet'));
    levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual([`# ${DESCRIPTION}`, 'Low', 'Medium [Recommended]', 'High', 'Extra', 'Max', '---', 'Ultracode']);
    expect(within(levels).getByRole('menuitemradio', { name: 'Max' })).toHaveAttribute('aria-disabled', 'true');
    const unsupported = 'The current model does not support this level';
    expect(levelTips(levels)).toEqual([null, null, null, unsupported, unsupported]);
    expect(levelDescriptions(levels)).toEqual([null, null, null, unsupported, unsupported]);
  });

  it('a level the model does not support shows no badge, only why it is unavailable', async () => {
    const models = MOCK_MODELS.map((option): ModelOption => (option.value === 'opus' ? { ...option, effortLevels: ['low', 'medium', 'high'] } : option));
    const { user } = await liveMain((api) => { vi.spyOn(api.engine, 'models').mockResolvedValue(models); });
    const levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual([`# ${DESCRIPTION}`, 'Low', 'Medium [Recommended]', 'High', 'Extra', 'Max', '---', 'Ultracode']);
    const max = within(levels).getByRole('menuitemradio', { name: 'Max' });
    expect(max).toHaveAttribute('aria-disabled', 'true');
    expect(max.querySelector('.rd-menu__badge')).toBeNull();
    expect(max).toHaveAccessibleDescription('The current model does not support this level');
  });

  it('a model without notes gets the shared line only; one without effort and a catalog without notes get none', async () => {
    const { user, controller, key } = await liveMain();
    await act(async () => controller.setModel(key, 'claude-opus-4-8'));
    let levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual([`# ${DESCRIPTION}`, 'Low', 'Medium', 'High', 'Extra', 'Max', '---', 'Ultracode']);
    expect(levels.querySelector('.rd-menu__badge')).toBeNull();
    expect(levelTips(levels)).toEqual([null, null, null, null, null]);
    await user.keyboard('{Escape}{Escape}');

    // Haiku 5.5 has notes in the catalog, but this list says it has no effort levels.
    await act(async () => controller.setModel(key, 'haiku'));
    levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual(['Low', 'Medium', 'High', 'Extra', 'Max']);
    expect(levels.querySelector('.rd-menu__badge')).toBeNull();
  });

  it('the CLI default is not guessed: the shared line only until the CLI reports which model it is', async () => {
    const { api, user, controller, key, handleId } = await liveMain();
    const lineOnly = [`# ${DESCRIPTION}`, 'Low', 'Medium', 'High', 'Extra', 'Max', '---', 'Ultracode'];
    const expectLineOnly = (levels: HTMLElement): void => {
      expect(rowsOf(levels)).toEqual(lineOnly);
      expect(levels).toHaveAccessibleDescription(DESCRIPTION);
      expect(levelTips(levels)).toEqual([null, null, null, null, null]);
      expect(levelDescriptions(levels)).toEqual([null, null, null, null, null]);
    };
    const report = (model: string): void => {
      const view = controller.view(key)!;
      act(() => api.mock.emitEngine({ type: 'init', handleId, sessionId: view.sessionId!, model, slashCommands: [], tools: [], cwd: view.cwd }));
    };
    // The list's other models have notes; its 'default' entry has none.
    expect(controller.view(key)?.models.some((option) => option.value === 'default' && !option.effortGuide)).toBe(true);
    report('default');
    expectLineOnly(await openEffort(user));
    await user.keyboard('{Escape}{Escape}');

    report('claude-opus-5-5');
    let levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual([`# ${DESCRIPTION}`, 'Low', 'Medium [Recommended]', 'High', 'Extra', 'Max [3.5× or more usage]', '---', 'Ultracode']);
    expect(levelDescriptions(levels)).toEqual([null, null, null, null, OPUS_MAX_TIP]);
    await user.keyboard('{Escape}{Escape}');

    // A closed view has reported no model: the account's last list stands in, with the same line only.
    await user.click(within(sidebar()).getByRole('button', { name: 'Finish the open tasks' }));
    await screen.findByTestId('readonly-note');
    expect(controller.currentView()?.key).not.toBe(key);
    expect(controller.currentView()?.model).toBeUndefined();
    levels = await openEffort(user);
    expectLineOnly(levels);
  });

  it('a model list without notes leaves the levels as they were', async () => {
    const plain: ModelOption[] = [
      { value: 'opus', label: 'Opus 5.5', catalogSource: 'native-config', equivalentValues: ['opus', 'claude-opus-5-5'] },
      { value: 'fable', label: 'Fable 5.1', catalogSource: 'native-config', equivalentValues: ['fable', 'claude-fable-5-1'] },
    ];
    const { user } = await liveMain((api) => { vi.spyOn(api.engine, 'models').mockResolvedValue(plain); });
    const levels = await openEffort(user);
    expect(rowsOf(levels)).toEqual(['Low', 'Medium', 'High', 'Extra', 'Max', '---', 'Ultracode']);
    expect(levels.querySelector('.rd-menu__section, .rd-menu__badge')).toBeNull();
    expect(levels).not.toHaveAttribute('aria-describedby');
    expect(levelTips(levels)).toEqual([null, null, null, null, null]);
    expect(within(levels).getByRole('menuitemradio', { name: 'Medium' })).toBeInTheDocument();
  });

  it('speaks Taiwan Mandarin', async () => {
    const { user, controller, key } = await liveMain();
    await act(async () => controller.updateSettings({ language: 'zh-TW' }));
    const names = { model: '模型', effort: '思考強度' };
    let levels = await openEffort(user, names);
    expect(rowsOf(levels)).toEqual([
      '# 強度越高，回應越周全，但需要較長時間，也會更快用掉額度。',
      '低',
      '中 [建議]',
      '高',
      '超高',
      '最高 [用量 3.5 倍以上]',
      '---',
      'Ultracode',
    ]);
    expect(levels).toHaveAccessibleDescription('強度越高，回應越周全，但需要較長時間，也會更快用掉額度。');
    expect(within(levels).getByRole('menuitemradio', { name: '中 建議' })).toBeInTheDocument();
    const max = within(levels).getByRole('menuitemradio', { name: '最高 用量 3.5 倍以上' });
    expect(max).toHaveAttribute('data-tip', '最高強度會讓 Claude 思考更久，用量可能是「中」的 3.5 倍以上。');
    expect(max).toHaveAccessibleDescription('最高強度會讓 Claude 思考更久，用量可能是「中」的 3.5 倍以上。');
    await user.keyboard('{Escape}{Escape}');

    await act(async () => controller.setModel(key, 'fable'));
    levels = await openEffort(user, names);
    expect(within(levels).getByRole('menuitemradio', { name: '高 建議' })).toBeInTheDocument();
    expect(within(levels).getByRole('menuitemradio', { name: '最高' })).toHaveAttribute(
      'data-tip',
      '可能耗用大量 token，回應時間會變長，也可能達到 token 上限。請只用在最困難的任務。',
    );
  });
});
