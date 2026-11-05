import { describe, expect, it } from 'vitest';
import { createImageStore, storeImageBlocks } from '../../src/main/engine/images';

const png = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });

describe('createImageStore', () => {
  it('evicts the least recently used images once the total base64 size passes the limit', () => {
    const store = createImageStore(10);
    store.put('a', 'image/png', 'aaaa');
    store.put('b', 'image/png', 'bbbb');
    expect(store.put('c', 'image/jpeg', 'cccc')).toEqual({ key: 'c', mediaType: 'image/jpeg' });
    expect(store.get('a')).toBeNull();
    expect(store.get('b')).toBe('data:image/png;base64,bbbb');
    expect(store.get('c')).toBe('data:image/jpeg;base64,cccc');
  });

  it('get refreshes recency so a viewed image outlives older unviewed ones', () => {
    const store = createImageStore(8);
    store.put('a', 'image/png', 'aaaa');
    store.put('b', 'image/png', 'bbbb');
    expect(store.get('a')).toBe('data:image/png;base64,aaaa');
    store.put('c', 'image/png', 'cccc');
    expect(store.get('b')).toBeNull();
    expect(store.get('a')).not.toBeNull();
    expect(store.get('c')).not.toBeNull();
  });

  it('replacing a key does not count its old size twice, and an oversized image still stays', () => {
    const store = createImageStore(8);
    store.put('a', 'image/png', 'aaaa');
    store.put('a', 'image/png', 'AAAA');
    store.put('b', 'image/png', 'bbbb');
    expect(store.get('a')).toBe('data:image/png;base64,AAAA');
    expect(store.get('b')).not.toBeNull();
    store.put('big', 'image/png', 'x'.repeat(20));
    expect(store.get('big')).not.toBeNull();
    expect(store.get('a')).toBeNull();
    expect(store.get('missing')).toBeNull();
  });
});

describe('storeImageBlocks', () => {
  it('stores base64 images in order under prefix:n, including images nested in tool_result content', () => {
    const store = createImageStore();
    const refs = storeImageBlocks(
      [
        { type: 'text', text: 'see' },
        png('one'),
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x' }, png('two')] },
        { type: 'tool_result', tool_use_id: 't2', content: 'plain text result' },
      ],
      's1:u1',
      store,
    );
    expect(refs).toEqual([
      { key: 's1:u1:0', mediaType: 'image/png' },
      { key: 's1:u1:1', mediaType: 'image/png' },
    ]);
    expect(store.get('s1:u1:0')).toBe('data:image/png;base64,one');
    expect(store.get('s1:u1:1')).toBe('data:image/png;base64,two');
  });

  it('skips unknown media types, non-base64 sources, empty data and non-array content', () => {
    const store = createImageStore();
    const refs = storeImageBlocks(
      [
        { type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'bmp' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'webp' } },
        null,
      ],
      'p',
      store,
    );
    expect(refs).toEqual([{ key: 'p:0', mediaType: 'image/webp' }]);
    expect(store.get('p:0')).toBe('data:image/webp;base64,webp');
    expect(storeImageBlocks('just text', 'q', store)).toEqual([]);
    expect(store.get('q:0')).toBeNull();
  });
});
