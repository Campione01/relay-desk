import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/renderer/i18n/en.ts';
import {
  buildResumeUrl,
  encodeStrict,
  isSessionId,
  isWindowsAbsolutePath,
  openerArgv,
} from '../relay-desk-handoff/hooks/relayUrl.ts';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('isSessionId', () => {
  it('accepts a transcript UUID in either case', () => {
    expect(isSessionId(ID)).toBe(true);
    expect(isSessionId(ID.toUpperCase())).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'abc', `${ID}x`, `x${ID}`, ID.replace(/-/g, ''), `${ID}\n`, 'zf8fad5b-d9cb-469f-a165-70867728950e', 42, null]) {
      expect(isSessionId(bad)).toBe(false);
    }
  });
});

describe('isWindowsAbsolutePath', () => {
  it('accepts drive-absolute paths with either separator', () => {
    for (const ok of ['C:\\', 'C:\\Users\\me\\proj', 'd:/demos/relay desk', 'E:\\a&b\\(x)!']) {
      expect(isWindowsAbsolutePath(ok)).toBe(true);
    }
  });

  it('rejects relative, UNC, device, stream, traversal and control-character paths', () => {
    for (const bad of [
      'relative\\path',
      '\\\\server\\share\\x',
      '\\\\?\\C:\\x',
      '//server/share',
      'C:relative',
      'C:\\a\\file.txt:stream',
      'C:\\a\\..\\b',
      'C:\\a\\b\n',
      'C:\\a"b',
      'C:\\a|b',
      'C:\\a?b',
      `C:\\${'x'.repeat(5000)}`,
      '',
      undefined,
    ]) {
      expect(isWindowsAbsolutePath(bad)).toBe(false);
    }
  });
});

describe('encodeStrict', () => {
  it('leaves only unreserved characters and percent escapes', () => {
    const encoded = encodeStrict("C:\\a b&c=d?e#f!'()*\u4e2d");
    expect(encoded).toMatch(/^[A-Za-z0-9\-_.~%]*$/);
    expect(encoded).toBe('C%3A%5Ca%20b%26c%3Dd%3Fe%23f%21%27%28%29%2A%E4%B8%AD');
    expect(decodeURIComponent(encoded)).toBe("C:\\a b&c=d?e#f!'()*\u4e2d");
  });
});

describe('buildResumeUrl', () => {
  it('builds relaydesk://resume with a lower-case id and an encoded cwd', () => {
    expect(buildResumeUrl(ID.toUpperCase(), 'C:\\Users\\me\\a b&c')).toEqual({
      ok: true,
      url: `relaydesk://resume?session=${ID}&cwd=C%3A%5CUsers%5Cme%5Ca%20b%26c`,
    });
  });

  it('round-trips through URLSearchParams', () => {
    const cwd = 'D:\\專案\\x&session=evil';
    const built = buildResumeUrl(ID, cwd);
    if (!built.ok) throw new Error(built.reason);
    const params = new URL(built.url).searchParams;
    expect([...params.keys()]).toEqual(['session', 'cwd']);
    expect(params.get('session')).toBe(ID);
    expect(params.get('cwd')).toBe(cwd);
  });

  it('refuses a bad id or a bad folder with a reason', () => {
    const badId = buildResumeUrl('not-a-uuid', 'C:\\x');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.reason).toMatch(/UUID/);
    const badCwd = buildResumeUrl(ID, '\\\\server\\share');
    expect(badCwd.ok).toBe(false);
    if (!badCwd.ok) expect(badCwd.reason).toMatch(/network paths are not supported/);
  });
});

describe('the mod text', () => {
  const hooks = ['register.tsx', 'relayUrl.ts'].map((name) => readFileSync(new URL(`../relay-desk-handoff/hooks/${name}`, import.meta.url), 'utf8'));

  it('is English and names the hand-back button by its label in the app', () => {
    for (const source of hooks) expect(source).not.toMatch(/[\u3000-\u9fff\uff00-\uffef]/);
    expect(hooks[0]).toContain(`press “${en['handoff.toDesktop']}” in Relay Desk`);
    expect(hooks[0]).toContain("const LABEL = 'Continue in Relay Desk'");
  });
});

describe('openerArgv', () => {
  const url = `relaydesk://resume?session=${ID}&cwd=C%3A%5Cx`;

  it('runs rundll32 from the system root with the URL as one argument', () => {
    expect(openerArgv('C:\\Windows', url)).toEqual(['C:\\Windows\\System32\\rundll32.exe', 'url.dll,FileProtocolHandler', url]);
    expect(openerArgv('C:\\Windows\\', url)?.[0]).toBe('C:\\Windows\\System32\\rundll32.exe');
  });

  it('refuses a missing or odd system root and any other scheme', () => {
    expect(openerArgv(undefined, url)).toBeNull();
    expect(openerArgv('/usr', url)).toBeNull();
    expect(openerArgv('\\\\evil\\share', url)).toBeNull();
    expect(openerArgv('C:\\Windows', 'https://example.com')).toBeNull();
  });
});
