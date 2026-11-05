import {
  ArrowRightLeft,
  ChevronDown,
  Copy,
  EllipsisVertical,
  Folder,
  FolderOpen,
  Keyboard,
  ListChecks,
  Pencil,
  Power,
  RotateCw,
  Settings,
  SquareMenu,
  Terminal,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_PROFILE_ID } from '@shared/types';
import { useT } from '../../i18n';
import { actionAvailability } from '../../state/availability';
import { useAppState, useController, useCurrentView } from '../../state/context';
import { hasOpenHandle } from '../../state/sessionReducer';
import { hasBackgroundWork } from '../tasks/taskModel';
import { Menu, type MenuEntry } from '../ui/Menu';
import { ICON, ICON_SM, IconButton } from '../ui/primitives';
import { NavButtons } from './NavButtons';

function SessionTitle() {
  const controller = useController();
  const t = useT();
  const view = useCurrentView();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  useEffect(() => setEditing(false), [view?.key]);

  if (!view) return <div className="rd-titlebar__title" />;

  const open = hasOpenHandle(view);
  const side = Boolean(view.sideChatOf);
  const canRename = Boolean(view.sessionId) && !side;
  const handBack = actionAvailability('handoff.toDesktop', view, view.profileId);

  const entries: MenuEntry[] = [
    {
      id: 'rename',
      label: t('session.rename'),
      icon: <Pencil {...ICON} />,
      disabled: !canRename,
      disabledReason: t(side ? 'reason.sideChat' : 'reason.noSession'),
      onSelect: () => {
        setDraft(view.title);
        setEditing(true);
      },
    },
    {
      id: 'copy',
      label: t('session.copyId'),
      icon: <Copy {...ICON} />,
      disabled: !view.sessionId || side,
      disabledReason: t(side ? 'reason.sideChat' : 'reason.noSession'),
      onSelect: () => void controller.copySessionId(view.key),
    },
    {
      id: 'folder',
      label: t('session.openFolder'),
      icon: <FolderOpen {...ICON} />,
      disabled: !view.cwd,
      disabledReason: t('reason.noFolder'),
      onSelect: () => void controller.openFolder(view.cwd),
    },
    { type: 'separator', id: 'sep1' },
    open
      ? {
          id: 'handback',
          label: t('handoff.toDesktop'),
          icon: <ArrowRightLeft {...ICON} />,
          disabled: !handBack.ok || view.profileId !== DEFAULT_PROFILE_ID,
          disabledReason: handBack.ok ? undefined : t(handBack.reason),
          onSelect: () => void controller.handBack(view.key),
        }
      : {
          id: 'takeover',
          label: t('session.takeOver'),
          icon: <Zap {...ICON} />,
          disabled: !view.sessionId || !view.cwd || side,
          disabledReason: t(side ? 'reason.sideChat' : view.sessionId ? 'reason.noFolder' : 'reason.noSession'),
          onSelect: () => void controller.takeOver(view.key, 'menu'),
        },
    {
      id: 'close',
      label: side ? t('sideChat.close') : t('session.close'),
      icon: <Power {...ICON} />,
      disabled: !side && !open && !view.opening,
      disabledReason: t('reason.notOpen'),
      onSelect: () => void (side ? controller.closeSideChat(view.key) : controller.closeSession(view.key)),
    },
  ];

  const commit = (): void => {
    setEditing(false);
    void controller.renameSession(view.key, draft);
  };

  return (
    <div className="rd-titlebar__title">
      {editing ? (
        <input
          ref={inputRef}
          className="rd-titlebar__input"
          aria-label={t('session.renameLabel')}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="rd-titlebar__name"
          data-tip={canRename ? t('session.clickToRename') : undefined}
          onClick={() => {
            if (!canRename) return;
            setDraft(view.title);
            setEditing(true);
          }}
        >
          {view.title}
        </button>
      )}
      <button
        ref={chevronRef}
        type="button"
        className="rd-titlebar__chevron"
        aria-label={t('session.menu')}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <ChevronDown {...ICON_SM} />
      </button>
      <Menu
        anchor={chevronRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        entries={entries}
        label={t('session.menu')}
        width={240}
      />
    </div>
  );
}

function RightGroup() {
  const controller = useController();
  const t = useT();
  const view = useCurrentView();
  const panel = useAppState((s) => s.ui.rightPanel);
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const terminal = actionAvailability('handoff.openInTerminal', view, activeProfileId);
  const tasks: MenuEntry[] = hasBackgroundWork(view)
    ? [
        {
          id: 'tasks',
          label: t('background.title'),
          icon: <ListChecks {...ICON} />,
          onSelect: () => controller.toggleTasksPane(true),
        },
        { type: 'separator', id: 'sep-tasks' },
      ]
    : [];

  const entries: MenuEntry[] = [
    ...tasks,
    {
      id: 'settings',
      label: t('settings.title'),
      icon: <Settings {...ICON} />,
      shortcut: 'Ctrl+,',
      onSelect: () => controller.openSettings(true),
    },
    {
      id: 'shortcuts',
      label: t('shortcuts.editorTitle'),
      icon: <Pencil {...ICON} />,
      onSelect: () => controller.openShortcutEditor(true),
    },
    {
      id: 'keys',
      label: t('keys.title'),
      icon: <Keyboard {...ICON} />,
      shortcut: 'Ctrl+/',
      onSelect: () => controller.openKeyboardHelp(true),
    },
    { type: 'separator', id: 'sep' },
    {
      id: 'refresh',
      label: t('sidebar.refresh'),
      icon: <RotateCw {...ICON} />,
      onSelect: () => void controller.loadSessions(),
    },
  ];

  return (
    <div className="rd-titlebar__right">
      <IconButton
        label={panel ? t('titlebar.hidePanel') : t('titlebar.showPanel')}
        icon={<SquareMenu {...ICON} />}
        aria-pressed={panel}
        onClick={() => controller.toggleRightPanel()}
      />
      <span className="rd-titlebar__divider" aria-hidden="true" />
      <IconButton
        label={terminal.ok ? t('titlebar.terminal') : t(terminal.reason)}
        icon={<Terminal {...ICON} />}
        disabled={!terminal.ok}
        onClick={() => void controller.runAction('handoff.openInTerminal')}
      />
      <IconButton
        label={view?.cwd ? t('titlebar.folder') : t('reason.noFolder')}
        icon={<Folder {...ICON} />}
        disabled={!view?.cwd}
        onClick={() => view && void controller.openFolder(view.cwd)}
      />
      <IconButton
        ref={moreRef}
        label={t('titlebar.more')}
        icon={<EllipsisVertical {...ICON} />}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((v) => !v)}
      />
      <Menu
        anchor={moreRef.current}
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        entries={entries}
        label={t('titlebar.more')}
        placement="bottom-end"
        width={230}
      />
    </div>
  );
}

export function TitleBar() {
  const sidebar = useAppState((s) => s.ui.sidebar);
  return (
    <header className="rd-titlebar" data-sidebar={sidebar}>
      {sidebar ? null : <NavButtons />}
      <SessionTitle />
      <div className="rd-titlebar__drag" />
      <RightGroup />
      <div className="rd-titlebar__caption" aria-hidden="true" />
    </header>
  );
}
