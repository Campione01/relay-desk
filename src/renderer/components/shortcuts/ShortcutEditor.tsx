import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  SHORTCUT_KINDS,
  type Shortcut,
  type ShortcutAction,
  type ShortcutGroup,
  type ShortcutKind,
} from '@shared/shortcuts';
import { useT, type MessageKey } from '../../i18n';
import { normalizeHotkey } from '../../lib/hotkeys';
import { useAppState, useController } from '../../state/context';
import { Dialog } from '../ui/Dialog';
import { ICON_SM, IconButton } from '../ui/primitives';
import { ACTION_META, GROUP_KEYS } from './actions';

/** App-wide keys a shortcut may not take. */
export const RESERVED_HOTKEYS = new Set([
  'Ctrl+B',
  'Ctrl+N',
  'Ctrl+U',
  'Ctrl+W',
  'Ctrl+C',
  'Ctrl+V',
  'Ctrl+X',
  'Ctrl+A',
  'Ctrl+Z',
  'Ctrl+Shift+M',
  'Ctrl+Shift+I',
  'Ctrl+Shift+E',
]);

const KIND_KEYS: Record<ShortcutKind, MessageKey> = {
  prompt: 'shortcuts.kind.prompt',
  slash: 'shortcuts.kind.slash',
  action: 'shortcuts.kind.action',
};

interface Draft {
  id: string;
  label: string;
  group: ShortcutGroup;
  kind: ShortcutKind;
  text: string;
  action: ShortcutAction | '';
  mode: 'send' | 'fill';
  hotkey: string;
  hint: string;
}

function toDraft(shortcut: Shortcut): Draft {
  return {
    id: shortcut.id,
    label: shortcut.label,
    group: shortcut.group,
    kind: shortcut.kind,
    text: shortcut.text ?? '',
    action: shortcut.action ?? '',
    mode: shortcut.mode,
    hotkey: shortcut.hotkey ?? '',
    hint: shortcut.hint ?? '',
  };
}

function newId(): string {
  return `custom.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 7)}`;
}

export type DraftErrors = Partial<Record<'label' | 'text' | 'action' | 'hotkey', MessageKey>>;

/** Field checks for the shortcut form; `others` are the other shortcuts (for hotkey clashes). */
export function validateDraft(draft: Draft, others: readonly Shortcut[]): DraftErrors {
  const errors: DraftErrors = {};
  if (!draft.label.trim()) errors.label = 'shortcuts.error.label';
  if (draft.kind === 'action') {
    if (!draft.action) errors.action = 'shortcuts.error.action';
  } else if (!draft.text.trim()) {
    errors.text = 'shortcuts.error.text';
  } else if (draft.kind === 'slash' && !draft.text.trimStart().startsWith('/')) {
    errors.text = 'shortcuts.error.slash';
  }
  if (draft.hotkey.trim()) {
    const hotkey = normalizeHotkey(draft.hotkey);
    if (!hotkey) errors.hotkey = 'shortcuts.error.hotkey';
    else if (RESERVED_HOTKEYS.has(hotkey)) errors.hotkey = 'shortcuts.error.reserved';
    else if (others.some((s) => s.id !== draft.id && s.hotkey && normalizeHotkey(s.hotkey) === hotkey)) {
      errors.hotkey = 'shortcuts.error.taken';
    }
  }
  return errors;
}

function fromDraft(draft: Draft): Shortcut {
  const shortcut: Shortcut = {
    id: draft.id,
    label: draft.label.trim(),
    group: draft.group,
    kind: draft.kind,
    mode: draft.kind === 'action' ? 'send' : draft.mode,
  };
  if (draft.kind === 'action') shortcut.action = draft.action as ShortcutAction;
  else shortcut.text = draft.text;
  const hotkey = draft.hotkey.trim() ? normalizeHotkey(draft.hotkey) : null;
  if (hotkey) shortcut.hotkey = hotkey;
  if (draft.hint.trim()) shortcut.hint = draft.hint.trim();
  return shortcut;
}

function ShortcutForm({
  draft,
  others,
  isNew,
  onCancel,
  onSave,
}: {
  draft: Draft;
  others: readonly Shortcut[];
  isNew: boolean;
  onCancel(): void;
  onSave(shortcut: Shortcut): void;
}) {
  const t = useT();
  const [value, setValue] = useState(draft);
  const [touched, setTouched] = useState(false);
  const errors = validateDraft(value, others);
  const valid = Object.keys(errors).length === 0;
  const set = <K extends keyof Draft>(key: K, next: Draft[K]): void => setValue((v) => ({ ...v, [key]: next }));
  const err = (key: keyof DraftErrors) =>
    touched && errors[key] ? (
      <span className="rd-field__error" role="alert">
        {t(errors[key]!)}
      </span>
    ) : null;

  return (
    <form
      className="rd-sform"
      aria-label={isNew ? t('shortcuts.addTitle') : t('shortcuts.editTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (valid) onSave(fromDraft(value));
      }}
    >
      <div className="rd-sform__grid">
        <label className="rd-field">
          <span className="rd-field__label">{t('shortcuts.field.label')}</span>
          <input className="rd-input" data-autofocus="" value={value.label} onChange={(e) => set('label', e.target.value)} />
          {err('label')}
        </label>
        <label className="rd-field">
          <span className="rd-field__label">{t('shortcuts.field.group')}</span>
          <select className="rd-select" value={value.group} onChange={(e) => set('group', e.target.value as ShortcutGroup)}>
            {SHORTCUT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(GROUP_KEYS[g])}
              </option>
            ))}
          </select>
        </label>
        <label className="rd-field">
          <span className="rd-field__label">{t('shortcuts.field.kind')}</span>
          <select className="rd-select" value={value.kind} onChange={(e) => set('kind', e.target.value as ShortcutKind)}>
            {SHORTCUT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_KEYS[k])}
              </option>
            ))}
          </select>
        </label>
        <label className="rd-field">
          <span className="rd-field__label">{t('shortcuts.field.hotkey')}</span>
          <input
            className="rd-input"
            value={value.hotkey}
            placeholder="Alt+1"
            onChange={(e) => set('hotkey', e.target.value)}
          />
          {err('hotkey')}
        </label>
      </div>
      {value.kind === 'action' ? (
        <label className="rd-field">
          <span className="rd-field__label">{t('shortcuts.field.action')}</span>
          <select
            className="rd-select"
            value={value.action}
            onChange={(e) => set('action', e.target.value as ShortcutAction | '')}
          >
            <option value="">{t('shortcuts.chooseAction')}</option>
            {SHORTCUT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {t(ACTION_META[action].label)}
              </option>
            ))}
          </select>
          {value.action ? <span className="rd-field__hint">{t(ACTION_META[value.action].desc)}</span> : null}
          {err('action')}
        </label>
      ) : (
        <label className="rd-field">
          <span className="rd-field__label">{t(value.kind === 'slash' ? 'shortcuts.field.command' : 'shortcuts.field.text')}</span>
          <textarea
            className="rd-textarea"
            value={value.text}
            placeholder={value.kind === 'slash' ? '/compact ' : ''}
            onChange={(e) => set('text', e.target.value)}
          />
          {err('text')}
        </label>
      )}
      <fieldset className="rd-sform__modes" disabled={value.kind === 'action'}>
        <legend className="rd-field__label">{t('shortcuts.field.mode')}</legend>
        <label className="rd-check">
          <input type="radio" name="mode" checked={value.kind === 'action' || value.mode === 'send'} onChange={() => set('mode', 'send')} />
          <span>
            {t('shortcuts.mode.send')}
            <span className="rd-field__hint"> — {t('shortcuts.mode.send.desc')}</span>
          </span>
        </label>
        <label className="rd-check">
          <input type="radio" name="mode" checked={value.kind !== 'action' && value.mode === 'fill'} onChange={() => set('mode', 'fill')} />
          <span>
            {t('shortcuts.mode.fill')}
            <span className="rd-field__hint"> — {t('shortcuts.mode.fill.desc')}</span>
          </span>
        </label>
        {value.kind === 'action' ? <span className="rd-field__hint">{t('shortcuts.mode.actionNote')}</span> : null}
      </fieldset>
      <label className="rd-field">
        <span className="rd-field__label">{t('shortcuts.field.hint')}</span>
        <input className="rd-input" value={value.hint} onChange={(e) => set('hint', e.target.value)} />
      </label>
      <div className="rd-sform__actions">
        <button type="button" className="rd-btn rd-btn--secondary" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="submit" className="rd-btn rd-btn--primary">
          {isNew ? t('common.add') : t('common.apply')}
        </button>
      </div>
    </form>
  );
}

/** Shortcut editor: add, edit, reorder and delete; saved through window.relay.shortcuts. */
export function ShortcutEditor() {
  const controller = useController();
  const t = useT();
  const open = useAppState((s) => s.ui.shortcutEditor);
  const stored = useAppState((s) => s.shortcuts);
  const currentGroup = useAppState((s) => s.shortcutGroup);
  const [list, setList] = useState<Shortcut[]>(stored);
  const [tab, setTab] = useState<ShortcutGroup>(currentGroup);
  const [editing, setEditing] = useState<{ draft: Draft; isNew: boolean } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setList(stored);
    setTab(currentGroup);
    setEditing(null);
    setPendingDelete(null);
  }, [open]);

  const dirty = useMemo(() => JSON.stringify(list) !== JSON.stringify(stored), [list, stored]);
  const rows = list.filter((s) => s.group === tab);

  const close = async (): Promise<void> => {
    if (dirty) {
      const ok = await controller.confirm({
        title: t('shortcuts.discardTitle'),
        body: t('shortcuts.discardBody'),
        confirmLabel: t('shortcuts.discard'),
        danger: true,
      });
      if (!ok) return;
    }
    controller.openShortcutEditor(false);
  };

  const move = (id: string, delta: -1 | 1): void => {
    setList((current) => {
      const index = current.findIndex((s) => s.id === id);
      const group = current[index]?.group;
      if (index < 0 || !group) return current;
      let target = index + delta;
      while (target >= 0 && target < current.length && current[target]!.group !== group) target += delta;
      if (target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    const ok = await controller.saveShortcuts(list);
    setSaving(false);
    if (ok) controller.openShortcutEditor(false);
  };

  const describe = (shortcut: Shortcut): string =>
    shortcut.kind === 'action' && shortcut.action ? t(ACTION_META[shortcut.action].label) : (shortcut.text ?? '');

  return (
    <Dialog
      open={open}
      size="wide"
      title={t('shortcuts.editorTitle')}
      onClose={() => void close()}
      testId="shortcut-editor"
      footer={
        <>
          <button
            type="button"
            className="rd-btn rd-btn--ghost rd-dialog__foot-left"
            onClick={async () => {
              const reset = await controller.resetShortcuts();
              if (reset) setList(reset);
            }}
          >
            {t('shortcuts.reset')}
          </button>
          <button type="button" className="rd-btn rd-btn--secondary" onClick={() => void close()}>
            {t('common.cancel')}
          </button>
          <button type="button" className="rd-btn rd-btn--primary" disabled={!dirty || saving || editing !== null} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="rd-segmented" role="radiogroup" aria-label={t('shortcuts.field.group')}>
        {SHORTCUT_GROUPS.map((g) => (
          <button
            key={g}
            type="button"
            role="radio"
            aria-checked={tab === g}
            className="rd-segmented__item"
            onClick={() => {
              setTab(g);
              setEditing(null);
            }}
          >
            {t(GROUP_KEYS[g])} <span className="rd-tnum">{list.filter((s) => s.group === g).length}</span>
          </button>
        ))}
      </div>
      {editing ? (
        <ShortcutForm
          key={editing.draft.id}
          draft={editing.draft}
          isNew={editing.isNew}
          others={list}
          onCancel={() => setEditing(null)}
          onSave={(shortcut) => {
            setList((current) =>
              editing.isNew ? [...current, shortcut] : current.map((s) => (s.id === shortcut.id ? shortcut : s)),
            );
            setTab(shortcut.group);
            setEditing(null);
          }}
        />
      ) : (
        <>
          <ul className="rd-slist" aria-label={t(GROUP_KEYS[tab])}>
            {rows.length === 0 ? <li className="rd-slist__empty">{t('shortcuts.emptyGroup')}</li> : null}
            {rows.map((shortcut, index) => (
              <li key={shortcut.id} className="rd-slist__row" data-testid="shortcut-row">
                <div className="rd-slist__main">
                  <span className="rd-slist__label">{shortcut.label}</span>
                  <span className="rd-slist__detail">{describe(shortcut)}</span>
                </div>
                <span className="rd-badge">{shortcut.kind === 'action' ? t('shortcuts.kind.action') : t(`shortcuts.mode.${shortcut.mode}`)}</span>
                {shortcut.hotkey ? <span className="rd-badge rd-tnum">{shortcut.hotkey}</span> : null}
                <div className="rd-slist__tools">
                  <IconButton
                    label={t('shortcuts.moveUp', { label: shortcut.label })}
                    icon={<ArrowUp {...ICON_SM} />}
                    size="small"
                    muted
                    disabled={index === 0}
                    onClick={() => move(shortcut.id, -1)}
                  />
                  <IconButton
                    label={t('shortcuts.moveDown', { label: shortcut.label })}
                    icon={<ArrowDown {...ICON_SM} />}
                    size="small"
                    muted
                    disabled={index === rows.length - 1}
                    onClick={() => move(shortcut.id, 1)}
                  />
                  <IconButton
                    label={t('shortcuts.editOne', { label: shortcut.label })}
                    icon={<Pencil {...ICON_SM} />}
                    size="small"
                    muted
                    onClick={() => setEditing({ draft: toDraft(shortcut), isNew: false })}
                  />
                  {pendingDelete === shortcut.id ? (
                    <button
                      type="button"
                      autoFocus
                      className="rd-btn rd-btn--danger rd-slist__confirm"
                      onClick={() => {
                        setList((current) => current.filter((s) => s.id !== shortcut.id));
                        setPendingDelete(null);
                      }}
                      onBlur={() => setPendingDelete(null)}
                    >
                      {t('shortcuts.confirmDelete')}
                    </button>
                  ) : (
                    <IconButton
                      label={t('shortcuts.deleteOne', { label: shortcut.label })}
                      icon={<Trash2 {...ICON_SM} />}
                      size="small"
                      muted
                      onClick={() => setPendingDelete(shortcut.id)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
          <div>
            <button
              type="button"
              className="rd-btn rd-btn--secondary"
              onClick={() =>
                setEditing({
                  isNew: true,
                  draft: {
                    id: newId(),
                    label: '',
                    group: tab,
                    kind: tab === 'handoff' ? 'action' : tab === 'commands' ? 'slash' : 'prompt',
                    text: '',
                    action: '',
                    mode: 'send',
                    hotkey: '',
                    hint: '',
                  },
                })
              }
            >
              <Plus {...ICON_SM} />
              {t('shortcuts.add')}
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
