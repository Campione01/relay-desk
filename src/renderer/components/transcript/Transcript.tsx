import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from '@shared/types';
import { useT, type Translate } from '../../i18n';
import { buildBlocks, summarizeActivity, toolTitle, type Block } from '../../lib/toolActivity';
import { isActiveState } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { ICON_SM } from '../ui/primitives';
import { ImageGalleryContext, ImageViewer, collectImages, type GalleryImage } from './ImageViewer';
import { Markdown } from './Markdown';
import { ErrorRow, HandedOffRow, LoadEarlier, PlanCard, ResultRow, StatusLine, SystemRow, ThinkingRow, UserMessage } from './Rows';
import { RunningLine } from '../tasks/RunningLine';
import { SelectionMenu } from './SelectionMenu';
import { ToolGroup } from './ToolGroup';

const STICK_THRESHOLD = 48;

/** Shortest time the last activity line of a running turn keeps one text; quick calls would otherwise flicker it. */
export const STEP_DWELL_MS = 1000;

/** What that line shows: its running step, or its summary between steps. `scope` names the view and the line. */
type LiveLine = { scope: string; groupId: string; toolId?: string; text: string } | undefined;

const lineKey = (line: LiveLine): string => (line ? `${line.toolId ?? ''}\n${line.text}` : '');
const lineScope = (line: LiveLine): string => line?.scope ?? '';

/** Shows each value for at least `minMs`, then the newest one; a value of another scope shows at once. */
function useSteady<T>(value: T, keyOf: (value: T) => string, minMs: number, scopeOf: (value: T) => string): T {
  const [shown, setShown] = useState(() => ({ value, at: Date.now() }));
  const latest = useRef(value);
  latest.current = value;
  const changed = keyOf(value) !== keyOf(shown.value);
  const moved = scopeOf(value) !== scopeOf(shown.value);
  useLayoutEffect(() => {
    if (!changed && !moved) return;
    const adopt = (): void => setShown({ value: latest.current, at: Date.now() });
    const wait = moved ? 0 : shown.at + minMs - Date.now();
    if (wait <= 0) {
      adopt();
      return;
    }
    const timer = setTimeout(adopt, wait);
    return () => clearTimeout(timer);
  }, [changed, moved, shown, minMs]);
  return shown.value;
}

function liveLine(blocks: readonly Block[], view: SessionView, t: Translate): LiveLine {
  const last = blocks.at(-1);
  if (view.engineState !== 'running' || last?.type !== 'tools') return undefined;
  const scope = `${view.key}\n${last.id}`;
  const tool = last.tools.filter((entry) => entry.status === 'running').at(-1);
  return tool
    ? { scope, groupId: last.id, toolId: tool.id, text: toolTitle(tool, true) }
    : { scope, groupId: last.id, text: summarizeActivity(last.tools, last.notes, t) };
}

/** Scrolling transcript column: history + live items, plan card, status line and inline errors. */
export function Transcript({ view }: { view: SessionView }) {
  const t = useT();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /** Scroll position and height as of the last commit, scroll or resize: what a prepend of earlier messages measures from. */
  const layoutRef = useRef({ top: 0, height: 0 });
  const firstItemRef = useRef<TranscriptItem | undefined>(undefined);
  // Only a send adds a submission: a new newest one is the user's own message or command, which scrolls into view.
  const sent = view.submissions.at(-1)?.id;
  const sentRef = useRef(sent);
  const [showJump, setShowJump] = useState(false);
  const { blocks, plan } = useMemo(() => buildBlocks(view.items), [view.items]);
  const running = isActiveState(view.engineState);
  // The activity line and the status line read one steady value, so they switch together; only a pending command keeps both.
  const raw = liveLine(blocks, view, t);
  const steady = useSteady(raw, lineKey, STEP_DWELL_MS, lineScope);
  const line = raw && steady?.scope === raw.scope ? steady : undefined;
  const lastBlock = blocks.at(-1);
  const showPlan = plan && (running || plan.todos.some((todo) => todo.status !== 'completed'));
  const pastedLabel = t('image.pasted');
  const gallery = useMemo(() => collectImages(view.items, pastedLabel), [view.items, pastedLabel]);
  const galleryRef = useRef(gallery);
  galleryRef.current = gallery;
  const [viewer, setViewer] = useState<{ images: GalleryImage[]; start: number } | null>(null);
  const openImage = useCallback((itemId: string, index: number): void => {
    const images = galleryRef.current;
    const start = images.findIndex((entry) => entry.itemId === itemId && entry.index === index);
    if (start >= 0) setViewer({ images, start });
  }, []);

  const scrollToEnd = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setShowJump(false);
  };

  const rememberLayout = (): void => {
    const el = scrollerRef.current;
    if (el) layoutRef.current = { top: el.scrollTop, height: el.scrollHeight };
  };

  useLayoutEffect(() => {
    stickRef.current = true;
    scrollToEnd();
  }, [view.key]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const previous = firstItemRef.current;
    firstItemRef.current = view.items[0];
    const own = sent !== sentRef.current;
    sentRef.current = sent;
    if (own) scrollToEnd();
    else if (el && previous && previous !== view.items[0] && view.items.indexOf(previous) > 0) {
      // Earlier messages went in above: whatever the user is reading keeps its place on screen.
      el.scrollTop = layoutRef.current.top + el.scrollHeight - layoutRef.current.height;
    } else if (stickRef.current) scrollToEnd();
    else setShowJump(true);
    rememberLayout();
  }, [view.items, view.engineState, view.errors.length, view.history, view.handedOff, sent]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const follow = (): void => {
      if (stickRef.current) el.scrollTop = el.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    observer.observe(el);
    // Rows that change height on their own (images, folded output) keep a view stuck to the bottom there, and move the height
    // a prepend measures from.
    const content = new ResizeObserver(() => {
      follow();
      rememberLayout();
    });
    // The user's own expand or collapse is not such a row: it settles like a scroll, from where it leaves the view, before that
    // resize would pull the view past what was just opened.
    const toggles = new MutationObserver(() => onScroll());
    if (columnRef.current) {
      content.observe(columnRef.current);
      toggles.observe(columnRef.current, { subtree: true, attributeFilter: ['aria-expanded'] });
    }
    return () => {
      observer.disconnect();
      content.disconnect();
      toggles.disconnect();
    };
  }, []);

  const onScroll = (): void => {
    const el = scrollerRef.current;
    if (!el) return;
    rememberLayout();
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD;
    stickRef.current = near;
    if (near) setShowJump(false);
  };

  const empty = view.items.length === 0;

  return (
    <ImageGalleryContext.Provider value={openImage}>
      <div className="rd-scroller rd-colwrap" ref={scrollerRef} onScroll={onScroll} data-testid="transcript-scroller">
        <div ref={columnRef} className="rd-col rd-transcript" role="log" aria-label={t('transcript.label')} aria-live="off">
          <LoadEarlier view={view} />
          {view.history === 'loading' ? <p className="rd-transcript__note">{t('transcript.loadingHistory')}</p> : null}
          {empty && view.history !== 'loading' && !view.opening ? (
            <p className="rd-transcript__note">
              {view.isNew ? t('transcript.newHint', { folder: view.cwd }) : view.history === 'loaded' ? t('transcript.empty') : ''}
            </p>
          ) : null}
          {blocks.map((block) => {
            if (block.type === 'tools') {
              return (
                <ToolGroup
                  key={block.id}
                  tools={block.tools}
                  notes={block.notes}
                  entries={block.entries}
                  line={line?.groupId === block.id ? { text: line.text, running: line.toolId !== undefined } : undefined}
                  live={running && block === lastBlock}
                />
              );
            }
            const { item } = block;
            switch (item.kind) {
              case 'user':
                return <UserMessage key={item.id} item={item} viewKey={view.key} running={running} />;
              case 'assistant':
                return (
                  <div key={item.id} className="rd-assistant" data-testid="assistant-message" data-streaming={item.streaming ? 'true' : undefined}>
                    <Markdown text={item.text} />
                  </div>
                );
              case 'thinking':
                return <ThinkingRow key={item.id} item={item} />;
              case 'system':
                return <SystemRow key={item.id} item={item} />;
              case 'result':
                return <ResultRow key={item.id} item={item} />;
              default:
                return null;
            }
          })}
          {showPlan && plan ? <PlanCard plan={plan} /> : null}
          {view.handedOff ? <HandedOffRow result={view.handedOff} /> : null}
          {view.errors.map((error) => (
            <ErrorRow key={error.id} viewKey={view.key} error={error} />
          ))}
          <StatusLine view={view} stepShown={line?.toolId !== undefined} />
          <RunningLine key={view.key} view={view} />
        </div>
        {showJump ? (
          <button type="button" className="rd-jump" onClick={scrollToEnd}>
            <ArrowDown {...ICON_SM} />
            {t('transcript.jumpToLatest')}
          </button>
        ) : null}
        <SelectionMenu view={view} rootRef={columnRef} scrollerRef={scrollerRef} />
        {viewer ? <ImageViewer images={viewer.images} start={viewer.start} onClose={() => setViewer(null)} /> : null}
      </div>
    </ImageGalleryContext.Provider>
  );
}
