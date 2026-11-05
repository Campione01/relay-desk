import { CircleStop, CornerDownLeft, Folder, Paperclip, Plus, SquareSlash, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { MAX_PROMPT_ATTACHMENTS } from '@shared/types';
import { useT } from '../../i18n';
import { buildSlashEntries, filterSlash, slashInsertText, slashQuery, type SlashEntry } from '../../lib/slash';
import { useAppState, useController } from '../../state/context';
import { isActiveState } from '../../state/sessionReducer';
import { useStoreValue } from '../../state/store';
import type { SessionView } from '../../state/types';
import { Menu, type MenuEntry } from '../ui/Menu';
import { ICON, IconButton } from '../ui/primitives';
import {
  EMPTY_ATTACHMENTS,
  addAttachments,
  attachmentStore,
  filesOf,
  ingestFiles,
  removeAttachments,
  setSending,
  toPromptAttachment,
} from './attachmentFiles';
import { AttachmentChips, problemText } from './Attachments';
import { SlashPopup } from './SlashPopup';

const MAX_HEIGHT_RATIO = 0.4;

/** Prompt box (§4.10): "+" menu, attachment chips, auto-growing textarea, slash popup, send / stop. */
export function PromptBox({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const draft = useAppState((s) => s.drafts[view.key] ?? '');
  const focusTick = useAppState((s) => s.promptFocus);
  const shortcuts = useAppState((s) => s.shortcuts);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashClosedFor, setSlashClosedFor] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const popupId = useId();
  const noticeId = useId();
  const running = isActiveState(view.engineState);
  const store = attachmentStore(controller);
  const attachments = useStoreValue(store, (s) => s.lists[view.key] ?? EMPTY_ATTACHMENTS);

  const query = slashQuery(draft);
  const entries = useMemo(
    () => buildSlashEntries(view.commands, view.slashCommands, shortcuts),
    [view.commands, view.slashCommands, shortcuts],
  );
  const filtered = useMemo(() => (query === null ? [] : filterSlash(entries, query)), [entries, query]);
  const slashOpen = query !== null && slashClosedFor !== draft && filtered.length > 0;
  const activeIndex = Math.min(slashIndex, Math.max(0, filtered.length - 1));

  useEffect(() => setSlashIndex(0), [query]);

  useEffect(() => setNotice(''), [view.key]);

  useEffect(() => {
    if (document.querySelector('[aria-modal="true"]')) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [focusTick, view.key]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = Math.max(120, window.innerHeight * MAX_HEIGHT_RATIO);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [draft]);

  const setDraft = (text: string): void => controller.setDraft(view.key, text);

  const submit = (queue: boolean): void => {
    const key = view.key;
    const sent = attachments;
    if (!draft.trim() && sent.length === 0) return;
    if (sent.length === 0) {
      void controller.send(key, draft, queue);
      return;
    }
    if (store.get().sending[key]) return;
    setSending(store, key, true);
    setNotice('');
    void controller
      .send(key, draft, queue, sent.map(toPromptAttachment))
      .then((ok) => {
        if (ok) removeAttachments(store, key, sent.map((a) => a.id));
      })
      .finally(() => setSending(store, key, false));
  };

  const keyRef = useRef(view.key);
  keyRef.current = view.key;

  /** Pasted or dropped files: media become chips, other files with a local path become @-mentions. */
  const ingest = async (key: string, files: File[]): Promise<void> => {
    const room = MAX_PROMPT_ATTACHMENTS - (store.get().lists[key]?.length ?? 0);
    const result = await ingestFiles(files, room);
    if (result.mentions.length > 0) {
      const current = controller.state.drafts[key] ?? '';
      const spacer = current && !/\s$/.test(current) ? ' ' : '';
      controller.setDraft(key, `${current}${spacer}${result.mentions.join(' ')} `);
    }
    const problems = [...result.problems];
    if (addAttachments(store, key, result.attachments) > 0 && !problems.some((p) => p.kind === 'tooMany')) {
      problems.unshift({ kind: 'tooMany', max: MAX_PROMPT_ATTACHMENTS });
    }
    if (keyRef.current === key) setNotice(problemText(problems, t));
    if (controller.state.currentKey === key) controller.focusPrompt();
  };
  const ingestRef = useRef(ingest);
  ingestRef.current = ingest;

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData;
    // Copies from Office and similar apps carry the text plus a picture of it: the text is what the user meant.
    if (data.getData('text/plain')) return;
    const files = filesOf(data);
    if (files.length === 0) return;
    event.preventDefault();
    void ingest(view.key, files);
  };

  // Drops anywhere on the session pane (transcript or prompt box) are handled like a paste.
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>('.rd-session') ?? rootRef.current;
    if (!pane) return;
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent): void => {
      const next = event.relatedTarget as Node | null;
      if (!next || !pane.contains(next)) setDragging(false);
    };
    const onDrop = (event: DragEvent): void => {
      setDragging(false);
      const files = filesOf(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      void ingestRef.current(keyRef.current, files);
    };
    pane.addEventListener('dragover', onDragOver);
    pane.addEventListener('dragleave', onDragLeave);
    pane.addEventListener('drop', onDrop);
    return () => {
      pane.removeEventListener('dragover', onDragOver);
      pane.removeEventListener('dragleave', onDragLeave);
      pane.removeEventListener('drop', onDrop);
    };
  }, []);

  const choose = (entry: SlashEntry): void => {
    const text = slashInsertText(entry);
    setDraft(text);
    setSlashClosedFor(text);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (slashOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSlashIndex((activeIndex + 1) % filtered.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSlashIndex((activeIndex - 1 + filtered.length) % filtered.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        const entry = filtered[activeIndex];
        if (entry) {
          event.preventDefault();
          choose(entry);
          return;
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setSlashClosedFor(draft);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      submit(event.ctrlKey || event.metaKey);
      return;
    }
    if (event.key === 'Escape' && running) {
      event.preventDefault();
      void controller.interrupt(view.key);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'u') {
      event.preventDefault();
      setPlusOpen(false);
      void controller.addFilesToPrompt(view.key);
    }
  };

  const plusEntries: MenuEntry[] = [
    {
      id: 'files',
      label: t('prompt.addFiles'),
      icon: <Paperclip {...ICON} />,
      shortcut: 'Ctrl+U',
      onSelect: () => void controller.addFilesToPrompt(view.key),
    },
    {
      id: 'folder',
      label: t('prompt.addFolder'),
      icon: <Folder {...ICON} />,
      onSelect: () => void controller.addFolderToPrompt(view.key),
    },
    {
      id: 'slash',
      label: t('prompt.slashCommands'),
      icon: <SquareSlash {...ICON} />,
      onSelect: () => {
        setDraft('/');
        setSlashClosedFor(null);
        controller.focusPrompt();
      },
    },
  ];

  const hasText = draft.trim().length > 0;
  const hasContent = hasText || attachments.length > 0;
  const showStop = running && !hasContent;

  return (
    <div ref={rootRef} className="rd-prompt" data-testid="prompt-box">
      {slashOpen ? (
        <SlashPopup
          id={popupId}
          entries={filtered}
          active={activeIndex}
          onHover={setSlashIndex}
          onChoose={choose}
        />
      ) : null}
      <div className="rd-prompt__box" data-drag={dragging || undefined}>
        <AttachmentChips items={attachments} onRemove={(id) => removeAttachments(store, view.key, [id])} />
        {notice ? (
          <div className="rd-prompt__notice" id={noticeId} role="alert">
            <span className="rd-prompt__notice-text">{notice}</span>
            <IconButton
              label={t('attach.dismiss')}
              icon={<X size={12} strokeWidth={2} aria-hidden />}
              size="small"
              tipPlace="top"
              onClick={() => setNotice('')}
            />
          </div>
        ) : null}
        <IconButton
          ref={plusRef}
          label={t('prompt.plusMenu')}
          icon={<Plus {...ICON} />}
          size="square"
          className="rd-prompt__plus"
          aria-haspopup="menu"
          aria-expanded={plusOpen}
          tipPlace="top"
          onClick={() => setPlusOpen((v) => !v)}
        />
        <Menu
          anchor={plusRef.current}
          open={plusOpen}
          onClose={() => setPlusOpen(false)}
          entries={plusEntries}
          label={t('prompt.plusMenu')}
          placement="top-start"
          offset={11}
          width={214}
        />
        <div className="rd-prompt__field">
          {draft === '/' ? (
            <span className="rd-prompt__hint" aria-hidden="true">
              <span className="rd-prompt__hint-slash">/</span>
              {t('prompt.slashFilter')}
            </span>
          ) : null}
          <textarea
            ref={textareaRef}
            className="rd-prompt__input rd-selectable"
            rows={1}
            value={draft}
            placeholder={t('prompt.placeholder')}
            aria-label={t('prompt.label')}
            aria-autocomplete="list"
            aria-controls={slashOpen ? popupId : undefined}
            aria-activedescendant={slashOpen ? `${popupId}-${activeIndex}` : undefined}
            aria-describedby={notice ? noticeId : undefined}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
        </div>
        {showStop ? (
          <IconButton
            label={t('prompt.stop')}
            shortcut="Esc"
            icon={<CircleStop size={16} strokeWidth={2} aria-hidden />}
            size="square"
            className="rd-prompt__action"
            tipPlace="top"
            onClick={() => void controller.interrupt(view.key)}
          />
        ) : (
          <IconButton
            label={running ? t('prompt.sendSteer') : t('prompt.send')}
            shortcut="Enter"
            icon={<CornerDownLeft size={16} strokeWidth={2} aria-hidden />}
            size="square"
            className="rd-prompt__action"
            tipPlace="top"
            disabled={!hasContent}
            onClick={() => submit(false)}
          />
        )}
      </div>
    </div>
  );
}
