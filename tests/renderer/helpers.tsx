import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { App } from '../../src/renderer/App';
import { createMockApi, type MockApiOptions, type MockRelayApi } from '../../src/renderer/mock/api';
import { MAIN_SESSION_ID } from '../../src/renderer/mock/fixtures';
import { AppController } from '../../src/renderer/state/controller';

export { MAIN_SESSION_ID };

export interface Rendered {
  api: MockRelayApi;
  controller: AppController;
  user: ReturnType<typeof userEvent.setup>;
}

/** Renders the whole app over a fresh mock api (English UI unless the options say otherwise). */
export async function renderApp(options: MockApiOptions = {}, beforeStart?: (api: MockRelayApi) => void): Promise<Rendered> {
  const api = createMockApi({ ...options, settings: { language: 'en', ...options.settings } });
  beforeStart?.(api);
  window.relay = api;
  const controller = new AppController(api);
  const user = userEvent.setup();
  render(<App controller={controller} />);
  await waitFor(() => expect(document.querySelector('.rd-app[data-ready="true"]')).not.toBeNull());
  await waitFor(() => expect(controller.state.sessionsState).toBe('loaded'));
  return { api, controller, user };
}

export function sidebar(): HTMLElement {
  return screen.getByRole('complementary', { name: 'Sessions' });
}

/** Opens the main fixture session read-only, takes it over and waits for the engine to be idle. */
export async function takeOverMain({ user, controller }: Rendered): Promise<string> {
  await user.click(within(sidebar()).getByRole('button', { name: 'Relay Desk packaging plan' }));
  await screen.findByTestId('readonly-note');
  await user.click(within(screen.getByTestId('readonly-note')).getByRole('button', { name: 'Take over' }));
  const dialog = await screen.findByTestId('takeover-dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Take over' }));
  await waitFor(() => expect(controller.currentView()?.engineState).toBe('idle'));
  return controller.currentView()!.handleId!;
}

export { createMockApi };
