import { createContext, useContext, type ReactNode } from 'react';
import type { AppController } from './controller';
import { useStoreValue } from './store';
import type { AppState, SessionView } from './types';

const ControllerContext = createContext<AppController | null>(null);

export function ControllerProvider({ controller, children }: { controller: AppController; children: ReactNode }) {
  return <ControllerContext.Provider value={controller}>{children}</ControllerContext.Provider>;
}

export function useController(): AppController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error('useController outside ControllerProvider');
  return controller;
}

export function useAppState<T>(selector: (state: AppState) => T): T {
  return useStoreValue(useController().store, selector);
}

export function useCurrentView(): SessionView | null {
  return useAppState((state) => (state.currentKey ? (state.views[state.currentKey] ?? null) : null));
}
