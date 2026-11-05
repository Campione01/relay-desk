import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_SESSION_ID, renderApp, sidebar, takeOverMain } from './helpers';

const footer = (): HTMLElement => screen.getByTestId('prompt-footer');
const effortButton = (): HTMLElement => within(footer()).getByRole('button', { expanded: false, name: /effort|Low|Medium|High|Extra|Max/ });

/** The effort levels are a submenu of the footer's model menu (one button for model and effort, as in the desktop). */
async function openEffortMenu(user: { click(el: Element): Promise<void> }): Promise<HTMLElement> {
  if (!screen.queryByRole('menu', { name: 'Model' })) await user.click(footer().querySelector('.rd-promptfoot__model')!);
  const menu = await screen.findByRole('menu', { name: 'Model' });
  await user.click(within(menu).getByRole('menuitem', { name: /^Effort/ }));
  return screen.findByRole('menu', { name: 'Effort' });
}

describe('Ultracode in the effort picker (R4-ultracode)', () => {
  it('can be turned on before the engine opens and is sent with the open', async () => {
    const { api, user, controller } = await renderApp();
    const open = vi.spyOn(api.engine, 'open');
    const live = vi.spyOn(api.engine, 'setUltracode');
    await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
    await screen.findByTestId('readonly-note');
    const menu = await openEffortMenu(user);
    const item = within(menu).getByRole('menuitemradio', { name: /Ultracode/ });
    expect(item).toHaveTextContent('Standing multi-agent workflow orchestration for this session; not saved');
    expect(item).toHaveAttribute('aria-checked', 'false');
    expect(item).not.toHaveAttribute('aria-disabled');
    await user.click(item);
    expect(controller.currentView()?.ultracode).toBe(true);
    expect(effortButton()).toHaveTextContent('Default effort · Ultracode');
    expect(live).not.toHaveBeenCalled();

    const key = controller.state.currentKey!;
    const took = controller.takeOver(key);
    await waitFor(() => expect(controller.state.takeover).not.toBeNull());
    act(() => controller.confirmTakeover());
    await act(async () => { await took; });
    expect(open.mock.calls[0]![0]).toMatchObject({ resumeSessionId: MAIN_SESSION_ID, ultracode: true });
  });

  it('toggles live through the engine and the footer shows it next to the effort', async () => {
    const rendered = await renderApp();
    const { api, user } = rendered;
    const handleId = await takeOverMain(rendered);
    const live = vi.spyOn(api.engine, 'setUltracode');
    let menu = await openEffortMenu(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'Max 3.5× or more usage' }));
    menu = await openEffortMenu(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: /Ultracode/ }));
    expect(live).toHaveBeenLastCalledWith(handleId, true);
    expect(footer().querySelector('.rd-promptfoot__effort')).toHaveTextContent('Max · Ultracode');
    menu = await openEffortMenu(user);
    expect(within(menu).getByRole('menuitemradio', { name: /Ultracode/ })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(menu).getByRole('menuitemradio', { name: /Ultracode/ }));
    expect(live).toHaveBeenLastCalledWith(handleId, false);
    expect(footer().querySelector('.rd-promptfoot__effort')!.textContent).toBe('Max');
  });

  it('is offered only when the model supports effort, unless it is already on', async () => {
    const rendered = await renderApp();
    const { user, controller } = rendered;
    await takeOverMain(rendered);
    const key = controller.state.currentKey!;
    await waitFor(() => expect(controller.view(key)?.models.length).toBeGreaterThan(0));
    await act(async () => controller.setModel(key, 'haiku'));
    let menu = await openEffortMenu(user);
    expect(within(menu).queryByRole('menuitemradio', { name: /Ultracode/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await act(async () => controller.setUltracode(key, true));
    menu = await openEffortMenu(user);
    expect(within(menu).getByRole('menuitemradio', { name: /Ultracode/ })).toHaveAttribute('aria-checked', 'true');
  });
});
