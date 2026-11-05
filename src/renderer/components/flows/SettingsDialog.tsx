import { useEffect, useState, type ReactNode } from 'react';
import {
  AUTO_CONTINUE_MAX,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  type AppSettings,
  type Effort,
  type PermissionMode,
  type WorkflowsSetting,
} from '@shared/types';
import { useT, type MessageKey } from '../../i18n';
import { useAppState, useController } from '../../state/context';
import { FONT_SCALES } from '../../theme/theme';
import { EFFORT_KEYS, MODE_KEYS } from '../prompt/PromptFooter';
import { Dialog } from '../ui/Dialog';

const MODEL_SUGGESTIONS = ['default', 'opus', 'sonnet', 'haiku', 'opusplan'];

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
}) {
  return (
    <div className="rd-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className="rd-segmented__item"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="rd-setting">
      <div className="rd-setting__text">
        {htmlFor ? (
          <label className="rd-setting__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="rd-setting__label">{label}</span>
        )}
        {hint ? <span className="rd-setting__hint">{hint}</span> : null}
      </div>
      <div className="rd-setting__control">{children}</div>
    </div>
  );
}

/**
 * Settings: theme, language, font scale, defaults, dynamic workflows, automatic continue, versions, data folder.
 * Changes apply at once.
 */
export function SettingsDialog() {
  const controller = useController();
  const t = useT();
  const open = useAppState((s) => s.ui.settings);
  const settings = useAppState((s) => s.settings);
  const versions = useAppState((s) => s.versions);
  const profiles = useAppState((s) => s.profiles);
  const [model, setModel] = useState(settings.defaultModel ?? '');

  useEffect(() => {
    if (open) setModel(settings.defaultModel ?? '');
  }, [open, settings.defaultModel]);

  const update = (patch: Partial<AppSettings>): void => void controller.updateSettings(patch);
  const commitModel = (): void => {
    const next = model.trim();
    if (next === (settings.defaultModel ?? '')) return;
    update({ defaultModel: next || undefined });
  };

  return (
    <Dialog open={open} size="medium" title={t('settings.title')} onClose={() => controller.openSettings(false)} testId="settings-dialog">
      <section className="rd-settings__section" aria-labelledby="settings-appearance">
        <h3 id="settings-appearance" className="rd-settings__heading">
          {t('settings.appearance')}
        </h3>
        <Row label={t('settings.theme')}>
          <Segmented
            label={t('settings.theme')}
            value={settings.theme}
            options={[
              { value: 'light', label: t('settings.theme.light') },
              { value: 'system', label: t('settings.theme.system') },
              { value: 'dark', label: t('settings.theme.dark') },
            ]}
            onChange={(theme) => update({ theme })}
          />
        </Row>
        <Row label={t('settings.language')} htmlFor="settings-language">
          <select
            id="settings-language"
            className="rd-select"
            value={settings.language}
            onChange={(event) => update({ language: event.target.value as AppSettings['language'] })}
          >
            <option value="zh-TW">繁體中文（台灣）</option>
            <option value="en">English</option>
          </select>
        </Row>
        <Row label={t('settings.fontScale')} hint={t('settings.fontScale.hint')}>
          <Segmented
            label={t('settings.fontScale')}
            value={settings.fontScale}
            options={FONT_SCALES.map((scale) => ({ value: scale, label: `${Math.round(scale * 100)}%` }))}
            onChange={(fontScale) => update({ fontScale })}
          />
        </Row>
      </section>
      <section className="rd-settings__section" aria-labelledby="settings-defaults">
        <h3 id="settings-defaults" className="rd-settings__heading">
          {t('settings.defaults')}
        </h3>
        <Row label={t('settings.defaultModel')} hint={t('settings.defaultModel.hint')} htmlFor="settings-model">
          <input
            id="settings-model"
            className="rd-input"
            list="settings-model-list"
            value={model}
            placeholder={t('model.default')}
            onChange={(event) => setModel(event.target.value)}
            onBlur={commitModel}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitModel();
            }}
          />
          <datalist id="settings-model-list">
            {MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Row>
        <Row label={t('settings.defaultEffort')} htmlFor="settings-effort">
          <select
            id="settings-effort"
            className="rd-select"
            value={settings.defaultEffort ?? ''}
            onChange={(event) => update({ defaultEffort: (event.target.value || undefined) as Effort | undefined })}
          >
            <option value="">{t('settings.unset')}</option>
            {EFFORT_LEVELS.map((level) => (
              <option key={level} value={level}>
                {t(EFFORT_KEYS[level])}
              </option>
            ))}
          </select>
        </Row>
        <Row label={t('settings.defaultMode')} htmlFor="settings-mode">
          <select
            id="settings-mode"
            className="rd-select"
            value={settings.defaultPermissionMode ?? ''}
            onChange={(event) =>
              update({ defaultPermissionMode: (event.target.value || undefined) as PermissionMode | undefined })
            }
          >
            <option value="">{t('settings.unset')}</option>
            {PERMISSION_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(MODE_KEYS[mode])}
              </option>
            ))}
          </select>
        </Row>
      </section>
      <section className="rd-settings__section" aria-labelledby="settings-claude-code">
        <h3 id="settings-claude-code" className="rd-settings__heading">
          {t('settings.claudeCode')}
        </h3>
        <Row label={t('settings.workflows')} hint={t('settings.workflows.hint')} htmlFor="settings-workflows">
          <select
            id="settings-workflows"
            className="rd-select"
            value={settings.workflows ?? ''}
            onChange={(event) => update({ workflows: (event.target.value || undefined) as WorkflowsSetting | undefined })}
          >
            <option value="">{t('settings.workflows.plan')}</option>
            <option value="on">{t('settings.workflows.on')}</option>
            <option value="off">{t('settings.workflows.off')}</option>
          </select>
        </Row>
        <Row
          label={t('settings.autoContinue')}
          hint={t('settings.autoContinue.hint', { max: AUTO_CONTINUE_MAX })}
          htmlFor="settings-auto-continue"
        >
          <select
            id="settings-auto-continue"
            className="rd-select"
            value={settings.autoContinue === false ? 'off' : 'on'}
            onChange={(event) => update({ autoContinue: event.target.value !== 'off' })}
          >
            <option value="on">{t('settings.autoContinue.on')}</option>
            <option value="off">{t('settings.autoContinue.off')}</option>
          </select>
        </Row>
        <Row label={t('settings.liveContext')} hint={t('settings.liveContext.hint')} htmlFor="settings-live-context">
          <select
            id="settings-live-context"
            className="rd-select"
            value={settings.liveContext === true ? 'on' : 'off'}
            onChange={(event) => update({ liveContext: event.target.value === 'on' })}
          >
            <option value="off">{t('settings.liveContext.off')}</option>
            <option value="on">{t('settings.liveContext.on')}</option>
          </select>
        </Row>
      </section>
      <section className="rd-settings__section" aria-labelledby="settings-about">
        <h3 id="settings-about" className="rd-settings__heading">
          {t('settings.about')}
        </h3>
        <dl className="rd-kv">
          <dt>{t('settings.version.app')}</dt>
          <dd className="rd-tnum">{versions?.app ?? '—'}</dd>
          <dt>{t('settings.version.sdk')}</dt>
          <dd className="rd-tnum">{versions?.sdk ?? '—'}</dd>
          <dt>{t('settings.version.cli')}</dt>
          <dd className="rd-tnum">{versions?.cli ?? '—'}</dd>
        </dl>
      </section>
      <section className="rd-settings__section" aria-labelledby="settings-data">
        <h3 id="settings-data" className="rd-settings__heading">
          {t('settings.data')}
        </h3>
        <dl className="rd-kv">
          <dt>{t('settings.dataFolder')}</dt>
          <dd className="rd-mono">%APPDATA%\Relay Desk</dd>
          {profiles.map((profile) => (
            <div key={profile.id} className="rd-kv__pair">
              <dt>{profile.name}</dt>
              <dd className="rd-mono">{profile.configDir ?? t('settings.defaultConfigDir')}</dd>
            </div>
          ))}
        </dl>
        <p className="rd-setting__hint">{t('settings.credentialsNote')}</p>
      </section>
    </Dialog>
  );
}

const KEY_ROWS: Array<[string, MessageKey]> = [
  ['Enter', 'keys.send'],
  ['Shift+Enter', 'keys.newline'],
  ['Ctrl+Enter', 'keys.queue'],
  ['Esc', 'keys.interrupt'],
  ['Alt+1 … Alt+9', 'keys.shortcuts'],
  ['Ctrl+B', 'keys.sidebar'],
  ['Ctrl+N', 'keys.newSession'],
  ['Ctrl+,', 'keys.settings'],
  ['Ctrl+Shift+M', 'keys.mode'],
  ['Ctrl+Shift+I', 'keys.model'],
  ['Ctrl+Shift+E', 'keys.effort'],
  ['Ctrl+/', 'keys.help'],
];

export function KeyboardHelp() {
  const controller = useController();
  const t = useT();
  const open = useAppState((s) => s.ui.keyboardHelp);
  return (
    <Dialog open={open} title={t('keys.title')} onClose={() => controller.openKeyboardHelp(false)}>
      <dl className="rd-kv rd-kv--keys">
        {KEY_ROWS.map(([keys, label]) => (
          <div key={keys} className="rd-kv__pair">
            <dt>
              <kbd className="rd-kbd">{keys}</kbd>
            </dt>
            <dd>{t(label)}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
