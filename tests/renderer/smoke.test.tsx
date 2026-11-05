import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SEED_SHORTCUTS } from '@shared/shortcuts';
import { readFileSync } from 'node:fs';
import { App } from '../../src/renderer/App';
import { useLanguage, useT } from '../../src/renderer/i18n';
import { createMockApi } from '../../src/renderer/mock/api';

describe('renderer smoke', () => {
  it('renders the app shell in English by default', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'What are we picking up today?' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Sessions' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Relay Desk packaging plan' })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('en');
  });

  it('is English outside a language provider and in the page before the app starts', () => {
    function Probe() {
      const t = useT();
      return <p>{`${useLanguage()}: ${t('settings.title')}`}</p>;
    }
    render(<Probe />);
    expect(screen.getByText('en: Settings')).toBeInTheDocument();
    expect(readFileSync('src/renderer/index.html', 'utf8')).toMatch(/<html lang="en">/);
  });

  it('has English dev:web demo data that names no unpublished documents', () => {
    for (const file of ['src/renderer/mock/fixtures.ts', 'src/renderer/mock/demo.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/[\u3000-\u9fff\uff00-\uffef]/);
      expect(source, file).not.toMatch(/docs[\\/]+(?:PLAN|MOD)\.md|docs[\\/]+reference|desktop-light/);
    }
  });

  it('mock api serves the seeded shortcuts and streams a turn', async () => {
    const api = createMockApi();
    expect((await api.shortcuts.get()).map((s) => s.id)).toEqual(SEED_SHORTCUTS.map((s) => s.id));

    const events: string[] = [];
    const off = api.engine.onEvent((e) => events.push(e.type));
    const handle = await api.engine.open({ profileId: 'default', cwd: 'D:\\demos\\demo-app' });
    await api.engine.send(handle.handleId, 'hi');
    await new Promise((resolve) => setTimeout(resolve, 20));
    off();

    expect(events.slice(0, 4)).toEqual(['state', 'init', 'commands', 'state']);
    expect(events).toContain('delta');
    expect(events.at(-1)).toBe('state');
  });
});
