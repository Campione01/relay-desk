// Synthetic fixtures for the in-memory api (dev:web and component tests). No real user data.
import type {
  AuthStatus,
  BackgroundAgent,
  BackgroundTask,
  ContextUsage,
  EffortGuide,
  McpServerEntry,
  McpServerState,
  ModelOption,
  PlanUsage,
  Profile,
  SessionSummary,
  SlashCommandInfo,
  TranscriptItem,
} from '@shared/types';

export const NOW = Date.UTC(2026, 9, 16, 9, 0, 0);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export const MAIN_SESSION_ID = '7f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c01';
export const CLI_SESSION_ID = '3b8e5d10-6a2f-4e7c-8d94-71c0a5f2e3b2';
export const TASK_SESSION_ID = '9a4d7c21-58e3-4b0f-a1c2-6d8e9f0a1b23';

export const WORK_PROFILE_ID = 'profile-work';

export const MOCK_PROFILES: readonly Profile[] = [
  { id: 'default', name: 'Personal account', configDir: null, createdAt: NOW - 30 * DAY },
  {
    id: WORK_PROFILE_ID,
    name: 'Work account',
    configDir: 'C:\\Users\\me\\AppData\\Roaming\\Relay Desk\\profiles\\profile-work',
    createdAt: NOW - 3 * DAY,
  },
];

export const MOCK_AUTH: Readonly<Record<string, Omit<AuthStatus, 'checkedAt'>>> = {
  default: { profileId: 'default', loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max' },
  [WORK_PROFILE_ID]: { profileId: WORK_PROFILE_ID, loggedIn: false, authMethod: 'none' },
};

const RELAY = 'D:\\demos\\relay-desk';
const BUSINESS = 'D:\\work\\business';
const NOTES = 'D:\\notes\\reading';
const DEMO = 'D:\\demos\\demo-app';

export const MOCK_SESSIONS: readonly SessionSummary[] = [
  {
    sessionId: MAIN_SESSION_ID,
    title: 'Relay Desk packaging plan',
    cwd: RELAY,
    lastModified: NOW - 5 * MIN,
    createdAt: NOW - 3 * HOUR,
    gitBranch: 'main',
  },
  { sessionId: TASK_SESSION_ID, title: 'Finish the open tasks', cwd: RELAY, lastModified: NOW - 3 * HOUR },
  { sessionId: '1c0e3f7a-2b4d-4e6f-8a9b-0c1d2e3f4a51', title: 'Shortcut bar editor', cwd: RELAY, lastModified: NOW - 2 * DAY },
  { sessionId: '1c0e3f7a-2b4d-4e6f-8a9b-0c1d2e3f4a52', title: 'Account switching research', cwd: RELAY, lastModified: NOW - 3 * DAY },
  { sessionId: '1c0e3f7a-2b4d-4e6f-8a9b-0c1d2e3f4a53', title: 'Test checklist cleanup', cwd: RELAY, lastModified: NOW - 4 * DAY },
  { sessionId: '1c0e3f7a-2b4d-4e6f-8a9b-0c1d2e3f4a54', title: 'Layout measurements', cwd: RELAY, lastModified: NOW - 5 * DAY },
  { sessionId: '1c0e3f7a-2b4d-4e6f-8a9b-0c1d2e3f4a55', title: 'Packaging settings', cwd: RELAY, lastModified: NOW - 9 * DAY },
  { sessionId: '2d1f4a8b-3c5e-4f70-9b0c-1d2e3f4a5b61', title: 'Quarterly report cleanup', cwd: BUSINESS, lastModified: NOW - DAY },
  { sessionId: '2d1f4a8b-3c5e-4f70-9b0c-1d2e3f4a5b62', title: 'Contract clause comparison', cwd: BUSINESS, lastModified: NOW - 4 * DAY },
  { sessionId: '4e2a5b9c-4d6f-4081-8c1d-2e3f4a5b6c71', title: 'Tidy the Downloads folder', cwd: 'D:\\', lastModified: NOW - 30 * MIN },
  { sessionId: '5f3b6c0d-5e70-4192-9d2e-3f4a5b6c7d81', title: 'Reading notes', cwd: NOTES, lastModified: NOW - 2 * DAY },
  { sessionId: '5f3b6c0d-5e70-4192-9d2e-3f4a5b6c7d82', title: 'Trip itinerary', cwd: NOTES, lastModified: NOW - 6 * DAY },
  { sessionId: CLI_SESSION_ID, title: 'Fix flaky test', cwd: DEMO, lastModified: NOW - 26 * HOUR },
];

export const MOCK_WORK_SESSIONS: readonly SessionSummary[] = [
  { sessionId: '6a4c7d1e-6f81-42a3-8e3f-4a5b6c7d8e91', title: 'Onboarding notes', cwd: 'D:\\work\\acme', lastModified: NOW - 2 * HOUR },
];

const TODOS = [
  { content: 'Count the common commands and check the dev environment', status: 'in_progress', activeForm: 'Counting the common commands and checking the dev environment' },
  { content: 'Capture the desktop layout as a visual reference', status: 'pending' },
  { content: 'Write the design and the plan', status: 'pending' },
  { content: 'Set up the project skeleton and the interface contract', status: 'pending' },
  { content: 'Build the modules in parallel', status: 'pending' },
  { content: 'Integrate, build and verify a real start', status: 'pending' },
  { content: 'Independent review and fixes', status: 'pending' },
  { content: 'Report and list what needs acceptance', status: 'pending' },
];

const HANDOFF_DOC = Array.from({ length: 99 }, (_, i) =>
  i === 0 ? '# Hand-off commands' : i % 10 === 1 ? `## Step ${Math.ceil(i / 10)}` : `- line ${i}`,
).join('\n');

function tool(
  id: string,
  name: string,
  summary: string,
  input: unknown,
  extra: Partial<Extract<TranscriptItem, { kind: 'tool' }>> = {},
): TranscriptItem {
  return { kind: 'tool', id, toolUseId: `toolu_${id}`, name, input, summary, status: 'done', ...extra };
}

export const MOCK_HISTORY: Readonly<Record<string, readonly TranscriptItem[]>> = {
  [MAIN_SESSION_ID]: [
    { kind: 'user', id: 'm-u1', text: 'Turn every official desktop and CLI hand-off command into a button, and keep the common replies.' },
    { kind: 'thinking', id: 'm-th1', text: 'First list the hand-off commands in the official docs, then compare them with the commands the user sends most.' },
    {
      kind: 'assistant',
      id: 'm-a1',
      text: 'OK. I will turn every official desktop and CLI hand-off command, such as `/desktop`, `claude --desktop --resume`, the desktop `/resume`, `--teleport` and Remote Control, into a button.',
    },
    tool('m-t1', 'Write', 'Created docs/handoff.md', { file_path: 'D:\\demos\\relay-desk\\docs\\handoff.md', content: HANDOFF_DOC }),
    tool('m-t2', 'Bash', 'Ran `git status`', { command: 'git status', description: 'Show working tree status' }, { output: 'On branch main\nnothing to commit' }),
    tool('m-t3', 'Bash', 'Ran `node scripts/tally.mjs`', { command: 'node scripts/tally.mjs' }, { output: 'continue 12\nGo ahead 9\nTry again 4' }),
    tool('m-t4', 'Read', 'Read screenshots/desktop-layout.png', { file_path: 'D:\\demos\\relay-desk\\screenshots\\desktop-layout.png' }, { images: 2, imageRefs: [{ key: 'mock:image:1', mediaType: 'image/png' }, { key: 'mock:image:0', mediaType: 'image/png' }] }),
    tool('m-t5', 'Bash', 'Ran `npm ls --depth 0`', { command: 'npm ls --depth 0' }, { output: 'relay-desk@0.1.0' }),
    tool('m-t6', 'Grep', 'Searched for "--desktop"', { pattern: '--desktop', path: 'docs' }),
    tool('m-t7', 'Grep', 'Searched for "teleport"', { pattern: 'teleport' }),
    tool('m-t8', 'Glob', 'Found 14 files', { pattern: 'src/**/*.ts' }),
    tool('m-t9', 'Grep', 'Searched for "remote-control"', { pattern: 'remote-control' }),
    tool('m-t10', 'WebFetch', 'Fetched code.claude.com/docs/en/desktop', { url: 'https://code.claude.com/docs/en/desktop', prompt: 'List hand-off commands' }),
    tool('m-t11', 'WebSearch', 'Searched the web for "desktop resume"', { query: 'desktop resume session' }),
    { kind: 'assistant', id: 'm-a2', text: 'Capturing the desktop window as a layout reference; the command count has finished.' },
    tool('m-t12', 'Bash', 'Restored the minimized window', { command: 'powershell -File restore.ps1', description: 'Restore the window' }, { output: 'ok' }),
    tool(
      'm-t13',
      'mcp__computer-use__left_click',
      'Clicked',
      { coordinate: [222, 851], action_summary: 'Restores the desktop window from the taskbar' },
      {
        status: 'error',
        output:
          'The click would land on the desktop shell (taskbar or Start menu). These can launch applications outside the allowlist. Request access for "File Explorer" first; that single grant covers all of them.',
      },
    ),
    tool('m-t14', 'mcp__computer-use__screenshot', 'Captured screen', { save_to_disk: true }, { images: 1, imageRefs: [{ key: 'mock:image:1', mediaType: 'image/png' }] }),
    {
      kind: 'assistant',
      id: 'm-a3',
      text: 'The screenshot cannot capture the desktop window, because the desktop hides its own window while the screenshot is taken. I followed the existing desktop style instead; please compare it yourself during acceptance. Next I will check the current SDK version and whether the desktop writes its conversation titles to the transcript.',
    },
    tool('m-t15', 'Bash', 'Checked transcript title entries and SDK version', {
      command: 'node -e "console.log(require(\'@anthropic-ai/claude-agent-sdk/package.json\').version)"',
    }, { output: '0.3.302' }),
    tool('m-t16', 'TodoWrite', 'Updated the plan', { todos: TODOS }),
    { kind: 'user', id: 'm-u2', text: 'continue', images: 2, imageRefs: [{ key: 'mock:image:1', mediaType: 'image/png' }, { key: 'mock:image:evicted', mediaType: 'image/png' }] },
  ],
  [TASK_SESSION_ID]: [
    { kind: 'user', id: 'k-u1', text: 'Is there anything I should test? List it; I will send you screenshots after testing and we can review them together.' },
    {
      kind: 'assistant',
      id: 'k-a1',
      text: [
        'These items need a manual check:',
        '',
        '| Item | How | Status |',
        '| --- | --- | --- |',
        '| Take over and hand back | Press “Continue in Relay Desk” in the desktop | To test |',
        '| Account sign-in | Finish `claude auth login` in its console window | To test |',
        '',
        'Run the unit tests:',
        '',
        '```powershell',
        'npx vitest run tests/renderer',
        '```',
        '',
        '- [x] Type check',
        '- [ ] Compare screenshots on a real machine',
      ].join('\n'),
    },
    tool(
      'k-t1',
      'Edit',
      'Edited src/renderer/App.tsx (+3 −1)',
      {
        file_path: 'D:\\demos\\relay-desk\\src\\renderer\\App.tsx',
        old_string: "import { App } from './App';\nrender(<App />);",
        new_string: "import { App } from './App';\nimport './styles/tokens.css';\nimport './styles/base.css';\nrender(<App controller={controller} />);",
      },
    ),
    tool('k-t2', 'Bash', 'Ran `rm -rf out`', { command: 'rm -rf out' }, { status: 'denied', output: 'The user denied this action.' }),
    { kind: 'system', id: 'k-s1', text: 'Conversation compacted', level: 'info' },
    { kind: 'result', id: 'k-r1', isError: true, text: 'API Error: 529 overloaded. Try again in a moment.' },
  ],
  [CLI_SESSION_ID]: [
    { kind: 'user', id: 'u1', text: 'Set up the project skeleton for me' },
    { kind: 'assistant', id: 'a1', text: 'OK, I will create `package.json` and the config files first.' },
    tool('t1', 'Bash', 'Ran `npm install`', { command: 'npm install' }, { output: 'added 599 packages' }),
    { kind: 'result', id: 'r1', durationMs: 42_000, inputTokens: 1_200, outputTokens: 800 },
  ],
};

/** Saved history pages before the MOCK_HISTORY page of a session, oldest first (work from before a compaction). */
export const MOCK_OLDER_HISTORY: Readonly<Record<string, readonly (readonly TranscriptItem[])[]>> = {
  [MAIN_SESSION_ID]: [
    [
      { kind: 'user', id: 'm0-u1', text: 'First find out how the desktop Code tab continues a session started in the CLI.' },
      { kind: 'assistant', id: 'm0-a1', text: 'OK. I will read the session-resume section of the official docs first, then check where the desktop and the CLI keep their transcripts.' },
      tool('m0-t1', 'WebFetch', 'Fetched code.claude.com/docs/en/desktop', { url: 'https://code.claude.com/docs/en/desktop', prompt: 'How are sessions resumed?' }),
      { kind: 'assistant', id: 'm0-a2', text: 'The desktop and the CLI share the transcripts under `~/.claude/projects`; the same session ID resumes it in either.' },
    ],
    [
      { kind: 'user', id: 'm1-u1', text: 'How are different accounts kept apart?' },
      { kind: 'assistant', id: 'm1-a1', text: 'Each account uses its own configuration folder (`CLAUDE_CONFIG_DIR`); the default account keeps `~/.claude`.' },
      tool('m1-t1', 'Bash', 'Ran `claude auth status`', { command: 'claude auth status' }, { output: 'Logged in as me@example.com' }),
      { kind: 'system', id: 'm1-s1', text: 'Conversation compacted', level: 'info' },
    ],
  ],
};

// The effort notes of the CLI's model catalog, which main adds to the current families.
const EFFORT_DESCRIPTION = 'Higher effort means more thorough responses, but takes longer and uses your limits faster.';
const EFFORT_MAX_TIP = 'May use excessive tokens resulting in long response times and may hit token limits. Use sparingly for the hardest tasks.';
const RECOMMENDED = { message: 'Recommended', tone: 'neutral' } as const;
const OPUS_EFFORT: EffortGuide = {
  description: EFFORT_DESCRIPTION,
  levels: {
    medium: { badge: RECOMMENDED },
    max: { badge: { message: '3.5× or more usage', tone: 'warning' }, tooltip: 'Claude thinks longer with Max effort and can consume 3.5× or more usage than Medium.' },
  },
};
const FABLE_EFFORT: EffortGuide = { description: EFFORT_DESCRIPTION, levels: { high: { badge: RECOMMENDED }, max: { tooltip: EFFORT_MAX_TIP } } };
const MEDIUM_EFFORT: EffortGuide = { description: EFFORT_DESCRIPTION, levels: { medium: { badge: RECOMMENDED }, max: { tooltip: EFFORT_MAX_TIP } } };

/**
 * SDK supportedModels() as a Relay session sees it (user settings loaded, CLI 2.1.302): the current families
 * by alias with the version in the label, then the older models by full id (the desktop's More models).
 */
export const MOCK_MODELS: readonly ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
  { value: 'opus', label: 'Opus 5.5', description: 'For complex work and everyday tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true, effortGuide: OPUS_EFFORT },
  { value: 'fable', label: 'Fable 5.1', description: 'For your toughest challenges', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], effortGuide: FABLE_EFFORT },
  { value: 'sonnet', label: 'Sonnet 5.5', description: 'Most efficient for simpler tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high'], effortGuide: MEDIUM_EFFORT },
  { value: 'haiku', label: 'Haiku 5.5', description: 'Fastest for quick answers', supportsEffort: false, effortGuide: MEDIUM_EFFORT },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', description: 'Fastest for quick answers', supportsEffort: false },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Efficient for routine tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-opus-5', label: 'Opus 5', description: 'Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
  { value: 'claude-fable-5', label: 'Fable 5', description: 'Most capable for your hardest and longest-running tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', description: 'Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Efficient for routine tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
];

/** The same call without settings sources: families only, the version in the description. */
export const MOCK_MODELS_BARE: readonly ModelOption[] = [
  { value: 'default', label: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
  { value: 'opus', label: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true },
  { value: 'claude-fable-5-1[1m]', label: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', label: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', label: 'Haiku', description: 'Haiku 5.5 · Fastest for quick answers', supportsEffort: false },
];

export const MOCK_CONTEXT: ContextUsage = {
  usedTokens: 184_900,
  maxTokens: 850_000,
  percent: 22,
  model: 'opus',
  categories: [
    { name: 'System tools', tokens: 24_400, kind: 'used' },
    { name: 'Messages', tokens: 17_900, kind: 'used' },
    { name: 'MCP tools', tokens: 14_300, kind: 'used' },
    { name: 'System prompt', tokens: 8_500, kind: 'used' },
    { name: 'Memory files', tokens: 7_100, kind: 'used' },
    { name: 'Skills', tokens: 6_500, kind: 'used' },
    { name: 'MCP server instructions', tokens: 2_500, kind: 'used' },
    { name: 'Custom agents', tokens: 550, kind: 'used' },
    { name: 'Since last update', tokens: 103_000, kind: 'used' },
    { name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { name: 'Free space', tokens: 632_100, kind: 'free' },
    { name: 'MCP tools (deferred)', tokens: 64_800, kind: 'deferred' },
    { name: 'System tools (deferred)', tokens: 22_200, kind: 'deferred' },
  ],
};

export const MOCK_COMMANDS: readonly SlashCommandInfo[] = [
  { name: 'schedule', description: 'Create a scheduled task that runs on demand or on an interval.' },
  { name: 'btw', description: 'Ask a side question without interrupting the current task.', argumentHint: '<question>' },
  { name: 'ultrareview', description: 'Run a deep multi-agent review of the current changes.' },
  { name: 'rewind', description: 'Restore the conversation and code to an earlier point.' },
  { name: 'fork', description: 'Fork this conversation into a new session.' },
  { name: 'subtask', description: 'Hand a self-contained task to a subagent.', argumentHint: '<task>' },
  { name: 'mcp', description: 'Manage MCP servers.' },
  { name: 'plugin', description: 'Manage plugins.' },
  { name: 'feedback', description: 'Send feedback about the CLI.' },
  { name: 'model', description: 'Set the model for this session.', argumentHint: '[model]' },
  { name: 'effort', description: 'Set the effort level.', argumentHint: '[level]' },
  { name: 'fast', description: 'Toggle fast mode.' },
  { name: 'plan', description: 'Switch to plan mode.' },
  { name: 'permissions', description: 'View or change tool permission rules.' },
  { name: 'skills', description: 'List available skills.' },
  { name: 'output-style', description: 'Change the output style.' },
  { name: 'compact', description: 'Clear history but keep a summary in context.', argumentHint: '<instructions>' },
  { name: 'context', description: 'Show context usage.' },
  { name: 'goal', description: 'Set a goal for the session.', argumentHint: '<goal>' },
  { name: 'autocompact', description: 'Configure automatic compaction.' },
  { name: 'clear', description: 'Clear the conversation history.' },
  { name: 'review', description: 'Review a pull request.' },
];

export const MOCK_BACKGROUND: readonly BackgroundAgent[] = [
  { id: 'bg-41c2', name: 'nightly-review', cwd: RELAY, state: 'running', startedAt: new Date(NOW - 40 * MIN).toISOString() },
  { id: 'bg-77ad', name: 'dependency audit', cwd: DEMO, state: 'idle', status: 'waiting for input', startedAt: new Date(NOW - 5 * HOUR).toISOString() },
];

export const MOCK_USAGE: Omit<PlanUsage, 'profileId' | 'fetchedAt'> = {
  available: true,
  subscriptionType: 'max',
  windows: [
    { id: 'five_hour', percent: 69, resetsAt: NOW + 3 * HOUR + 29 * MIN },
    { id: 'seven_day', percent: 7, resetsAt: NOW + 4 * DAY + 17 * HOUR },
    { id: 'model_scoped:Fable', percent: 0, resetsAt: NOW + 4 * DAY + 17 * HOUR },
  ],
  extraUsage: { enabled: false, percent: null, usedCredits: null, monthlyLimit: null, currency: null },
};

/** Background tasks derived from history, per session id. */
export const MOCK_TASKS: Readonly<Record<string, BackgroundTask[]>> = {
  [MAIN_SESSION_ID]: [
    { taskId: 'task-a1', kind: 'agent', taskType: 'local_agent', subagentType: 'lean-reviewer', description: 'Review renderer behaviour', status: 'completed', durationMs: 6 * MIN + 17_000, totalTokens: 241_493, toolUses: 46 },
    { taskId: 'task-b2', kind: 'shell', taskType: 'local_bash', description: 'npm run dev', status: 'running' },
    {
      taskId: 'task-w3',
      kind: 'workflow',
      taskType: 'local_workflow',
      workflowName: 'audit-routes',
      description: 'Audit every route handler for missing auth checks',
      status: 'running',
      totalTokens: 512_300,
      toolUses: 88,
      workflow: {
        phases: [
          { index: 1, title: 'Discover', agents: 1, done: 1, failed: 0, running: 0 },
          { index: 2, title: 'Audit', agents: 6, done: 3, failed: 1, running: 2 },
          { index: 3, title: 'Verify', agents: 0, done: 0, failed: 0, running: 0 },
        ],
        agents: [
          { index: 1, label: 'List route files', phaseIndex: 1, state: 'done', agentId: 'a0000000000000001', tokens: 18_200, toolCalls: 4 },
          { index: 2, label: 'src/routes/users.ts', phaseIndex: 2, state: 'done', agentId: 'a0000000000000002', tokens: 41_000, toolCalls: 9 },
          { index: 3, label: 'src/routes/orders.ts', phaseIndex: 2, state: 'done', agentId: 'a0000000000000003', tokens: 38_400, toolCalls: 8 },
          { index: 4, label: 'src/routes/admin.ts', phaseIndex: 2, state: 'failed', agentId: 'a0000000000000004', tokens: 12_100, toolCalls: 3 },
          { index: 5, label: 'src/routes/billing.ts', phaseIndex: 2, state: 'done', agentId: 'a0000000000000005', tokens: 36_900, toolCalls: 7 },
          { index: 6, label: 'src/routes/files.ts', phaseIndex: 2, state: 'running', agentId: 'a0000000000000006', tokens: 9_800, toolCalls: 2, lastTool: 'Read' },
          { index: 7, label: 'src/routes/search.ts', phaseIndex: 2, state: 'running', agentId: 'a0000000000000007', tokens: 4_100, toolCalls: 1, lastTool: 'Grep' },
        ],
      },
    },
  ],
};

/** A subagent's own transcript (sessions.subagent). */
export const MOCK_SUBAGENT_ITEMS: readonly TranscriptItem[] = [
  { kind: 'user', id: 'sub-u1', text: 'Review the renderer for behaviour regressions.' },
  { kind: 'tool', id: 'sub-t1', toolUseId: 'sub-t1', name: 'Read', input: { file_path: 'D:\\demos\\demo-app\\src\\App.tsx' }, summary: 'Read src\\App.tsx', status: 'done' },
  { kind: 'assistant', id: 'sub-a1', text: 'No regressions found in App.tsx.' },
];

/** End of a background command's output file (engine.taskOutput). */
export const MOCK_TASK_OUTPUT = '> demo-app@1.0.0 dev\n> vite\n\n  VITE ready in 412 ms\n  Local:   http://localhost:5173/\n';

/** 1x1 PNG keyed like the engine's image refs. */
export const MOCK_IMAGES: Readonly<Record<string, string>> = {
  'mock:image:0': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  /** Synthetic 192x112 window sketch for thumbnails and the image viewer. */
  'mock:image:1': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMAAAABwBAMAAAC6OGJBAAAAKlBMVEX////8/Pv7+/nw7+zk5OPi4uHh4eDIyMYbrn14eHYqeNbpajXQOzsoKCjnE950AAABnUlEQVR42u1aPU/DMBB9JW0nFjZm9oqg+AcwVx06MWcqKxsZGcvGCj+BLAwVcxe2RIqUPeo/YOE7CmIqTVoTpfG5Tc15ss/SPfnO7z6ctBzoHXtgAAZoPED7WSI8mRECyITfCfvAqFtEqcyyi+uQGMDqhUWBEwJtoDPMydKH+SxYR/fLKQBES9KI2Ae9ZUFmG3KLUl+6I2pou80v3i+YyYpMHlfW4f3OzrdzghyTfaN84NXQdj+fvLkNYPJ/4cHHVX51xlWFGpMX6bg2Dy4X088b9oEykyvURStp+5p5QBqLxO4xWUZnk/NBMREAAOKVjiQiPoEtWVPm5Cx29PZoyELddRF3+rTV9bhSR8A+UB+tI4nweMomakQ+CNZ+Lmpadc11EffJG3wv8jgW6aquuS5iJjOACdU1m4iZTPA1tpAnag2/FKDTv1MFGPmAdSDZOJwBsJ6UzRN3y3zQV7f/11CrkwPNt2hfTPUCTDDY8VAxwIT8t4diYxgIzSYSm4lFfzM5eVVW3k1KT+AqA7ilTk4fR3qjKVEi4qS/fYAf+xxXPGN4v/UAAAAASUVORK5CYII=',
};

/** What a desktop import would bring in (no env values: names only). */
export const MOCK_MCP_ENTRIES: readonly McpServerEntry[] = [
  { name: 'Blender', transport: 'stdio', command: 'uvx', args: ['blender-mcp'], envKeys: [], enabled: true, source: 'desktop', importedAt: NOW - DAY },
  { name: 'Blockbench', transport: 'stdio', command: 'npx', args: ['-y', 'blockbench-mcp'], envKeys: ['BLOCKBENCH_PORT'], enabled: true, source: 'desktop', importedAt: NOW - DAY },
];

export const MOCK_MCP_STATES: readonly McpServerState[] = [
  { name: 'Blender', status: 'connected', toolCount: 17, scope: 'dynamic', relay: true },
  { name: 'Blockbench', status: 'failed', toolCount: 0, scope: 'dynamic', error: 'Connection closed', relay: true },
];
