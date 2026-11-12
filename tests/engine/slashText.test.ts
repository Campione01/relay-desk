import { describe, expect, it } from 'vitest';
import { startsWithSlash, withoutDriveSlash } from '@shared/slashText';

describe('text-only sends that begin with "/"', () => {
  it.each([
    ['/E:/demo-work/project-a/x/REPORT.md', 'E:/demo-work/project-a/x/REPORT.md'],
    ['/E:\\x\\y.md', 'E:\\x\\y.md'],
    ['/e:/x', 'e:/x'],
    ['   /E:/x', 'E:/x'],
    ['\t/E:/x', 'E:/x'],
    ['\n\r\n/E:/x please read', 'E:/x please read'],
    ['\u3000/C:\\tmp', 'C:\\tmp'],
    ['/E:/x\n/F:/y', 'E:/x\n/F:/y'],
  ])('%j is a drive path and loses its leading blanks and "/"', (text, sent) => {
    expect(withoutDriveSlash(text)).toBe(sent);
    expect(startsWithSlash(withoutDriveSlash(text))).toBe(false);
    expect(withoutDriveSlash(withoutDriveSlash(text))).toBe(sent);
  });

  it.each(['/ hi', '//c', '/交接', '/tmp/x', ' /tmp/x.log', '\n/x.y', '/foo.bar', '/E:', '/E:foo', '/EE:/x', '/1:/x', '/', '/compact', '/compact keep the plan', ' /mcp'])(
    '%j is not a drive path and stays as typed', (text) => {
      expect(withoutDriveSlash(text)).toBe(text);
      expect(startsWithSlash(text)).toBe(true);
    });

  it.each(['E:/x', 'hello /tmp/x', 'see /E:/x', 'a/b', '', '   ', '\\E:/x', '／tmp'])('%j does not begin with "/"', (text) => {
    expect(withoutDriveSlash(text)).toBe(text);
    expect(startsWithSlash(text)).toBe(false);
  });

  it('mirrors the host rule trimStart().startsWith("/") for every blank trimStart removes', () => {
    const blanks = [' ', '\t', '\n', '\r', '\v', '\f', '\u00a0', '\u1680', '\u2000', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'];
    for (const blank of blanks) {
      for (const text of [`${blank}/x`, `${blank}${blank}/x`, `${blank}x`]) {
        expect(startsWithSlash(text)).toBe(text.trimStart().startsWith('/'));
      }
    }
    // Not trimmed by trimStart, so not refused by the host either.
    expect(startsWithSlash('\u200b/x')).toBe(false);
    expect('\u200b/x'.trimStart().startsWith('/')).toBe(false);
  });
});
