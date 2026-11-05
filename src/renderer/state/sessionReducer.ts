import type { EngineEvent } from '@shared/events';
import type { HistoryPage, TranscriptItem } from '@shared/types';
import type { SessionView, Submission, ViewError } from './types';

export type ViewSeed = Pick<SessionView, 'key' | 'profileId' | 'cwd' | 'title'> & Partial<SessionView>;

export function createView(seed: ViewSeed): SessionView {
  return {
    isNew: false,
    confirmed: false,
    takeover: false,
    engineState: 'none',
    opening: false,
    items: [],
    localEchoes: [],
    submissions: [],
    history: 'idle',
    slashCommands: [],
    commands: [],
    models: [],
    permissions: [],
    questions: [],
    errors: [],
    ...seed,
  };
}

export function isActiveState(state: SessionView['engineState']): boolean {
  return state === 'running' || state === 'awaiting';
}

export function isSubmissionPending(submission: Submission): boolean {
  return ['preparing', 'queued', 'sending', 'waiting'].includes(submission.phase);
}

/** The slash command submission pending on the view's handle (commands never stack); messages queued behind it keep its label. */
export function runningCommand(view: SessionView): Submission | undefined {
  if (!view.handleId) return undefined;
  return view.submissions.find((entry) => entry.handleId === view.handleId && entry.command && isSubmissionPending(entry));
}

/** A slash command still pending for the view (its handle, or the one being opened for it). */
export function pendingCommand(view: SessionView): string | undefined {
  return view.submissions.find((entry) => entry.command && isSubmissionPending(entry)
    && (!entry.handleId || entry.handleId === view.handleId))?.command;
}

/** True while an engine handle is usable (open and not closed). */
export function hasOpenHandle(view: SessionView): boolean {
  return Boolean(view.handleId) && view.engineState !== 'closed' && view.engineState !== 'none';
}

/** Same id = replace in place; otherwise right after `afterId` while that item is shown, else after `anchorId`, else append. */
export function upsertItem(items: readonly TranscriptItem[], item: TranscriptItem, afterId?: string, anchorId?: string): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index < 0) {
    const shown = (id: string | undefined): number => (id === undefined ? -1 : items.findIndex((existing) => existing.id === id));
    let after = shown(afterId);
    if (after < 0) after = shown(anchorId);
    return after < 0 ? [...items, item] : [...items.slice(0, after + 1), item, ...items.slice(after + 1)];
  }
  const next = items.slice();
  next[index] = item;
  return next;
}

function stopStreaming(items: readonly TranscriptItem[]): TranscriptItem[] {
  if (!items.some((item) => (item.kind === 'assistant' || item.kind === 'thinking') && item.streaming)) {
    return items as TranscriptItem[];
  }
  return items.map((item) =>
    (item.kind === 'assistant' || item.kind === 'thinking') && item.streaming ? { ...item, streaming: false } : item,
  );
}

function applyItem(view: SessionView, item: TranscriptItem, now: number, afterId?: string, anchorId?: string): SessionView {
  if (item.kind === 'user' && item.deliveryUnconfirmed) {
    view = { ...view, submissions: view.submissions.map((submission) =>
      submission.handleId === view.handleId && submission.nativeItemId === item.id
        ? { ...submission, phase: 'unconfirmed', settledAt: submission.settledAt ?? now }
        : submission) };
  }
  if (item.kind === 'user' && !item.queued) {
    // A queued message is sent when the running reply ends: show it after that reply, not inside it (RQ-6).
    const index = view.items.findIndex((existing) => existing.id === item.id);
    const existing = view.items[index];
    if (existing?.kind === 'user' && existing.queued) {
      return { ...view, items: [...view.items.slice(0, index), ...view.items.slice(index + 1), item] };
    }
  }
  if (item.kind === 'user' && view.localEchoes.length > 0 && !view.items.some((i) => i.id === item.id)) {
    const echoId = view.localEchoes.find((id) => {
      const echo = view.items.find((i) => i.id === id);
      const submission = view.submissions.find((entry) => entry.echoId === id);
      return (!submission || submission.handleId === view.handleId)
        && echo?.kind === 'user' && !echo.deliveryUnconfirmed && echo.text.trim() === item.text.trim();
    });
    if (echoId) {
      return {
        ...view,
        items: view.items.map((existing) => (existing.id === echoId ? item : existing)),
        localEchoes: view.localEchoes.filter((id) => id !== echoId),
        submissions: view.submissions.map((submission) => submission.echoId === echoId && submission.handleId === view.handleId
          ? { ...submission, nativeItemId: item.id } : submission),
      };
    }
  }
  return { ...view, items: upsertItem(view.items, item, afterId, anchorId) };
}

function applyDelta(view: SessionView, itemId: string, text: string): SessionView {
  const index = view.items.findIndex((item) => item.id === itemId);
  if (index < 0) {
    return { ...view, items: [...view.items, { kind: 'assistant', id: itemId, text, streaming: true }] };
  }
  const item = view.items[index]!;
  if (item.kind !== 'assistant' && item.kind !== 'thinking') return view;
  const items = view.items.slice();
  items[index] = { ...item, text: item.text + text, streaming: true };
  return { ...view, items };
}

/** Applies one engine event to the view that owns its handle. Pure: `now` is passed in. */
export function applyEngineEvent(view: SessionView, event: EngineEvent, now: number): SessionView {
  switch (event.type) {
    case 'init':
      return {
        ...view,
        sessionId: event.sessionId || view.sessionId,
        model: event.model || view.model,
        effort: event.effort ?? view.effort,
        permissionMode: event.permissionMode ?? view.permissionMode,
        slashCommands: event.slashCommands,
        cwd: event.cwd || view.cwd,
        ...(event.fast ? { fast: event.fast } : {}),
        ...(event.nativeFast ? { nativeFast: event.nativeFast,
          ...(typeof event.nativeFast.requested === 'boolean' ? { fastMode: event.nativeFast.requested } : {}),
          fast: event.fast ?? (event.nativeFast.state ? { state: event.nativeFast.state } : undefined),
        } : {}),
      };
    case 'item':
      return applyItem(view, event.item, now, event.afterId, event.anchorId);
    case 'delta':
      return applyDelta(view, event.itemId, event.text);
    case 'permission':
      if (view.permissions.some((r) => r.requestId === event.request.requestId)) return view;
      return { ...view, permissions: [...view.permissions, event.request] };
    case 'question':
      if (view.questions.some((r) => r.requestId === event.request.requestId)) return view;
      return { ...view, questions: [...view.questions, event.request] };
    case 'requestClosed':
      return {
        ...view,
        permissions: view.permissions.filter((r) => r.requestId !== event.requestId),
        questions: view.questions.filter((r) => r.requestId !== event.requestId),
      };
    case 'state': {
      const active = isActiveState(event.state);
      const newTurn = active && !isActiveState(view.engineState);
      const startedAt = event.startedAt ?? (newTurn ? now : view.startedAt);
      const tokens = event.tokens ?? (newTurn ? undefined : view.tokens);
      if (event.state === 'closed') {
        const pending = view.submissions.filter((submission) => (isSubmissionPending(submission) || view.localEchoes.includes(submission.echoId))
          && (!submission.handleId || submission.handleId === event.handleId));
        const pendingEchoes = new Set(pending.map((submission) => submission.echoId));
        const unconfirmedIds = new Set(view.items
          .filter((item) => item.kind === 'user' && (item.queued || item.deliveryUnconfirmed || pendingEchoes.has(item.id)))
          .map((item) => item.id));
        return {
          ...view,
          engineState: 'closed',
          handleId: undefined,
          mcp: undefined,
          startedAt,
          tokens,
          permissions: [],
          questions: [],
          items: stopStreaming(view.items).map((item) =>
            item.kind === 'user' && (item.queued || pendingEchoes.has(item.id)) ? { ...item, queued: undefined, deliveryUnconfirmed: true } : item,
          ),
          localEchoes: view.localEchoes.filter((id) => !unconfirmedIds.has(id)),
          submissions: view.submissions.map((submission) => pending.includes(submission)
            || (submission.handleId === event.handleId && submission.nativeItemId && unconfirmedIds.has(submission.nativeItemId))
            ? { ...submission, phase: 'unconfirmed', settledAt: now } : submission),
          autoContinue: undefined,
          panel: undefined,
        };
      }
      return {
        ...view,
        engineState: event.state,
        startedAt,
        tokens,
        items: event.state === 'idle' ? stopStreaming(view.items) : view.items,
      };
    }
    case 'context':
      return { ...view, context: event.usage };
    case 'commands':
      return { ...view, commands: event.commands };
    case 'tasks':
      return { ...view, tasks: event.tasks };
    case 'mcp':
      return { ...view, mcp: event.servers };
    case 'autoContinue':
      if (event.state.phase === 'idle') return view.autoContinue ? { ...view, autoContinue: undefined } : view;
      // A late wait of a handle that is gone could never be cancelled from here.
      if (!hasOpenHandle(view)) return view;
      return { ...view, autoContinue: event.state };
    case 'panel':
      if (!event.panel) return view.panel ? { ...view, panel: undefined } : view;
      // A late panel of a closed handle could never be operated; a revision not above the shown one is stale.
      if (!hasOpenHandle(view) || (view.panel && event.panel.revision <= view.panel.revision)) return view;
      return { ...view, panel: event.panel };
    case 'account':
      return {
        ...view,
        account: { email: event.email, subscriptionType: event.subscriptionType, organization: event.organization },
      };
    case 'error': {
      const error: ViewError = {
        id: `engine-${now}-${view.errors.length}`,
        message: event.message,
        fatal: event.fatal,
        retry: event.fatal ? { kind: 'open' } : { kind: 'none' },
      };
      return { ...view, errors: [...view.errors, error] };
    }
    default:
      return view;
  }
}

/**
 * History first, then live items that arrived while it loaded. `stale` = ids shown when the request started: the
 * new history replaces them, except explicit local unconfirmed user intent absent from its actual IDs and the live
 * native turn results the saved history never has. Those stay right after the item they followed; queued ones stay last.
 */
export function mergeHistory(view: SessionView, history: readonly TranscriptItem[], stale?: ReadonlySet<string>): SessionView {
  const historyIds = new Set(history.map((item) => item.id));
  const localIds = new Set(view.submissions.filter(isSubmissionPending).map((submission) => submission.echoId));
  const retained = (item: TranscriptItem): boolean =>
    (item.kind === 'user' && (item.deliveryUnconfirmed === true || item.queued === true || localIds.has(item.id)))
    || (item.kind === 'result' && item.id.startsWith('native-result:'));
  const items = history.slice();
  const queued: TranscriptItem[] = [];
  let anchor: string | undefined;
  for (const item of view.items) {
    if (historyIds.has(item.id)) {
      anchor = item.id;
      continue;
    }
    const old = stale?.has(item.id) ?? false;
    if (old && !retained(item)) continue;
    if (item.kind === 'user' && item.queued) {
      queued.push(item);
      continue;
    }
    // Live items that arrived during the load, or kept ones whose neighbours all went, follow the history.
    const at = old && anchor !== undefined ? items.findIndex((entry) => entry.id === anchor) + 1 : items.length;
    items.splice(at, 0, item);
    anchor = item.id;
  }
  items.push(...queued);
  const kept = new Set(items.map((item) => item.id));
  const localEchoes = view.localEchoes.filter((id) => kept.has(id));
  return {
    ...view,
    items,
    localEchoes: localEchoes.length === view.localEchoes.length ? view.localEchoes : localEchoes,
    history: 'loaded',
  };
}

/**
 * The latest history page over the view. A page that starts at an item shown after older ones still joins them: they stay
 * with their cursor. Otherwise it replaces them (they may no longer meet it) and brings its own cursor.
 */
export function mergeLatestPage(view: SessionView, page: HistoryPage, stale?: ReadonlySet<string>): SessionView {
  const first = page.items[0]?.id;
  const at = first === undefined ? -1 : view.items.findIndex((item) => item.id === first);
  if (at > 0) {
    const pageIds = new Set(page.items.map((item) => item.id));
    const before = view.items.slice(0, at).filter((item) => !pageIds.has(item.id));
    return mergeHistory(view, [...before, ...page.items], stale);
  }
  return { ...mergeHistory(view, page.items, stale), olderHistory: page.older ? { cursor: page.older, state: 'idle' } : undefined };
}

/** An older history page goes above the items; ids already shown (a page edge seen twice) are skipped. */
export function prependHistory(view: SessionView, page: HistoryPage): SessionView {
  const shown = new Set(view.items.map((item) => item.id));
  const older = page.items.filter((item) => !shown.has(item.id));
  return {
    ...view,
    items: older.length > 0 ? [...older, ...view.items] : view.items,
    olderHistory: page.older ? { cursor: page.older, state: 'idle' } : undefined,
  };
}

/**
 * Key of the view that already shows `sessionId` for this account, preferring one with an open or opening
 * handle (RQ-1: Relay's own new `n-*` view keeps its key after the session shows up in the list).
 */
export function findSessionViewKey(
  views: Readonly<Record<string, SessionView>>,
  sessionId: string,
  profileId: string,
): string | undefined {
  const id = sessionId.toLowerCase();
  let fallback: string | undefined;
  for (const [key, view] of Object.entries(views)) {
    // A side chat shares the session id until its fork starts; it never stands for the session itself.
    if (view.sideChatOf || view.profileId !== profileId || view.sessionId?.toLowerCase() !== id) continue;
    if (hasOpenHandle(view) || view.engineState === 'starting') return key;
    fallback ??= key;
  }
  return fallback;
}

/** '' for account-wide events (usage), which no view owns. */
export function engineHandleOf(event: EngineEvent): string {
  if (event.type === 'usage') return '';
  return event.type === 'permission' || event.type === 'question' ? event.request.handleId : event.handleId;
}
