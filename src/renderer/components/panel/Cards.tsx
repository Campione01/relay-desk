import { Check, Ellipsis, Folder, Monitor, MousePointer, Plus, RotateCw, UserRound } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_PROFILE_ID, type AuthenticationEnvironmentMetadata, type AuthenticationSource, type AuthStatus, type ContextUsage, type Profile } from '@shared/types';
import { useLanguage, useT } from '../../i18n';
import { formatPercent, formatTokens, middleTruncate, planLabel } from '../../lib/format';
import { actionAvailability } from '../../state/availability';
import { useAppState, useController, useCurrentView } from '../../state/context';
import { isProPlan, planDisplay } from '../../state/plan';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { AccountLabelState } from '../../state/types';
import { Menu, type MenuEntry } from '../ui/Menu';
import { Avatar, HIGH_USAGE, ICON, ICON_SM, IconButton, MiniBar, Spinner } from '../ui/primitives';
import { ACTION_META, HANDOFF_ACTIONS } from '../shortcuts/actions';
import { ConnectorsCard } from './ConnectorsCard';
import { BackgroundCard } from './BackgroundCard';
import { OutputsCard } from './OutputsCard';
import { PanelCard } from './PanelCard';
import { Dialog } from '../ui/Dialog';

export function EnvironmentCard() {
  const controller = useController();
  const t = useT();
  const view = useCurrentView();
  const profiles = useAppState((s) => s.profiles);
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const profileId = view?.profileId ?? activeProfileId;
  const profile = profiles.find((p) => p.id === profileId);
  const plan = useAppState((s) => planDisplay(s.auth[profileId], s.plans[profileId], s.usage[profileId], s.labels[profileId]).label);
  const remote = actionAvailability('handoff.remoteControl', view, activeProfileId);
  return (
    <PanelCard id="environment" title={t('env.title')}>
      <ul className="rd-card__rows">
        <li className="rd-card__row">
          <Monitor {...ICON} className="rd-card__icon" />
          <span className="rd-card__label">{t('env.thisComputer')}</span>
        </li>
        <li className="rd-card__row" title={view?.cwd || undefined}>
          <Folder {...ICON} className="rd-card__icon" />
          <span className="rd-card__label">{view?.cwd ? middleTruncate(view.cwd, 30) : t('env.noFolder')}</span>
        </li>
        <li className="rd-card__row">
          <UserRound {...ICON} className="rd-card__icon" />
          <span className="rd-card__label">{profile?.name ?? profileId}</span>
          {plan ? <span className="rd-card__value">{plan}</span> : null}
        </li>
        <li className="rd-card__row">
          <MousePointer {...ICON} className="rd-card__icon" />
          <span className="rd-card__label">{t('handoff.remoteControl')}</span>
          <button
            type="button"
            className="rd-link"
            disabled={!remote.ok}
            data-tip={remote.ok ? `${t('handoff.remoteControl.desc')}\nclaude --remote-control` : t(remote.reason)}
            data-tip-place="left"
            onClick={() => void controller.runAction('handoff.remoteControl')}
          >
            {t('env.start')}
          </button>
        </li>
      </ul>
      <div className="rd-card__foot">
        <button type="button" className="rd-link" onClick={() => void controller.inspectCodeContext(profileId, view?.cwd || undefined)}>
          {t('codeContext.inspect')}
        </button>
      </div>
    </PanelCard>
  );
}

export function HandoffCard() {
  const controller = useController();
  const t = useT();
  const language = useLanguage();
  const view = useCurrentView();
  const activeProfileId = useAppState((s) => s.activeProfileId);
  const open = view ? hasOpenHandle(view) : false;
  const summary =
    view?.takeover && open
      ? t('handoff.summary.active')
      : view?.handedOff
        ? t('handoff.summary.done', {
            time: new Date(view.handedOff.at).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }),
          })
        : view?.opening
          ? null
          : view?.sessionId
            ? t('handoff.summary.available')
            : t('handoff.summary.none');
  return (
    <PanelCard
      id="handoff"
      title={t('handoff.title')}
      summary={
        view?.opening ? (
          <span className="rd-card__busy">
            <Spinner small />
            {t('status.starting')}
          </span>
        ) : (
          summary
        )
      }
    >
      <ul className="rd-card__rows rd-card__rows--tall">
        {HANDOFF_ACTIONS.map((action) => {
          const meta = ACTION_META[action];
          const state = actionAvailability(action, view, activeProfileId);
          const Icon = meta.icon;
          return (
            <li key={action}>
              <button
                type="button"
                className="rd-actionrow"
                aria-disabled={!state.ok || undefined}
                data-tip={meta.command}
                data-tip-place="left"
                onClick={() => {
                  if (state.ok) void controller.runAction(action);
                }}
              >
                <Icon {...ICON} className="rd-card__icon" />
                <span className="rd-actionrow__text">
                  <span className="rd-actionrow__label">{t(meta.label)}</span>
                  <span className="rd-actionrow__desc">{state.ok ? t(meta.desc) : t(state.reason)}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="rd-card__note">{t('handoff.tip')}</p>
    </PanelCard>
  );
}

const PALETTE = ['var(--rd-legend-blue)', 'var(--rd-legend-orange)', 'var(--rd-legend-green)'];

function isCssColor(value: string | undefined): value is string {
  return Boolean(value && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(value.trim()));
}

interface LegendRow {
  name: string;
  tokens: number;
  color: string;
  kind: ContextUsage['categories'][number]['kind'];
}

/** Classifies on `kind` only (never on the English name): used first, then buffer, free, deferred. */
export function contextLegend(usage: ContextUsage): { main: LegendRow[]; deferred: LegendRow[] } {
  const main: LegendRow[] = [];
  const deferred: LegendRow[] = [];
  let usedIndex = 0;
  const used = usage.categories.filter((c) => c.kind === 'used');
  for (const c of used) {
    const color = isCssColor(c.color) ? c.color : (PALETTE[usedIndex] ?? 'var(--rd-legend-gray)');
    usedIndex += 1;
    main.push({ name: c.name, tokens: c.tokens, color, kind: c.kind });
  }
  for (const c of usage.categories.filter((x) => x.kind === 'buffer')) {
    main.push({ name: c.name, tokens: c.tokens, color: isCssColor(c.color) ? c.color : 'var(--rd-legend-light)', kind: c.kind });
  }
  for (const c of usage.categories.filter((x) => x.kind === 'free')) {
    main.push({ name: c.name, tokens: c.tokens, color: 'var(--rd-legend-free)', kind: c.kind });
  }
  for (const c of usage.categories.filter((x) => x.kind === 'deferred')) {
    deferred.push({ name: c.name, tokens: c.tokens, color: 'var(--rd-legend-light)', kind: c.kind });
  }
  return { main, deferred };
}

export function ContextCard() {
  const controller = useController();
  const t = useT();
  const view = useCurrentView();
  const usage = view?.context;
  const open = view ? hasOpenHandle(view) : false;
  const percent = usage ? usage.percent : null;
  const summary =
    percent === null ? (
      '—'
    ) : (
      <>
        <span className="rd-tnum">{formatPercent(percent)}</span>
        <MiniBar percent={percent} high={percent >= HIGH_USAGE} />
      </>
    );
  return (
    <PanelCard id="context" title={t('context.title')} summary={summary}>
      {usage ? (
        <ContextBreakdown usage={usage} />
      ) : (
        <p className="rd-card__note">{open ? t('context.loading') : t('context.none')}</p>
      )}
      <MemoryFiles files={usage?.memoryFiles} />
      {open && view ? (
        <div className="rd-card__foot">
          <button type="button" className="rd-link" onClick={() => void controller.refreshContext(view.key)}>
            {t('context.refresh')}
          </button>
        </div>
      ) : null}
    </PanelCard>
  );
}

function MemoryFiles({ files }: { files: ContextUsage['memoryFiles'] }) {
  const t = useT();
  return (
    <section className="rd-memory-files" aria-label={t('context.memoryFiles')}>
      <h3 className="rd-settings__heading">{t('context.memoryFiles')}</h3>
      {files === undefined ? (
        <p className="rd-card__note">{t('context.memoryFiles.unobserved')}</p>
      ) : files.length === 0 ? (
        <p className="rd-card__note">{t('context.memoryFiles.empty')}</p>
      ) : (
        <>
          <p className="rd-card__note">{t('context.memoryFiles.reported')}</p>
          <ul className="rd-card__rows">
            {files.map((file, index) => (
              <li key={`${file.path}-${index}`} className="rd-memory-file">
                <code className="rd-context-path" title={file.path}>{file.path}</code>
                <span className="rd-card__note">{t('context.memoryFileMeta', { type: file.type, tokens: formatTokens(file.tokens) })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ContextBreakdown({ usage }: { usage: ContextUsage }) {
  const t = useT();
  const { main, deferred } = contextLegend(usage);
  const max = usage.maxTokens > 0 ? usage.maxTokens : 1;
  const share = (tokens: number): string => formatPercent((tokens / max) * 100, 1);
  const barRows = main.filter((row) => row.kind !== 'free');
  return (
    <div className="rd-ctx" data-testid="context-breakdown">
      <div className="rd-ctx__top">
        <span>{t('context.used', { percent: formatPercent(usage.percent) })}</span>
        <span className="rd-ctx__muted rd-tnum">
          {formatTokens(usage.usedTokens)} / {formatTokens(usage.maxTokens)}
        </span>
      </div>
      <div className="rd-ctx__bar" role="img" aria-label={t('context.used', { percent: formatPercent(usage.percent) })}>
        {barRows.map((row) => (
          <span
            key={row.name}
            className="rd-ctx__seg"
            style={{ width: `${Math.max(0, (row.tokens / max) * 100)}%`, background: row.color }}
          />
        ))}
      </div>
      <ul className="rd-ctx__legend">
        {main.map((row) => (
          <li key={row.name} className="rd-ctx__row">
            <span className="rd-ctx__swatch" style={{ background: row.color }} />
            <span className="rd-ctx__name">{row.name}</span>
            <span className="rd-ctx__value rd-tnum">{formatTokens(row.tokens)}</span>
            <span className="rd-ctx__pct rd-tnum">{share(row.tokens)}</span>
          </li>
        ))}
      </ul>
      {usage.live ? <p className="rd-card__note" data-testid="context-live-note">{t('context.liveNote')}</p> : null}
      {deferred.length > 0 ? (
        <ul className="rd-ctx__legend rd-ctx__legend--deferred">
          {deferred.map((row) => (
            <li key={row.name} className="rd-ctx__row">
              <span className="rd-ctx__swatch" style={{ background: row.color }} />
              <span className="rd-ctx__name rd-ctx__muted">{row.name}</span>
              <span className="rd-ctx__value rd-tnum">{formatTokens(row.tokens)}</span>
              <span className="rd-ctx__pct">—</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function statusDot(status: AuthStatus | undefined): { className: string; label: 'accounts.loggedIn' | 'accounts.loggedOut' | 'accounts.statusError' | 'accounts.statusUnknown' } {
  if (!status) return { className: 'rd-dot rd-dot--off', label: 'accounts.statusUnknown' };
  if (status.error) return { className: 'rd-dot rd-dot--warn', label: 'accounts.statusError' };
  if (status.loggedIn) return { className: 'rd-dot rd-dot--ok', label: 'accounts.loggedIn' };
  return { className: 'rd-dot rd-dot--off', label: 'accounts.loggedOut' };
}

function AuthenticationSourceDialog({ profile, onClose }: { profile: Profile; onClose(): void }) {
  const controller = useController(), t = useT(), name = useId();
  const current = profile.authenticationSource ?? 'cli-config';
  const [source, setSource] = useState<AuthenticationSource>(current);
  const [environment, setEnvironment] = useState<AuthenticationEnvironmentMetadata | null>(null);
  const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void controller.authenticationEnvironment().then((value) => { if (!cancelled) { setEnvironment(value); setLoading(false); } });
    return () => { cancelled = true; };
  }, [controller]);
  const save = async (): Promise<void> => {
    setSaving(true);
    const saved = await controller.setAuthenticationSource(profile.id, source);
    if (saved) onClose();
    else setSaving(false);
  };
  return (
    <Dialog open title={t('accounts.authenticationTitle', { name: profile.name })} onClose={() => { if (!saving) onClose(); }}
      dismissable={!saving} testId="authentication-source-dialog" suppressInfoToasts footer={<>
        <button type="button" className="rd-btn rd-btn--secondary" disabled={saving} onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="rd-btn rd-btn--primary" disabled={saving || source === current || source === 'launch-environment' && !environment?.available}
          onClick={() => void save()}>{t('common.save')}</button>
      </>}>
      <p className="rd-card__note">{t('accounts.authenticationScope')}</p>
      <fieldset className="rd-sform__modes" disabled={saving}>
        <legend className="rd-field__label">{t('accounts.authenticationSource')}</legend>
        <label className="rd-check"><input type="radio" name={name} checked={source === 'cli-config'} onChange={() => setSource('cli-config')} />
          <span className="rd-auth-choice__text">{t('accounts.authenticationCliConfig')}<span className="rd-field__hint">{t('accounts.authenticationCliHint')}</span></span>
        </label>
        <label className="rd-check"><input type="radio" name={name} checked={source === 'launch-environment'} disabled={!environment?.available}
          onChange={() => setSource('launch-environment')} />
          <span className="rd-auth-choice__text">{t('accounts.authenticationEnvironment')}<span className="rd-field__hint">{t('accounts.authenticationEnvironmentHint')}</span></span>
        </label>
      </fieldset>
      <p className="rd-card__note">{t('accounts.authenticationWarning')}</p>
      {loading ? <p className="rd-card__note">{t('common.loading')}</p>
        : !environment ? <p className="rd-card__note">{t('accounts.authenticationEnvironmentFailed')}</p>
          : !environment.available ? <p className="rd-card__note" data-testid="authentication-environment-empty">{t('accounts.authenticationEnvironmentEmpty')}</p>
            : <section aria-label={t('accounts.authenticationVariableNames')}>
              <h3 className="rd-settings__heading">{t('accounts.authenticationVariableNames')}</h3>
              <ul className="rd-card__rows">{environment.variableNames.map((variable) => <li key={variable}><code>{variable}</code></li>)}</ul>
            </section>}
      <p className="rd-card__note">{t('accounts.authenticationNoSecrets')}</p>
    </Dialog>
  );
}

function AccountRow({ profile, status, plan, cliPlan, label, active }: {
  profile: Profile;
  status?: AuthStatus;
  plan?: string;
  /** The plan Claude Code still works with when it differs from the shown one. */
  cliPlan?: string;
  label?: AccountLabelState;
  active: boolean;
}) {
  const controller = useController();
  const t = useT();
  const menuRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [authenticationOpen, setAuthenticationOpen] = useState(false);
  const dot = statusDot(status);
  const entries: MenuEntry[] = [
    {
      id: 'use',
      label: t('accounts.useForNew'),
      icon: <Check {...ICON} />,
      disabled: active,
      onSelect: () => void controller.setActiveProfile(profile.id),
    },
    { type: 'separator', id: 's1' },
    { id: 'authentication-source', label: t('accounts.authenticationSource'),
      description: t(profile.authenticationSource === 'launch-environment' ? 'accounts.authenticationEnvironment' : 'accounts.authenticationCliConfig'),
      onSelect: () => setAuthenticationOpen(true) },
    {
      id: 'login',
      label: t('accounts.login'),
      submenu: [
        { id: 'claudeai', label: t('accounts.method.claudeai'), onSelect: () => void controller.login(profile.id, 'claudeai') },
        { id: 'sso', label: t('accounts.method.sso'), onSelect: () => void controller.login(profile.id, 'sso') },
        { id: 'console', label: t('accounts.method.console'), onSelect: () => void controller.login(profile.id, 'console') },
      ],
    },
    { id: 'cancel-login', label: t('accounts.cancelLogin'), onSelect: () => void controller.cancelLogin(profile.id) },
    {
      id: 'logout',
      label: t('accounts.logout'),
      disabled: !status?.loggedIn,
      disabledReason: t('accounts.loggedOut'),
      onSelect: () => void controller.logout(profile.id),
    },
    {
      id: 'refresh',
      label: t('accounts.refresh'),
      onSelect: () => void controller.refreshStatus(profile.id, true),
    },
    { type: 'separator', id: 's2' },
    { id: 'rename', label: t('accounts.rename'), onSelect: () => void controller.renameProfile(profile.id) },
    {
      id: 'remove',
      label: t('common.remove'),
      disabled: profile.id === DEFAULT_PROFILE_ID,
      disabledReason: t('accounts.defaultCannotRemove'),
      onSelect: () => void controller.removeProfile(profile.id),
    },
  ];
  return (
    <li className="rd-acct" data-testid="account-row" data-active={active || undefined}>
      <span className={dot.className} role="img" aria-label={t(dot.label)} />
      <Avatar name={profile.name} square />
      <span className="rd-acct__text">
        <span className="rd-acct__name">
          {profile.name}
          {plan ? <span className="rd-acct__plan"> · {plan}</span> : null}
        </span>
        <span className="rd-acct__meta">
          {status?.error ?? (status ? t(status.loggedIn ? 'accounts.loggedIn' : 'accounts.loggedOut') : t('accounts.statusUnknown'))}
        </span>
        {status?.loggedIn && label?.email ? (
          <>
            <span className="rd-acct__caption">{t('accounts.labelCaption')}</span>
            <span className="rd-acct__meta" data-testid="account-label" title={label.email}>{label.email}</span>
          </>
        ) : null}
        {status?.loggedIn && cliPlan ? (
          <span className="rd-acct__drift" role="note" data-testid="account-plan-stale">
            {t(isProPlan(cliPlan) ? 'accounts.planStalePro' : 'accounts.planStale', { cli: cliPlan })}
          </span>
        ) : null}
        {status?.loggedIn && label?.drift ? (
          <span className="rd-acct__drift" role="note" data-testid="account-drift">
            {t('accounts.labelDrift', { label: label.drift.label, remembered: label.drift.remembered })}
          </span>
        ) : null}
      </span>
      {active ? <Check {...ICON_SM} className="rd-acct__check" aria-label={t('accounts.active')} aria-hidden={undefined} role="img" /> : null}
      {!status?.loggedIn ? (
        <button type="button" className="rd-link" onClick={() => void controller.login(profile.id)}>
          {t('accounts.login')}
        </button>
      ) : null}
      <IconButton
        ref={menuRef}
        label={t('accounts.actionsFor', { name: profile.name })}
        icon={<Ellipsis {...ICON_SM} />}
        size="small"
        muted
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu
        anchor={menuRef.current}
        open={open}
        onClose={() => setOpen(false)}
        entries={entries}
        label={t('accounts.actionsFor', { name: profile.name })}
        placement="bottom-end"
        width={210}
      />
      {authenticationOpen ? <AuthenticationSourceDialog profile={profile} onClose={() => setAuthenticationOpen(false)} /> : null}
    </li>
  );
}

export function AccountsCard() {
  const controller = useController();
  const t = useT();
  const profiles = useAppState((s) => s.profiles);
  const auth = useAppState((s) => s.auth);
  const plans = useAppState((s) => s.plans);
  const usage = useAppState((s) => s.usage);
  const labels = useAppState((s) => s.labels);
  const activeId = useAppState((s) => s.activeProfileId);
  const shown = (id: string) => planDisplay(auth[id], plans[id], usage[id], labels[id]);
  return (
    <PanelCard id="accounts" title={t('accounts.title')} summary={t('accounts.count', { n: profiles.length })}>
      <ul className="rd-card__rows">
        {profiles.map((profile) => (
          <AccountRow
            key={profile.id}
            profile={profile}
            status={auth[profile.id]}
            plan={shown(profile.id).label}
            cliPlan={shown(profile.id).cliPlan}
            label={labels[profile.id]}
            active={profile.id === activeId}
          />
        ))}
      </ul>
      <div className="rd-card__rows">
        <button type="button" className="rd-actionrow rd-actionrow--compact" onClick={() => void controller.addProfile()}>
          <Plus {...ICON} className="rd-card__icon" />
          <span className="rd-actionrow__label rd-actionrow__label--muted">{t('accounts.add')}</span>
        </button>
        <button type="button" className="rd-actionrow rd-actionrow--compact" onClick={() => void controller.refreshAllStatus(true)}>
          <RotateCw {...ICON} className="rd-card__icon" />
          <span className="rd-actionrow__label rd-actionrow__label--muted">{t('accounts.refreshAll')}</span>
        </button>
      </div>
      <p className="rd-card__note">{t('accounts.planHint')}</p>
      <p className="rd-card__note">{t('accounts.note')}</p>
    </PanelCard>
  );
}

export function RightPanel() {
  const t = useT();
  return (
    <aside className="rd-panel" aria-label={t('panel.label')} data-testid="right-panel">
      <EnvironmentCard />
      <HandoffCard />
      <ContextCard />
      <ConnectorsCard />
      <OutputsCard />
      <BackgroundCard />
      <AccountsCard />
    </aside>
  );
}
