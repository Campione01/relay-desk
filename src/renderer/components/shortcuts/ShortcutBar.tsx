import { ChevronDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SHORTCUT_GROUPS, type Shortcut } from '@shared/shortcuts';
import { useT } from '../../i18n';
import { hotkeyOf } from '../../lib/hotkeys';
import { actionAvailability, type Availability } from '../../state/availability';
import { useAppState, useController } from '../../state/context';
import { isActiveState } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { Menu, type MenuEntry } from '../ui/Menu';
import { ICON_SM } from '../ui/primitives';
import { ACTION_META, GROUP_KEYS } from './actions';
import { assignHotkeys, hotkeysById } from './hotkeys';

/** Relay shortcut bar (§6.1): group selector, chips, Alt+1-9, editor entry. */
export function ShortcutBar({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const shortcuts = useAppState((s) => s.shortcuts);
  const group = useAppState((s) => s.shortcutGroup);
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const groupRef = useRef<HTMLButtonElement>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const running = isActiveState(view.engineState);

  const visible = useMemo(() => shortcuts.filter((s) => s.group === group), [shortcuts, group]);
  const hotkeys = useMemo(() => assignHotkeys(shortcuts, visible), [shortcuts, visible]);
  const hotkeyOfId = useMemo(() => hotkeysById(hotkeys), [hotkeys]);

  const availability = (shortcut: Shortcut): Availability =>
    shortcut.kind === 'action' && shortcut.action ? actionAvailability(shortcut.action, view, activeProfileId) : { ok: true };

  const latest = useRef({ shortcuts, hotkeys, availability });
  latest.current = { shortcuts, hotkeys, availability };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat) return;
      if (!event.altKey && !event.ctrlKey) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const { shortcuts: list, hotkeys: map, availability: check } = latest.current;
      const id = map.get(hotkeyOf(event));
      const shortcut = id ? list.find((s) => s.id === id) : undefined;
      if (!shortcut) return;
      event.preventDefault();
      if (check(shortcut).ok) void controller.runShortcut(shortcut);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  const groupEntries: MenuEntry[] = SHORTCUT_GROUPS.map((g) => ({
    id: g,
    label: t(GROUP_KEYS[g]),
    checked: g === group,
    onSelect: () => controller.setShortcutGroup(g),
  }));

  const tipFor = (shortcut: Shortcut, state: Availability): string => {
    if (!state.ok) return t(state.reason);
    if (shortcut.kind === 'action' && shortcut.action) {
      const meta = ACTION_META[shortcut.action];
      const command = shortcut.hint ?? meta.command;
      return command ? `${t(meta.desc)}\n${command}` : t(meta.desc);
    }
    const how =
      shortcut.mode === 'fill' ? t('shortcuts.fills') : running ? t('shortcuts.queues') : t('shortcuts.sends');
    return `${shortcut.text ?? ''}\n${how}`;
  };

  return (
    <div className="rd-shortcutbar" role="toolbar" aria-label={t('shortcuts.barLabel')} data-testid="shortcut-bar">
      <button
        ref={groupRef}
        type="button"
        className="rd-shortcutbar__group"
        aria-haspopup="menu"
        aria-expanded={groupOpen}
        aria-label={t('shortcuts.groupPicker', { group: t(GROUP_KEYS[group]) })}
        onClick={() => setGroupOpen((v) => !v)}
      >
        {t(GROUP_KEYS[group])}
        <ChevronDown {...ICON_SM} />
      </button>
      <Menu
        anchor={groupRef.current}
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        entries={groupEntries}
        label={t('shortcuts.groupMenu')}
        placement="top-start"
        width={180}
      />
      <div className="rd-shortcutbar__chips">
        {visible.length === 0 ? <span className="rd-shortcutbar__empty">{t('shortcuts.emptyGroup')}</span> : null}
        {visible.map((shortcut) => {
          const state = availability(shortcut);
          const meta = shortcut.kind === 'action' && shortcut.action ? ACTION_META[shortcut.action] : null;
          const Icon = meta?.icon;
          return (
            <button
              key={shortcut.id}
              type="button"
              className="rd-chip"
              data-mode={shortcut.mode}
              aria-disabled={!state.ok || undefined}
              data-tip={tipFor(shortcut, state)}
              data-tip-key={hotkeyOfId.get(shortcut.id)}
              data-tip-place="top"
              aria-keyshortcuts={hotkeyOfId.get(shortcut.id)}
              onClick={() => {
                if (state.ok) void controller.runShortcut(shortcut);
              }}
            >
              {Icon ? <Icon {...ICON_SM} /> : null}
              <span>{shortcut.label}</span>
            </button>
          );
        })}
      </div>
      <button type="button" className="rd-shortcutbar__edit" onClick={() => controller.openShortcutEditor(true)}>
        {t('shortcuts.edit')}
      </button>
    </div>
  );
}
