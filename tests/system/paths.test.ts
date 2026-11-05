import { describe, expect, it } from 'vitest';
import { isSameOrInside, toLocalAbsolutePath } from '../../src/main/system/paths';

describe('Windows directory containment', () => {
  it('treats dot-prefixed names as descendants without accepting actual parent traversal or other drives', () => {
    const root = 'C:\\Users\\synthetic\\AppData\\Roaming\\Claude';
    const child = `${root}\\..profile`;
    expect(toLocalAbsolutePath(child)).toBe(child);
    expect(isSameOrInside(child, root)).toBe(true);
    expect(isSameOrInside(`${root}\\..profile\\nested`, root)).toBe(true);
    expect(isSameOrInside(root.toUpperCase(), root)).toBe(true);
    expect(isSameOrInside('C:\\Users\\synthetic\\AppData\\Roaming\\outside', root)).toBe(false);
    expect(isSameOrInside('D:\\Claude', root)).toBe(false);
    expect(isSameOrInside('C:\\Users\\synthetic\\AppData\\Roaming', root)).toBe(false);
  });
});
