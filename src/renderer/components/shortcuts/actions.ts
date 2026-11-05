import {
  ArrowRightLeft,
  ChartPie,
  CircleStop,
  Cloud,
  CloudDownload,
  Cpu,
  FolderOpen,
  FolderPlus,
  Gauge,
  GitFork,
  MousePointer,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import type { ShortcutAction, ShortcutGroup } from '@shared/shortcuts';
import type { MessageKey } from '../../i18n';

export interface ActionMeta {
  label: MessageKey;
  desc: MessageKey;
  icon: LucideIcon;
  /** Official command line shown in tooltips. */
  command?: string;
}

export const ACTION_META: Record<ShortcutAction, ActionMeta> = {
  'handoff.toDesktop': {
    label: 'handoff.toDesktop',
    desc: 'handoff.toDesktop.desc',
    icon: ArrowRightLeft,
    command: 'claude --desktop --resume <id>',
  },
  'handoff.openFolderInDesktop': {
    label: 'handoff.openFolderInDesktop',
    desc: 'handoff.openFolderInDesktop.desc',
    icon: FolderOpen,
    command: 'claude --desktop',
  },
  'handoff.openInTerminal': {
    label: 'handoff.openInTerminal',
    desc: 'handoff.openInTerminal.desc',
    icon: Terminal,
    command: 'claude --resume <id>',
  },
  'handoff.openInTerminalFork': {
    label: 'handoff.openInTerminalFork',
    desc: 'handoff.openInTerminalFork.desc',
    icon: GitFork,
    command: 'claude --resume <id> --fork-session',
  },
  'handoff.continueLatestInTerminal': {
    label: 'handoff.continueLatestInTerminal',
    desc: 'handoff.continueLatestInTerminal.desc',
    icon: SquareTerminal,
    command: 'claude --continue',
  },
  'handoff.toCloud': {
    label: 'handoff.toCloud',
    desc: 'handoff.toCloud.desc',
    icon: Cloud,
    command: 'claude --cloud <task>',
  },
  'handoff.teleport': {
    label: 'handoff.teleport',
    desc: 'handoff.teleport.desc',
    icon: CloudDownload,
    command: 'claude --teleport [<id>]',
  },
  'handoff.remoteControl': {
    label: 'handoff.remoteControl',
    desc: 'handoff.remoteControl.desc',
    icon: MousePointer,
    command: 'claude --remote-control',
  },
  'ui.modelPicker': { label: 'action.modelPicker', desc: 'action.modelPicker.desc', icon: Cpu },
  'ui.effortPicker': { label: 'action.effortPicker', desc: 'action.effortPicker.desc', icon: Gauge },
  'ui.permissionPicker': { label: 'action.permissionPicker', desc: 'action.permissionPicker.desc', icon: ShieldCheck },
  'ui.usagePopover': { label: 'action.usagePopover', desc: 'action.usagePopover.desc', icon: ChartPie },
  'session.interrupt': { label: 'action.interrupt', desc: 'action.interrupt.desc', icon: CircleStop },
  'session.newInFolder': { label: 'action.newInFolder', desc: 'action.newInFolder.desc', icon: FolderPlus },
};

export const HANDOFF_ACTIONS: readonly ShortcutAction[] = [
  'handoff.toDesktop',
  'handoff.openFolderInDesktop',
  'handoff.openInTerminal',
  'handoff.openInTerminalFork',
  'handoff.continueLatestInTerminal',
  'handoff.toCloud',
  'handoff.teleport',
  'handoff.remoteControl',
];

export const GROUP_KEYS: Record<ShortcutGroup, MessageKey> = {
  replies: 'shortcuts.group.replies',
  commands: 'shortcuts.group.commands',
  handoff: 'shortcuts.group.handoff',
  custom: 'shortcuts.group.custom',
};
