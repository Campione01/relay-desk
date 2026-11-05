import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS,
  type PromptAttachment,
} from '@shared/types';
import { createStore, type Store } from '../../state/store';

/** An attachment waiting in the prompt box of one view. */
export interface DraftAttachment extends PromptAttachment {
  id: string;
  name: string;
  /** Decoded size in bytes. */
  size: number;
}

/** Why a file was not attached; the prompt box turns these into one inline message. */
export type AttachProblem =
  | { kind: 'tooMany'; max: number }
  | { kind: 'tooLarge'; name: string; limit: number; pdf: boolean }
  | { kind: 'unsupported'; name: string }
  | { kind: 'readFailed'; name: string };

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const PDF_TYPE = 'application/pdf';
const BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: PDF_TYPE,
};

/** Supported media type of a file, or null. Explorer copies can come without a type, so the extension decides then. */
export function mediaTypeOf(file: Pick<File, 'type' | 'name'>): string | null {
  const type = file.type.toLowerCase();
  if (type === 'image/jpg') return 'image/jpeg';
  if (IMAGE_TYPES.includes(type) || type === PDF_TYPE) return type;
  if (type && type !== 'application/octet-stream') return null;
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return (ext && BY_EXTENSION[ext]) || null;
}

export function limitFor(mediaType: string): number {
  return mediaType === PDF_TYPE ? MAX_PDF_ATTACHMENT_BYTES : MAX_IMAGE_ATTACHMENT_BYTES;
}

/** "980 B", "14 KB", "2.4 MB", "5 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

/** Files of a paste or drop: the file list, else file items (a pasted screenshot can arrive as an item only). */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files && data.files.length > 0) return Array.from(data.files);
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      if (comma < 0) reject(new Error('unreadable'));
      else resolve(url.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/** `@"path"` mention of a file that is not media, as "Add files" inserts it; '' when the file has no local path. */
export function mentionFor(file: File): string {
  const path = window.relayFiles?.pathFor(file) ?? '';
  return path ? `@"${path.replace(/"/g, '\\"')}"` : '';
}

export interface IngestResult {
  attachments: DraftAttachment[];
  mentions: string[];
  problems: AttachProblem[];
}

let nextId = 0;

/**
 * Splits pasted or dropped files into attachments (read as base64) and @-mentions, enforcing the count and size
 * limits; `room` = how many more attachments the view can take.
 */
export async function ingestFiles(files: readonly File[], room: number): Promise<IngestResult> {
  const problems: AttachProblem[] = [];
  const mentions: string[] = [];
  const accepted: Array<{ file: File; mediaType: string }> = [];
  let tooMany = false;
  for (const file of files) {
    const mediaType = mediaTypeOf(file);
    if (!mediaType) {
      const mention = mentionFor(file);
      if (mention) mentions.push(mention);
      else if (file.type.startsWith('image/')) problems.push({ kind: 'unsupported', name: file.name });
      continue;
    }
    if (file.size > limitFor(mediaType)) {
      problems.push({ kind: 'tooLarge', name: file.name, limit: limitFor(mediaType), pdf: mediaType === PDF_TYPE });
      continue;
    }
    if (accepted.length >= room) {
      tooMany = true;
      continue;
    }
    accepted.push({ file, mediaType });
  }
  if (tooMany) problems.unshift({ kind: 'tooMany', max: MAX_PROMPT_ATTACHMENTS });
  const read = await Promise.all(
    accepted.map(async ({ file, mediaType }): Promise<DraftAttachment | null> => {
      try {
        const data = await readBase64(file);
        nextId += 1;
        return {
          id: `att-${nextId}`,
          kind: mediaType === PDF_TYPE ? 'pdf' : 'image',
          mediaType,
          data,
          name: file.name,
          size: file.size,
        };
      } catch {
        problems.push({ kind: 'readFailed', name: file.name });
        return null;
      }
    }),
  );
  return { attachments: read.filter((a): a is DraftAttachment => a !== null), mentions, problems };
}

/** What crosses IPC on send: the contract shape only. */
export function toPromptAttachment(item: DraftAttachment): PromptAttachment {
  return { kind: item.kind, mediaType: item.mediaType, data: item.data, name: item.name };
}

// ---------------------------------------------------------------- per-view store

export interface AttachmentState {
  /** view key -> attachments waiting in its prompt box (kept when the user switches views). */
  lists: Record<string, DraftAttachment[]>;
  /** view keys with a send in flight (blocks a second send of the same attachments). */
  sending: Record<string, boolean>;
}

const stores = new WeakMap<object, Store<AttachmentState>>();

/** One store per controller, so every app instance (and every test) starts empty. */
export function attachmentStore(owner: object): Store<AttachmentState> {
  let store = stores.get(owner);
  if (!store) {
    store = createStore<AttachmentState>({ lists: {}, sending: {} });
    stores.set(owner, store);
  }
  return store;
}

export const EMPTY_ATTACHMENTS: readonly DraftAttachment[] = [];

export function addAttachments(store: Store<AttachmentState>, key: string, items: readonly DraftAttachment[]): number {
  let dropped = 0;
  store.set((state) => {
    const current = state.lists[key] ?? [];
    const room = Math.max(0, MAX_PROMPT_ATTACHMENTS - current.length);
    dropped = Math.max(0, items.length - room);
    if (room === 0 || items.length === 0) return state;
    return { ...state, lists: { ...state.lists, [key]: [...current, ...items.slice(0, room)] } };
  });
  return dropped;
}

export function removeAttachments(store: Store<AttachmentState>, key: string, ids: readonly string[]): void {
  store.set((state) => {
    const current = state.lists[key];
    if (!current) return state;
    const next = current.filter((item) => !ids.includes(item.id));
    if (next.length === current.length) return state;
    const lists = { ...state.lists };
    if (next.length) lists[key] = next;
    else delete lists[key];
    return { ...state, lists };
  });
}

export function setSending(store: Store<AttachmentState>, key: string, sending: boolean): void {
  store.set((state) => {
    if (Boolean(state.sending[key]) === sending) return state;
    const next = { ...state.sending };
    if (sending) next[key] = true;
    else delete next[key];
    return { ...state, sending: next };
  });
}
