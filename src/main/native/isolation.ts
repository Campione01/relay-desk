import { mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { physicalFuturePath } from './scope';

export interface PrototypePaths {
  root: string;
  home: string;
  userData: string;
  roaming: string;
  local: string;
  project: string;
  temp: string;
  session: string;
  logs: string;
  crashes: string;
  launches: string;
  globalConfig: string;
  xdgConfig: string;
  xdgData: string;
  xdgCache: string;
  xdgState: string;
}

export const PROTOTYPE_APP_ID = 'com.relaydesk.nativeprototype';
export const PROTOTYPE_NAME = 'Relay Desk Native Prototype';

export function prototypePaths(rootInput: string, originalHome: string): PrototypePaths {
  if (!isAbsolute(rootInput)) throw new Error('Prototype root must be an absolute path.');
  const root = resolve(rootInput);
  const home = resolve(originalHome);
  const fromHome = relative(home, root);
  const underHome = !fromHome || (!fromHome.startsWith('..\\') && !fromHome.startsWith('../') && fromHome !== '..' && !isAbsolute(fromHome));
  const ownedName = root.split(/[\\/]/).some((part) => /^RelayDeskNativePrototype$/i.test(part));
  if (!ownedName || root.length < 12 || underHome || root === resolve(root, '..') || root.startsWith('\\\\')) {
    throw new Error('Unsafe prototype isolation root.');
  }
  return {
    root, home: join(root, 'home'), userData: join(root, 'app'), roaming: join(root, 'roaming'),
    local: join(root, 'local'), project: join(root, 'project'), temp: join(root, 'temp'),
    session: join(root, 'session'), logs: join(root, 'logs'), crashes: join(root, 'crashes'), launches: join(root, 'launches'),
    globalConfig: join(root, 'home', '.claude'), xdgConfig: join(root, 'xdg', 'config'),
    xdgData: join(root, 'xdg', 'data'), xdgCache: join(root, 'xdg', 'cache'), xdgState: join(root, 'xdg', 'state'),
  };
}

export function initializePrototypeEnvironment(rootInput: string, env: NodeJS.ProcessEnv = process.env): PrototypePaths {
  const paths = prototypePaths(rootInput, env.USERPROFILE ?? env.HOME ?? 'C:\\Users\\Unknown');
  // Validate every existing ancestor before mkdir or Electron can follow a reparse point.
  for (const path of Object.values(paths)) {
    if (relative(resolve(path), physicalFuturePath(path)) !== '') throw new Error('Prototype storage cannot use redirected directories.');
  }
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  env.USERPROFILE = paths.home;
  env.HOME = paths.home;
  env.APPDATA = paths.roaming;
  env.LOCALAPPDATA = paths.local;
  env.TEMP = paths.temp;
  env.TMP = paths.temp;
  env.TMPDIR = paths.temp;
  env.XDG_CONFIG_HOME = paths.xdgConfig;
  env.XDG_DATA_HOME = paths.xdgData;
  env.XDG_CACHE_HOME = paths.xdgCache;
  env.XDG_STATE_HOME = paths.xdgState;
  env.RELAY_DESK_NATIVE_PROTOTYPE = '1';
  env.RELAY_NATIVE_SANDBOX_ROOT = paths.root;
  return paths;
}

export function isNativePrototype(): boolean {
  return process.env.RELAY_DESK_NATIVE_PROTOTYPE === '1';
}
