import type { TranscriptItem } from '@shared/types';

/** 'code' rows get the code icon; everything else, shell scripts included, the plain file icon (desktop Outputs card). */
export type OutputKind = 'code' | 'file';

export interface OutputFile {
  /** As written by the newest Write call of that file. */
  path: string;
  name: string;
  kind: OutputKind;
}

const CODE_EXTENSIONS: ReadonlySet<string> = new Set(
  'py js jsx ts tsx mjs cjs java kt go rs rb php c h cc cpp hpp cs swift scala lua r sql html css scss vue svelte dart'.split(' '),
);

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function outputKind(name: string): OutputKind {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'file';
  return CODE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? 'code' : 'file';
}

/** Windows paths: one file whatever the case and slash style. */
function pathKey(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function writtenPath(item: TranscriptItem): string | null {
  if (item.kind !== 'tool' || item.name !== 'Write' || item.status !== 'done') return null;
  const input = item.input && typeof item.input === 'object' ? (item.input as { file_path?: unknown }) : null;
  const path = input?.file_path;
  return typeof path === 'string' && path.trim() !== '' ? path : null;
}

/** Files written by finished Write calls of the view (subagents included), newest first, each file once. */
export function outputsOf(items: readonly TranscriptItem[]): OutputFile[] {
  const seen = new Set<string>();
  const outputs: OutputFile[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const path = writtenPath(items[index]!);
    if (path === null) continue;
    const key = pathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = baseName(path);
    outputs.push({ path, name, kind: outputKind(name) });
  }
  return outputs;
}
