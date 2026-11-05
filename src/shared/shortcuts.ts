export const SHORTCUT_ACTIONS = [
  'handoff.toDesktop',
  'handoff.openFolderInDesktop',
  'handoff.openInTerminal',
  'handoff.openInTerminalFork',
  'handoff.continueLatestInTerminal',
  'handoff.toCloud',
  'handoff.teleport',
  'handoff.remoteControl',
  'ui.modelPicker',
  'ui.effortPicker',
  'ui.permissionPicker',
  'ui.usagePopover',
  'session.interrupt',
  'session.newInFolder',
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

export const SHORTCUT_GROUPS = ['replies', 'commands', 'handoff', 'custom'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export const SHORTCUT_KINDS = ['prompt', 'slash', 'action'] as const;
export type ShortcutKind = (typeof SHORTCUT_KINDS)[number];

export interface Shortcut {
  id: string;
  label: string;
  group: ShortcutGroup;
  kind: ShortcutKind;
  /** prompt / slash text; required unless kind is 'action'. */
  text?: string;
  /** Required when kind is 'action'. */
  action?: ShortcutAction;
  /** send = act on click; fill = put text in the prompt box for editing. Actions always run on click. */
  mode: 'send' | 'fill';
  /** e.g. 'Alt+1'. */
  hotkey?: string;
  hint?: string;
}

const SEED: Shortcut[] = [
  { id: 'seed.reply.ok', label: 'Go ahead', group: 'replies', kind: 'prompt', text: 'Go ahead', mode: 'send' },
  { id: 'seed.reply.continue', label: 'Continue', group: 'replies', kind: 'prompt', text: 'continue', mode: 'send' },
  { id: 'seed.reply.tryAgain', label: 'Try again', group: 'replies', kind: 'prompt', text: 'Try again', mode: 'send' },
  {
    id: 'seed.reply.anythingLeft',
    label: 'Anything left?',
    group: 'replies',
    kind: 'prompt',
    text: 'Is there anything left to do?',
    mode: 'send',
  },
  {
    id: 'seed.reply.changeSummary',
    label: 'Change summary',
    group: 'replies',
    kind: 'prompt',
    text: 'Briefly list the files and features you changed this time.',
    mode: 'send',
  },
  {
    id: 'seed.reply.goalProgress',
    label: 'Goal progress',
    group: 'replies',
    kind: 'prompt',
    text: 'What is still missing to reach the original goal?',
    mode: 'send',
  },
  {
    id: 'seed.reply.testList',
    label: 'Test list',
    group: 'replies',
    kind: 'prompt',
    text: 'List what I need to test by hand, with the steps.',
    mode: 'send',
  },
  { id: 'seed.cmd.compact', label: '/compact', group: 'commands', kind: 'slash', text: '/compact', mode: 'send' },
  {
    id: 'seed.cmd.compactWith',
    label: '/compact …',
    group: 'commands',
    kind: 'slash',
    text: '/compact ',
    mode: 'fill',
    hint: '/compact <instructions>',
  },
  { id: 'seed.cmd.model', label: 'Model', group: 'commands', kind: 'action', action: 'ui.modelPicker', mode: 'send' },
  { id: 'seed.cmd.effort', label: 'Effort', group: 'commands', kind: 'action', action: 'ui.effortPicker', mode: 'send' },
  {
    id: 'seed.cmd.permission',
    label: 'Permission mode',
    group: 'commands',
    kind: 'action',
    action: 'ui.permissionPicker',
    mode: 'send',
  },
  { id: 'seed.cmd.goal', label: '/goal', group: 'commands', kind: 'slash', text: '/goal ', mode: 'fill' },
  { id: 'seed.cmd.autocompact', label: '/autocompact', group: 'commands', kind: 'slash', text: '/autocompact', mode: 'fill' },
  { id: 'seed.cmd.usage', label: '/usage', group: 'commands', kind: 'slash', text: '/usage', mode: 'send' },
  { id: 'seed.cmd.context', label: '/context', group: 'commands', kind: 'slash', text: '/context', mode: 'send' },
  { id: 'seed.cmd.usagePanel', label: 'Usage panel', group: 'commands', kind: 'action', action: 'ui.usagePopover', mode: 'send' },
  {
    id: 'seed.handoff.toDesktop',
    label: 'Hand back to desktop',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.toDesktop',
    mode: 'send',
    hint: 'claude --desktop --resume <id>',
  },
  {
    id: 'seed.handoff.openFolderInDesktop',
    label: 'Open this folder in desktop',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.openFolderInDesktop',
    mode: 'send',
    hint: 'claude --desktop',
  },
  {
    id: 'seed.handoff.openInTerminal',
    label: 'Continue in terminal',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.openInTerminal',
    mode: 'send',
    hint: 'claude --resume <id>',
  },
  {
    id: 'seed.handoff.openInTerminalFork',
    label: 'Fork into terminal',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.openInTerminalFork',
    mode: 'send',
    hint: 'claude --resume <id> --fork-session',
  },
  {
    id: 'seed.handoff.continueLatestInTerminal',
    label: 'Continue latest in terminal',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.continueLatestInTerminal',
    mode: 'send',
    hint: 'claude --continue',
  },
  {
    id: 'seed.handoff.toCloud',
    label: 'Send to cloud',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.toCloud',
    mode: 'send',
    hint: 'claude --cloud <task>',
  },
  {
    id: 'seed.handoff.teleport',
    label: 'Pull from cloud',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.teleport',
    mode: 'send',
    hint: 'claude --teleport [<id>]',
  },
  {
    id: 'seed.handoff.remoteControl',
    label: 'Remote Control',
    group: 'handoff',
    kind: 'action',
    action: 'handoff.remoteControl',
    mode: 'send',
    hint: 'claude --remote-control',
  },
];

/** Seed list. Ids are stable: stores and the editor match seeds by id. */
export const SEED_SHORTCUTS: readonly Readonly<Shortcut>[] = Object.freeze(SEED.map((s) => Object.freeze(s)));

/** Mutable deep copy of the seed (for stores, reset and the mock api). */
export function seedShortcuts(): Shortcut[] {
  return SEED_SHORTCUTS.map((s) => ({ ...s }));
}
