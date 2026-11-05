import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptItem } from '@shared/types';
import { clearImageCache, loadImage } from '../../src/renderer/components/transcript/imageCache';
import { MOCK_IMAGES } from '../../src/renderer/mock/fixtures';
import { renderApp, sidebar } from './helpers';

const SESSION = {
  sessionId: '21111111-2222-4333-8444-555555555555',
  title: 'Image fixture',
  cwd: 'D:\\demos\\fixture',
  lastModified: Date.UTC(2026, 9, 16),
};

const IMG_A = MOCK_IMAGES['mock:image:1']!;
const IMG_B = MOCK_IMAGES['mock:image:0']!;

const ITEMS: TranscriptItem[] = [
  {
    kind: 'user',
    id: 'u1',
    text: 'Look at these',
    imageRefs: [
      { key: 'mock:image:1', mediaType: 'image/png' },
      { key: 'gone:0', mediaType: 'image/png' },
    ],
  },
  { kind: 'assistant', id: 'a1', text: 'Reading them.' },
  {
    kind: 'tool',
    id: 't1',
    toolUseId: 'tu1',
    name: 'Read',
    input: { file_path: 'D:\\shot.png' },
    summary: 'Read shot.png',
    status: 'done',
    imageRefs: [
      { key: 'mock:image:1', mediaType: 'image/png' },
      { key: 'mock:image:0', mediaType: 'image/png' },
    ],
  },
  {
    kind: 'tool',
    id: 't2',
    toolUseId: 'tu2',
    name: 'mcp__computer-use__screenshot',
    input: {},
    summary: 'Captured screen',
    status: 'done',
    images: 1,
  },
];

async function openFixture() {
  const rendered = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: ITEMS } });
  await rendered.user.click(within(sidebar()).getByRole('button', { name: 'Image fixture' }));
  await screen.findByTestId('assistant-message');
  return rendered;
}

function thumbsIn(el: HTMLElement): HTMLElement[] {
  return within(el).queryAllByTestId('image-thumb');
}

beforeEach(() => clearImageCache());

describe('image cache', () => {
  it('asks main once per key and serves later reads from the cache', async () => {
    const image = vi.fn(async () => IMG_A);
    const [first, second] = await Promise.all([loadImage({ image }, 'k1'), loadImage({ image }, 'k1')]);
    expect(first).toBe(IMG_A);
    expect(second).toBe(IMG_A);
    expect(await loadImage({ image }, 'k1')).toBe(IMG_A);
    expect(image).toHaveBeenCalledTimes(1);
  });

  it('does not keep a missing answer and refuses anything but an image data URL', async () => {
    const image = vi.fn<(key: string) => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(IMG_A);
    expect(await loadImage({ image }, 'k2')).toBeNull();
    expect(await loadImage({ image }, 'k2')).toBe(IMG_A);
    const bad = vi.fn(async () => 'javascript:alert(1)');
    expect(await loadImage({ image: bad }, 'k3')).toBeNull();
  });
});

describe('transcript images', () => {
  it('shows real thumbnails on the tool line and under the user message, placeholders when bytes are gone', async () => {
    await openFixture();
    const user = screen.getByTestId('user-message');
    const userThumbs = thumbsIn(user);
    expect(userThumbs).toHaveLength(2);
    await waitFor(() => expect(userThumbs[0]!.querySelector('img')).toHaveAttribute('src', IMG_A));
    await waitFor(() => expect(userThumbs[1]).toHaveAttribute('data-state', 'missing'));
    expect(userThumbs[1]!.querySelector('img')).toBeNull();
    // The bubble comes first, the images under it.
    expect(user.firstElementChild).toHaveClass('rd-user__bubble');

    const line = screen.getByTestId('tool-group').querySelector<HTMLElement>('.rd-tools__line')!;
    const lineThumbs = thumbsIn(line);
    expect(lineThumbs).toHaveLength(2);
    await waitFor(() => expect(lineThumbs[1]!.querySelector('img')).toHaveAttribute('src', IMG_B));
    // A count-only tool keeps a non-interactive placeholder.
    expect(line.querySelectorAll('span.rd-imgthumb[data-state="missing"]')).toHaveLength(1);
  });

  it('opens the viewer at the clicked image of the whole conversation, paged by buttons and arrow keys', async () => {
    const { user } = await openFixture();
    const line = screen.getByTestId('tool-group').querySelector<HTMLElement>('.rd-tools__line')!;
    const thumb = thumbsIn(line)[0]!;
    await user.click(thumb);
    const viewer = await screen.findByRole('dialog', { name: 'Image viewer: Read' });
    expect(viewer).toHaveAttribute('aria-modal', 'true');
    expect(within(viewer).getByText('Read')).toHaveClass('rd-imgview__source');
    // The two pasted images of the user message come first in transcript order.
    expect(within(viewer).getByText('3 of 4')).toBeInTheDocument();
    await waitFor(() => expect(within(viewer).getByRole('img')).toHaveAttribute('src', IMG_A));
    expect(within(viewer).getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(within(viewer).getByRole('button', { name: 'Previous image' })).not.toHaveAttribute('aria-disabled');

    await user.click(within(viewer).getByRole('button', { name: 'Next image' }));
    expect(within(viewer).getByText('4 of 4')).toBeInTheDocument();
    await waitFor(() => expect(within(viewer).getByRole('img')).toHaveAttribute('src', IMG_B));
    expect(within(viewer).getByRole('button', { name: 'Next image' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(viewer).getByRole('button', { name: 'Next image' }));
    expect(within(viewer).getByText('4 of 4')).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}');
    expect(within(viewer).getByText('1 of 4')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Image viewer: Pasted image' })).toBe(viewer);
    expect(within(viewer).getByText('Pasted image')).toHaveClass('rd-imgview__source');
    expect(within(viewer).getByRole('button', { name: 'Previous image' })).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{ArrowLeft}');
    expect(within(viewer).getByText('1 of 4')).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(within(viewer).getByText('2 of 4')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument();
    expect(thumb).toHaveFocus();
  });

  it('pages across tools that hold one image each, also those hidden in a collapsed group, with each source label', async () => {
    const shot = (n: number, name: string, key: string): TranscriptItem => ({
      kind: 'tool',
      id: `s${n}`,
      toolUseId: `su${n}`,
      name,
      input: {},
      summary: `Screenshot ${n}`,
      status: 'done',
      imageRefs: [{ key, mediaType: 'image/png' }],
    });
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'Check the window' },
      shot(1, 'mcp__computer-use__screenshot', 'mock:image:1'),
      shot(2, 'mcp__computer-use__screenshot', 'mock:image:0'),
      shot(3, 'Read', 'mock:image:1'),
      shot(4, 'mcp__Claude_Preview__preview_screenshot', 'mock:image:0'),
      { kind: 'assistant', id: 'a1', text: 'Done.' },
    ];
    const { user } = await renderApp({ sessions: [SESSION], history: { [SESSION.sessionId]: items } });
    await user.click(within(sidebar()).getByRole('button', { name: 'Image fixture' }));
    await screen.findByTestId('assistant-message');
    const line = screen.getByTestId('tool-group').querySelector<HTMLElement>('.rd-tools__line')!;
    // The collapsed line shows three thumbnails; the fourth image is only reachable through the pager.
    expect(thumbsIn(line)).toHaveLength(3);
    await user.click(thumbsIn(line)[1]!);
    const viewer = await screen.findByTestId('image-viewer');
    expect(within(viewer).getByText('2 of 4')).toBeInTheDocument();
    expect(within(viewer).getByText('computer-use · screenshot')).toHaveClass('rd-imgview__source');
    await user.click(within(viewer).getByRole('button', { name: 'Next image' }));
    expect(within(viewer).getByText('3 of 4')).toBeInTheDocument();
    expect(within(viewer).getByText('Read')).toHaveClass('rd-imgview__source');
    await user.keyboard('{ArrowRight}');
    expect(within(viewer).getByText('4 of 4')).toBeInTheDocument();
    expect(within(viewer).getByText('Claude_Preview · preview_screenshot')).toHaveClass('rd-imgview__source');
    await waitFor(() => expect(within(viewer).getByRole('img')).toHaveAttribute('src', IMG_B));
    await user.click(within(viewer).getByRole('button', { name: 'Previous image' }));
    await user.click(within(viewer).getByRole('button', { name: 'Previous image' }));
    await user.click(within(viewer).getByRole('button', { name: 'Previous image' }));
    expect(within(viewer).getByText('1 of 4')).toBeInTheDocument();
    expect(within(viewer).getByRole('button', { name: 'Previous image' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('traps Tab inside the viewer and closes on a backdrop click but not on the image', async () => {
    const { user } = await openFixture();
    const userThumb = thumbsIn(screen.getByTestId('user-message'))[0]!;
    await user.click(userThumb);
    const viewer = await screen.findByRole('dialog', { name: 'Image viewer: Pasted image' });
    const close = within(viewer).getByRole('button', { name: 'Close' });
    const next = within(viewer).getByRole('button', { name: 'Next image' });
    expect(close).toHaveFocus();
    await user.tab();
    expect(within(viewer).getByRole('button', { name: 'Previous image' })).toHaveFocus();
    await user.tab();
    expect(next).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(next).toHaveFocus();

    const img = await within(viewer).findByRole('img');
    fireEvent.mouseDown(img);
    expect(screen.getByTestId('image-viewer')).toBeInTheDocument();
    fireEvent.mouseDown(viewer.querySelector('.rd-imgview__stage')!);
    expect(screen.queryByTestId('image-viewer')).not.toBeInTheDocument();
    expect(userThumb).toHaveFocus();
  });

  it('says so when an image is no longer held by main', async () => {
    const { user } = await openFixture();
    const missing = thumbsIn(screen.getByTestId('user-message'))[1]!;
    await waitFor(() => expect(missing).toHaveAttribute('data-state', 'missing'));
    await user.click(missing);
    const viewer = await screen.findByTestId('image-viewer');
    expect(within(viewer).getByRole('status')).toHaveTextContent('This image is no longer available');
    expect(within(viewer).getByText('2 of 4')).toBeInTheDocument();
  });

  it('fits a decoded image by its natural aspect ratio', async () => {
    const { user } = await openFixture();
    await user.click(thumbsIn(screen.getByTestId('tool-group'))[0]!);
    const img = await within(await screen.findByTestId('image-viewer')).findByRole('img');
    Object.defineProperty(img, 'naturalWidth', { value: 1920 });
    Object.defineProperty(img, 'naturalHeight', { value: 1080 });
    act(() => {
      fireEvent.load(img);
    });
    expect(img).toHaveAttribute('data-fitted', 'true');
    expect(img.style.getPropertyValue('--rd-img-ratio')).toBe(String(1920 / 1080));
  });
});
