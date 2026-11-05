import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import {
  groupDiffStats,
  inputDiff,
  paramRows,
  summarizeActivity,
  toolTitle,
  type NoteItem,
  type ThinkingItem,
  type ToolItem,
} from '../../lib/toolActivity';
import { formatElapsed } from '../../lib/format';
import { ICON_SM, ICON_XS, Spinner } from '../ui/primitives';
import { DiffChip, DiffView } from './DiffView';
import { ImagePlaceholders, ImageThumbs, imageSourceLabel } from './ImageViewer';
import { SystemRow, ThinkingRow } from './Rows';

const MAX_THUMBS = 3;

/** Thumbnails of the tools of one line, at most `limit` in total; each opens the conversation viewer at itself. */
function ToolThumbs({ tools, limit = MAX_THUMBS }: { tools: readonly ToolItem[]; limit?: number }) {
  let left = limit;
  const parts: ReactNode[] = [];
  for (const tool of tools) {
    if (left <= 0) break;
    const refs = tool.imageRefs ?? [];
    if (refs.length > 0) {
      parts.push(<ImageThumbs key={tool.id} images={refs} label={imageSourceLabel(tool.name)} variant="tool" limit={left} itemId={tool.id} />);
      left -= Math.min(left, refs.length);
    } else if (tool.images) {
      const count = Math.min(left, tool.images);
      parts.push(<ImagePlaceholders key={tool.id} count={count} variant="tool" />);
      left -= count;
    }
  }
  if (parts.length === 0) return null;
  return <span className="rd-thumbs">{parts}</span>;
}

export function ToolRow({ tool, defaultOpen }: { tool: ToolItem; defaultOpen?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen ?? tool.status === 'error');
  const diff = inputDiff(tool.name, tool.input);
  const params = diff ? [] : paramRows(tool.input);
  const running = tool.status === 'running';
  const statusWord =
    tool.status === 'error' ? t('tools.statusFailed') : tool.status === 'denied' ? t('tools.statusDenied') : null;
  return (
    <div
      className="rd-toolrow"
      data-status={tool.status}
      data-nested={tool.parentToolUseId ? 'true' : undefined}
      data-testid="tool-row"
    >
      <div className="rd-toolrow__line">
        <button type="button" className="rd-toolrow__head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {running ? <Spinner small label={t('status.running')} /> : null}
          <span className="rd-toolrow__summary">{toolTitle(tool)}</span>
          {statusWord ? <span className="rd-toolrow__status">{statusWord}</span> : null}
          {open ? <ChevronDown {...ICON_XS} className="rd-toolrow__chev" /> : <ChevronRight {...ICON_SM} className="rd-toolrow__chev" />}
        </button>
        <ToolThumbs tools={[tool]} />
      </div>
      {open ? (
        <div className="rd-toolrow__body">
          {tool.status === 'error' && tool.output ? (
            <div className="rd-toolrow__error rd-selectable" role="alert">
              {tool.output}
            </div>
          ) : null}
          {diff ? <DiffView diff={diff} /> : null}
          {params.length > 0 ? (
            <dl className="rd-params rd-selectable">
              {params.map((row) => (
                <div key={row.key} className="rd-params__row">
                  <dt className="rd-params__key rd-mono">{row.key}:</dt>
                  <dd className={row.prose ? 'rd-params__value' : 'rd-params__value rd-mono'}>{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {tool.status !== 'error' && tool.output ? (
            <pre className="rd-toolrow__output rd-mono rd-selectable">{tool.output}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Re-renders every second while `active`, for elapsed times. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Tool-activity summary line (§4.6) that expands into the bordered tool card (§4.7); task notes fold in here too.
 * `line` is what the transcript shows on the last line of a running turn (held steady there); `live` marks that line.
 */
export function ToolGroup({
  tools,
  notes = [],
  entries,
  line,
  live = false,
}: {
  tools: ToolItem[];
  notes?: NoteItem[];
  entries: Array<ToolItem | ThinkingItem | NoteItem>;
  line?: { text: string; running: boolean };
  live?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const stats = groupDiffStats(tools);
  const running = line?.running ?? false;
  // Like the desktop: while a call runs, the line names that step and times the whole group.
  const summary = line ? line.text : summarizeActivity(tools, notes, t);
  const single = tools.length === 1 && notes.length === 0;
  const since = running ? tools.find((tool) => tool.startedAt !== undefined)?.startedAt : undefined;
  const now = useSecondTick(since !== undefined);
  return (
    <div className="rd-tools" data-testid="tool-group" data-live={live ? 'true' : undefined}>
      <div className="rd-tools__line">
        <button type="button" className="rd-tools__summary" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {running ? <Spinner small label={t('status.running')} /> : null}
          <span className="rd-tools__text">{summary}</span>
          {since !== undefined ? (
            <span className="rd-tools__elapsed rd-tnum" data-testid="tool-elapsed">
              {formatElapsed(now - since)}
            </span>
          ) : null}
          {stats ? <DiffChip added={stats.added} removed={stats.removed} /> : null}
          {open ? <ChevronDown {...ICON_SM} className="rd-tools__chev" /> : <ChevronRight {...ICON_SM} className="rd-tools__chev" />}
        </button>
        {open ? null : <ToolThumbs tools={tools} />}
      </div>
      {open ? (
        <div className="rd-toolcard">
          {entries.map((entry) =>
            entry.kind === 'tool' ? (
              <ToolRow key={entry.id} tool={entry} defaultOpen={single || entry.status === 'error'} />
            ) : entry.kind === 'system' ? (
              <div key={entry.id} className="rd-toolrow rd-toolrow--note" data-testid="task-note-row">
                <SystemRow item={entry} />
              </div>
            ) : (
              <div key={entry.id} className="rd-toolrow">
                <ThinkingRow item={entry} inCard />
              </div>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
