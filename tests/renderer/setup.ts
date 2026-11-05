import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { createMockApi } from '../../src/renderer/mock/api';

// Every renderer test starts with a fresh in-memory window.relay; replace it in a test to customise fixtures.
beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  window.relay = createMockApi();
});

afterEach(() => {
  cleanup();
});
