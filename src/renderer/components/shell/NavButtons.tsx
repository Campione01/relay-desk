import { ArrowLeft, ArrowRight, PanelLeft, Plus, TextAlignStart } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { folderName } from '../../lib/format';
import { useAppState, useController } from '../../state/context';
import { Menu, type MenuEntry } from '../ui/Menu';
import { ICON, IconButton } from '../ui/primitives';

const RECENT_IN_MENU = 8;

/** Left title-bar group (§4.1): sessions menu, sidebar toggle, back, forward. */
export function NavButtons() {
  const controller = useController();
  const t = useT();
  const sidebar = useAppState((s) => s.ui.sidebar);
  const canBack = useAppState((s) => s.navBack.length > 0);
  const canForward = useAppState((s) => s.navForward.length > 0);
  const sessions = useAppState((s) => s.sessions);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const entries = useMemo<MenuEntry[]>(() => {
    const recent = [...sessions].sort((a, b) => b.lastModified - a.lastModified).slice(0, RECENT_IN_MENU);
    const list: MenuEntry[] = [
      {
        id: 'new',
        label: t('sidebar.newSession'),
        icon: <Plus {...ICON} />,
        shortcut: 'Ctrl+N',
        onSelect: () => controller.showHome(),
      },
    ];
    if (recent.length > 0) {
      list.push({ type: 'separator', id: 'sep' }, { type: 'section', id: 'recent', label: t('home.recentSessions') });
      for (const session of recent) {
        list.push({
          id: `s-${session.sessionId}`,
          label: session.title || session.sessionId,
          description: folderName(session.cwd) || undefined,
          onSelect: () => controller.openSummary(session),
        });
      }
    }
    return list;
  }, [sessions, t, controller]);

  return (
    <div className="rd-navbtns">
      <IconButton
        ref={menuRef}
        label={t('titlebar.sessionsMenu')}
        icon={<TextAlignStart {...ICON} />}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu anchor={menuRef.current} open={open} onClose={() => setOpen(false)} entries={entries} label={t('titlebar.sessionsMenu')} width={260} />
      <IconButton
        label={sidebar ? t('titlebar.hideSidebar') : t('titlebar.showSidebar')}
        shortcut="Ctrl+B"
        icon={<PanelLeft {...ICON} />}
        aria-pressed={sidebar}
        onClick={() => controller.toggleSidebar()}
      />
      <IconButton label={t('titlebar.back')} icon={<ArrowLeft {...ICON} />} disabled={!canBack} onClick={() => controller.back()} />
      <IconButton
        label={t('titlebar.forward')}
        icon={<ArrowRight {...ICON} />}
        disabled={!canForward}
        onClick={() => controller.forward()}
      />
    </div>
  );
}
