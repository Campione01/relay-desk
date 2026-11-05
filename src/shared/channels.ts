import type { RelayApi } from './ipc';

/** Channel name for every RelayApi member: `relay:<namespace>:<method>`. */
type ChannelTable = {
  readonly [N in keyof RelayApi]: { readonly [M in keyof RelayApi[N] & string]: `relay:${N}:${M}` };
};

/**
 * One IPC channel per RelayApi method. Invoke channels are answered with ipcMain.handle;
 * on* channels are pushed with webContents.send. `satisfies` keeps this table and RelayApi in lockstep.
 */
export const IPC = {
  app: {
    getLaunchRequest: 'relay:app:getLaunchRequest',
    onLaunchRequest: 'relay:app:onLaunchRequest',
    getSettings: 'relay:app:getSettings',
    setSettings: 'relay:app:setSettings',
    pickFolder: 'relay:app:pickFolder',
    pickFiles: 'relay:app:pickFiles',
    revealPath: 'relay:app:revealPath',
    revealFile: 'relay:app:revealFile',
    openExternal: 'relay:app:openExternal',
    versions: 'relay:app:versions',
    inspectCodeContext: 'relay:app:inspectCodeContext',
  },
  sessions: {
    list: 'relay:sessions:list',
    history: 'relay:sessions:history',
    rename: 'relay:sessions:rename',
    fork: 'relay:sessions:fork',
    delete: 'relay:sessions:delete',
    tasks: 'relay:sessions:tasks',
    image: 'relay:sessions:image',
    subagent: 'relay:sessions:subagent',
  },
  engine: {
    open: 'relay:engine:open',
    startupInput: 'relay:engine:startupInput',
    cancelStartup: 'relay:engine:cancelStartup',
    panelInput: 'relay:engine:panelInput',
    panelClose: 'relay:engine:panelClose',
    send: 'relay:engine:send',
    interrupt: 'relay:engine:interrupt',
    close: 'relay:engine:close',
    setModel: 'relay:engine:setModel',
    setEffort: 'relay:engine:setEffort',
    setUltracode: 'relay:engine:setUltracode',
    setFastMode: 'relay:engine:setFastMode',
    setWorkflows: 'relay:engine:setWorkflows',
    setAutoContinue: 'relay:engine:setAutoContinue',
    setLiveContext: 'relay:engine:setLiveContext',
    cancelAutoContinue: 'relay:engine:cancelAutoContinue',
    continueAfterLimit: 'relay:engine:continueAfterLimit',
    stopTask: 'relay:engine:stopTask',
    taskOutput: 'relay:engine:taskOutput',
    setPermissionMode: 'relay:engine:setPermissionMode',
    respondPermission: 'relay:engine:respondPermission',
    respondQuestion: 'relay:engine:respondQuestion',
    models: 'relay:engine:models',
    refreshContext: 'relay:engine:refreshContext',
    mcpStatus: 'relay:engine:mcpStatus',
    mcpToggle: 'relay:engine:mcpToggle',
    mcpReconnect: 'relay:engine:mcpReconnect',
    onEvent: 'relay:engine:onEvent',
  },
  handoff: {
    toDesktop: 'relay:handoff:toDesktop',
    openFolderInDesktop: 'relay:handoff:openFolderInDesktop',
    openInTerminal: 'relay:handoff:openInTerminal',
    toCloud: 'relay:handoff:toCloud',
    teleport: 'relay:handoff:teleport',
    remoteControl: 'relay:handoff:remoteControl',
    backgroundAgents: 'relay:handoff:backgroundAgents',
    attachBackground: 'relay:handoff:attachBackground',
  },
  accounts: {
    list: 'relay:accounts:list',
    add: 'relay:accounts:add',
    rename: 'relay:accounts:rename',
    remove: 'relay:accounts:remove',
    status: 'relay:accounts:status',
    login: 'relay:accounts:login',
    cancelLogin: 'relay:accounts:cancelLogin',
    authenticationEnvironment: 'relay:accounts:authenticationEnvironment',
    setAuthenticationSource: 'relay:accounts:setAuthenticationSource',
    logout: 'relay:accounts:logout',
    setSharedCodeContext: 'relay:accounts:setSharedCodeContext',
    unshareCodeContext: 'relay:accounts:unshareCodeContext',
    onStatus: 'relay:accounts:onStatus',
  },
  shortcuts: {
    get: 'relay:shortcuts:get',
    set: 'relay:shortcuts:set',
    reset: 'relay:shortcuts:reset',
  },
  usage: {
    get: 'relay:usage:get',
  },
  mcp: {
    list: 'relay:mcp:list',
    previewDesktopImport: 'relay:mcp:previewDesktopImport',
    importFromDesktop: 'relay:mcp:importFromDesktop',
    setEnabled: 'relay:mcp:setEnabled',
    remove: 'relay:mcp:remove',
  },
} as const satisfies ChannelTable;

export const ALL_CHANNELS: readonly string[] = Object.values(IPC).flatMap((methods) => Object.values(methods));

/** True for subscription members (onEvent, onStatus, ...). */
export function isEventMethod(method: string): boolean {
  return /^on[A-Z]/.test(method);
}
