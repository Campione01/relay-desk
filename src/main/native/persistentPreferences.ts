import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_PROFILE_ID, type Profile, type WorkflowsSetting } from '@shared/types';
import { assertPrototypePath, physicalFuturePath } from './scope';

/** Native menu writers may touch only this independent account, never Desktop's default profile. */
export function createNativePreferenceScope(profile: Profile, prototypeRoot: string) {
  if (profile.id === DEFAULT_PROFILE_ID || !profile.configDir) {
    throw new Error('Saved native controls require an independent Relay account directory.');
  }
  const directory = resolve(profile.configDir);
  const settingsPath = join(directory, 'settings.json');
  const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const verify = (): void => {
    assertPrototypePath(directory, prototypeRoot);
    if (!samePath(physicalFuturePath(directory), directory) || !lstatSync(directory).isDirectory()) {
      throw new Error('Native preference directory must not alias another account.');
    }
    for (const name of ['settings.json', '.claude.json']) {
      const file = join(directory, name);
      if (!samePath(physicalFuturePath(file), file)) throw new Error('Native preference files must not be shared links.');
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) {
          throw new Error('Native preference files must be bounded, independent regular files.');
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  verify();
  const prepareNativeSettings = (input: { workflows?: WorkflowsSetting; fastMode?: boolean; autoContinue?: boolean }): void => {
      verify();
      if (input.workflows === undefined && input.fastMode === undefined && input.autoContinue === undefined) return;
      let settings: Record<string, unknown> = {};
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Native settings must be a JSON object.');
      const updated: Record<string, unknown> = { ...settings };
      if (input.workflows !== undefined) { updated.enableWorkflows = input.workflows === 'on'; delete updated.disableWorkflows; }
      if (input.fastMode !== undefined) updated.fastMode = input.fastMode;
      if (input.autoContinue !== undefined) updated.autoContinueAtUsageLimit = input.autoContinue;
      if (JSON.stringify(settings) === JSON.stringify(updated)) return;
      const temporary = join(directory, `.relay-preferences-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        verify();
        renameSync(temporary, settingsPath);
      } finally {
        try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
  };
  return {
    directory, verify, prepareNativeSettings,
    assertCycleBinding(): void {
      verify();
      try {
        lstatSync(join(directory, 'keybindings.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      throw new Error('Custom native keybindings require an explicitly observed Shift+Tab permission-cycle hint; no shortcut was sent.');
    },
    prepareWorkflows(value: WorkflowsSetting | undefined): void { prepareNativeSettings({ workflows: value }); },
  };
}
