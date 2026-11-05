/** "52s", "9m 52s", "1h 4m". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** "550", "37.6k", "103k", "1.2M" (desktop status line and context breakdown style). */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Folder label for a cwd: last path segment, or the drive ("D:") for a drive root. */
export function folderName(cwd: string): string {
  const trimmed = cwd.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return /^[\\/]/.test(cwd) ? '/' : '';
  if (/^[A-Za-z]:$/.test(trimmed)) return trimmed.toUpperCase();
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

/** Keeps both ends of a long path: "D:\\demos\\…\\relay-desk". */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** "max" -> "Max", "team_premium" -> "Team premium". */
export function planLabel(subscriptionType?: string): string | undefined {
  if (!subscriptionType) return undefined;
  const words = subscriptionType.replace(/[_-]+/g, ' ').trim();
  if (!words) return undefined;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : '?';
}

/** Readable message for an error thrown by ipcRenderer.invoke or the mock. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '') || raw;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** file:/// URL for a Windows or POSIX path (folder buttons go through app.openExternal). */
export function fileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const withRoot = /^[A-Za-z]:/.test(normalized) ? `/${normalized}` : normalized;
  return `file://${encodeURI(withRoot).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

export function countLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}
