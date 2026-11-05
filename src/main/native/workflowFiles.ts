import { lstat, open, realpath } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { resolve, win32 } from 'node:path';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TranscriptItem } from '@shared/types';
import { MAX_SUBAGENT_MESSAGES } from '../engine/listingOps';
import { isRecord, mapSessionMessages } from '../engine/mapTranscript';
import { imageStore, storeImageBlocks, type ImageStore } from '../engine/images';
import type { NativeWorkflowState } from './workflowParity';

export const MAX_NATIVE_WORKFLOW_FILE_BYTES = 32 * 1024 * 1024;
const MAX_AGENT_CACHE = 8;
const stamp = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
const canonical = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

class UnsafeNativeWorkflowFile extends Error {}
export interface NativeWorkflowFilesOptions {
  assertPath(path: string): void;
  cwd?: string;
  images?: ImageStore;
  maxFileBytes?: number;
}

/** Parent-owned path policy plus handle identity checks; no SDK calls, watcher or timer. */
export function createNativeWorkflowFiles(options: NativeWorkflowFilesOptions) {
  const maxBytes = options.maxFileBytes ?? MAX_NATIVE_WORKFLOW_FILE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid native workflow read limit.');
  let disposed = false;
  let applied = new WeakMap<NativeWorkflowState, Map<string, string>>();
  const agents = new Map<string, { stamp: string; items: TranscriptItem[] }>();

  function boundary(path: string): void {
    try { options.assertPath(path); }
    catch { throw new UnsafeNativeWorkflowFile('Native workflow path is outside the owned session/profile boundary.'); }
  }
  function regular(stat: BigIntStats): void {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new UnsafeNativeWorkflowFile('Native workflow file must be a single-link regular file.');
    if (stat.size > BigInt(maxBytes)) throw new UnsafeNativeWorkflowFile('Native workflow file exceeds the bounded read limit.');
  }
  async function read(path: string, previous?: string): Promise<{ stamp: string; text?: string } | null> {
    boundary(path);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const before = await lstat(path, { bigint: true }); regular(before);
      const physical = await realpath(path); boundary(physical);
      if (canonical(physical) !== canonical(path)) throw new UnsafeNativeWorkflowFile('Native workflow path crosses a symbolic link or junction.');
      const signature = stamp(before);
      if (previous === signature) return { stamp: signature };
      handle = await open(path, 'r');
      const opened = await handle.stat({ bigint: true }); regular(opened);
      if (stamp(opened) !== signature) return null;
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) return null;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true });
      regular(after); regular(current);
      if (stamp(after) !== signature || stamp(current) !== signature) return null;
      const afterPath = await realpath(path); boundary(afterPath);
      if (canonical(afterPath) !== canonical(path)) throw new UnsafeNativeWorkflowFile('Native workflow path changed while reading.');
      return { stamp: signature, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch (error) {
      if (error instanceof UnsafeNativeWorkflowFile) throw error;
      return null;
    } finally { await handle?.close(); }
  }

  async function refresh(state: NativeWorkflowState, taskIds?: ReadonlySet<string>): Promise<boolean> {
    if (disposed) return false;
    let stamps = applied.get(state);
    if (!stamps) { stamps = new Map(); applied.set(state, stamps); }
    let changed = false;
    const activeKeys = new Set<string>();
    for (const source of state.workflowSources()) {
      if (taskIds && (!source.taskId || !taskIds.has(source.taskId))) continue;
      for (const kind of ['metadata', 'journal'] as const) {
        const path = kind === 'metadata' ? source.metadataPath : source.journalPath;
        if (!path) continue;
        const key = JSON.stringify([source.runId, source.taskId, source.toolUseId, kind, path]);
        activeKeys.add(key);
        const value = await read(path, stamps.get(key));
        if (disposed) return changed;
        if (!value || value.text === undefined) continue;
        if (kind === 'metadata') {
          let metadata: unknown;
          try { metadata = JSON.parse(value.text); } catch { continue; }
          changed = state.ingestMetadata(source, metadata) || changed;
        } else changed = state.ingestJournal(source, value.text) || changed;
        stamps.set(key, value.stamp);
      }
    }
    if (!taskIds) for (const key of stamps.keys()) if (!activeKeys.has(key)) stamps.delete(key);
    return changed;
  }

  async function readAgent(state: NativeWorkflowState, agentId: string): Promise<TranscriptItem[] | null> {
    if (disposed) throw new Error('Native workflow reader is closed.');
    const path = state.workflowAgentPath(agentId);
    if (!path) return null;
    const source = state.workflowSources().find((entry) => entry.transcriptDir && win32.normalize(entry.transcriptDir) === win32.dirname(path));
    if (!source?.metadataPath) return null;
    const sessionId = win32.basename(win32.dirname(win32.dirname(source.metadataPath)));
    const prior = agents.get(path), value = await read(path, prior?.stamp);
    if (disposed) throw new Error('Native workflow reader is closed.');
    if (!value || value.text === undefined) {
      if (prior) return structuredClone(prior.items);
      throw new Error('Native workflow transcript is not readable yet.');
    }
    let rows: unknown[];
    try { rows = value.text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)); }
    catch {
      if (prior) return structuredClone(prior.items);
      throw new Error('Native workflow transcript is incomplete.');
    }
    const entries = rows.filter((row): row is Record<string, unknown> => isRecord(row) &&
      ['user', 'assistant', 'attachment'].includes(String(row.type)) && typeof row.uuid === 'string');
    const byId = new Map(entries.map((row) => [row.uuid as string, row]));
    const chain: Record<string, unknown>[] = [], seen = new Set<string>();
    let current = entries.findLast((row) => row.type === 'user' || row.type === 'assistant');
    // Match the saved reader's latest-leaf chain; attachment nodes can connect messages.
    while (current && !seen.has(current.uuid as string)) {
      seen.add(current.uuid as string); chain.push(current);
      current = typeof current.parentUuid === 'string' ? byId.get(current.parentUuid) : undefined;
    }
    const messages: SessionMessage[] = [];
    for (const row of chain.reverse()) {
      if (row.type === 'attachment') continue;
      if (row.agentId !== agentId || row.sessionId !== sessionId || typeof row.uuid !== 'string' ||
        !(isRecord(row.message) || typeof row.message === 'string')) throw new UnsafeNativeWorkflowFile('Native workflow transcript identity does not match its bound agent/session.');
      // A subagent viewed on its own has no parent tool row, as in the existing listing path.
      messages.push({ ...row, parent_tool_use_id: null, session_id: row.sessionId,
        ...(row.isMeta === true ? { is_meta: true } : {}) } as unknown as SessionMessage);
    }
    const items = mapSessionMessages(messages.slice(-MAX_SUBAGENT_MESSAGES), { sessionId, ...(options.cwd ? { cwd: options.cwd } : {}),
      storeImages: (content, keyPrefix) => storeImageBlocks(content, keyPrefix, options.images ?? imageStore) });
    agents.delete(path); agents.set(path, { stamp: value.stamp, items });
    while (agents.size > MAX_AGENT_CACHE) agents.delete(agents.keys().next().value!);
    return structuredClone(items);
  }

  function dispose(): void { disposed = true; agents.clear(); applied = new WeakMap(); }
  return { refresh, readAgent, dispose };
}
