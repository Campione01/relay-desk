import type { BackgroundTask, ContextUsage, ImageRef, PlanUsage, TranscriptItem } from '@shared/types';
import {
  applyToolResult, asToolResult, asToolUse, assistantBlockText, classifyUserText, isRecord,
  summarizeTool, toolItemFromUse, type ToolItem,
} from '../engine/mapTranscript';
import { redactSecrets } from '../engine/redaction';
import { storeImageBlocks } from '../engine/images';
import { nativeTurnTokens, nativeUsageObservation } from './usage';

export { isRecord };
export const nativeText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function nativeContext(value: unknown): ContextUsage | null {
  if (!isRecord(value)) return null;
  const context = isRecord(value.context) ? value.context : value;
  const body = isRecord(context.breakdown) ? context.breakdown : context;
  const usedTokens = finite(body.totalTokens) ?? finite(context.tokens);
  const maxTokens = finite(body.maxTokens) ?? finite(context.window);
  if (usedTokens === undefined || maxTokens === undefined || maxTokens <= 0) return null;
  const categories: ContextUsage['categories'] = [];
  for (const row of rows(body.categories)) {
    if (!isRecord(row) || typeof row.name !== 'string' || finite(row.tokens) === undefined) continue;
    if (row.kind !== 'used' && row.kind !== 'free' && row.kind !== 'buffer' && row.kind !== 'deferred') continue;
    categories.push({ name: row.name, tokens: row.tokens as number, kind: row.kind,
      ...(typeof row.color === 'string' ? { color: row.color } : {}) });
  }
  const memoryFiles: NonNullable<ContextUsage['memoryFiles']> = [];
  for (const file of rows(body.memoryFiles)) {
    if (isRecord(file) && typeof file.path === 'string' && typeof file.type === 'string' && finite(file.tokens) !== undefined) {
      memoryFiles.push({ path: file.path, type: file.type, tokens: file.tokens as number });
    }
  }
  return { usedTokens, maxTokens,
    percent: finite(body.percentage) ?? finite(context.percent) ?? Math.round(usedTokens / maxTokens * 100),
    categories, ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(Array.isArray(body.memoryFiles) ? { memoryFiles } : {}) };
}

/** Missing rate-limit readings are unknown, not an API account or a zero reading. */
export function nativePlanUsage(value: unknown, profileId: string, now: number): PlanUsage | null {
  return nativeUsageObservation(value, profileId, now).planUsage ?? null;
}

/** The text command.run answered with, cleaned like a transcript output row; nothing for empty output. */
export function nativeCommandOutput(text: string, id: string): Extract<TranscriptItem, { kind: 'system' }> | undefined {
  const display = classifyUserText(`<local-command-stdout>${text.replace(/<\/?local-command-(?:stdout|stderr)>/g, '')}</local-command-stdout>`);
  return display.kind === 'system' ? { ...display, id, level: display.level ?? 'info' } : undefined;
}

export function nativeAgents(value: unknown): BackgroundTask[] {
  if (!Array.isArray(value)) throw new Error('Native agent.list returned no list.');
  const result: BackgroundTask[] = [];
  const statuses: Record<string, BackgroundTask['status']> = {
    pending: 'pending', running: 'running', waiting: 'paused', idle: 'paused',
    completed: 'completed', failed: 'failed', killed: 'stopped', stopped: 'stopped',
  };
  for (const row of value) {
    if (!isRecord(row) || typeof row.id !== 'string') continue;
    result.push({ taskId: row.id, kind: 'agent', taskType: 'local_agent',
      description: nativeText(row.description) ?? row.id,
      status: statuses[nativeText(row.status) ?? ''] ?? 'unknown',
      ...(typeof row.parentId === 'string' ? { parentTaskId: row.parentId } : {}),
      ...(typeof row.type === 'string' ? { subagentType: row.type } : {}) });
  }
  return result;
}

interface TextStream {
  id: string;
  turnId: string;
  stepId: string;
  index: number;
  kind: 'assistant' | 'thinking';
  text: string;
  claimed: boolean;
  final: boolean;
}
interface SentPrompt { id: string; text: string; emitted: boolean; claimed: boolean; nativeText?: string; images?: number; imageRefs?: ImageRef[] }

function pendingWriteSummary(item: ToolItem): void {
  if (item.name === 'Write') item.summary = item.summary.replace(/^Wrote\b/, 'Write request:');
  if (item.name === 'Edit' || item.name === 'MultiEdit') item.summary = item.summary.replace(/^Edited\b/, 'Edit request:');
}

/** Projects native events into Relay items; it never edits or resubmits native messages. */
export class NativeTranscriptMapper {
  private readonly streams = new Map<string, TextStream>();
  private readonly tools = new Map<string, ToolItem>();
  private readonly toolBlocks = new Map<string, { id: string; json: string }>();
  private readonly appended = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly denied = new Set<string>();
  private readonly sent: SentPrompt[] = [];
  /** Tools known only from streamed chunks: no assistant append has recorded their tool_use yet. */
  private readonly streamTools = new Map<string, { turnId: string; main: boolean }>();
  private command: { emitted: boolean; sendId?: string } | undefined;
  private turnId = 'initial';

  constructor(private readonly emit: (item: TranscriptItem) => void,
    private readonly delta: (id: string, text: string) => void,
    private readonly cwd: string,
    private readonly now: () => number = Date.now,
    private readonly images: { store?: typeof storeImageBlocks; prefix?: () => string } = {}) {}

  beginTurn(id: string): void { this.turnId = id; }
  markDenied(id: string): void { this.denied.add(id); }
  registerSend(id: string, text: string): void { this.sent.push({ id, text, emitted: false, claimed: false }); }
  prepareAttachments(id: string, nativeText: string, images: number, imageRefs: ImageRef[]): void {
    const prompt = this.sent.find((row) => row.id === id && !row.claimed);
    if (!prompt) throw new Error('Native attachment transcript ownership is unavailable.');
    Object.assign(prompt, { nativeText, ...(images ? { images, imageRefs } : {}) });
  }
  acceptSend(id: string, queued: boolean): void {
    const prompt = this.sent.find((row) => row.id === id);
    if (!prompt || prompt.emitted) return;
    prompt.emitted = true;
    this.emit({ kind: 'user', id, text: prompt.text,
      ...(prompt.images ? { images: prompt.images, imageRefs: prompt.imageRefs } : {}), ...(queued ? { queued: true } : {}) });
  }
  rejectSend(id: string): void {
    const index = this.sent.findIndex((row) => row.id === id && !row.emitted);
    if (index >= 0) this.sent.splice(index, 1);
  }
  /** Shows local command output rows until endCommand(); outside a command they come from Relay's own controls. */
  beginCommand(sendId?: string): void { this.command = { emitted: false, ...(sendId ? { sendId } : {}) }; }
  /** Whether the command's own transcript rows showed its output. */
  endCommand(): boolean {
    const emitted = this.command?.emitted ?? false;
    this.command = undefined;
    return emitted;
  }
  step(data: unknown): void {
    if (!isRecord(data) || !isRecord(data.chunk)) return;
    const chunk = data.chunk;
    const turnId = nativeText(data.turnId) ?? this.turnId;
    const stepId = String(data.stepId ?? data.index ?? 0);
    const index = finite(chunk.index) ?? 0;
    const key = `${turnId}:${stepId}:${nativeText(data.agentId) ?? 'main'}:${index}`;
    if (chunk.kind === 'text' || chunk.kind === 'thinking') {
      if (data.agentId || typeof chunk.text !== 'string' || !chunk.text) return;
      const kind = chunk.kind === 'text' ? 'assistant' : 'thinking';
      const streamKey = `${key}:${kind}`;
      let stream = this.streams.get(streamKey);
      if (!stream) {
        stream = { id: `native:${streamKey}`, turnId, stepId, index, kind, text: '', claimed: false, final: false };
        this.streams.set(streamKey, stream);
      }
      if (stream.final) return;
      const first = !stream.text;
      stream.text += chunk.text;
      if (first) this.emit({ kind, id: stream.id, text: stream.text, streaming: true });
      else this.delta(stream.id, chunk.text);
    } else if (chunk.kind === 'tool' && typeof chunk.id === 'string' && typeof chunk.name === 'string') {
      this.toolBlocks.set(key, { id: chunk.id, json: '' });
      if (!this.tools.has(chunk.id)) this.streamTools.set(chunk.id, { turnId, main: !data.agentId });
      this.tool({ id: chunk.id, name: chunk.name, input: {} }, nativeText(data.parentToolUseId));
    } else if (chunk.kind === 'input' && typeof chunk.json === 'string') {
      const block = this.toolBlocks.get(key);
      if (!block) return;
      block.json += chunk.json;
      try {
        const input: unknown = JSON.parse(block.json);
        const tool = this.tools.get(block.id);
        if (tool && tool.status === 'running') this.tool({ id: tool.toolUseId, name: tool.name, input }, tool.parentToolUseId);
      } catch { /* Native arguments are partial JSON until their block ends. */ }
    } else if (chunk.kind === 'stop') {
      for (const stream of this.streams.values()) {
        if (stream.turnId === turnId && stream.stepId === stepId) this.finish(stream);
      }
    }
  }

  tool(use: { id: string; name: string; input: unknown }, parentToolUseId?: string): void {
    const before = this.tools.get(use.id);
    if (before && before.status !== 'running') return;
    const item = toolItemFromUse(use, { cwd: this.cwd, ...(parentToolUseId ? { parentToolUseId } : {}) });
    pendingWriteSummary(item);
    item.startedAt = before?.startedAt ?? this.now();
    this.tools.set(use.id, item);
    this.emit(item);
  }

  append(data: unknown): void {
    if (!isRecord(data) || !isRecord(data.message) || typeof data.uuid !== 'string') return;
    const key = `${nativeText(data.agentId) ?? 'main'}:${data.uuid}`;
    if (this.appended.has(key)) return;
    this.appended.add(key);
    const message = data.message;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : rows(message.content);
    const type = nativeText(message.type) ?? nativeText(message.role);
    if (type === 'system' && message.name === 'local_command' || type === 'user' && data.door === 'command') {
      if (!this.command || data.agentId || message.isMeta) return;
      const display = classifyUserText(blocks.map((block) => isRecord(block) && block.type === 'text' ? nativeText(block.text) ?? '' : '').join('\n'));
      if (display.kind !== 'system') return;
      this.command.emitted = true;
      // Output that comes before command.run answers would otherwise sit above the command's echo for good.
      if (this.command.sendId) this.acceptSend(this.command.sendId, false);
      this.emit({ ...display, id: data.uuid, level: display.level ?? 'info' });
      return;
    }
    if (type === 'system' || data.door === 'compaction') {
      // A compaction row may hold the whole summary; it shows as the one line history gives it.
      const compacted = data.door === 'compaction' || message.name === 'compact_boundary' || message.subtype === 'compact_boundary';
      const text = compacted ? 'Conversation compacted' : blocks.map((block) => isRecord(block) ? nativeText(block.text) ?? '' : '').join('\n');
      if (text.trim()) this.emit({ kind: 'system', id: data.uuid, text, level: 'info' });
      return;
    }
    if (type === 'assistant') {
      blocks.forEach((block, index) => {
        const use = asToolUse(block);
        if (use) { this.streamTools.delete(use.id); this.tool(use, nativeText(data.parentToolUseId)); return; }
        if (data.agentId) return;
        const part = assistantBlockText(block);
        if (!part || !part.text) return;
        const turnId = nativeText(data.turnId) ?? this.turnId;
        // Native append UUIDs differ from stream refs. Match only within this turn and claim once.
        const candidates = [...this.streams.values()].filter((entry) => entry.turnId === turnId &&
          !entry.claimed && entry.kind === part.kind);
        const stream = candidates.find((entry) => part.text === entry.text || part.text.startsWith(entry.text)) ?? candidates[0];
        if (stream) {
          stream.claimed = true;
          stream.final = true;
          stream.text = part.text;
          this.emit({ kind: part.kind, id: stream.id, text: part.text });
        } else {
          this.emit({ kind: part.kind, id: `${data.uuid}:${index}`, text: part.text });
        }
      });
    } else if (type === 'user') {
      const text: string[] = [];
      for (const block of blocks) {
        const result = asToolResult(block);
        if (result) {
          const before = this.tools.get(result.toolUseId);
          if (before) {
            const item = applyToolResult(before, result, { denied: this.denied.has(result.toolUseId) });
            if (result.images > 0) {
              const refs = (this.images.store ?? storeImageBlocks)([block], `${this.images.prefix?.() ?? data.uuid}:${item.id}`);
              if (refs.length) item.imageRefs = refs;
            }
            // The original summary is past tense; do not assert a write before native success.
            item.summary = summarizeTool(item.name, item.input, this.cwd);
            if (item.status !== 'done') pendingWriteSummary(item);
            this.tools.set(result.toolUseId, item);
            this.emit(item);
          }
        } else if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      }
      if (data.agentId || message.isMeta || data.door !== 'prompt' && data.door !== undefined) return;
      const joined = text.join('\n');
      if (!joined.trim()) return;
      const sent = this.sent.find((entry) => !entry.claimed && (entry.text === joined || entry.nativeText === joined));
      if (sent) {
        sent.claimed = true;
        sent.emitted = true;
        this.emit({ kind: 'user', id: sent.id, text: sent.text,
          ...(sent.images ? { images: sent.images, imageRefs: sent.imageRefs } : {}) });
      } else {
        const display = classifyUserText(joined);
        if (display.kind === 'user') this.emit({ ...display, id: data.uuid });
        else if (display.kind === 'system') this.emit({ ...display, id: data.uuid, level: display.level ?? 'info' });
      }
    }
  }

  complete(data: unknown): void {
    if (!isRecord(data) || data.agentId || typeof data.turnId !== 'string' || this.completed.has(data.turnId)) return;
    this.completed.add(data.turnId);
    for (const stream of this.streams.values()) if (stream.turnId === data.turnId) this.finish(stream);
    // Subagent tools may outlive the main turn (background agents); only finalize() settles them.
    this.settleStreamTools((owner) => owner.main && owner.turnId === data.turnId);
    const usage = isRecord(data.usage) ? data.usage : {};
    const isError = data.reason === 'error' || data.reason === 'refusal';
    this.emit({ kind: 'result', id: `native-result:${data.turnId}`,
      ...(finite(data.durationMs) !== undefined ? { durationMs: data.durationMs as number } : {}),
      ...nativeTurnTokens(usage),
      isError, ...(data.reason === 'aborted' || data.isAborted === true ? { text: 'Interrupted' } : {}),
      ...(isError ? { text: redactSecrets(nativeText(data.error) ?? `Native turn ended: ${nativeText(data.reason) ?? 'error'}`) } : {}) });
  }

  finalize(): void {
    for (const stream of this.streams.values()) this.finish(stream);
    this.settleStreamTools(() => true);
  }
  /** A streamed tool_use that never completed (interrupt, retry) has no result to wait for. */
  private settleStreamTools(match: (owner: { turnId: string; main: boolean }) => boolean): void {
    for (const [id, owner] of this.streamTools) {
      if (!match(owner)) continue;
      this.streamTools.delete(id);
      const item = this.tools.get(id);
      if (!item || item.status !== 'running') continue;
      const settled: ToolItem = { ...item, status: 'error', output: 'Interrupted' };
      this.tools.set(id, settled);
      this.emit(settled);
    }
  }
  private finish(stream: TextStream): void {
    if (stream.final) return;
    stream.final = true;
    this.emit({ kind: stream.kind, id: stream.id, text: stream.text });
  }
}
