import type { EngineEvent } from '@shared/events';
import type { RelayApi } from '@shared/ipc';
import { SHORTCUT_GROUPS, type Shortcut, type ShortcutAction, type ShortcutGroup } from '@shared/shortcuts';
import { startsWithSlash, withoutDriveSlash } from '@shared/slashText';
import {
  DEFAULT_PROFILE_ID,
  SHARED_CONTEXT_ERROR_PREFIX,
  defaultSettings,
  type AppSettings,
  type AuthenticationEnvironmentMetadata,
  type AuthenticationSource,
  type AuthStatus,
  type Effort,
  type HandoffResult,
  type LaunchRequest,
  type McpServerState,
  type NativePanelInput,
  type NativeStartupInput,
  type OpenSessionRequest,
  type PermissionDecision,
  type PermissionMode,
  type PlanUsage,
  type PromptAttachment,
  type Profile,
  type ProfileId,
  type QuestionAnswer,
  type SessionSummary,
  type TranscriptItem,
  type WorkflowsSetting,
} from '@shared/types';
import { createTranslator, type MessageKey, type Params, type Translate } from '../i18n';
import { errorText, shortId } from '../lib/format';
import { parseSlash, rewritesConversation, slashRoute } from '../lib/slash';
import { applyFontScale, applyLanguage, applyTheme } from '../theme/theme';
import { actionAvailability, normalizeFolder, viewsClosedBy } from './availability';
import {
  applyEngineEvent,
  createView,
  engineHandleOf,
  findSessionViewKey,
  hasOpenHandle,
  isActiveState,
  isSubmissionPending,
  mergeLatestPage,
  pendingCommand,
  prependHistory,
} from './sessionReducer';
import { checkAccountLabel, loadAccountLabels, saveAccountLabels, weeklyAnchor } from './accountLabel';
import { nextAuthSince } from './plan';
import { mergePrefs, readSessionPrefs, writeSessionPrefs, type SessionPrefs } from './sessionPrefs';
import {
  EMPTY_MARKS,
  forgetSession,
  readMarks,
  withArchived,
  withGroup,
  withoutGroup,
  withPin,
  withPlacement,
  withUnread,
  writeMarks,
  type SidebarMarks,
} from './sidebarMarks';
import { createStore, type Store } from './store';
import type {
  AppState,
  ConfirmRequest,
  FooterMenu,
  PanelCardId,
  SessionView,
  Submission,
  TakeoverPrompt,
  TextRequest,
  Toast,
  UiState,
  ViewError,
  ViewErrorRetry,
} from './types';

const STORAGE_KEYS = {
  ui: 'relay.ui',
  group: 'relay.shortcutGroup',
} as const;

const DEFAULT_CARDS: Record<PanelCardId, boolean> = {
  environment: true,
  handoff: false,
  context: false,
  accounts: false,
  connectors: false,
  outputs: true,
  background: false,
};

const TOAST_MS = 6000;
const SESSIONS_REFRESH_MS = 1200;
const STATUS_REFRESH_MS = 10 * 60_000;
const MAX_BUFFERED_EVENTS = 500;
const MAX_BUFFERED_HANDLES = 32;
const MAX_RETIRED_HANDLES = 128;
const MAX_STARTUP_TEXT = 32_768;
const MAX_RECENT_FOLDERS = 8;
/** One toast for failed native panel input in this window (and none while the last one is still shown). */
const PANEL_TOAST_MS = 5000;

type SettingName = 'model' | 'effort' | 'permissionMode' | 'ultracode' | 'fastMode';

const settingId = (key: string, name: SettingName): string => `${key}\u0000${name}`;

/** A side chat that runs its own fork: that id is never saved, so it has no history to load. */
const isUnsavedFork = (view: SessionView): boolean => Boolean(view.sideChatOf) && view.sessionId !== view.sideChatSource;

interface OpeningAttempt {
  key: string;
  requestId: string;
  handleId?: string;
  revision: number;
  finished: boolean;
  retired: boolean;
  knownHandles: Set<string>;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
}

function initialState(): AppState {
  let storedUi: Partial<Pick<UiState, 'sidebar' | 'rightPanel' | 'cards'>> = {};
  try {
    const raw = readStorage(STORAGE_KEYS.ui);
    if (raw) storedUi = JSON.parse(raw) as typeof storedUi;
  } catch {
    storedUi = {};
  }
  const storedGroup = readStorage(STORAGE_KEYS.group);
  const group = (SHORTCUT_GROUPS as readonly string[]).includes(storedGroup ?? '')
    ? (storedGroup as ShortcutGroup)
    : 'replies';
  return {
    ready: false,
    settings: defaultSettings(),
    versions: null,
    profiles: [],
    auth: {},
    usage: {},
    plans: {},
    labels: {},
    modelCatalog: {},
    activeProfileId: DEFAULT_PROFILE_ID,
    sessions: [],
    sessionsState: 'idle',
    views: {},
    handleToKey: {},
    currentKey: null,
    navBack: [],
    navForward: [],
    shortcuts: [],
    shortcutGroup: group,
    drafts: {},
    promptFocus: 0,
    ui: {
      sidebar: typeof storedUi.sidebar === 'boolean' ? storedUi.sidebar : true,
      rightPanel: typeof storedUi.rightPanel === 'boolean' ? storedUi.rightPanel : true,
      tasksPane: false,
      tasksPaneTask: null,
      cards: { ...DEFAULT_CARDS, ...(storedUi.cards ?? {}) },
      settings: false,
      shortcutEditor: false,
      keyboardHelp: false,
      footerMenu: null,
      sessionSearch: false,
    },
    takeover: null,
    confirm: null,
    textRequest: null,
    toasts: [],
    background: { list: [], state: 'idle' },
    marks: readMarks(),
    codeContext: null,
  };
}

export const sessionKey = (sessionId: string): string => `s:${sessionId}`;

/**
 * Main deletes only `<userData>\profiles\<id>` (profiles.ts remove); the renderer does not know userData, so it
 * offers the delete option only for folders of that shape and main still checks the exact path (RQ-11).
 */
export function isManagedProfileDir(profile: Pick<Profile, 'id' | 'configDir'>): boolean {
  if (!profile.configDir) return false;
  const parts = profile.configDir.replace(/[\\/]+$/, '').split(/[\\/]+/);
  return parts.length >= 3 && parts.at(-1)!.toLowerCase() === profile.id.toLowerCase() && parts.at(-2)!.toLowerCase() === 'profiles';
}

/**
 * The mode the next open asks for: the user's pick in this view, else the Settings default. A mode the CLI reported
 * is never sent back: it would override the native settings next time (EC-1).
 */
export function pendingPermissionMode(
  view: Pick<SessionView, 'permissionOverride'>,
  settings: Pick<AppSettings, 'defaultPermissionMode'>,
): PermissionMode | undefined {
  return view.permissionOverride ?? settings.defaultPermissionMode;
}

/** View fields seeded from a conversation's remembered choices; a remembered mode counts as the user's pick. */
export function rememberedFields(prefs: SessionPrefs | undefined): Partial<SessionView> {
  if (!prefs) return {};
  return {
    prefs,
    ...(prefs.model ? { model: prefs.model } : {}),
    ...(prefs.effort ? { effort: prefs.effort } : {}),
    ...(prefs.permissionMode ? { permissionMode: prefs.permissionMode, permissionOverride: prefs.permissionMode } : {}),
    ...(prefs.ultracode ? { ultracode: true } : {}),
    ...(typeof prefs.fastMode === 'boolean' ? { fastMode: prefs.fastMode } : {}),
  };
}

/** Owns the renderer state and every call to window.relay. Components read the store and call these methods. */
export class AppController {
  readonly store: Store<AppState>;
  private readonly api: RelayApi;
  private t: Translate = createTranslator('en');
  private seq = 0;
  private readonly buffered = new Map<string, EngineEvent[]>();
  private readonly openingAttempts = new Map<string, OpeningAttempt>();
  private readonly retiredHandles = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly resolvers = new Map<string, (value: unknown) => void>();
  private takeoverResolve: ((ok: boolean) => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private profileLoad = 0;
  private backgroundLoad = 0;
  private codeContextRequest = 0;
  private historySeq = 0;
  /** "Dynamic workflows" as last saved; sessions get only saved values, never an optimistic one. */
  private savedWorkflows: WorkflowsSetting | undefined;
  /** "Continue automatically at usage limit" as last saved (unset = on); same rule as savedWorkflows. */
  private savedAutoContinue: boolean | undefined;
  /** "Refresh context usage during a turn" as last saved. */
  private savedLiveContext: boolean | undefined;
  /** view key -> token of its newest history request; older replies are dropped. */
  private readonly historyRequests = new Map<string, number>();
  /** view key -> token of its pending "Load earlier messages" request. */
  private readonly olderRequests = new Map<string, number>();
  private readonly sendOpenings = new Map<string, Promise<string | undefined>>();
  private readonly draftRevisions = new Map<string, number>();
  /** Usage pushes have no source identity; an old-source request must not refill a cleared account. */
  private readonly pendingUsageSources = new Set<{ profileId: ProfileId; source: AuthenticationSource }>();
  /** handle id -> its last queued native panel input or close; each one starts after the one before it settled. */
  private readonly panelTails = new Map<string, Promise<void>>();
  private panelToast: { id: string; at: number } | null = null;
  /** settingId -> the newest pick of that setting still in flight and the value the CLI last confirmed. */
  private readonly settingChanges = new Map<string, { seq: number; confirmed: Partial<SessionView> }>();
  private settingSeq = 0;

  constructor(api: RelayApi) {
    this.api = api;
    this.store = createStore(initialState());
  }

  // ---------------------------------------------------------------- state helpers

  get state(): AppState {
    return this.store.get();
  }

  private set(patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void {
    const left = this.state.currentKey;
    this.store.set((state) => ({ ...state, ...(typeof patch === 'function' ? patch(state) : patch) }));
    if (left && this.state.currentKey !== left) this.cancelOlderHistory(left);
  }

  private patchView(key: string, update: Partial<SessionView> | ((view: SessionView) => SessionView)): void {
    this.store.set((state) => {
      const view = state.views[key];
      if (!view) return state;
      const next = typeof update === 'function' ? update(view) : { ...view, ...update };
      if (next === view) return state;
      return { ...state, views: { ...state.views, [key]: next } };
    });
  }

  view(key: string | null | undefined): SessionView | null {
    return key ? (this.state.views[key] ?? null) : null;
  }

  currentView(): SessionView | null {
    return this.view(this.state.currentKey);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  private later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private tr(key: MessageKey, params?: Params): string {
    return this.t(key, params);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Subscribes to main-process pushes and loads the first data. Returns the cleanup. */
  start(): () => void {
    const offs = [
      this.api.engine.onEvent((event) => this.onEngineEvent(event)),
      this.api.app.onLaunchRequest((request) => {
        void this.handleLaunch(request);
      }),
      this.api.accounts.onStatus((status) => this.setAuth(status)),
      this.watchAccountStatus(),
    ];
    void this.bootstrap();
    return () => {
      for (const off of offs) off();
      for (const timer of this.timers) clearTimeout(timer);
      this.timers.clear();
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    };
  }

  private async bootstrap(): Promise<void> {
    const [settings, profiles, shortcuts, versions] = await Promise.allSettled([
      this.api.app.getSettings(),
      this.api.accounts.list(),
      this.api.shortcuts.get(),
      this.api.app.versions(),
    ]);
    if (settings.status === 'fulfilled') {
      this.applySettings(settings.value);
      this.savedWorkflows = settings.value.workflows;
      this.savedAutoContinue = settings.value.autoContinue;
      this.savedLiveContext = settings.value.liveContext;
    } else {
      this.applySettings(this.state.settings);
    }
    if (profiles.status === 'fulfilled') {
      const savedProfile = this.state.settings.activeProfileId;
      const active = savedProfile && profiles.value.some((p) => p.id === savedProfile)
        ? savedProfile
        : DEFAULT_PROFILE_ID;
      this.set({ profiles: profiles.value, activeProfileId: active });
      if (savedProfile !== active) await this.updateSettings({ activeProfileId: active });
    }
    if (shortcuts.status === 'fulfilled') this.set({ shortcuts: shortcuts.value });
    if (versions.status === 'fulfilled') this.set({ versions: versions.value });
    this.set({ ready: true });
    for (const failed of [settings, profiles, shortcuts]) {
      if (failed.status === 'rejected') this.toast('error', errorText(failed.reason));
    }
    void this.loadSessions();
    void this.refreshAllStatus(false);
    void this.refreshUsage(this.state.activeProfileId, false);
    let launch: LaunchRequest | null = null;
    try {
      launch = await this.api.app.getLaunchRequest();
    } catch (error) {
      this.toast('error', errorText(error));
    }
    if (launch) await this.handleLaunch(launch);
  }

  // ---------------------------------------------------------------- settings

  async inspectCodeContext(profileId: ProfileId, cwd?: string): Promise<void> {
    const request = ++this.codeContextRequest;
    this.set({ codeContext: { profileId, cwd, state: 'loading' } });
    const isCurrent = (): boolean => {
      const current = this.state.codeContext;
      const view = this.currentView();
      return request === this.codeContextRequest && current !== null &&
        current.profileId === profileId && current.cwd === cwd &&
        (view?.profileId ?? this.state.activeProfileId) === profileId && (view?.cwd || undefined) === cwd;
    };
    try {
      const report = await this.api.app.inspectCodeContext(profileId, cwd);
      if (!isCurrent()) return;
      if (report.profileId !== profileId) throw new Error(this.tr('codeContext.scopeMismatch'));
      this.set({ codeContext: { profileId, cwd, state: 'loaded', report } });
    } catch (error) {
      if (!isCurrent()) return;
      this.set({ codeContext: { profileId, cwd, state: 'error', error: errorText(error) } });
    }
  }

  closeCodeContext(): void {
    this.codeContextRequest += 1;
    this.set({ codeContext: null });
  }

  private patchCodeContext(profileId: ProfileId, patch: Partial<NonNullable<AppState['codeContext']>>): void {
    this.set((state) => (state.codeContext?.profileId === profileId ? { codeContext: { ...state.codeContext, ...patch } } : {}));
  }

  /** Independent accounts: share the default account's instructions, rules and skills for new writers (EC-2). */
  async setSharedCodeContext(profileId: ProfileId, enabled: boolean): Promise<void> {
    this.patchCodeContext(profileId, { busy: true });
    try {
      const profile = await this.api.accounts.setSharedCodeContext(profileId, enabled);
      this.set((state) => ({ profiles: state.profiles.map((p) => (p.id === profile.id ? profile : p)) }));
      const scope = this.state.codeContext;
      if (scope?.profileId === profileId) await this.inspectCodeContext(profileId, scope.cwd);
    } catch (error) {
      this.patchCodeContext(profileId, { busy: false });
      this.toast('error', errorText(error));
    }
  }

  /** Removes only what Relay created for sharing; everything it keeps is listed in the dialog. */
  async unshareCodeContext(profileId: ProfileId): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile || profileId === DEFAULT_PROFILE_ID) return;
    const ok = await this.confirm({
      title: this.tr('codeContext.unshareTitle', { name: profile.name }),
      body: this.tr('codeContext.unshareBody'),
      confirmLabel: this.tr('codeContext.unshare'),
    });
    if (!ok) return;
    this.patchCodeContext(profileId, { busy: true });
    try {
      const report = await this.api.accounts.unshareCodeContext(profileId);
      await this.reloadProfiles();
      const scope = this.state.codeContext;
      if (scope?.profileId !== profileId) return;
      await this.inspectCodeContext(profileId, scope.cwd);
      this.patchCodeContext(profileId, { unshared: { kept: report.warnings } });
    } catch (error) {
      this.patchCodeContext(profileId, { busy: false });
      this.toast('error', errorText(error));
    }
  }

  private applySettings(settings: AppSettings): void {
    this.t = createTranslator(settings.language);
    applyTheme(settings.theme);
    applyFontScale(settings.fontScale);
    applyLanguage(settings.language);
    this.set({ settings });
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<void> {
    const before = this.state.settings;
    this.applySettings({ ...before, ...patch });
    let saved: AppSettings;
    try {
      saved = await this.api.app.setSettings(patch);
      this.applySettings(saved);
    } catch (error) {
      this.applySettings(before);
      this.toast('error', errorText(error));
      return;
    }
    const previous = this.savedWorkflows;
    this.savedWorkflows = saved.workflows;
    const autoContinueBefore = this.savedAutoContinue !== false;
    this.savedAutoContinue = saved.autoContinue;
    const liveContextBefore = this.savedLiveContext === true;
    this.savedLiveContext = saved.liveContext;
    // "Dynamic workflows" (SDK applyFlagSettings) and "Continue automatically at usage limit" (off also ends a wait).
    if (saved.workflows !== previous) await this.applyToOpenSessions((handleId) => this.api.engine.setWorkflows(handleId, saved.workflows ?? null));
    const autoContinue = saved.autoContinue !== false;
    if (autoContinue !== autoContinueBefore) {
      await this.applyToOpenSessions((handleId) => this.api.engine.setAutoContinue(handleId, autoContinue), (view) => Boolean(view.sideChatOf));
    }
    const liveContext = saved.liveContext === true;
    if (liveContext !== liveContextBefore) await this.applyToOpenSessions((handleId) => this.api.engine.setLiveContext(handleId, liveContext));
  }

  /** A changed app-wide choice reaches every open session at once; one toast when a session refuses it. */
  private async applyToOpenSessions(apply: (handleId: string) => Promise<void>, skip?: (view: SessionView) => boolean): Promise<void> {
    const live = Object.values(this.state.views).filter((view) => view.handleId && hasOpenHandle(view) && !skip?.(view));
    const results = await Promise.allSettled(live.map((view) => apply(view.handleId!)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) this.toast('error', errorText(failed.reason));
  }

  private rememberFolder(cwd: string): void {
    const recent = [cwd, ...this.state.settings.recentFolders.filter((f) => f !== cwd)].slice(0, MAX_RECENT_FOLDERS);
    void this.updateSettings({ recentFolders: recent });
  }

  // ---------------------------------------------------------------- accounts

  private setAuth(status: AuthStatus): void {
    this.set((state) => {
      const id = status.profileId;
      const authSince = nextAuthSince(state.auth[id], state.plans[id]?.authSince, status);
      return { auth: { ...state.auth, [id]: status }, plans: { ...state.plans, [id]: { ...state.plans[id], authSince } } };
    });
    this.checkLabel(status.profileId, status.loggedIn ? status.email : undefined);
  }

  private setUsage(usage: PlanUsage): void {
    this.set((state) => ({ usage: { ...state.usage, [usage.profileId]: usage } }));
    this.checkLabel(usage.profileId, this.state.labels[usage.profileId]?.email);
  }

  /** Label drift check (accountLabel.ts): compares only the label and the account's weekly reset; never asks any api. */
  private checkLabel(profileId: ProfileId, email: string | undefined): void {
    const records = loadAccountLabels();
    const before = records[profileId];
    const check = checkAccountLabel(before, email, weeklyAnchor(this.state.usage[profileId]), Date.now());
    if (check.record && check.record !== before) saveAccountLabels({ ...records, [profileId]: check.record });
    this.set((state) => {
      const previous = state.labels[profileId]?.drift;
      // A failed usage fetch has no weekly anchor; a note already shown for this label stays until usage decides again.
      const drift = check.drift ?? (check.undecided && previous?.label === email ? previous : undefined);
      return { labels: { ...state.labels, [profileId]: { ...(email ? { email } : {}), ...(drift ? { drift } : {}), ...(check.undecided ? { undecided: true } : {}) } } };
    });
  }

  /** Plan usage (5-hour / weekly windows) of an account; main caches it for 60 s unless force. */
  async refreshUsage(profileId: ProfileId = this.state.activeProfileId, force = false): Promise<PlanUsage | null> {
    const source = this.state.profiles.find((profile) => profile.id === profileId)?.authenticationSource ?? 'cli-config';
    const unchanged = (): boolean => this.state.profiles.some((profile) => profile.id === profileId && (profile.authenticationSource ?? 'cli-config') === source);
    const request = { profileId, source }; this.pendingUsageSources.add(request);
    try {
      const usage = await this.api.usage.get(profileId, force);
      if (!unchanged()) return null;
      this.setUsage(usage);
      return usage;
    } catch (error) {
      if (!unchanged()) return null;
      this.setUsage({ profileId, available: false, windows: [], fetchedAt: Date.now(), error: errorText(error) });
      return null;
    } finally {
      this.pendingUsageSources.delete(request);
    }
  }

  /** Direct api access for feature components whose data lives outside the store (images, MCP list, read-only tasks). */
  get relay(): RelayApi {
    return this.api;
  }

  async refreshStatus(profileId: ProfileId, force: boolean): Promise<void> {
    const source = this.state.profiles.find((profile) => profile.id === profileId)?.authenticationSource ?? 'cli-config';
    const unchanged = (): boolean => this.state.profiles.some((profile) => profile.id === profileId && (profile.authenticationSource ?? 'cli-config') === source);
    try {
      const status = await this.api.accounts.status(profileId, force);
      if (unchanged()) this.setAuth(status);
    } catch (error) {
      if (!unchanged()) return;
      this.setAuth({
        profileId,
        loggedIn: false,
        authMethod: 'unknown',
        checkedAt: Date.now(),
        error: errorText(error),
      });
    }
  }

  async refreshAllStatus(force: boolean): Promise<void> {
    await Promise.all(this.state.profiles.map((p) => this.refreshStatus(p.id, force)));
  }

  /**
   * A plan change (upgrade) shows up without a restart: re-check on focus and every 10 min while visible (main throttles).
   * The timer also fetches the active account's usage (main's 60 s cache applies) so the label check has a weekly anchor.
   */
  private watchAccountStatus(): () => void {
    const visible = (): boolean => document.visibilityState !== 'hidden';
    const refresh = (): void => {
      if (this.state.ready && visible()) void this.refreshAllStatus(false);
    };
    const tick = (): void => {
      refresh();
      const id = this.state.activeProfileId;
      if (this.state.ready && visible() && this.state.auth[id]?.loggedIn !== false) void this.refreshUsage(id, false);
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const interval = setInterval(tick, STATUS_REFRESH_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      clearInterval(interval);
    };
  }

  async reloadProfiles(): Promise<void> {
    try {
      const profiles = await this.api.accounts.list();
      const active = profiles.some((p) => p.id === this.state.activeProfileId)
        ? this.state.activeProfileId
        : DEFAULT_PROFILE_ID;
      const changed = active !== this.state.activeProfileId;
      this.set({ profiles, activeProfileId: active });
      if (changed) {
        await this.updateSettings({ activeProfileId: active });
        void this.loadSessions();
      }
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** User choice only (R5): the profile used for new sessions and the session list. */
  async setActiveProfile(profileId: ProfileId): Promise<void> {
    if (profileId === this.state.activeProfileId) return;
    if (!this.state.profiles.some((p) => p.id === profileId)) return;
    this.set({ activeProfileId: profileId, sessions: [], sessionsState: 'idle', background: { list: [], state: 'idle' } });
    await this.updateSettings({ activeProfileId: profileId });
    await this.loadSessions();
    if (this.state.ui.tasksPane) void this.loadBackground();
  }

  async addProfile(): Promise<void> {
    const name = await this.askText({
      title: this.tr('accounts.addTitle'),
      label: this.tr('accounts.nameLabel'),
      hint: this.tr('accounts.addHint'),
      confirmLabel: this.tr('common.add'),
    });
    if (!name) return;
    try {
      const profile = await this.api.accounts.add(name.trim());
      await this.reloadProfiles();
      void this.refreshStatus(profile.id, true);
      this.toast('info', this.tr('accounts.added', { name: profile.name }));
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  async renameProfile(profileId: ProfileId): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile) return;
    const name = await this.askText({
      title: this.tr('accounts.renameTitle'),
      label: this.tr('accounts.nameLabel'),
      initial: profile.name,
      confirmLabel: this.tr('common.save'),
    });
    if (!name || name.trim() === profile.name) return;
    try {
      await this.api.accounts.rename(profileId, name.trim());
      await this.reloadProfiles();
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  async removeProfile(profileId: ProfileId): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    if (!profile || profileId === DEFAULT_PROFILE_ID) return;
    const managed = isManagedProfileDir(profile);
    const { ok, checked } = await this.requestConfirm({
      title: this.tr('accounts.removeTitle', { name: profile.name }),
      body: this.tr(managed ? 'accounts.removeBody' : 'accounts.removeBodyCustom', { dir: profile.configDir ?? '' }),
      confirmLabel: this.tr('common.remove'),
      danger: true,
      ...(managed ? { checkboxLabel: this.tr('accounts.deleteDirectory') } : {}),
    });
    if (!ok) return;
    const deleteDirectory = managed && checked;
    try {
      await this.api.accounts.remove(profileId, { deleteDirectory });
      if (this.state.activeProfileId === profileId) await this.setActiveProfile(DEFAULT_PROFILE_ID);
      await this.reloadProfiles();
      this.set((state) => {
        const auth = { ...state.auth };
        delete auth[profileId];
        const labels = { ...state.labels };
        delete labels[profileId];
        return { auth, labels };
      });
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  async login(profileId: ProfileId, method?: 'claudeai' | 'sso' | 'console'): Promise<void> {
    try {
      const result = await this.api.accounts.login(profileId, method);
      // Cancelled while it started: the cancel reports itself.
      if (!result.ok && result.cancelled) return;
      this.reportResult(result, this.tr('accounts.loginStarted'));
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** Read only names when the user explicitly opens the authentication-source view. */
  async authenticationEnvironment(): Promise<AuthenticationEnvironmentMetadata | null> {
    try {
      const metadata = await this.api.accounts.authenticationEnvironment();
      const variableNames = [...new Set(metadata.variableNames.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))].sort();
      return { available: metadata.available && variableNames.length > 0, variableNames };
    } catch {
      this.toast('error', this.tr('accounts.authenticationEnvironmentFailed'));
      return null;
    }
  }

  async setAuthenticationSource(profileId: ProfileId, source: AuthenticationSource): Promise<boolean> {
    const current = this.state.profiles.find((profile) => profile.id === profileId);
    if (!current) return false;
    if ((current.authenticationSource ?? 'cli-config') === source) return true;
    if (source === 'launch-environment' && !await this.confirm({
      title: this.tr('accounts.authenticationConfirmTitle', { name: current.name }),
      body: this.tr('accounts.authenticationWarning'),
      confirmLabel: this.tr('accounts.authenticationUseEnvironment'),
    })) return false;
    try {
      const profile = await this.api.accounts.setAuthenticationSource(profileId, source);
      if (profile.id !== profileId || (profile.authenticationSource ?? 'cli-config') !== source) throw new Error('Authentication source was not confirmed.');
      this.set((state) => {
        const auth = { ...state.auth }, usage = { ...state.usage }, plans = { ...state.plans }, labels = { ...state.labels };
        delete auth[profileId]; delete usage[profileId]; delete plans[profileId]; delete labels[profileId];
        return { profiles: state.profiles.map((entry) => entry.id === profileId ? profile : entry), auth, usage, plans, labels };
      });
      this.toast('info', this.tr('accounts.authenticationSourceChanged'));
      return true;
    } catch {
      this.toast('error', this.tr('accounts.authenticationSourceFailed'));
      return false;
    }
  }

  async cancelLogin(profileId: ProfileId): Promise<void> {
    try {
      const result = await this.api.accounts.cancelLogin(profileId);
      this.toast(result.ok ? 'info' : 'error', this.tr(result.ok
        ? result.noPending ? 'accounts.noPendingLogin' : 'accounts.loginCancelled'
        : 'accounts.cancelLoginFailed'));
    } catch {
      this.toast('error', this.tr('accounts.cancelLoginFailed'));
    }
  }

  async logout(profileId: ProfileId): Promise<void> {
    const profile = this.state.profiles.find((p) => p.id === profileId);
    const ok = await this.confirm({
      title: this.tr('accounts.logoutTitle', { name: profile?.name ?? profileId }),
      body: this.tr('accounts.logoutBody'),
      confirmLabel: this.tr('accounts.logout'),
      danger: true,
    });
    if (!ok) return;
    try {
      const result = await this.api.accounts.logout(profileId);
      this.reportResult(result);
      void this.refreshStatus(profileId, true);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  // ---------------------------------------------------------------- sessions list and views

  async loadSessions(): Promise<void> {
    const profileId = this.state.activeProfileId;
    const load = ++this.profileLoad;
    this.set((state) => ({ sessionsState: state.sessionsState === 'loaded' ? 'loaded' : 'loading', sessionsError: undefined }));
    try {
      const sessions = await this.api.sessions.list(profileId);
      if (load !== this.profileLoad) return;
      this.set({ sessions, sessionsState: 'loaded' });
      this.syncViewsFromList(sessions, profileId);
    } catch (error) {
      if (load !== this.profileLoad) return;
      this.set({ sessionsState: 'error', sessionsError: errorText(error) });
    }
  }

  private syncViewsFromList(sessions: readonly SessionSummary[], profileId: ProfileId): void {
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));
    this.store.set((state) => {
      let changed = false;
      const views = { ...state.views };
      for (const [key, view] of Object.entries(views)) {
        if (!view.sessionId || view.sideChatOf || view.profileId !== profileId) continue;
        const summary = byId.get(view.sessionId);
        if (!summary) continue;
        const title = summary.title || view.title;
        const cwd = view.cwd || summary.cwd;
        if (title !== view.title || cwd !== view.cwd) {
          views[key] = { ...view, title, cwd };
          changed = true;
        }
      }
      return changed ? { ...state, views } : state;
    });
  }

  private scheduleSessionsRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.loadSessions();
    }, SESSIONS_REFRESH_MS);
  }

  private ensureSessionView(summary: Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'>, profileId: ProfileId): string {
    // Relay's own new session keeps its `n-*` view after it appears in the list (RQ-1).
    const existing = findSessionViewKey(this.state.views, summary.sessionId, profileId);
    if (existing) return existing;
    const key = sessionKey(summary.sessionId);
    if (!this.state.views[key]) {
      const view = createView({
        key,
        profileId,
        sessionId: summary.sessionId,
        cwd: summary.cwd,
        title: summary.title || shortId(summary.sessionId),
        ...rememberedFields(readSessionPrefs(profileId, summary.sessionId)),
      });
      this.set((state) => ({ views: { ...state.views, [key]: view } }));
    }
    return key;
  }

  /** Records a choice the user made in this view; a saved conversation remembers it for the next open. */
  private remember(key: string, patch: SessionPrefs): void {
    this.patchView(key, (v) => ({ ...v, prefs: mergePrefs(v.prefs, patch) }));
    this.persistPrefs(key);
  }

  /** Side chats are unsaved forks and a new view has no id yet: neither is stored. */
  private persistPrefs(key: string): void {
    const view = this.view(key);
    if (!view?.prefs || !view.sessionId || view.sideChatOf) return;
    writeSessionPrefs(view.profileId, view.sessionId, view.prefs, Date.now());
  }

  /** Shows a listed session read-only (history); nothing is resumed until the user sends or takes over. */
  openSummary(summary: SessionSummary): void {
    const key = this.ensureSessionView(summary, this.state.activeProfileId);
    this.navigate(key);
    this.reloadIdleHistory(key);
  }

  /** A view without a writer may be stale: the session can have changed in the desktop or a terminal (RQ-2). */
  private reloadIdleHistory(key: string): void {
    const view = this.view(key);
    if (!view?.sessionId || hasOpenHandle(view) || view.opening || view.history === 'loading') return;
    void this.loadHistory(key);
  }

  /** Loads the latest page of the saved history; older pages shown stay when the page still joins them (mergeLatestPage). */
  async loadHistory(key: string, expectedHandle?: string): Promise<void> {
    const view = this.view(key);
    if (!view?.sessionId || isUnsavedFork(view)) return;
    const ownsRead = () => !expectedHandle || (this.state.currentKey === key
      && this.view(key)?.handleId === expectedHandle && hasOpenHandle(this.view(key)!));
    if (!ownsRead()) return;
    const token = ++this.historySeq;
    this.historyRequests.set(key, token);
    // `stale` holds what is shown now; an older page prepended after it would count as live and land below the history.
    this.cancelOlderHistory(key);
    const stale = new Set(view.items.map((item) => item.id));
    if (!expectedHandle) this.patchView(key, { history: 'loading' });
    try {
      const page = await this.api.sessions.history(view.profileId, view.sessionId, view.cwd || undefined);
      if (this.historyRequests.get(key) !== token || !ownsRead()) return;
      this.patchView(key, (v) => mergeLatestPage(v, page, stale));
    } catch (error) {
      if (this.historyRequests.get(key) !== token || !ownsRead()) return;
      if (!expectedHandle) this.patchView(key, { history: 'error' });
      this.addError(key, errorText(error), { kind: 'history' });
    }
  }

  /** "Load earlier messages": the page before the oldest one shown. A failure keeps the cursor for a retry. */
  async loadOlderHistory(key: string): Promise<void> {
    const view = this.view(key);
    const older = view?.olderHistory;
    if (!view?.sessionId || !older || older.state === 'loading' || view.history === 'loading') return;
    const token = ++this.historySeq;
    this.olderRequests.set(key, token);
    this.patchView(key, { olderHistory: { cursor: older.cursor, state: 'loading' } });
    try {
      const page = await this.api.sessions.history(view.profileId, view.sessionId, view.cwd || undefined, older.cursor);
      if (this.olderRequests.get(key) !== token) return;
      this.olderRequests.delete(key);
      this.patchView(key, (v) => prependHistory(v, page));
    } catch (error) {
      if (this.olderRequests.get(key) !== token) return;
      this.olderRequests.delete(key);
      this.patchView(key, { olderHistory: { cursor: older.cursor, state: 'error', error: errorText(error) } });
    }
  }

  /** Drops the pending earlier page of a view (reloaded or left); its button is usable again. */
  private cancelOlderHistory(key: string): void {
    if (!this.olderRequests.delete(key)) return;
    this.patchView(key, (v) => (v.olderHistory?.state === 'loading' ? { ...v, olderHistory: { cursor: v.olderHistory.cursor, state: 'idle' } } : v));
  }

  /** `launch`: opened by a link; the engine waits for the user's first send (AS-2). */
  async newSession(
    cwd: string,
    profileId: ProfileId = this.state.activeProfileId,
    options: { launch?: NonNullable<SessionView['launch']> } = {},
  ): Promise<void> {
    if (options.launch) {
      const waiting = Object.values(this.state.views).find(
        (v) => v.launch && v.profileId === profileId && normalizeFolder(v.cwd) === normalizeFolder(cwd) && !v.handleId && !v.opening,
      );
      if (waiting) {
        this.patchView(waiting.key, { launch: options.launch });
        this.navigate(waiting.key);
        return;
      }
    }
    const key = this.nextId('n');
    const { defaultModel, defaultEffort } = this.state.settings;
    // No permission mode is stored here: openRequest applies the Settings default current at open time.
    const view = createView({
      key,
      profileId,
      cwd,
      title: this.tr('session.newTitle'),
      isNew: true,
      confirmed: true,
      history: 'loaded',
      model: defaultModel,
      effort: defaultEffort,
      ...(options.launch ? { launch: options.launch } : {}),
    });
    this.set((state) => ({ views: { ...state.views, [key]: view } }));
    this.navigate(key);
    if (options.launch) return;
    this.rememberFolder(cwd);
    await this.openEngine(key, false);
  }

  async pickFolderAndStart(): Promise<void> {
    try {
      const folder = await this.api.app.pickFolder();
      if (folder) await this.newSession(folder);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  showHome(): void {
    this.navigate(null);
  }

  navigate(key: string | null): void {
    if (key === this.state.currentKey) return;
    const target = key ? this.view(key) : undefined;
    // Opening a session reads it, as in the desktop.
    if (target?.sessionId) this.setUnread(target.sessionId, false, target.profileId);
    this.set((state) => ({
      navBack: [...state.navBack, state.currentKey].slice(-50),
      navForward: [],
      currentKey: key,
      // The pane follows the session in view and starts on its list.
      ui: { ...state.ui, footerMenu: null, tasksPaneTask: null },
      promptFocus: state.promptFocus + 1,
    }));
    // Main reads it at open; a session whose read failed gets another try when it comes into view.
    if (key && target && hasOpenHandle(target) && !target.context) void this.refreshContext(key);
  }

  back(): void {
    const { navBack, currentKey, views } = this.state;
    const stack = navBack.filter((k) => k === null || views[k]);
    const target = stack.pop();
    if (target === undefined) return;
    this.set((state) => ({ navBack: stack, navForward: [...state.navForward, currentKey], currentKey: target }));
  }

  forward(): void {
    const { navForward, currentKey, views } = this.state;
    const stack = navForward.filter((k) => k === null || views[k]);
    const target = stack.pop();
    if (target === undefined) return;
    this.set((state) => ({ navForward: stack, navBack: [...state.navBack, currentKey], currentKey: target }));
  }

  // ---------------------------------------------------------------- engine

  private retireHandle(handleId: string): void {
    this.buffered.delete(handleId);
    this.retiredHandles.add(handleId);
    if (this.retiredHandles.size > MAX_RETIRED_HANDLES) this.retiredHandles.delete(this.retiredHandles.values().next().value!);
  }

  private retireOpening(attempt: OpeningAttempt, discard = true): void {
    attempt.retired = true;
    this.openingAttempts.delete(attempt.requestId);
    if (discard && attempt.handleId && !this.state.handleToKey[attempt.handleId]) this.retireHandle(attempt.handleId);
    // Uncorrelated pre-open events are useful only while an open is still pending.
    if (this.openingAttempts.size === 0) this.buffered.clear();
  }

  private async closeUnadopted(attempt: OpeningAttempt, handleId: string): Promise<void> {
    const owner = this.view(this.state.handleToKey[handleId]);
    if (owner?.handleId === handleId && hasOpenHandle(owner)) return;
    if (attempt.knownHandles.has(handleId) || (attempt.handleId && attempt.handleId !== handleId)) return;
    this.retireHandle(handleId);
    try {
      await this.api.engine.close(handleId);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  private onStartupEvent(event: Extract<EngineEvent, { type: 'startup' }>): void {
    const attempt = this.openingAttempts.get(event.requestId);
    if (!attempt || attempt.retired || attempt.finished || this.view(attempt.key)?.openingRequestId !== event.requestId) return;
    if (!Number.isSafeInteger(event.revision) || event.revision < 0 || event.revision < attempt.revision) return;
    if (event.phase === 'waiting' && event.revision <= attempt.revision) return;
    if (attempt.handleId && attempt.handleId !== event.handleId) return;
    const owner = this.view(this.state.handleToKey[event.handleId]);
    if (owner?.handleId === event.handleId && hasOpenHandle(owner)) return;
    attempt.handleId = event.handleId;
    attempt.revision = event.revision;
    attempt.finished = event.phase !== 'waiting';
    this.patchView(attempt.key, (view) => ({
      ...view,
      startup: attempt.finished ? undefined : {
        handleId: event.handleId,
        requestId: event.requestId,
        revision: event.revision,
        text: event.text.slice(-MAX_STARTUP_TEXT),
        inputPending: view.startup?.inputPending ?? false,
      },
    }));
  }

  /** Only explicit menu keys for the exact screen the user saw; never a prompt or credential. */
  async startupInput(key: string, requestId: string, input: NativeStartupInput): Promise<void> {
    const view = this.view(key);
    const startup = view?.startup;
    const attempt = this.openingAttempts.get(requestId);
    if (!view?.opening || view.openingRequestId !== requestId || !startup || startup.requestId !== requestId ||
      startup.revision !== input.revision || startup.inputPending || !attempt || attempt.finished || attempt.retired) return;
    if (!['enter', 'up', 'down', 'left', 'right', 'tab', 'escape'].includes(input.key)) return;
    this.patchView(key, { startup: { ...startup, inputPending: true, error: undefined } });
    try {
      await this.api.engine.startupInput(startup.handleId, requestId, input);
    } catch (error) {
      // Main shows the screen again under the next revision once it accepts a key, before it writes the key.
      if (!attempt.retired && !attempt.finished) this.patchView(key, (current) => current.startup?.requestId === requestId
        && (current.startup.revision === input.revision || current.startup.revision === input.revision + 1)
        ? { ...current, startup: { ...current.startup, error: errorText(error) } } : current);
    } finally {
      if (!attempt.retired && !attempt.finished) this.patchView(key, (current) => current.startup?.requestId === requestId
        ? { ...current, startup: { ...current.startup, inputPending: false } } : current);
    }
  }

  /** One key, text or click for the native panel the view's open handle shows; in order per handle, never retried. */
  panelInput(key: string, input: NativePanelInput): Promise<void> {
    return this.queuePanel(key, (handleId) => this.api.engine.panelInput(handleId, input));
  }

  /** Closes the view's native panel the way Esc does; main publishes it closed. */
  closePanel(key: string): Promise<void> {
    return this.queuePanel(key, async (handleId) => {
      const revision = this.view(key)?.panel?.revision;
      await this.api.engine.panelClose(handleId);
      // Main resolves once the dialog is gone; a panel it published since then stays.
      this.patchView(key, (v) => (v.handleId === handleId && v.panel && v.panel.revision === revision ? { ...v, panel: undefined } : v));
    });
  }

  private queuePanel(key: string, call: (handleId: string) => Promise<void>): Promise<void> {
    const view = this.view(key);
    if (!view?.handleId || !view.panel || !hasOpenHandle(view)) return Promise.resolve();
    const handleId = view.handleId;
    // Input queued for a panel that closed meanwhile, or for a handle the view no longer holds, reaches nothing.
    const shown = (): boolean => {
      const current = this.view(key);
      return current?.handleId === handleId && Boolean(current.panel) && hasOpenHandle(current);
    };
    const run = async (): Promise<void> => {
      if (!shown()) return;
      try {
        await call(handleId);
      } catch (error) {
        if (shown()) this.panelFailed(error);
      }
    };
    const tail = (this.panelTails.get(handleId) ?? Promise.resolve()).then(run);
    this.panelTails.set(handleId, tail);
    void tail.then(() => {
      if (this.panelTails.get(handleId) === tail) this.panelTails.delete(handleId);
    });
    return tail;
  }

  /** A run of failed panel inputs shows one toast; nothing is sent again. */
  private panelFailed(error: unknown): void {
    const now = Date.now();
    const last = this.panelToast;
    if (last && (now - last.at < PANEL_TOAST_MS || this.state.toasts.some((toast) => toast.id === last.id))) return;
    this.panelToast = { id: this.toast('error', this.tr('nativePanel.inputFailed', { message: errorText(error) })), at: now };
  }

  private openRequest(view: SessionView, resume: boolean): OpenSessionRequest {
    const { settings } = this.state;
    const request: OpenSessionRequest = { profileId: view.profileId, cwd: view.cwd };
    if (resume && view.sessionId) request.resumeSessionId = view.sessionId;
    const model = view.model ?? settings.defaultModel;
    const effort = view.effort ?? settings.defaultEffort;
    if (model) request.model = model;
    if (effort) request.effort = effort;
    const permissionMode = pendingPermissionMode(view, settings);
    if (permissionMode) request.permissionMode = permissionMode;
    if (view.ultracode) request.ultracode = true;
    if (typeof view.fastMode === 'boolean') request.fastMode = view.fastMode;
    if (this.savedWorkflows) request.workflows = this.savedWorkflows;
    if (this.savedAutoContinue === false) request.autoContinue = false;
    if (this.savedLiveContext === true) request.liveContext = true;
    if (view.sideChatOf) {
      if (view.sideChatSource) request.resumeSessionId = view.sideChatSource;
      request.forkSession = true;
      request.ephemeral = true;
      // A side chat never continues on its own after a usage limit (the CLI's side questions do not).
      request.autoContinue = false;
    }
    const mcp = view.prefs?.mcp;
    if (request.resumeSessionId && mcp && Object.keys(mcp).length > 0) request.mcpOverrides = { ...mcp };
    return request;
  }

  /** Opens an engine handle for the view. resume = continue view.sessionId. */
  async openEngine(key: string, resume: boolean, options: { skipSharedContext?: boolean } = {}): Promise<boolean> {
    const view = this.view(key);
    if (!view) return false;
    if (hasOpenHandle(view)) return true;
    if (view.opening) return false;
    const attempt: OpeningAttempt = {
      key, requestId: crypto.randomUUID(), revision: 0, finished: false, retired: false,
      knownHandles: new Set(Object.keys(this.state.handleToKey)),
    };
    this.openingAttempts.set(attempt.requestId, attempt);
    this.patchView(key, { opening: true, openingRequestId: attempt.requestId, startup: undefined, engineState: 'starting' });
    try {
      const request = this.openRequest(view, resume);
      request.startupRequestId = attempt.requestId;
      if (options.skipSharedContext) request.skipSharedContext = true;
      const handle = await this.api.engine.open(request);
      if (attempt.retired || this.view(key)?.openingRequestId !== attempt.requestId) {
        this.retireOpening(attempt);
        await this.closeUnadopted(attempt, handle.handleId);
        return false;
      }
      const owner = this.state.handleToKey[handle.handleId];
      const ownerView = owner && owner !== key ? this.view(owner) : null;
      if (owner && ownerView?.handleId === handle.handleId && hasOpenHandle(ownerView)) {
        // Main returned the writer another view already holds (R4): show that view instead of re-pointing it.
        this.retireOpening(attempt);
        this.patchView(key, { opening: false, openingRequestId: undefined, startup: undefined, engineState: view.engineState });
        const draft = this.state.drafts[key] ?? '';
        if (draft && !this.state.drafts[owner]) this.setDraft(owner, draft);
        this.navigate(owner);
        return false;
      }
      this.set((state) => ({ handleToKey: { ...state.handleToKey, [handle.handleId]: key } }));
      this.patchView(key, (v) => ({
        ...v,
        handleId: handle.handleId,
        mcp: undefined,
        panel: undefined,
        sessionId: handle.sessionId ?? v.sessionId,
        opening: false,
        openingRequestId: undefined,
        startup: undefined,
        engineState: v.engineState === 'none' || v.engineState === 'closed' ? 'starting' : v.engineState,
        handedOff: undefined,
        launch: undefined,
        // A Reopen offer is answered by this handle, whichever way it was opened.
        errors: v.errors.some((error) => error.retry.kind === 'open') ? v.errors.filter((error) => error.retry.kind !== 'open') : v.errors,
        effort: v.effort ?? request.effort,
        model: v.model ?? request.model,
        // The CLI honours a requested mode; its own report (init) replaces this.
        permissionMode: request.permissionMode ?? v.permissionMode,
      }));
      // A "Dynamic workflows" change made while this session was opening reaches it now.
      const workflows = this.savedWorkflows;
      if (workflows !== request.workflows) {
        this.api.engine.setWorkflows(handle.handleId, workflows ?? null).catch((error: unknown) => this.toast('error', errorText(error)));
      }
      const autoContinue = this.savedAutoContinue !== false && !view.sideChatOf;
      if (autoContinue !== (request.autoContinue !== false)) {
        this.api.engine.setAutoContinue(handle.handleId, autoContinue).catch((error: unknown) => this.toast('error', errorText(error)));
      }
      const liveContext = this.savedLiveContext === true;
      if (liveContext !== (request.liveContext === true)) {
        this.api.engine.setLiveContext(handle.handleId, liveContext).catch((error: unknown) => this.toast('error', errorText(error)));
      }
      // Choices made before a link-opened session had its id are stored now.
      this.persistPrefs(key);
      if (view.launch) this.rememberFolder(view.cwd);
      const pending = this.buffered.get(handle.handleId);
      if (pending) {
        this.buffered.delete(handle.handleId);
        for (const event of pending) this.onEngineEvent(event);
      }
      this.retireOpening(attempt, false);
      void this.loadModels(key);
      return true;
    } catch (error) {
      if (attempt.retired || this.view(key)?.openingRequestId !== attempt.requestId) return false;
      this.retireOpening(attempt);
      this.patchView(key, { opening: false, openingRequestId: undefined, startup: undefined, engineState: view.handleId ? view.engineState : 'none' });
      const message = errorText(error);
      // EC-2: a broken shared Code context must not lock the account out; offer one open without it.
      if (message.includes(SHARED_CONTEXT_ERROR_PREFIX) && !options.skipSharedContext) {
        this.addError(key, message, { kind: 'open', skipSharedContext: true }, false, this.tr('error.openWithoutShared'));
      } else {
        this.addError(key, message, { kind: 'open' });
      }
      return false;
    }
  }

  private onEngineEvent(event: EngineEvent): void {
    if (event.type === 'startup') {
      this.onStartupEvent(event);
      return;
    }
    if (event.type === 'usage') {
      const profile = this.state.profiles.find((entry) => entry.id === event.usage.profileId);
      if ([...this.pendingUsageSources].some((request) => request.profileId === event.usage.profileId &&
        (!profile || request.source !== (profile.authenticationSource ?? 'cli-config')))) return;
      this.setUsage(event.usage);
      return;
    }
    const handleId = engineHandleOf(event);
    const key = this.state.handleToKey[handleId];
    if (!key) {
      if (this.retiredHandles.has(handleId) || this.openingAttempts.size === 0) return;
      if (!this.buffered.has(handleId) && this.buffered.size >= MAX_BUFFERED_HANDLES) this.buffered.delete(this.buffered.keys().next().value!);
      const list = this.buffered.get(handleId) ?? [];
      if (list.length < MAX_BUFFERED_EVENTS) list.push(event);
      this.buffered.set(handleId, list);
      return;
    }
    const before = this.view(key);
    if (!before) return;
    // Events of a handle that this view already replaced (closed and reopened) are dropped.
    if (before.handleId !== handleId) return;
    const after = applyEngineEvent(before, event, Date.now());
    this.patchView(key, () => after);
    if (event.type === 'init') this.confirmSettings(key, event);
    if (event.type === 'account' && event.subscriptionType) {
      const session = { subscriptionType: event.subscriptionType, at: Date.now() };
      this.set((state) => ({ plans: { ...state.plans, [before.profileId]: { ...state.plans[before.profileId], session } } }));
    }
    if (event.type === 'account' && event.email) this.checkLabel(before.profileId, event.email);

    if (event.type === 'init' && before.isNew) this.scheduleSessionsRefresh();
    if (event.type === 'state' && event.state === 'idle' && isActiveState(before.engineState)) {
      // A reply that finished while another session was in view waits as unread, as in the desktop.
      if (after.sessionId && this.state.currentKey !== key && !after.sideChatOf) this.setUnread(after.sessionId, true, after.profileId);
      const listed = after.sessionId && this.state.sessions.some((s) => s.sessionId === after.sessionId);
      if (!listed || after.isNew) this.scheduleSessionsRefresh();
    }
  }

  async loadModels(key: string): Promise<void> {
    const view = this.view(key);
    if (!view?.handleId || !hasOpenHandle(view)) return;
    const { handleId, profileId } = view;
    try {
      const models = await this.api.engine.models(handleId);
      const owner = this.view(key);
      if (!owner || owner.handleId !== handleId || owner.profileId !== profileId || !hasOpenHandle(owner)) return;
      this.patchView(key, { models });
      if (models.length > 0) this.set((state) => ({ modelCatalog: { ...state.modelCatalog, [profileId]: models } }));
    } catch {
      // The picker shows the current model only.
    }
  }

  async refreshContext(key: string): Promise<void> {
    const view = this.view(key);
    if (!view?.handleId || !hasOpenHandle(view)) return;
    const handleId = view.handleId;
    const isCurrent = () => {
      const current = this.view(key);
      return current?.handleId === handleId && hasOpenHandle(current);
    };
    try {
      const usage = await this.api.engine.refreshContext(handleId);
      if (usage && isCurrent()) this.patchView(key, { context: usage });
    } catch (error) {
      if (isCurrent()) this.toast('error', errorText(error));
    }
  }

  /** Sends text and attachments; opens (and, for an existing session, confirms the take-over of) the session first. */
  async send(key: string, text: string, queue = false, attachments: PromptAttachment[] = []): Promise<boolean> {
    if (!text.trim() && attachments.length === 0) return false;
    const view = this.view(key);
    if (!view) return false;
    // Main sends the same rewritten text, and the CLI's copy is matched to this echo by its text.
    const outgoing = withoutDriveSlash(text);
    const slash = attachments.length === 0 ? parseSlash(outgoing) : null;
    const routed = slash ? this.routeSlash(key, view, slash.name, slash.args, text) : null;
    if (routed !== null) return routed;
    if (!slash && startsWithSlash(outgoing)) {
      this.toast('info', this.tr('slash.leadingSlash'));
      return false;
    }
    const echoId = this.nextId('local-user');
    const id = this.nextId('submission');
    const command = slash?.name;
    let handleId = hasOpenHandle(view) ? view.handleId : undefined;
    const queued = queue && isActiveState(view.engineState);
    const images = attachments.filter((a) => a.kind === 'image').length;
    const recent = new Set(view.submissions.filter((entry) => !isSubmissionPending(entry)).slice(-4).map((entry) => entry.id));
    this.patchView(key, (v) => ({
      ...v,
      items: [...v.items, { kind: 'user', id: echoId, text: outgoing, ...(queued ? { queued: true } : {}), ...(images ? { images } : {}) }],
      localEchoes: [...v.localEchoes, echoId],
      submissions: [...v.submissions.filter((submission) => isSubmissionPending(submission) || recent.has(submission.id)),
      { id, handleId, echoId, command, phase: 'preparing', createdAt: Date.now() }],
    }));
    // Shortcut sends and late failures must not replace a separately edited draft.
    const ownsDraft = !this.state.drafts[key] || this.state.drafts[key] === text;
    if (this.state.drafts[key] === text) this.setDraft(key, '');
    const draftRevision = this.draftRevisions.get(key);
    const restoreDraft = () => {
      if (ownsDraft && this.draftRevisions.get(key) === draftRevision && !this.state.drafts[key]
        && this.view(key)?.submissions.at(-1)?.id === id) {
        this.setDraft(key, text);
        return true;
      }
      return false;
    };
    if (!handleId) {
      let opening = this.sendOpenings.get(key);
      if (!opening) {
        opening = this.prepareSendHandle(key, outgoing, queue);
        this.sendOpenings.set(key, opening);
      }
      handleId = await opening;
      if (this.sendOpenings.get(key) === opening) this.sendOpenings.delete(key);
      const submission = this.view(key)?.submissions.find((entry) => entry.id === id);
      if (!handleId || this.view(key)?.handleId !== handleId || !submission || !isSubmissionPending(submission)) {
        this.finishSubmission(key, id, undefined, 'failed');
        if (!this.view(key)?.handleId && restoreDraft()) {
          this.patchView(key, (v) => ({ ...v, items: v.items.filter((item) => item.id !== echoId),
            localEchoes: v.localEchoes.filter((echo) => echo !== echoId) }));
        }
        return false;
      }
    }
    const owner = handleId;
    const ownsSubmission = () => this.view(key)?.handleId === owner && hasOpenHandle(this.view(key)!)
      && this.view(key)!.submissions.some((entry) => entry.id === id && entry.handleId === owner && isSubmissionPending(entry));
    this.patchView(key, (v) => {
      const index = v.submissions.findIndex((entry) => entry.id === id);
      const waiting = v.submissions.slice(0, index).some((entry) => entry.handleId === owner && isSubmissionPending(entry));
      return { ...v, submissions: v.submissions.map((entry) => entry.id === id
        ? { ...entry, handleId: owner, phase: waiting ? 'queued' : 'sending' } : entry) };
    });
    try {
      const opts = { ...(queue ? { queue: true } : {}), ...(attachments.length ? { attachments } : {}) };
      // Main owns serialization and native acceptance. No timer guesses native progress or retries a request.
      const sent = this.api.engine.send(owner, outgoing, Object.keys(opts).length ? opts : undefined);
      this.patchView(key, (v) => ({ ...v, submissions: v.submissions.map((entry) => entry.id === id && entry.phase === 'sending'
        ? { ...entry, phase: 'waiting' } : entry) }));
      await sent;
      if (!ownsSubmission()) return false;
      this.finishSubmission(key, id, owner, command ? 'ended' : 'accepted');
      // Main shows a command's printed rows under its line; a reload would drop that line, which history lacks. A rewind
      // rewrites the saved conversation itself, so only it is read again.
      if (command && rewritesConversation(command, view.commands) && this.state.currentKey === key) void this.loadHistory(key, owner);
      return true;
    } catch (error) {
      if (!ownsSubmission()) return false;
      this.finishSubmission(key, id, owner, 'unconfirmed');
      restoreDraft();
      // A rejected command may already have run. Ordinary text retains its explicit manual Retry action.
      const retry: ViewErrorRetry = command || attachments.length ? { kind: 'none' } : { kind: 'send', text, queue };
      this.addError(key, errorText(error), retry, false, retry.kind === 'send' ? this.tr('submission.sendAgain') : undefined);
      return false;
    }
  }

  /**
   * Slash commands Relay answers with its own UI, or refuses with a short note, instead of sending them to the native CLI.
   * Synchronous so a command that does go to the CLI gets its submission in the same tick. null = send it; else handled.
   */
  private routeSlash(key: string, view: SessionView, name: string, args: string, text: string): boolean | null {
    const route = slashRoute(name, args, view.commands);
    if (route === 'terminal') {
      this.toast('info', this.tr('slash.terminalOnly'));
      return false;
    }
    if (route === 'signIn') {
      this.toast('info', this.tr('slash.signInTerminal', { name: name.toLowerCase() }));
      return false;
    }
    if (!route) {
      const busy = pendingCommand(view);
      if (!busy) return null;
      this.toast('info', this.tr('slash.finishFirst', { name: busy }));
      return false;
    }
    if (this.state.drafts[key] === text) this.setDraft(key, '');
    switch (route) {
      case 'newSession':
        void this.runAction('session.newInFolder', key);
        break;
      case 'history':
        this.showSessionSearch();
        break;
      case 'accounts':
        this.revealCard('accounts');
        break;
      case 'close':
        void this.closeSession(key);
        break;
      default:
        if (this.state.currentKey !== key) this.navigate(key);
        this.openFooterMenu(route);
    }
    return true;
  }

  private async prepareSendHandle(key: string, text: string, queue: boolean): Promise<string | undefined> {
    const view = this.view(key);
    if (!view) return;
    const resume = Boolean(view.sessionId);
    if (resume && !view.confirmed && !await this.requestTakeover(key, 'send', text, queue)) return;
    if (resume && !isUnsavedFork(view)) await this.loadHistory(key);
    if (!await this.openEngine(key, resume)) return;
    return this.view(key)?.handleId;
  }

  private finishSubmission(key: string, id: string, handleId: string | undefined, phase: Submission['phase']): void {
    this.patchView(key, (v) => {
      const target = v.submissions.find((entry) => entry.id === id && entry.handleId === handleId && isSubmissionPending(entry));
      if (!target) return v;
      const uncertain = phase === 'failed' || phase === 'unconfirmed';
      const submissions = v.submissions.map((entry) => entry === target ? { ...entry, phase, settledAt: Date.now() } : entry);
      const next = submissions.find((entry) => entry.handleId === handleId && isSubmissionPending(entry));
      return { ...v,
        submissions: submissions.map((entry) => entry === next && entry.phase === 'queued' ? { ...entry, phase: 'waiting' } : entry),
        items: uncertain ? v.items.map((item) => item.kind === 'user' && (item.id === target.echoId || item.id === target.nativeItemId)
          ? { ...item, queued: undefined, deliveryUnconfirmed: true } : item) : v.items,
        localEchoes: uncertain ? v.localEchoes.filter((echo) => echo !== target.echoId) : v.localEchoes,
      };
    });
  }

  async interrupt(key: string): Promise<void> {
    const view = this.view(key);
    if (!view?.handleId) return;
    try {
      await this.api.engine.interrupt(view.handleId);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** Ends the Relay handle of a view (the session itself stays in the store). */
  async closeSession(key: string): Promise<void> {
    const view = this.view(key);
    if (view?.opening && view.openingRequestId) {
      const requestId = view.openingRequestId;
      const attempt = this.openingAttempts.get(requestId);
      if (attempt) this.retireOpening(attempt);
      this.patchView(key, { opening: false, openingRequestId: undefined, startup: undefined, engineState: 'closed' });
      try {
        await this.api.engine.cancelStartup(requestId);
      } catch (error) {
        this.toast('error', errorText(error));
      }
      return;
    }
    if (!view?.handleId || !hasOpenHandle(view)) return;
    const pending = view.submissions.some((entry) => entry.handleId === view.handleId && isSubmissionPending(entry));
    if (isActiveState(view.engineState) || pending) {
      const ok = await this.confirm({
        title: this.tr('session.closeTitle'),
        body: this.tr('session.closeRunningBody'),
        confirmLabel: this.tr('session.close'),
        danger: true,
      });
      if (!ok) return;
    }
    if (this.view(key)?.handleId !== view.handleId) return;
    try {
      await this.api.engine.close(view.handleId);
      this.patchView(key, (v) => v.handleId === view.handleId
        ? applyEngineEvent(v, { type: 'state', handleId: view.handleId!, state: 'closed' }, Date.now()) : v);
    } catch (error) {
      if (this.view(key)?.handleId === view.handleId) this.toast('error', errorText(error));
    }
  }

  async setPermissionMode(key: string, mode: PermissionMode): Promise<void> {
    await this.changeSetting(key, 'permissionMode', { permissionMode: mode, permissionOverride: mode }, { permissionMode: mode },
      (handleId) => this.api.engine.setPermissionMode(handleId, mode));
  }

  async setModel(key: string, model: string): Promise<void> {
    await this.changeSetting(key, 'model', { model }, { model }, (handleId) => this.api.engine.setModel(handleId, model));
  }

  /** Ultracode is session-scoped: kept on the view, sent on open and to a live handle. */
  async setUltracode(key: string, enabled: boolean): Promise<void> {
    await this.changeSetting(key, 'ultracode', { ultracode: enabled }, { ultracode: enabled },
      (handleId) => this.api.engine.setUltracode(handleId, enabled));
  }

  /** Fast mode is per session like ultracode: kept on the view, sent on open and to a live handle, remembered. */
  async setFastMode(key: string, enabled: boolean): Promise<void> {
    await this.changeSetting(key, 'fastMode', { fastMode: enabled }, { fastMode: enabled },
      (handleId) => this.api.engine.setFastMode(handleId, enabled));
  }

  /**
   * Shows a picked setting at once and remembers it once the live session took it. A refusal goes back to the value the
   * CLI last confirmed, unless a newer pick of the same setting was made meanwhile.
   */
  private async changeSetting(key: string, name: SettingName, patch: Partial<SessionView>, prefs: SessionPrefs,
    apply: (handleId: string) => Promise<void>): Promise<void> {
    const view = this.view(key);
    if (!view) return;
    const id = settingId(key, name);
    const seq = ++this.settingSeq;
    const confirmed = this.settingChanges.get(id)?.confirmed
      ?? Object.fromEntries(Object.keys(patch).map((field) => [field, view[field as keyof SessionView]])) as Partial<SessionView>;
    this.patchView(key, patch);
    if (!view.handleId || !hasOpenHandle(view)) {
      this.settingChanges.delete(id);
      this.remember(key, prefs);
      return;
    }
    this.settingChanges.set(id, { seq, confirmed });
    try {
      await apply(view.handleId);
      const change = this.settingChanges.get(id);
      // Gone = a newer pick already settled; this older answer must not overwrite it.
      if (!change) return;
      change.confirmed = patch;
      if (change.seq === seq) this.settingChanges.delete(id);
      this.remember(key, prefs);
    } catch (error) {
      const change = this.settingChanges.get(id);
      if (change?.seq === seq) {
        this.settingChanges.delete(id);
        this.patchView(key, change.confirmed);
      }
      this.toast('error', errorText(error));
    }
  }

  /** The CLI's own report of a setting is what a refused pick of it goes back to. */
  private confirmSettings(key: string, event: Extract<EngineEvent, { type: 'init' }>): void {
    const reported: Array<[SettingName, Partial<SessionView>]> = [];
    if (event.model) reported.push(['model', { model: event.model }]);
    if (event.permissionMode) reported.push(['permissionMode', { permissionMode: event.permissionMode }]);
    if (event.effort) reported.push(['effort', { effort: event.effort }]);
    for (const [name, value] of reported) {
      const change = this.settingChanges.get(settingId(key, name));
      if (change) change.confirmed = { ...change.confirmed, ...value };
    }
  }

  /** Stops one background task of the open session (its own stop button). */
  async stopTask(key: string, taskId: string): Promise<void> {
    const view = this.view(key);
    if (!view?.handleId || !hasOpenHandle(view)) return;
    try {
      await this.api.engine.stopTask(view.handleId, taskId);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** Ends the wait for the usage reset (or the missed-reset offer) of the view's session. */
  async cancelAutoContinue(key: string): Promise<void> {
    await this.settleAutoContinue(key, (handleId) => this.api.engine.cancelAutoContinue(handleId));
  }

  /** The missed-reset offer's Continue: main sends the resume prompt now. */
  async continueAfterLimit(key: string): Promise<void> {
    await this.settleAutoContinue(key, (handleId) => this.api.engine.continueAfterLimit(handleId));
  }

  private async settleAutoContinue(key: string, call: (handleId: string) => Promise<void>): Promise<void> {
    const view = this.view(key);
    if (!view?.handleId || !hasOpenHandle(view)) return;
    const { handleId, autoContinue } = view;
    try {
      await call(handleId);
      // Main also reports idle; the note must not outlive a call that succeeded, but a newer wait stays.
      this.patchView(key, (v) => (autoContinue && v.autoContinue === autoContinue ? { ...v, autoContinue: undefined } : v));
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** End of a background task's output file; null while it has none or the session is not open. Throws on failure. */
  async taskOutput(key: string, taskId: string): Promise<string | null> {
    const view = this.view(key);
    if (!view?.handleId || !hasOpenHandle(view)) return null;
    return this.api.engine.taskOutput(view.handleId, taskId);
  }

  /** One subagent's own transcript (live or saved session). Throws on failure. */
  async subagentTranscript(key: string, agentId: string): Promise<TranscriptItem[]> {
    const view = this.view(key);
    if (!view?.sessionId) return [];
    return this.api.sessions.subagent(view.profileId, view.sessionId, agentId, view.cwd || undefined);
  }

  /** Shows a file in Explorer (Outputs card). */
  async revealFile(path: string): Promise<void> {
    try {
      await this.api.app.revealFile(path);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** Switches an MCP server of the open session; the choice is remembered for this conversation. Throws on failure. */
  async toggleMcp(key: string, name: string, enabled: boolean): Promise<McpServerState[]> {
    const view = this.view(key);
    if (!view?.handleId || !hasOpenHandle(view)) throw new Error(this.tr('reason.notOpen'));
    const servers = await this.api.engine.mcpToggle(view.handleId, name, enabled);
    this.remember(key, { mcp: { [name]: enabled } });
    return servers;
  }

  /** "Reply" on a transcript selection: quotes it into the prompt as Markdown and focuses the prompt. */
  quoteIntoPrompt(key: string, selection: string): void {
    const quote = AppController.quote(selection);
    if (!quote) return;
    const draft = (this.state.drafts[key] ?? '').trimEnd();
    this.setDraft(key, `${draft ? `${draft}\n\n` : ''}${quote}\n\n`);
    this.focusPrompt();
  }

  /** Markdown quote of a selection, '' when it is blank. */
  private static quote(selection: string): string {
    const lines = selection.trim().split(/\r?\n/);
    if (!lines[0]) return '';
    return lines.map((line) => (line ? `> ${line}` : '>')).join('\n');
  }

  /** Why a selection in this view cannot start a side chat, or null. */
  sideChatBlocked(key: string): MessageKey | null {
    const view = this.view(key);
    if (view?.sideChatOf) return 'selection.sideChatInside';
    // The fork resumes the transcript on disk: Relay's own new session has one once the session list shows it.
    if (!view?.sessionId) return 'selection.sideChatNeedsSession';
    const id = view.sessionId.toLowerCase();
    const saved = !view.isNew || (view.profileId === this.state.activeProfileId
      && this.state.sessions.some((session) => session.sessionId.toLowerCase() === id));
    return saved ? null : 'selection.sideChatNeedsSession';
  }

  /**
   * Side chat: a new view over the same session with its items as context and the quote as draft. Its first send
   * opens an unsaved fork (openRequest: forkSession + ephemeral), so the original conversation is never written.
   */
  async startSideChat(key: string, selection: string): Promise<string | null> {
    const view = this.view(key);
    const quote = AppController.quote(selection);
    if (!view || !quote || this.sideChatBlocked(key)) return null;
    const sideKey = this.nextId('side');
    const snippet = selection.trim().replace(/\s+/g, ' ');
    const side = createView({
      key: sideKey,
      profileId: view.profileId,
      sessionId: view.sessionId,
      cwd: view.cwd,
      title: this.tr('sideChat.title', { text: snippet.length > 40 ? `${snippet.slice(0, 40)}…` : snippet }),
      confirmed: true,
      sideChatOf: key,
      ...(view.sessionId ? { sideChatSource: view.sessionId } : {}),
      history: 'loaded',
      items: view.items
        .filter((item) => !(item.kind === 'user' && item.queued))
        .map((item) => ((item.kind === 'assistant' || item.kind === 'thinking') && item.streaming ? { ...item, streaming: false } : item)),
      ...(view.model ? { model: view.model } : {}),
      ...(view.effort ? { effort: view.effort } : {}),
      ...(view.permissionOverride ? { permissionMode: view.permissionOverride, permissionOverride: view.permissionOverride } : {}),
      ...(view.ultracode ? { ultracode: true } : {}),
      ...(typeof view.fastMode === 'boolean' ? { fastMode: view.fastMode } : {}),
      // The fork starts with the original's MCP choices; what changes in the side chat is not stored.
      ...(view.prefs ? { prefs: { ...view.prefs, ...(view.prefs.mcp ? { mcp: { ...view.prefs.mcp } } : {}) } } : {}),
    });
    this.set((state) => ({ views: { ...state.views, [sideKey]: side }, drafts: { ...state.drafts, [sideKey]: `${quote}\n\n` } }));
    this.navigate(sideKey);
    return sideKey;
  }

  /** Ends a side chat's engine (a running turn asks first) and forgets the view: nothing of it was saved. */
  async closeSideChat(key: string): Promise<void> {
    const view = this.view(key);
    if (!view?.sideChatOf) return;
    if (hasOpenHandle(view) || view.opening) {
      await this.closeSession(key);
      const after = this.view(key);
      if (after && hasOpenHandle(after)) return;
    }
    const origin = this.view(view.sideChatOf) ? view.sideChatOf : null;
    this.set((state) => {
      const views = { ...state.views };
      delete views[key];
      const drafts = { ...state.drafts };
      delete drafts[key];
      return {
        views,
        drafts,
        navBack: state.navBack.filter((k) => k !== key),
        navForward: state.navForward.filter((k) => k !== key),
        ...(state.currentKey === key ? { currentKey: origin, promptFocus: state.promptFocus + 1 } : {}),
      };
    });
  }

  async setEffort(key: string, effort: Effort): Promise<void> {
    await this.changeSetting(key, 'effort', { effort }, { effort }, (handleId) => this.api.engine.setEffort(handleId, effort));
  }

  /** Throws on failure so the card can show the error and stay. */
  async respondPermission(key: string, requestId: string, decision: PermissionDecision): Promise<void> {
    await this.api.engine.respondPermission(requestId, decision);
    this.patchView(key, (v) => ({ ...v, permissions: v.permissions.filter((r) => r.requestId !== requestId) }));
  }

  async respondQuestion(key: string, requestId: string, answer: QuestionAnswer | null): Promise<void> {
    await this.api.engine.respondQuestion(requestId, answer);
    this.patchView(key, (v) => ({ ...v, questions: v.questions.filter((r) => r.requestId !== requestId) }));
  }

  // ---------------------------------------------------------------- inline errors

  private addError(key: string, message: string, retry: ViewErrorRetry, fatal = false, retryLabel?: string): void {
    const error: ViewError = { id: this.nextId('error'), message, retry, fatal, ...(retryLabel ? { retryLabel } : {}) };
    this.patchView(key, (v) => ({ ...v, errors: [...v.errors, error] }));
  }

  dismissError(key: string, errorId: string): void {
    this.patchView(key, (v) => ({ ...v, errors: v.errors.filter((e) => e.id !== errorId) }));
  }

  async retryError(key: string, errorId: string): Promise<void> {
    const view = this.view(key);
    const error = view?.errors.find((e) => e.id === errorId);
    if (!view || !error) return;
    this.dismissError(key, errorId);
    switch (error.retry.kind) {
      case 'history':
        await this.loadHistory(key);
        break;
      case 'open':
        await this.openEngine(key, Boolean(view.sessionId) && view.confirmed, { skipSharedContext: error.retry.skipSharedContext });
        break;
      case 'send':
        await this.send(key, error.retry.text, error.retry.queue);
        break;
      case 'action':
        await this.runAction(error.retry.action, key);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- take-over and launch requests

  private requestTakeover(key: string, source: TakeoverPrompt['source'], pendingText?: string, pendingQueue?: boolean): Promise<boolean> {
    this.takeoverResolve?.(false);
    return new Promise<boolean>((resolve) => {
      this.takeoverResolve = resolve;
      this.set({ takeover: { key, source, pendingText, pendingQueue } });
    });
  }

  confirmTakeover(): void {
    const prompt = this.state.takeover;
    if (!prompt) return;
    this.patchView(prompt.key, (v) => ({
      ...v,
      confirmed: true,
      // The listing cannot tell where a session was started; every session not created in Relay gets the banner (RQ-4).
      takeover: v.takeover || !v.isNew,
    }));
    this.set({ takeover: null });
    const resolve = this.takeoverResolve;
    this.takeoverResolve = null;
    resolve?.(true);
  }

  cancelTakeover(): void {
    if (!this.state.takeover) return;
    this.set({ takeover: null });
    const resolve = this.takeoverResolve;
    this.takeoverResolve = null;
    resolve?.(false);
  }

  /** Take-over from the title menu or a launch request: confirm, then resume in Relay. */
  async takeOver(key: string, source: TakeoverPrompt['source'] = 'menu'): Promise<boolean> {
    const view = this.view(key);
    if (!view?.sessionId) return false;
    if (hasOpenHandle(view)) return true;
    if (!view.confirmed) {
      const ok = await this.requestTakeover(key, source);
      if (!ok) return false;
    }
    // A failed reload leaves its own error row and never blocks the take-over.
    await this.loadHistory(key);
    return this.openEngine(key, true);
  }

  async handleLaunch(request: LaunchRequest): Promise<void> {
    const { profiles } = this.state;
    const requested = request.profileId && profiles.some((p) => p.id === request.profileId) ? request.profileId : undefined;
    if (request.profileId && !requested) {
      this.toast('error', this.tr('launch.unknownProfile', { id: request.profileId }));
    }
    const previousProfile = this.state.activeProfileId;
    const profileId = requested ?? (request.action === 'resume' ? DEFAULT_PROFILE_ID : previousProfile);
    if (profileId !== previousProfile) await this.setActiveProfile(profileId);

    if (request.sessionId && (request.action === 'resume' || request.action === 'open')) {
      if (this.state.sessionsState !== 'loaded') await this.loadSessions();
      const sessionId = request.sessionId.toLowerCase();
      const summary = this.state.sessions.find((s) => s.sessionId.toLowerCase() === sessionId);
      const existing = this.view(findSessionViewKey(this.state.views, request.sessionId, profileId));
      const cwd = existing && (hasOpenHandle(existing) || existing.opening)
        ? existing.cwd
        : await this.chooseLaunchFolder(existing?.cwd || summary?.cwd || '', request.cwd);
      const key = this.ensureSessionView({ sessionId: request.sessionId, title: summary?.title ?? '', cwd }, profileId);
      const view = this.view(key)!;
      if (cwd && view.cwd !== cwd && !hasOpenHandle(view) && !view.opening) this.patchView(key, { cwd });
      this.navigate(key);
      this.reloadIdleHistory(key);
      if (request.action === 'open' || hasOpenHandle(view)) return;
      if (!this.view(key)?.cwd) {
        this.addError(key, this.tr('launch.missingFolder'), { kind: 'none' });
        return;
      }
      await this.takeOver(key, 'launch');
      return;
    }
    // A link never starts the CLI by itself: the new session waits for the user's first message (AS-2).
    if (request.cwd) {
      const account = profileId !== previousProfile ? (this.state.profiles.find((p) => p.id === profileId)?.name ?? profileId) : undefined;
      await this.newSession(request.cwd, profileId, { launch: { cwd: request.cwd, ...(account ? { account } : {}) } });
    }
  }

  /** The session's recorded folder wins; a different folder from the link is used only when the user agrees. */
  private async chooseLaunchFolder(recorded: string, requested: string | undefined): Promise<string> {
    if (!requested) return recorded;
    if (!recorded || normalizeFolder(recorded) === normalizeFolder(requested)) return recorded || requested;
    const useLink = await this.confirm({
      title: this.tr('launch.folderTitle'),
      body: this.tr('launch.folderBody', { recorded, requested }),
      confirmLabel: this.tr('launch.useLinkFolder'),
      cancelLabel: this.tr('launch.keepRecordedFolder'),
    });
    return useLink ? requested : recorded;
  }

  /** "Hand back to desktop": closes the Relay handle first (main does it before running the desktop command). */
  async handBack(key: string): Promise<void> {
    await this.runAction('handoff.toDesktop', key);
  }

  // ---------------------------------------------------------------- hand-off and shortcut actions

  private reportResult(result: HandoffResult, okText?: string): void {
    if (result.ok) this.toast('info', result.message || okText || this.tr('common.done'));
    else this.toast('error', result.message || this.tr('common.failed'));
  }

  private markHandedOff(key: string, result: HandoffResult): void {
    this.patchView(key, (v) => {
      const closed = v.handleId
        ? applyEngineEvent(v, { type: 'state', handleId: v.handleId, state: 'closed' }, Date.now())
        : v;
      return {
        ...closed,
        engineState: closed.engineState === 'none' ? 'none' : 'closed',
        takeover: false,
        confirmed: false,
        handedOff: { ok: result.ok, message: result.message, at: Date.now() },
      };
    });
  }

  async runAction(action: ShortcutAction, key: string | null = this.state.currentKey): Promise<void> {
    const view = this.view(key);
    const availability = actionAvailability(action, view, this.state.activeProfileId);
    if (!availability.ok) {
      this.toast('error', this.tr(availability.reason));
      return;
    }
    switch (action) {
      case 'ui.modelPicker':
        this.openFooterMenu('model');
        return;
      case 'ui.effortPicker':
        this.openFooterMenu('effort');
        return;
      case 'ui.permissionPicker':
        this.openFooterMenu('permission');
        return;
      case 'ui.usagePopover':
        this.openFooterMenu('usage');
        return;
      case 'session.interrupt':
        if (key) await this.interrupt(key);
        return;
      case 'session.newInFolder':
        if (view?.cwd) await this.newSession(view.cwd, view.profileId);
        return;
      default:
        await this.runHandoff(action, view);
    }
  }

  private async runHandoff(action: ShortcutAction, view: SessionView | null): Promise<void> {
    const profileId = view?.profileId ?? this.state.activeProfileId;
    const cwd = view?.cwd ?? '';
    // Main closes these writers too, also those of other views (RQ-3): confirm and mark every one.
    const affected = viewsClosedBy(action, view, Object.values(this.state.views));
    const closes = affected.length > 0;
    if (closes && view) {
      const names = (list: SessionView[]): string => list.map((v) => `• ${v.title}`).join('\n');
      const running = affected.filter((v) => isActiveState(v.engineState));
      const onlyThis = affected.length === 1 && affected[0]!.key === view.key;
      const lines = [this.tr('handoff.confirmCloseBody')];
      if (!onlyThis) lines.push(this.tr('handoff.confirmSessions', { list: names(affected) }));
      if (running.length > 0) {
        lines.push(onlyThis ? this.tr('handoff.confirmRunning') : this.tr('handoff.confirmRunningSessions', { list: names(running) }));
      }
      const ok = await this.confirm({
        title: this.tr(action === 'handoff.toDesktop' ? 'handoff.confirmDesktopTitle' : 'handoff.confirmCloseTitle'),
        body: lines.join('\n'),
        confirmLabel: this.tr(action === 'handoff.toDesktop' ? 'handoff.toDesktop' : 'common.continue'),
      });
      if (!ok) return;
    }
    const handleId = affected.some((v) => v.key === view?.key) ? view?.handleId : undefined;
    let result: HandoffResult;
    try {
      switch (action) {
        case 'handoff.toDesktop':
          result = await this.api.handoff.toDesktop({
            profileId,
            sessionId: view!.sessionId!,
            cwd,
            ...(handleId ? { handleId } : {}),
          });
          break;
        case 'handoff.openFolderInDesktop':
          result = await this.api.handoff.openFolderInDesktop({ profileId, cwd });
          break;
        case 'handoff.openInTerminal':
          result = await this.api.handoff.openInTerminal({
            profileId,
            cwd,
            sessionId: view!.sessionId!,
            ...(handleId ? { handleId } : {}),
          });
          break;
        case 'handoff.openInTerminalFork':
          result = await this.api.handoff.openInTerminal({ profileId, cwd, sessionId: view!.sessionId!, fork: true });
          break;
        case 'handoff.continueLatestInTerminal':
          result = await this.api.handoff.openInTerminal({ profileId, cwd, continueLatest: true, ...(handleId ? { handleId } : {}) });
          break;
        case 'handoff.toCloud': {
          const task = await this.askText({
            title: this.tr('handoff.cloudTitle'),
            label: this.tr('handoff.cloudLabel'),
            initial: view ? (this.state.drafts[view.key] ?? '') : '',
            hint: this.tr('handoff.cloudHint'),
            confirmLabel: this.tr('handoff.toCloud'),
            multiline: true,
          });
          if (!task) return;
          result = await this.api.handoff.toCloud({ profileId, cwd, task });
          break;
        }
        case 'handoff.teleport': {
          const id = await this.askText({
            title: this.tr('handoff.teleportTitle'),
            label: this.tr('handoff.teleportLabel'),
            hint: this.tr('handoff.teleportHint'),
            confirmLabel: this.tr('handoff.teleport'),
            optional: true,
          });
          if (id === null) return;
          result = await this.api.handoff.teleport({ profileId, cwd, ...(id.trim() ? { cloudSessionId: id.trim() } : {}) });
          break;
        }
        case 'handoff.remoteControl':
          result = await this.api.handoff.remoteControl({
            profileId,
            cwd,
            ...(view?.sessionId ? { sessionId: view.sessionId } : {}),
            ...(handleId ? { handleId } : {}),
          });
          break;
        default:
          return;
      }
    } catch (error) {
      const message = errorText(error);
      if (view) this.addError(view.key, message, { kind: 'action', action });
      else this.toast('error', message);
      return;
    }
    if (closes && result.ok) for (const closed of affected) this.markHandedOff(closed.key, result);
    if (!result.ok && view && closes) {
      this.addError(view.key, result.message || this.tr('common.failed'), { kind: 'action', action });
      return;
    }
    this.reportResult(result);
  }

  async runShortcut(shortcut: Shortcut): Promise<void> {
    if (shortcut.kind === 'action') {
      if (shortcut.action) await this.runAction(shortcut.action);
      return;
    }
    const key = this.state.currentKey;
    const text = shortcut.text ?? '';
    if (!key || !text) return;
    if (shortcut.mode === 'fill') {
      this.setDraft(key, text);
      this.focusPrompt();
      return;
    }
    const view = this.view(key);
    await this.send(key, text, Boolean(view && isActiveState(view.engineState)));
  }

  async saveShortcuts(list: Shortcut[]): Promise<boolean> {
    try {
      const saved = await this.api.shortcuts.set(list);
      this.set({ shortcuts: saved });
      return true;
    } catch (error) {
      this.toast('error', errorText(error));
      return false;
    }
  }

  async resetShortcuts(): Promise<Shortcut[] | null> {
    const ok = await this.confirm({
      title: this.tr('shortcuts.resetTitle'),
      body: this.tr('shortcuts.resetBody'),
      confirmLabel: this.tr('shortcuts.reset'),
      danger: true,
    });
    if (!ok) return null;
    try {
      const list = await this.api.shortcuts.reset();
      this.set({ shortcuts: list });
      return list;
    } catch (error) {
      this.toast('error', errorText(error));
      return null;
    }
  }

  setShortcutGroup(group: ShortcutGroup): void {
    writeStorage(STORAGE_KEYS.group, group);
    this.set({ shortcutGroup: group });
  }

  // ---------------------------------------------------------------- background sessions

  async loadBackground(): Promise<void> {
    const profileId = this.state.activeProfileId;
    const request = ++this.backgroundLoad;
    this.set((state) => ({ background: { ...state.background, state: 'loading', error: undefined } }));
    try {
      const list = await this.api.handoff.backgroundAgents(profileId);
      if (profileId !== this.state.activeProfileId || request !== this.backgroundLoad) return;
      this.set({ background: { list, state: 'loaded' } });
    } catch (error) {
      if (profileId !== this.state.activeProfileId || request !== this.backgroundLoad) return;
      this.set((state) => ({ background: { ...state.background, state: 'error', error: errorText(error) } }));
    }
  }

  async attachBackground(id: string): Promise<void> {
    try {
      this.reportResult(await this.api.handoff.attachBackground({ profileId: this.state.activeProfileId, id }));
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  // ---------------------------------------------------------------- sidebar session menu

  marksOf(profileId: ProfileId = this.state.activeProfileId): SidebarMarks {
    return this.state.marks[profileId] ?? EMPTY_MARKS;
  }

  private patchMarks(update: (marks: SidebarMarks) => SidebarMarks, profileId: ProfileId = this.state.activeProfileId): void {
    const before = this.marksOf(profileId);
    const after = update(before);
    if (after === before) return;
    this.set((state) => ({ marks: { ...state.marks, [profileId]: after } }));
    writeMarks(this.state.marks);
  }

  /** The view of a listed session, created read-only when there is none yet; nothing is opened. */
  sessionViewKey(summary: Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'>): string {
    return this.ensureSessionView(summary, this.state.activeProfileId);
  }

  setPinned(sessionId: string, pinned: boolean): void {
    this.patchMarks((marks) => withPin(marks, sessionId, pinned));
  }

  setUnread(sessionId: string, unread: boolean, profileId: ProfileId = this.state.activeProfileId): void {
    this.patchMarks((marks) => withUnread(marks, sessionId, unread), profileId);
  }

  /** Archiving takes a session off the list; one Relay has open is closed first (a running one asks). */
  async setArchived(summary: Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'>, archived: boolean): Promise<void> {
    if (archived) {
      const key = findSessionViewKey(this.state.views, summary.sessionId, this.state.activeProfileId);
      if (key && hasOpenHandle(this.view(key)!)) {
        await this.closeSession(key);
        const after = this.view(key);
        if (after && hasOpenHandle(after)) return;
      }
      if (key && this.state.currentKey === key) this.showHome();
    }
    this.patchMarks((marks) => withArchived(marks, summary.sessionId, archived));
  }

  /** "Move to": into one of the own groups, or back to its folder with null. */
  moveSession(sessionId: string, groupId: string | null): void {
    this.patchMarks((marks) => withPlacement(marks, sessionId, groupId));
  }

  /** Asks for a name, creates the group and moves the session into it. */
  async moveToNewGroup(sessionId: string): Promise<void> {
    const name = (await this.askText({
      title: this.tr('sidebar.newGroupTitle'),
      label: this.tr('sidebar.groupNameLabel'),
      confirmLabel: this.tr('common.add'),
    }))?.trim();
    if (!name) return;
    const id = this.nextId('group');
    this.patchMarks((marks) => withPlacement(withGroup(marks, { id, name }), sessionId, id));
  }

  async renameGroup(groupId: string): Promise<void> {
    const group = this.marksOf().groups.find((g) => g.id === groupId);
    if (!group) return;
    const name = (await this.askText({
      title: this.tr('sidebar.renameGroupTitle'),
      label: this.tr('sidebar.groupNameLabel'),
      initial: group.name,
      confirmLabel: this.tr('common.save'),
    }))?.trim();
    if (!name || name === group.name) return;
    this.patchMarks((marks) => withGroup(marks, { id: groupId, name }));
  }

  /** Its sessions go back to their folders; nothing is deleted. */
  removeGroup(groupId: string): void {
    this.patchMarks((marks) => withoutGroup(marks, groupId));
  }

  /** A saved copy under a new id (SDK forkSession); it opens as Relay's own session, so no take-over is asked. */
  async forkSession(summary: Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'>): Promise<void> {
    const profileId = this.state.activeProfileId;
    let forked: string;
    try {
      forked = await this.api.sessions.fork(profileId, summary.sessionId, summary.cwd || undefined);
    } catch (error) {
      this.toast('error', errorText(error));
      return;
    }
    await this.loadSessions();
    const listed = this.state.sessions.find((s) => s.sessionId.toLowerCase() === forked.toLowerCase());
    const key = this.ensureSessionView(listed ?? { sessionId: forked, title: `${summary.title} (fork)`, cwd: summary.cwd }, profileId);
    this.patchView(key, { confirmed: true });
    this.navigate(key);
    this.reloadIdleHistory(key);
  }

  /** Asks first, closes Relay's handle, then removes the transcript (SDK deleteSession). */
  async deleteSession(summary: Pick<SessionSummary, 'sessionId' | 'title' | 'cwd'>): Promise<void> {
    const ok = await this.confirm({
      title: this.tr('sidebar.deleteTitle'),
      body: this.tr('sidebar.deleteBody', { title: summary.title }),
      confirmLabel: this.tr('sidebar.delete'),
      danger: true,
    });
    if (!ok) return;
    const profileId = this.state.activeProfileId;
    const key = findSessionViewKey(this.state.views, summary.sessionId, profileId);
    if (key && hasOpenHandle(this.view(key)!)) {
      await this.closeSession(key);
      const after = this.view(key);
      if (after && hasOpenHandle(after)) return;
    }
    try {
      await this.api.sessions.delete(profileId, summary.sessionId, summary.cwd || undefined);
    } catch (error) {
      this.toast('error', errorText(error));
      return;
    }
    const id = summary.sessionId.toLowerCase();
    if (key && this.state.currentKey === key) this.showHome();
    this.set((state) => {
      const views = { ...state.views };
      for (const [viewKey, view] of Object.entries(views)) {
        if (view.profileId === profileId && view.sessionId?.toLowerCase() === id) delete views[viewKey];
      }
      return {
        views,
        sessions: state.sessions.filter((s) => s.sessionId.toLowerCase() !== id),
        navBack: state.navBack.filter((k) => k === null || views[k]),
        navForward: state.navForward.filter((k) => k === null || views[k]),
      };
    });
    this.patchMarks((marks) => forgetSession(marks, summary.sessionId), profileId);
  }

  // ---------------------------------------------------------------- session title menu

  async renameSession(key: string, title?: string): Promise<void> {
    const view = this.view(key);
    if (!view?.sessionId) return;
    const next =
      title ??
      (await this.askText({
        title: this.tr('session.renameTitle'),
        label: this.tr('session.renameLabel'),
        initial: view.title,
        confirmLabel: this.tr('common.save'),
      }));
    const trimmed = next?.trim();
    if (!trimmed || trimmed === view.title) return;
    const before = view.title;
    this.patchView(key, { title: trimmed });
    try {
      await this.api.sessions.rename(view.profileId, view.sessionId, trimmed);
      this.set((state) => ({
        sessions: state.sessions.map((s) => (s.sessionId === view.sessionId ? { ...s, title: trimmed } : s)),
      }));
    } catch (error) {
      this.patchView(key, { title: before });
      this.toast('error', errorText(error));
    }
  }

  async copySessionId(key: string): Promise<void> {
    const id = this.view(key)?.sessionId;
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      this.toast('info', this.tr('session.idCopied'));
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  async openFolder(cwd: string): Promise<void> {
    if (!cwd) return;
    try {
      await this.api.app.revealPath(cwd);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  /** Links in assistant text open in the default browser (http/https only). */
  async openUrl(url: string): Promise<void> {
    if (!/^https?:\/\//i.test(url)) return;
    try {
      await this.api.app.openExternal(url);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  async addFolderToPrompt(key: string): Promise<void> {
    try {
      const folder = await this.api.app.pickFolder();
      if (!folder) return;
      this.addPathsToPrompt(key, [folder]);
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  async addFilesToPrompt(key: string): Promise<void> {
    try {
      this.addPathsToPrompt(key, await this.api.app.pickFiles());
    } catch (error) {
      this.toast('error', errorText(error));
    }
  }

  private addPathsToPrompt(key: string, paths: string[]): void {
    if (!this.view(key) || paths.length === 0) return;
    const draft = this.state.drafts[key] ?? '';
    const spacer = draft && !/\s$/.test(draft) ? ' ' : '';
    const references = paths.map((path) => `@"${path.replace(/"/g, '\\"')}"`).join(' ');
    this.setDraft(key, `${draft}${spacer}${references} `);
    if (this.state.currentKey === key) this.focusPrompt();
  }

  // ---------------------------------------------------------------- prompt drafts

  setDraft(key: string, text: string): void {
    this.draftRevisions.set(key, (this.draftRevisions.get(key) ?? 0) + 1);
    this.set((state) => (state.drafts[key] === text ? {} : { drafts: { ...state.drafts, [key]: text } }));
  }

  focusPrompt(): void {
    this.set((state) => ({ promptFocus: state.promptFocus + 1 }));
  }

  // ---------------------------------------------------------------- ui

  private persistUi(): void {
    const { sidebar, rightPanel, cards } = this.state.ui;
    writeStorage(STORAGE_KEYS.ui, JSON.stringify({ sidebar, rightPanel, cards }));
  }

  private patchUi(patch: Partial<UiState>): void {
    this.set((state) => ({ ui: { ...state.ui, ...patch } }));
  }

  toggleSidebar(): void {
    this.patchUi({ sidebar: !this.state.ui.sidebar });
    this.persistUi();
  }

  toggleRightPanel(open = !this.state.ui.rightPanel): void {
    this.patchUi({ rightPanel: open });
    this.persistUi();
  }

  setCard(card: PanelCardId, open: boolean): void {
    this.patchUi({ cards: { ...this.state.ui.cards, [card]: open } });
    this.persistUi();
    if (open && card === 'context') {
      const key = this.state.currentKey;
      if (key) void this.refreshContext(key);
    }
    if (open && card === 'background' && this.state.background.state !== 'loading') void this.loadBackground();
  }

  /** Opens or closes the Background tasks pane; opening it also refreshes the detached `claude --bg` sessions. */
  toggleTasksPane(open = !this.state.ui.tasksPane): void {
    this.patchUi(open ? { tasksPane: true } : { tasksPane: false, tasksPaneTask: null });
    if (open && this.state.background.state !== 'loading') void this.loadBackground();
  }

  /** Opens the pane on one task's detail (a row of the right-panel card), or on the list with null. */
  openTask(taskId: string | null): void {
    if (!this.state.ui.tasksPane) this.toggleTasksPane(true);
    this.patchUi({ tasksPaneTask: taskId });
  }

  /** Opens the right panel on one card (context ring, account chip). */
  revealCard(card: PanelCardId): void {
    this.patchUi({ rightPanel: true });
    this.setCard(card, true);
  }

  openSettings(open: boolean): void {
    this.patchUi({ settings: open });
  }

  openShortcutEditor(open: boolean): void {
    this.patchUi({ shortcutEditor: open });
  }

  openKeyboardHelp(open: boolean): void {
    this.patchUi({ keyboardHelp: open });
  }

  openFooterMenu(menu: FooterMenu): void {
    this.patchUi({ footerMenu: menu });
  }

  /** Relay's own session history: the sidebar comes into view with its search focused. */
  showSessionSearch(): void {
    this.patchUi({ sidebar: true, sessionSearch: true });
    this.persistUi();
  }

  sessionSearchShown(): void {
    if (this.state.ui.sessionSearch) this.patchUi({ sessionSearch: false });
  }

  // ---------------------------------------------------------------- dialogs and toasts

  async confirm(request: Omit<ConfirmRequest, 'id'>): Promise<boolean> {
    return (await this.requestConfirm(request)).ok;
  }

  private requestConfirm(request: Omit<ConfirmRequest, 'id'>): Promise<{ ok: boolean; checked: boolean }> {
    const id = this.nextId('confirm');
    const previous = this.state.confirm;
    if (previous) this.resolvers.get(previous.id)?.(false);
    return new Promise((resolve) => {
      this.resolvers.set(id, (value) => resolve(value ? value as { ok: boolean; checked: boolean } : { ok: false, checked: false }));
      this.set({ confirm: { ...request, id } });
    });
  }

  resolveConfirm(ok: boolean, checked = false): void {
    const current = this.state.confirm;
    if (!current) return;
    this.set({ confirm: null });
    const resolve = this.resolvers.get(current.id);
    this.resolvers.delete(current.id);
    resolve?.({ ok, checked });
  }

  askText(request: Omit<TextRequest, 'id'>): Promise<string | null> {
    const id = this.nextId('text');
    const previous = this.state.textRequest;
    if (previous) this.resolvers.get(previous.id)?.(null);
    return new Promise<string | null>((resolve) => {
      this.resolvers.set(id, (value) => resolve(typeof value === 'string' ? value : null));
      this.set({ textRequest: { ...request, id } });
    });
  }

  resolveText(value: string | null): void {
    const current = this.state.textRequest;
    if (!current) return;
    this.set({ textRequest: null });
    const resolve = this.resolvers.get(current.id);
    this.resolvers.delete(current.id);
    resolve?.(value);
  }

  toast(kind: Toast['kind'], text: string, retry?: () => void): string {
    const id = this.nextId('toast');
    // The same note again replaces the copy still showing (and restarts its time), so repeated presses do not stack.
    const same = (t: Toast): boolean => !retry && !t.retry && t.kind === kind && t.text === text;
    this.set((state) => ({ toasts: [...state.toasts.filter((t) => !same(t)).slice(-3), { id, kind, text, ...(retry ? { retry } : {}) }] }));
    if (kind === 'info') this.later(() => this.dismissToast(id), TOAST_MS);
    return id;
  }

  dismissToast(id: string): void {
    this.set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  }
}
