import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_PDF_ATTACHMENT_BYTES } from '@shared/types';
import { formatBytes, mediaTypeOf } from '../../src/renderer/components/prompt/attachmentFiles';
import { renderApp, sidebar, takeOverMain, type Rendered } from './helpers';

const b64 = (text: string): string => btoa(text);

function png(name = 'shot.png', body = 'PNGDATA'): File {
  return new File([body], name, { type: 'image/png' });
}

function clipboard(files: File[], text = '') {
  return {
    clipboardData: {
      files,
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      types: files.length ? ['Files'] : ['text/plain'],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  };
}

function transfer(files: File[]) {
  return { dataTransfer: { files, items: [], types: ['Files'], dropEffect: 'none' } };
}

async function ready(): Promise<Rendered & { handleId: string; box: HTMLTextAreaElement }> {
  const rendered = await renderApp();
  const handleId = await takeOverMain(rendered);
  const box = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
  return { ...rendered, handleId, box };
}

const chips = (): HTMLElement[] => within(screen.getByTestId('prompt-attachments')).getAllByRole('listitem');

afterEach(() => {
  delete window.relayFiles;
});

describe('pasted and dropped media (R4-paste)', () => {
  it('a pasted image becomes a thumbnail chip and Enter sends it with the text, then the chips clear', async () => {
    const { api, box, handleId, user } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    fireEvent.paste(box, clipboard([png()]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    const thumb = screen.getByTestId('prompt-attachments').querySelector('img')!;
    expect(thumb.getAttribute('src')).toBe(`data:image/png;base64,${b64('PNGDATA')}`);
    expect(within(chips()[0]!).getByRole('img', { name: 'shot.png · 7 B' })).toBeInTheDocument();
    await user.type(box, 'look at this{Enter}');
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(handleId, 'look at this', {
        attachments: [{ kind: 'image', mediaType: 'image/png', data: b64('PNGDATA'), name: 'shot.png' }],
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('prompt-attachments')).not.toBeInTheDocument());
  });

  it('a message with only attachments can be sent with Enter and the send button', async () => {
    const { api, box, handleId, user } = await ready();
    const send = vi.spyOn(api.engine, 'send');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.paste(box, clipboard([png()]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    box.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledWith(handleId, '', { attachments: [expect.objectContaining({ kind: 'image' })] }));
    await waitFor(() => expect(screen.queryByTestId('prompt-attachments')).not.toBeInTheDocument());
    fireEvent.paste(box, clipboard([png('second.png')]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  });

  it('attachments stay when the send fails and are not sent twice while a send is in flight', async () => {
    const { api, box, user } = await ready();
    let fail!: (error: Error) => void;
    const send = vi.spyOn(api.engine, 'send').mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    fireEvent.paste(box, clipboard([png()]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.type(box, 'first{Enter}');
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    box.focus();
    await user.keyboard('{Enter}');
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => fail(new Error('pipe closed')));
    expect(within(await screen.findByTestId('inline-error')).getByText('pipe closed')).toHaveClass('rd-errrow__text');
    // No Retry that would resend the text without the files; the user sends again from the box.
    expect(within(screen.getByTestId('inline-error')).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(chips()).toHaveLength(1);
    expect(box).toHaveValue('first');
  });

  it('keeps attachments per view when the user switches views', async () => {
    const rendered = await ready();
    const { box, user, controller } = rendered;
    const mainKey = controller.state.currentKey!;
    fireEvent.paste(box, clipboard([png()]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    await user.click(within(sidebar()).getByRole('button', { name: 'Fix flaky test' }));
    await screen.findByTestId('readonly-note');
    expect(screen.queryByTestId('prompt-attachments')).not.toBeInTheDocument();
    act(() => controller.navigate(mainKey));
    expect(chips()).toHaveLength(1);
  });

  it('a PDF copied in Explorer (no type) becomes a document chip; × removes it from the keyboard', async () => {
    const { box, user } = await ready();
    fireEvent.paste(box, clipboard([new File(['%PDF-1.7'], 'Quarterly report.pdf', { type: '' })]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    const chip = chips()[0]!;
    expect(chip).toHaveAttribute('data-kind', 'pdf');
    expect(chip).toHaveTextContent('Quarterly report.pdf');
    expect(chip).toHaveTextContent('PDF');
    within(chip).getByRole('button', { name: 'Remove Quarterly report.pdf' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('prompt-attachments')).not.toBeInTheDocument();
  });

  it('enforces the size and count limits with an inline message', async () => {
    const { box } = await ready();
    const big = new File([new Uint8Array(MAX_IMAGE_ATTACHMENT_BYTES + 1)], 'huge.png', { type: 'image/png' });
    fireEvent.paste(box, clipboard([big]));
    expect(await screen.findByRole('alert')).toHaveTextContent('“huge.png” was not added: images can be up to 5 MB.');
    expect(screen.queryByTestId('prompt-attachments')).not.toBeInTheDocument();

    const many = Array.from({ length: 11 }, (_, i) => png(`p${i}.png`));
    fireEvent.paste(box, clipboard(many));
    await waitFor(() => expect(chips()).toHaveLength(10));
    expect(screen.getByRole('alert')).toHaveTextContent('A message can carry up to 10 files; the rest were not added.');
    fireEvent.paste(box, clipboard([png('one-more.png')]));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('A message can carry up to 10 files'));
    expect(chips()).toHaveLength(10);
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('an unsupported image type is named in the message', async () => {
    const { box } = await ready();
    fireEvent.paste(box, clipboard([new File(['BM'], 'old.bmp', { type: 'image/bmp' })]));
    expect(await screen.findByRole('alert')).toHaveTextContent('“old.bmp” was not added: only PNG, JPEG, GIF and WebP images and PDF files can be attached.');
  });

  it('plain text pastes as before, also when the clipboard carries a picture of it', async () => {
    const { box } = await ready();
    expect(fireEvent.paste(box, clipboard([], 'just text'))).toBe(true);
    expect(fireEvent.paste(box, clipboard([png('cells.png')], 'A1\tB1'))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('prompt-attachments')).not.toBeInTheDocument();
  });

  it('drops on the prompt box or the transcript attach media and mention other files by path', async () => {
    const { box, controller } = await ready();
    const key = controller.state.currentKey!;
    window.relayFiles = { pathFor: (file: File) => (file.name === 'notes.txt' ? 'D:\\work\\notes "v2".txt' : '') };
    const promptBox = box.closest<HTMLElement>('.rd-prompt__box')!;
    fireEvent.dragOver(promptBox, transfer([png()]));
    expect(promptBox).toHaveAttribute('data-drag', 'true');
    fireEvent.drop(promptBox, transfer([png(), new File(['x'], 'notes.txt', { type: 'text/plain' }), new File(['y'], 'nopath.zip', { type: 'application/zip' })]));
    await waitFor(() => expect(chips()).toHaveLength(1));
    expect(promptBox).not.toHaveAttribute('data-drag');
    expect(controller.state.drafts[key]).toBe('@"D:\\work\\notes \\"v2\\".txt" ');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const transcript = screen.getByTestId('session-pane').firstElementChild as HTMLElement;
    expect(transcript.contains(box)).toBe(false);
    fireEvent.drop(transcript, transfer([new File(['%PDF'], 'spec.pdf', { type: 'application/pdf' })]));
    await waitFor(() => expect(chips()).toHaveLength(2));
  });

  it('without the preload a dropped non-media file is skipped silently', async () => {
    const { box, controller } = await ready();
    fireEvent.drop(box, transfer([new File(['x'], 'notes.txt', { type: 'text/plain' })]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.state.drafts[controller.state.currentKey!] ?? '').toBe('');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('attachment helpers', () => {
  it('detects media by type, then by extension when the type is missing', () => {
    expect(mediaTypeOf({ type: 'image/jpg', name: 'a' })).toBe('image/jpeg');
    expect(mediaTypeOf({ type: 'image/webp', name: 'a' })).toBe('image/webp');
    expect(mediaTypeOf({ type: '', name: 'Scan.PDF' })).toBe('application/pdf');
    expect(mediaTypeOf({ type: '', name: 'photo.jpeg' })).toBe('image/jpeg');
    expect(mediaTypeOf({ type: 'text/plain', name: 'x.png' })).toBeNull();
    expect(mediaTypeOf({ type: '', name: 'README' })).toBeNull();
  });

  it('formats sizes for the chip tooltip and the limits', () => {
    expect(formatBytes(980)).toBe('980 B');
    expect(formatBytes(14 * 1024)).toBe('14 KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB');
    expect(formatBytes(MAX_IMAGE_ATTACHMENT_BYTES)).toBe('5 MB');
    expect(formatBytes(MAX_PDF_ATTACHMENT_BYTES)).toBe('20 MB');
  });
});
