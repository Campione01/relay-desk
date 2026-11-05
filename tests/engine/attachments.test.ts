import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENTS, MAX_TOTAL_ATTACHMENT_BYTES, type TranscriptItem } from '@shared/types';
import { MAX_ATTACHMENT_NAME_LENGTH, parseAttachments, promptContent } from '../../src/main/engine/attachments';
import { createMockApi } from '../../src/renderer/mock/api';

const bytes = (head: string | Buffer, size = 32): Buffer => {
  const start = typeof head === 'string' ? Buffer.from(head, 'latin1') : head;
  return Buffer.concat([start, Buffer.alloc(Math.max(0, size - start.length), 7)]);
};
const b64 = (data: Buffer): string => data.toString('base64');

const PNG = b64(bytes('\x89PNG\r\n\x1a\n'));
const JPEG = b64(bytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
const GIF = b64(bytes('GIF89a'));
const WEBP = b64(bytes('RIFF\x10\x00\x00\x00WEBPVP8 '));
const PDF = b64(bytes('%PDF-1.7\n'));

const image = (mediaType: string, data: unknown, extra: Record<string, unknown> = {}) => ({ kind: 'image', mediaType, data, ...extra });
const pdf = (data: string, extra: Record<string, unknown> = {}) => ({ kind: 'pdf', mediaType: 'application/pdf', data, ...extra });

function failure(value: unknown): string {
  try {
    parseAttachments(value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected parseAttachments to reject');
}

describe('parseAttachments', () => {
  it('accepts every supported image type and PDFs, keeping a name and dropping line breaks in the data', () => {
    const wrapped = PDF.replace(/(.{8})/g, '$1\r\n');
    expect(
      parseAttachments([
        image('image/png', PNG),
        image('image/jpeg', JPEG),
        image('image/gif', GIF),
        image('image/webp', WEBP, { name: 'shot.webp' }),
        pdf(wrapped, { name: 'spec.pdf' }),
        pdf(PDF, { name: '   ' }),
        pdf(PDF, { name: null }),
      ]),
    ).toEqual([
      { kind: 'image', mediaType: 'image/png', data: PNG },
      { kind: 'image', mediaType: 'image/jpeg', data: JPEG },
      { kind: 'image', mediaType: 'image/gif', data: GIF },
      { kind: 'image', mediaType: 'image/webp', data: WEBP, name: 'shot.webp' },
      { kind: 'pdf', mediaType: 'application/pdf', data: PDF, name: 'spec.pdf' },
      { kind: 'pdf', mediaType: 'application/pdf', data: PDF },
      { kind: 'pdf', mediaType: 'application/pdf', data: PDF },
    ]);
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
    expect(parseAttachments([])).toEqual([]);
  });

  it('copies only the known fields', () => {
    expect(parseAttachments([image('image/png', PNG, { path: 'C:\\secret\\a.png', extra: 1 })])).toEqual([
      { kind: 'image', mediaType: 'image/png', data: PNG },
    ]);
  });

  it('limits the number of files per message', () => {
    const many = Array.from({ length: MAX_PROMPT_ATTACHMENTS }, () => image('image/png', PNG));
    expect(parseAttachments(many)).toHaveLength(MAX_PROMPT_ATTACHMENTS);
    expect(failure([...many, image('image/png', PNG)])).toBe(`At most ${MAX_PROMPT_ATTACHMENTS} files can be attached to one message.`);
    expect(failure({ 0: image('image/png', PNG), length: 1 })).toBe('Invalid attachments.');
  });

  it('rejects unknown kinds and media types that do not match the kind', () => {
    expect(failure([null])).toBe('Attachment 1 is not a file.');
    expect(failure([{ kind: 'video', mediaType: 'video/mp4', data: PNG }])).toBe('Attachment 1 must be an image or a PDF.');
    expect(failure([image('image/png', PNG), image('image/svg+xml', PNG)])).toBe('Attachment 2 must be a PNG, JPEG, GIF or WebP image.');
    expect(failure([image('application/pdf', PDF)])).toBe('Attachment 1 must be a PNG, JPEG, GIF or WebP image.');
    expect(failure([{ kind: 'pdf', mediaType: 'image/png', data: PNG }])).toBe('Attachment 1 must be a PDF.');
  });

  it('requires plain, padded base64 without a data: prefix and never echoes the data', () => {
    expect(failure([image('image/png', `data:image/png;base64,${PNG}`)])).toBe('Attachment 1 must be base64 without a data: prefix.');
    expect(failure([image('image/png', PNG.slice(0, -1))])).toBe('Attachment 1 is not valid base64.');
    expect(failure([image('image/png', `${PNG.slice(0, 8)} ${PNG.slice(9)}`)])).toBe('Attachment 1 is not valid base64.');
    expect(failure([image('image/png', `${PNG.slice(0, 8)}\t${PNG.slice(9)}`)])).toBe('Attachment 1 is not valid base64.');
    expect(failure([image('image/png', `${PNG.slice(0, 4)}=${PNG.slice(5)}`)])).toBe('Attachment 1 is not valid base64.');
    expect(failure([image('image/png', `${PNG.slice(0, 4)}-${PNG.slice(5)}`)])).toBe('Attachment 1 is not valid base64.');
    expect(failure([image('image/png', '')])).toBe('Attachment 1 is not valid base64.');
    expect(failure([image('image/png', 42)])).toBe('Attachment 1 has no data.');
    for (const value of [[image('image/png', `${PNG}!`)], [image('image/png', `data:x,${PNG}`)], [image('image/jpeg', PNG)]]) {
      expect(failure(value)).not.toContain(PNG.slice(0, 12));
    }
  });

  it('checks the magic bytes against the media type', () => {
    expect(failure([image('image/jpeg', PNG)])).toBe('Attachment 1 is not a JPEG file.');
    expect(failure([image('image/png', JPEG)])).toBe('Attachment 1 is not a PNG file.');
    expect(failure([image('image/gif', b64(bytes('GIF88a')))])).toBe('Attachment 1 is not a GIF file.');
    expect(failure([image('image/webp', b64(bytes('RIFF\x10\x00\x00\x00WAVEfmt ')))])).toBe('Attachment 1 is not a WebP file.');
    expect(failure([image('image/webp', b64(bytes('WEBP')))])).toBe('Attachment 1 is not a WebP file.');
    expect(failure([pdf(b64(bytes('%PS-Adobe')))])).toBe('Attachment 1 is not a PDF file.');
    expect(failure([pdf(b64(Buffer.from('%PDF')))])).toBe('Attachment 1 is not a PDF file.');
    expect(parseAttachments([image('image/gif', b64(bytes('GIF87a')))])).toHaveLength(1);
  });

  it('enforces the decoded size limits per kind', () => {
    const atImageLimit = b64(bytes('\x89PNG\r\n\x1a\n', MAX_IMAGE_ATTACHMENT_BYTES));
    expect(parseAttachments([image('image/png', atImageLimit)])).toHaveLength(1);
    const overImageLimit = b64(bytes('\x89PNG\r\n\x1a\n', MAX_IMAGE_ATTACHMENT_BYTES + 1));
    expect(failure([image('image/png', overImageLimit)])).toBe('Attachment 1 is larger than 5 MB.');
    // A file that fits the PDF limit is still too large as an image.
    expect(failure([image('image/png', b64(bytes('\x89PNG\r\n\x1a\n', MAX_IMAGE_ATTACHMENT_BYTES * 2)))])).toBe('Attachment 1 is larger than 5 MB.');

    expect(parseAttachments([pdf(b64(bytes('%PDF-1.7\n', MAX_PDF_ATTACHMENT_BYTES)))])).toHaveLength(1);
    expect(failure([pdf(b64(bytes('%PDF-1.7\n', MAX_PDF_ATTACHMENT_BYTES + 1)))])).toBe('Attachment 1 is larger than 20 MB.');
  });

  it('caps all files of one message together, so the request stays under the API limit', () => {
    const fourImages = Array.from({ length: 4 }, () => image('image/png', b64(bytes('\x89PNG\r\n\x1a\n', MAX_IMAGE_ATTACHMENT_BYTES))));
    expect(4 * MAX_IMAGE_ATTACHMENT_BYTES).toBe(MAX_TOTAL_ATTACHMENT_BYTES);
    expect(parseAttachments(fourImages)).toHaveLength(4);
    const twoPdfs = [pdf(b64(bytes('%PDF-1.7\n', 12 * 1024 * 1024))), pdf(b64(bytes('%PDF-1.7\n', 12 * 1024 * 1024)))];
    expect(failure(twoPdfs)).toBe('The attached files together are larger than 20 MB; send them in more than one message.');
  });

  it('accepts names up to the limit only', () => {
    const name = 'n'.repeat(MAX_ATTACHMENT_NAME_LENGTH);
    expect(parseAttachments([pdf(PDF, { name })])[0]?.name).toBe(name);
    expect(failure([pdf(PDF, { name: `${name}x` })])).toBe(`Attachment 1 needs a name of at most ${MAX_ATTACHMENT_NAME_LENGTH} characters.`);
    expect(failure([pdf(PDF, { name: 7 })])).toBe(`Attachment 1 needs a name of at most ${MAX_ATTACHMENT_NAME_LENGTH} characters.`);
  });
});

describe('promptContent', () => {
  it('keeps plain text without attachments', () => {
    expect(promptContent('Hello')).toBe('Hello');
    expect(promptContent('Hello', [])).toBe('Hello');
  });

  it('builds a text block, then one image or document block per file in order', () => {
    const files = parseAttachments([image('image/png', PNG), pdf(PDF, { name: 'spec.pdf' }), image('image/webp', WEBP), pdf(PDF)]);
    expect(promptContent('Look at these', files)).toEqual([
      { type: 'text', text: 'Look at these' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF }, title: 'spec.pdf' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: WEBP } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF } },
    ]);
  });

  it('leaves out the text block when the text is blank', () => {
    const files = parseAttachments([image('image/jpeg', JPEG)]);
    expect(promptContent('  ', files)).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: JPEG } }]);
  });
});

describe('mock engine.send (renderer parity)', () => {
  it('echoes pasted images with refs that sessions.image serves, and rejects an empty message', async () => {
    const api = createMockApi();
    const items: TranscriptItem[] = [];
    const off = api.engine.onEvent((event) => {
      if (event.type === 'item') items.push(event.item);
    });
    const handle = await api.engine.open({ profileId: 'default', cwd: 'D:\demos\demo-app' });
    await expect(api.engine.send(handle.handleId, ' ')).rejects.toThrow('Missing message');
    const files = parseAttachments([image('image/png', PNG), pdf(PDF)]);
    await api.engine.send(handle.handleId, '', { attachments: files });
    await new Promise((resolve) => setTimeout(resolve, 20));
    off();
    const echo = items.find((item) => item.kind === 'user');
    const key = `${handle.sessionId}:${echo?.id}:0`;
    expect(echo).toEqual({ kind: 'user', id: expect.any(String), text: '', images: 1, imageRefs: [{ key, mediaType: 'image/png' }] });
    await expect(api.sessions.image(key)).resolves.toBe(`data:image/png;base64,${PNG}`);
  });
});
