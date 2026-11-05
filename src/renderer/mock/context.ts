import { DEFAULT_PROFILE_ID, type Profile, type SharedCodeContextReport } from '@shared/types';

/** Synthetic metadata only. Never probes the file system or copies a real user's context. */
export function mockCodeContext(profile: Profile, cwd?: string): SharedCodeContextReport {
  const globalRoot = 'C:\\Users\\me\\.claude';
  const configDirectory = profile.configDir ?? globalRoot;
  const native = profile.id === DEFAULT_PROFILE_ID;
  return {
    profileId: profile.id,
    mode: native ? 'default' : 'shared',
    configDirectory,
    globalRoot,
    entries: (['instructions', 'rules', 'skills'] as const).map((kind) => {
      const suffix = kind === 'instructions' ? 'CLAUDE.md' : kind;
      return { kind, sourcePath: `${globalRoot}\\${suffix}`, targetPath: `${configDirectory}\\${suffix}`, state: native ? 'native' : 'ready' };
    }),
    memory: {
      ...(cwd ? { directory: `${globalRoot}\\projects\\${cwd.replace(/[^a-z0-9]/gi, '-')}\\memory`, indexExists: true } : {}),
      shared: !native,
      enabled: true,
    },
    permissions: { allow: 3, deny: 1, ask: 2, defaultMode: 'default' },
    warnings: [],
  };
}
