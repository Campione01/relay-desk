import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_PROMPT_ATTACHMENTS,
  MAX_TOTAL_ATTACHMENT_BYTES,
  type PromptAttachment,
} from '@shared/types';
import { isRecord } from './mapTranscript';

export const MAX_ATTACHMENT_NAME_LENGTH = 200;

type UserContent = SDKUserMessage['message']['content'];
type ContentBlock = Exclude<UserContent, string>[number];

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type ImageMediaType = (typeof IMAGE_TYPES)[number];

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function startsWith(bytes: Buffer, ascii: string, offset = 0): boolean {
  return bytes.length >= offset + ascii.length && bytes.toString('latin1', offset, offset + ascii.length) === ascii;
}

const MAGIC: Record<ImageMediaType | 'application/pdf', (bytes: Buffer) => boolean> = {
  'image/png': (b) => startsWith(b, '\x89PNG\r\n\x1a\n'),
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => startsWith(b, 'GIF87a') || startsWith(b, 'GIF89a'),
  'image/webp': (b) => startsWith(b, 'RIFF') && startsWith(b, 'WEBP', 8),
  'application/pdf': (b) => startsWith(b, '%PDF-'),
};

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Decoded byte count of padded base64 (length a multiple of 4). */
function decodedLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function attachmentOf(value: unknown, label: string): PromptAttachment {
  if (!isRecord(value)) throw new Error(`${label} is not a file.`);
  const { kind, mediaType, data, name } = value;
  if (kind !== 'image' && kind !== 'pdf') throw new Error(`${label} must be an image or a PDF.`);
  if (kind === 'image' ? !IMAGE_TYPES.includes(mediaType as ImageMediaType) : mediaType !== 'application/pdf') {
    throw new Error(kind === 'image' ? `${label} must be a PNG, JPEG, GIF or WebP image.` : `${label} must be a PDF.`);
  }
  const type = mediaType as ImageMediaType | 'application/pdf';
  const limit = kind === 'image' ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_PDF_ATTACHMENT_BYTES;
  const tooLarge = `${label} is larger than ${megabytes(limit)}.`;
  if (typeof data !== 'string') throw new Error(`${label} has no data.`);
  // Cheap bound before any copy: base64 needs 4/3 of the bytes, line breaks add a little.
  if (data.length > Math.ceil(limit / 3) * 4 * 2) throw new Error(tooLarge);
  if (/^data:/i.test(data)) throw new Error(`${label} must be base64 without a data: prefix.`);
  const base64 = data.replace(/[\r\n]/g, '');
  if (!base64 || base64.length % 4 !== 0 || !BASE64.test(base64)) throw new Error(`${label} is not valid base64.`);
  const bytes = decodedLength(base64);
  if (bytes === 0) throw new Error(`${label} is empty.`);
  if (bytes > limit) throw new Error(tooLarge);
  if (!MAGIC[type](Buffer.from(base64.slice(0, 16), 'base64'))) throw new Error(`${label} is not a ${mediaTypeName(type)} file.`);
  let title: string | undefined;
  if (name !== undefined && name !== null) {
    if (typeof name !== 'string' || name.length > MAX_ATTACHMENT_NAME_LENGTH) {
      throw new Error(`${label} needs a name of at most ${MAX_ATTACHMENT_NAME_LENGTH} characters.`);
    }
    if (name.trim()) title = name;
  }
  return { kind, mediaType: type, data: base64, ...(title !== undefined ? { name: title } : {}) };
}

function mediaTypeName(type: ImageMediaType | 'application/pdf'): string {
  return { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'application/pdf': 'PDF' }[type];
}

/**
 * Validates renderer-supplied prompt attachments: count, media type, base64 data (line breaks are dropped),
 * decoded size and magic bytes. Absent means none. Messages never echo the data.
 */
export function parseAttachments(value: unknown): PromptAttachment[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Invalid attachments.');
  if (value.length > MAX_PROMPT_ATTACHMENTS) throw new Error(`At most ${MAX_PROMPT_ATTACHMENTS} files can be attached to one message.`);
  const files = value.map((item, index) => attachmentOf(item, `Attachment ${index + 1}`));
  const total = files.reduce((sum, file) => sum + decodedLength(file.data), 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error(`The attached files together are larger than ${megabytes(MAX_TOTAL_ATTACHMENT_BYTES)}; send them in more than one message.`);
  }
  return files;
}

/** SDK user message content: plain text without attachments, else a text block (when non-empty) and one block per file. */
export function promptContent(text: string, attachments: readonly PromptAttachment[] = []): UserContent {
  if (attachments.length === 0) return text;
  const blocks: ContentBlock[] = text.trim() ? [{ type: 'text', text }] : [];
  for (const file of attachments) {
    if (file.kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: file.mediaType as ImageMediaType, data: file.data } });
    } else {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: file.data },
        ...(file.name ? { title: file.name } : {}),
      });
    }
  }
  return blocks;
}
