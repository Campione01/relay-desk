import { ArrowLeft, MessagesSquare, X } from 'lucide-react';
import { useEffect } from 'react';
import { useT } from '../../i18n';
import { hotkeyOf } from '../../lib/hotkeys';
import { installInputModality } from '../../lib/inputModality';
import { useAppState, useController, useCurrentView } from '../../state/context';
import type { SessionView } from '../../state/types';
import { AutoContinueNote } from '../flows/AutoContinueNote';
import { NativeStartup } from '../flows/NativeStartup';
import { ConfirmHost, TextRequestHost, Toasts } from '../flows/Hosts';
import { PermissionCard } from '../flows/PermissionCard';
import { QuestionCard } from '../flows/QuestionCard';
import { KeyboardHelp, SettingsDialog } from '../flows/SettingsDialog';
import { ReadOnlyNote, TakeoverBanner, TakeoverDialog } from '../flows/Takeover';
import { CodeContextDialog } from '../flows/CodeContextDialog';
import { RightPanel } from '../panel/Cards';
import { NativePanel } from '../prompt/NativePanel';
import { PromptBox } from '../prompt/PromptBox';
import { PromptFooter } from '../prompt/PromptFooter';
import { ShortcutBar } from '../shortcuts/ShortcutBar';
import { ShortcutEditor } from '../shortcuts/ShortcutEditor';
import { TasksPane } from '../tasks/TasksPane';
import { Transcript } from '../transcript/Transcript';
import { ICON_SM, IconButton } from '../ui/primitives';
import { TooltipLayer } from '../ui/TooltipLayer';
import { EmptyState } from './EmptyState';
import { Sidebar } from './Sidebar';
import { TitleBar } from './TitleBar';

/** Top of a side-chat view: says it is not saved, leads back to the conversation and closes it. */
function SideChatStrip({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const origin = useAppState((s) => (view.sideChatOf ? (s.views[view.sideChatOf] ?? null) : null));
  return (
    <div className="rd-sidestrip rd-colwrap">
      <div className="rd-col rd-sidestrip__box" data-testid="sidechat-strip">
        <MessagesSquare {...ICON_SM} className="rd-sidestrip__icon" />
        <p className="rd-sidestrip__text">{t('sideChat.strip')}</p>
        <button
          type="button"
          className="rd-btn rd-btn--secondary rd-sidestrip__back"
          disabled={!origin}
          onClick={() => origin && controller.navigate(origin.key)}
        >
          <ArrowLeft {...ICON_SM} />
          {t('sideChat.back')}
        </button>
        <IconButton
          label={t('sideChat.close')}
          icon={<X {...ICON_SM} />}
          size="small"
          muted
          onClick={() => void controller.closeSideChat(view.key)}
        />
      </div>
    </div>
  );
}

function SessionPane({ view }: { view: SessionView }) {
  return (
    <div className="rd-session" data-testid="session-pane" data-opening={view.opening}>
      {view.sideChatOf ? <SideChatStrip view={view} /> : null}
      <Transcript key={view.key} view={view} />
      <div className="rd-bottom rd-colwrap">
        <div className="rd-col rd-bottom__stack">
          {view.permissions.map((request) => (
            <PermissionCard key={request.requestId} viewKey={view.key} request={request} />
          ))}
          {view.questions.map((request) => (
            <QuestionCard key={request.requestId} viewKey={view.key} request={request} />
          ))}
          <TakeoverBanner view={view} />
          <AutoContinueNote key={view.key} view={view} />
          <ReadOnlyNote view={view} />
          {view.opening ? <NativeStartup view={view} /> : <>
            <NativePanel view={view} />
            <ShortcutBar view={view} />
            <PromptBox view={view} />
          </>}
          <PromptFooter view={view} />
        </div>
      </div>
    </div>
  );
}

function useGlobalKeys(): void {
  const controller = useController();
  useEffect(() => {
    installInputModality();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const view = controller.currentView();
      switch (hotkeyOf(event)) {
        case 'Ctrl+B':
          event.preventDefault();
          controller.toggleSidebar();
          break;
        case 'Ctrl+N':
          event.preventDefault();
          controller.showHome();
          break;
        case 'Ctrl+,':
          event.preventDefault();
          controller.openSettings(true);
          break;
        case 'Ctrl+/':
          event.preventDefault();
          controller.openKeyboardHelp(true);
          break;
        case 'Ctrl+Shift+M':
          if (!view) return;
          event.preventDefault();
          controller.openFooterMenu('permission');
          break;
        case 'Ctrl+Shift+I':
          if (!view) return;
          event.preventDefault();
          controller.openFooterMenu('model');
          break;
        case 'Ctrl+Shift+E':
          if (!view) return;
          event.preventDefault();
          controller.openFooterMenu('effort');
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);
}

/** Window layout: sidebar | title bar + transcript column + tasks pane + right panel overlay. */
export function AppShell() {
  const sidebar = useAppState((s) => s.ui.sidebar);
  const panel = useAppState((s) => s.ui.rightPanel);
  const tasksPane = useAppState((s) => s.ui.tasksPane);
  const ready = useAppState((s) => s.ready);
  const view = useCurrentView();
  const tasks = Boolean(view) && tasksPane;
  useGlobalKeys();

  return (
    <div className="rd-app" data-sidebar={sidebar} data-ready={ready}>
      {sidebar ? <Sidebar /> : null}
      <div className="rd-main">
        <TitleBar />
        <main className="rd-content" data-panel={panel} data-tasks={tasks}>
          {view ? <SessionPane view={view} /> : <EmptyState />}
          {view && tasks ? <TasksPane key={view.key} view={view} /> : null}
          {panel ? <RightPanel /> : null}
          <Toasts />
        </main>
      </div>
      <TakeoverDialog />
      <SettingsDialog />
      <ShortcutEditor />
      <KeyboardHelp />
      <ConfirmHost />
      <TextRequestHost />
      <CodeContextDialog />
      <TooltipLayer />
    </div>
  );
}
