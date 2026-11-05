import { TriangleAlert, Zap, ZapOff } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { EFFORT_LEVELS, PERMISSION_MODES, type Effort, type PermissionMode } from '@shared/types';
import { useT, type MessageKey, type Translate } from '../../i18n';
import { effortGuideDescription, effortGuideFor, localizeGuideText } from '../../lib/effortGuide';
import { formatPercent, formatTokens } from '../../lib/format';
import {
  currentModelOption,
  fastIndicator,
  fastRowVisible,
  isFastReason,
  modelMenu,
  type FastIndicator,
  type FastReason,
  type ModelChoice,
} from '../../lib/models';
import { useAppState, useController } from '../../state/context';
import { pendingPermissionMode } from '../../state/controller';
import { cliWorkingPlan, workflowsEnabled } from '../../state/plan';
import { hasOpenHandle } from '../../state/sessionReducer';
import type { SessionView } from '../../state/types';
import { Menu, type MenuEntry } from '../ui/Menu';
import { ICON_XS, UsageRing } from '../ui/primitives';
import { UsagePopover, usageAtLimit } from './UsagePopover';

export const MODE_KEYS: Record<PermissionMode, MessageKey> = {
  default: 'mode.default',
  acceptEdits: 'mode.acceptEdits',
  plan: 'mode.plan',
  auto: 'mode.auto',
  dontAsk: 'mode.dontAsk',
  bypassPermissions: 'mode.bypassPermissions',
};

const MODE_DESC_KEYS: Record<PermissionMode, MessageKey> = {
  default: 'mode.default.desc',
  acceptEdits: 'mode.acceptEdits.desc',
  plan: 'mode.plan.desc',
  auto: 'mode.auto.desc',
  dontAsk: 'mode.dontAsk.desc',
  bypassPermissions: 'mode.bypassPermissions.desc',
};

export const EFFORT_KEYS: Record<Effort, MessageKey> = {
  low: 'effort.low',
  medium: 'effort.medium',
  high: 'effort.high',
  xhigh: 'effort.xhigh',
  max: 'effort.max',
};

const FAST_REASON_KEYS: Record<FastReason, MessageKey> = {
  free: 'model.fastReason.free',
  preference: 'model.fastReason.preference',
  extra_usage_disabled: 'model.fastReason.extra_usage_disabled',
  network_error: 'model.fastReason.network_error',
  unknown: 'model.fastReason.unknown',
  not_first_party: 'model.fastReason.not_first_party',
  disabled_by_env: 'model.fastReason.disabled_by_env',
  model_not_allowed: 'model.fastReason.model_not_allowed',
  sdk_opt_in_required: 'model.fastReason.sdk_opt_in_required',
  pending: 'model.fastReason.pending',
};

/** Why fast mode cannot serve, in the UI language; a reason the CLI added later is shown as it came. */
function fastStatusText(indicator: Exclude<FastIndicator, null>, t: Translate): string {
  if (indicator.state === 'cooldown') return t('model.fastCooldown');
  if (indicator.state === 'on') return t('model.fastOn');
  const reason = isFastReason(indicator.reason) ? t(FAST_REASON_KEYS[indicator.reason]) : indicator.reason;
  return t('model.fastUnavailable', { reason });
}

/** Row under the prompt box (§4.11): permission mode (left); the model and effort button and the usage ring with its popover (right). */
export function PromptFooter({ view }: { view: SessionView }) {
  const controller = useController();
  const t = useT();
  const menu = useAppState((s) => s.ui.footerMenu);
  const modeRef = useRef<HTMLButtonElement>(null);
  const modelRef = useRef<HTMLButtonElement>(null);
  const ringRef = useRef<HTMLButtonElement>(null);
  const usage = useAppState((s) => s.usage[view.profileId]);
  const catalog = useAppState((s) => s.modelCatalog[view.profileId]);
  const defaultMode = useAppState((s) => s.settings.defaultPermissionMode);
  // Ultracode needs dynamic workflows; like the CLI's /effort, it is offered only where they are on.
  const workflows = useAppState((s) =>
    workflowsEnabled(s.settings.workflows, cliWorkingPlan(s.auth[view.profileId], s.plans[view.profileId], s.usage[view.profileId])),
  );
  const open = hasOpenHandle(view);
  // Live: the mode the CLI reported or Relay requested. Before the open: the mode it will ask for. Undefined = the
  // native settings decide (EC-1): the label says so and nothing is checked.
  const mode = open ? view.permissionMode : pendingPermissionMode(view, { defaultPermissionMode: defaultMode });
  const atLimit = usageAtLimit(usage);
  // Ctrl+Shift+E opens the same menu as Ctrl+Shift+I with its Effort submenu showing.
  const modelOpen = menu === 'model' || menu === 'effort';
  // A closed view has no list of its own; the account's last list stands in until the engine reports one.
  const models = view.models.length > 0 || open ? view.models : (catalog ?? []);
  const option = currentModelOption(view.model, models);
  const catalogSource = models.find((model) => model.catalogSource)?.catalogSource
    ?? (models.length === 0 && view.nativeFast !== undefined ? 'native-config' : undefined);
  const rows = modelMenu(view.model, models, t('model.default'), catalogSource);
  const nativeFast = view.nativeFast && !open
    ? { ...view.nativeFast, requested: view.fastMode ?? view.nativeFast.requested, locked: false, state: undefined }
    : view.nativeFast;
  const fast = fastIndicator(view.fastMode, !open && nativeFast ? undefined : view.fast, option, nativeFast);
  // The switch stays while the menu is open even when turning it off would hide it.
  const fastShown = useRef(false);
  if (!modelOpen) fastShown.current = false;
  const showFast = fastRowVisible(option, usage?.extraUsage?.enabled, view.fastMode, view.fast, view.nativeFast) || (!view.nativeFast && fastShown.current);
  const fastRequested = nativeFast?.requested ?? view.fastMode;
  if (modelOpen && showFast) fastShown.current = true;

  const refreshCatalog = view.nativeFast !== undefined || view.models.length === 0;
  useEffect(() => {
    if (modelOpen && open && refreshCatalog) void controller.loadModels(view.key);
  }, [modelOpen, open, refreshCatalog, view.key, controller]);

  const close = (): void => controller.openFooterMenu(null);

  const modeEntries: MenuEntry[] = PERMISSION_MODES.map((value) => ({
    id: value,
    label: t(MODE_KEYS[value]),
    description: t(MODE_DESC_KEYS[value]),
    checked: value === mode,
    onSelect: () => void controller.setPermissionMode(view.key, value),
  }));

  const pick = (row: ModelChoice): void => {
    if (row.value !== rows.currentValue) void controller.setModel(view.key, row.value);
  };
  const modelEntries: MenuEntry[] = rows.main.map((row, index) => ({
    id: `model:${row.value}`,
    label: row.name,
    checked: row.value === rows.currentValue,
    shortcut: index < 9 ? String(index + 1) : undefined,
    onSelect: () => pick(row),
  }));
  const moreEntries: MenuEntry[] = rows.more.map((row) => ({
    id: `more:${row.value}`,
    label: row.name,
    checked: row.value === rows.currentValue,
    onSelect: () => pick(row),
  }));

  const effortUnsupported = option?.supportsEffort === false;
  // The CLI model catalog's notes, as the desktop's effort picker shows them; a model without effort gets none.
  const guide = effortUnsupported ? undefined : effortGuideFor(view.model, models);
  const guideLine = effortUnsupported ? undefined : effortGuideDescription(guide, models);
  const levelEntries: MenuEntry[] = EFFORT_LEVELS.map((level) => {
    const unsupported = effortUnsupported || Boolean(option?.effortLevels && !option.effortLevels.includes(level));
    const notes = guide?.levels[level];
    return {
      id: level,
      label: t(EFFORT_KEYS[level]),
      badge: notes?.badge && !unsupported ? { text: localizeGuideText(notes.badge.message, t), tone: notes.badge.tone } : undefined,
      checked: level === view.effort,
      disabled: unsupported,
      disabledReason: t('effort.unsupported'),
      tip: notes?.tooltip ? localizeGuideText(notes.tooltip, t) : undefined,
      onSelect: () => void controller.setEffort(view.key, level),
    };
  });
  // Session-scoped and never saved; usable before the open (sent with it). Kept visible while on, to turn it off.
  const showUltracode = (workflows && !effortUnsupported) || Boolean(view.ultracode);
  const effortEntries: MenuEntry[] = [
    ...(guideLine ? ([{ type: 'section', id: 'effort-guide', label: localizeGuideText(guideLine, t), describes: true }] satisfies MenuEntry[]) : []),
    ...levelEntries,
    ...(showUltracode
      ? ([
          { type: 'separator', id: 'ultracode-sep' },
          {
            id: 'ultracode',
            label: t('effort.ultracode'),
            description: t('effort.ultracode.desc'),
            checked: Boolean(view.ultracode),
            onSelect: () => void controller.setUltracode(view.key, !view.ultracode),
          },
        ] satisfies MenuEntry[])
      : []),
  ];
  const effortText = view.effort ? t(EFFORT_KEYS[view.effort]) : t('effort.default');

  const menuEntries: MenuEntry[] = [
    { type: 'section', id: 'model-header', label: t('model.menuHeader') },
    ...modelEntries,
    { type: 'separator', id: 'effort-sep' },
    { id: 'effort', label: t('model.effortRow'), value: effortText, submenu: effortEntries },
    ...(moreEntries.length
      ? ([{ type: 'separator', id: 'more-sep' }, { id: 'more', label: t('model.more'), submenu: moreEntries }] satisfies MenuEntry[])
      : []),
    ...(showFast
      ? ([
          { type: 'separator', id: 'fast-sep' },
          {
            type: 'toggle',
            id: 'fast',
            label: view.nativeFast?.label ?? t('model.fast'),
            checked: Boolean(fastRequested),
            disabled: nativeFast?.locked,
            disabledReason: nativeFast?.locked ? 'The native Fast mode preference is locked by policy.' : undefined,
            tip: fast && fast.state !== 'on' ? fastStatusText(fast, t) : t('model.fastDesc'),
            onSelect: () => void controller.setFastMode(view.key, !fastRequested),
          },
        ] satisfies MenuEntry[])
      : []),
  ];

  const percent = view.context ? view.context.percent : null;
  const contextTip = view.context
    ? t('context.ringTip', {
        percent: formatPercent(view.context.percent),
        used: formatTokens(view.context.usedTokens),
        max: formatTokens(view.context.maxTokens),
      })
    : t('context.ringEmpty');
  const ringTip = atLimit
    ? `${t('usage.ringLabel', { context: contextTip })}\n${t('usage.limitReached')}`
    : t('usage.ringLabel', { context: contextTip });

  return (
    <div className="rd-promptfoot" data-testid="prompt-footer">
      <button
        ref={modeRef}
        type="button"
        className="rd-promptfoot__btn rd-promptfoot__mode"
        aria-haspopup="menu"
        aria-expanded={menu === 'permission'}
        data-tip={t('mode.pickerTip')}
        data-tip-key="Ctrl+Shift+M"
        data-tip-place="top"
        onClick={() => controller.openFooterMenu(menu === 'permission' ? null : 'permission')}
      >
        {mode ? t(MODE_KEYS[mode]) : t('mode.settingsDefault')}
      </button>
      <Menu
        anchor={modeRef.current}
        open={menu === 'permission'}
        onClose={close}
        entries={modeEntries}
        label={t('mode.pickerTip')}
        placement="top-start"
        width={280}
      />
      <div className="rd-promptfoot__right">
        <button
          ref={modelRef}
          type="button"
          className="rd-promptfoot__btn rd-promptfoot__model"
          aria-haspopup="menu"
          aria-expanded={modelOpen}
          data-tip={t('model.pickerTip')}
          data-tip-key="Ctrl+Shift+I"
          data-tip-place="top"
          onClick={() => controller.openFooterMenu(modelOpen ? null : 'model')}
        >
          {/* The spaces only separate the parts in the button's accessible name; flex layout drops them. */}
          <span className="rd-promptfoot__name">{rows.current}</span>{' '}
          {fast ? (
            <span
              className="rd-promptfoot__fast"
              data-state={fast.state}
              role="img"
              aria-label={fastStatusText(fast, t)}
              data-tip={fastStatusText(fast, t)}
              data-tip-place="top"
            >
              {fast.state === 'unavailable' ? <ZapOff {...ICON_XS} /> : <Zap {...ICON_XS} />}
            </span>
          ) : null}
          {fast ? ' ' : null}
          <span className="rd-promptfoot__effort">
            {view.ultracode ? `${effortText} · ${t('effort.ultracode')}` : effortText}
          </span>
        </button>
        {atLimit ? (
          <span
            className="rd-promptfoot__warn"
            role="img"
            aria-label={t('usage.limitReached')}
            data-tip={t('usage.limitReached')}
            data-tip-place="top"
          >
            <TriangleAlert {...ICON_XS} />
          </span>
        ) : null}
        <Menu
          anchor={modelRef.current}
          open={modelOpen}
          onClose={close}
          entries={menuEntries}
          label={t('model.pickerTip')}
          placement="top-end"
          offset={6}
          className="rd-menu--model"
          initialSubmenu={menu === 'effort' ? 'effort' : undefined}
        />
        <button
          ref={ringRef}
          type="button"
          className="rd-promptfoot__ring"
          aria-label={ringTip}
          aria-haspopup="dialog"
          aria-expanded={menu === 'usage'}
          data-tip={menu === 'usage' ? undefined : ringTip}
          data-tip-place="top"
          onClick={() => controller.openFooterMenu(menu === 'usage' ? null : 'usage')}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && menu === 'usage') {
              event.preventDefault();
              close();
            }
          }}
        >
          <UsageRing percent={percent} limit={atLimit} />
        </button>
        <UsagePopover anchor={ringRef.current} open={menu === 'usage'} onClose={close} profileId={view.profileId} view={view} />
      </div>
    </div>
  );
}
