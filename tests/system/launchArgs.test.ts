import { describe, expect, it } from 'vitest';
import { isSessionId, parseArgv, parseProtocolUrl } from '../../src/main/system/launchArgs';
import { isSameOrInside, toLocalAbsolutePath } from '../../src/main/system/paths';

const SID = '7f1c2a9e-0b3d-4c55-9a61-2f0e8d1b6c01';
const EXE = 'C:\\Program Files\\Relay Desk\\Relay Desk.exe';
const enc = encodeURIComponent;

describe('toLocalAbsolutePath', () => {
  it.each([
    ['D:\\demos\\app', 'D:\\demos\\app'],
    ['d:/demos/app/', 'd:\\demos\\app'],
    ['D:\\', 'D:\\'],
    ['C:\\a\\.\\b', 'C:\\a\\b'],
    ['D:\\中文 資料夾\\R&D %x% !y!', 'D:\\中文 資料夾\\R&D %x% !y!'],
  ])('accepts %j', (input, expected) => {
    expect(toLocalAbsolutePath(input)).toBe(expected);
  });

  it.each([
    '\\\\server\\share\\x',
    '//server/share/x',
    '\\\\?\\C:\\x',
    '\\\\.\\pipe\\x',
    'relative\\path',
    '\\rooted',
    'C:relative',
    'C:\\a\\..\\b',
    'C:/a/../../Windows',
    'C:\\a\nb',
    'C:\\a\u0000b',
    'C:\\a\\b:stream',
    'C:\\a|b',
    '',
    'x'.repeat(2000),
  ])('rejects %j', (input) => {
    expect(toLocalAbsolutePath(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(toLocalAbsolutePath(42)).toBeNull();
    expect(toLocalAbsolutePath(null)).toBeNull();
  });

  it('isSameOrInside is case-insensitive and boundary-safe', () => {
    expect(isSameOrInside('C:\\Users\\me\\.CLAUDE\\x', 'C:\\Users\\me\\.claude')).toBe(true);
    expect(isSameOrInside('C:\\Users\\me\\.claude', 'C:\\Users\\me\\.claude\\')).toBe(true);
    expect(isSameOrInside('C:\\Users\\me\\.claude-work', 'C:\\Users\\me\\.claude')).toBe(false);
    expect(isSameOrInside('D:\\x', 'C:\\x')).toBe(false);
  });
});

describe('isSessionId', () => {
  it('accepts UUIDs only', () => {
    expect(isSessionId(SID)).toBe(true);
    expect(isSessionId(SID.toUpperCase())).toBe(true);
    expect(isSessionId(`${SID} `)).toBe(false);
    expect(isSessionId('../../etc')).toBe(false);
    expect(isSessionId(undefined)).toBe(false);
  });
});

describe('parseArgv', () => {
  it('plain start (with Chromium switches and the dev app path) is null', () => {
    expect(parseArgv([EXE])).toBeNull();
    expect(parseArgv(['electron.exe', '.', '--allow-file-access-from-files', '--original-process-start-time=1'])).toBeNull();
  });

  it('--resume <uuid> --cwd <path> [--profile <id>]', () => {
    expect(parseArgv([EXE, '--resume', SID, '--cwd', 'D:\\demos\\app'])).toEqual({
      action: 'resume',
      sessionId: SID,
      cwd: 'D:\\demos\\app',
      profileId: 'default',
    });
    expect(parseArgv(['electron.exe', 'D:\\dev', '--profile=work', `--resume=${SID.toUpperCase()}`, '--cwd=D:/x'])).toEqual({
      action: 'resume',
      sessionId: SID,
      cwd: 'D:\\x',
      profileId: 'work',
    });
    expect(parseArgv([EXE, '--resume', SID])).toEqual({ action: 'resume', sessionId: SID, profileId: 'default' });
  });

  it('--cwd alone or --new is a new session request', () => {
    expect(parseArgv([EXE, '--cwd', 'D:\\demos\\app'])).toEqual({ action: 'new', cwd: 'D:\\demos\\app' });
    expect(parseArgv([EXE, '--new'])).toEqual({ action: 'new' });
  });

  it.each([
    ['bad uuid', ['--resume', 'not-a-uuid', '--cwd', 'D:\\x']],
    ['missing value', ['--resume', '--cwd', 'D:\\x']],
    ['empty value', ['--resume=', '--cwd', 'D:\\x']],
    ['UNC cwd', ['--resume', SID, '--cwd', '\\\\evil\\share']],
    ['dot-dot cwd', ['--resume', SID, '--cwd', 'D:\\demos\\..\\..\\Windows']],
    ['relative cwd', ['--cwd', 'repos']],
    ['control chars', ['--resume', SID, '--cwd', 'D:\\x\r\ny']],
    ['bad profile', ['--resume', SID, '--profile', '../default']],
    ['repeated flag', ['--resume', SID, '--resume', '3b8e5d10-6a2f-4e7c-8d94-71c0a5f2e3b2']],
    ['resume with --new', ['--new', '--resume', SID]],
  ])('rejects %s', (_name, args) => {
    expect(parseArgv([EXE, ...args])).toBeNull();
  });

  it('a relaydesk:// URL in argv wins and is parsed as a URL only', () => {
    expect(parseArgv([EXE, '--resume', SID, `relaydesk://new?cwd=${enc('D:\\a')}`])).toEqual({ action: 'new', cwd: 'D:\\a' });
    expect(parseArgv([EXE, '--cwd', 'D:\\ok', 'relaydesk://evil'])).toBeNull();
  });
});

describe('parseProtocolUrl', () => {
  it('resume with session, cwd and profile', () => {
    expect(parseProtocolUrl(`relaydesk://resume?session=${SID}&cwd=${enc('D:\\中文\\R&D x')}&profile=work`)).toEqual({
      action: 'resume',
      sessionId: SID,
      cwd: 'D:\\中文\\R&D x',
      profileId: 'work',
    });
  });

  it('tolerates a trailing slash, the no-slash form and upper-case action', () => {
    expect(parseProtocolUrl(`relaydesk://resume/?session=${SID}`)).toEqual({ action: 'resume', sessionId: SID, profileId: 'default' });
    expect(parseProtocolUrl(`relaydesk:resume?session=${SID}`)).toEqual({ action: 'resume', sessionId: SID, profileId: 'default' });
    expect(parseProtocolUrl(`RelayDesk://RESUME?session=${SID}`)).toEqual({ action: 'resume', sessionId: SID, profileId: 'default' });
  });

  it('profile-less desktop resume always selects the default account', () => {
    expect(parseProtocolUrl(`relaydesk://resume?session=${SID}&cwd=${enc('D:\\desktop-project')}`)).toEqual({
      action: 'resume', sessionId: SID, cwd: 'D:\\desktop-project', profileId: 'default',
    });
  });

  it('new and open', () => {
    expect(parseProtocolUrl(`relaydesk://new?cwd=${enc('C:\\work')}`)).toEqual({ action: 'new', cwd: 'C:\\work' });
    expect(parseProtocolUrl('relaydesk://new')).toEqual({ action: 'new' });
    expect(parseProtocolUrl('relaydesk://open')).toEqual({ action: 'open' });
  });

  it.each([
    ['unknown action', `relaydesk://delete?session=${SID}`],
    ['extra path', `relaydesk://resume/extra?session=${SID}`],
    ['other scheme', `https://resume?session=${SID}`],
    ['missing session', `relaydesk://resume?cwd=${enc('D:\\a')}`],
    ['bad session', 'relaydesk://resume?session=abc'],
    ['session on new', `relaydesk://new?session=${SID}`],
    ['UNC cwd', `relaydesk://resume?session=${SID}&cwd=${enc('\\\\attacker\\share')}`],
    ['UNC cwd with slashes', `relaydesk://new?cwd=${enc('//attacker/share')}`],
    ['dot-dot cwd', `relaydesk://new?cwd=${enc('C:\\a\\..\\..\\Windows')}`],
    ['encoded control char', `relaydesk://new?cwd=${enc('C:\\a\nb')}`],
    ['raw space', `relaydesk://new?cwd=C:\\a b`],
    ['duplicate cwd', `relaydesk://new?cwd=${enc('C:\\a')}&cwd=${enc('D:\\b')}`],
    ['empty cwd', 'relaydesk://new?cwd='],
    ['credentials', `relaydesk://user:pw@resume?session=${SID}`],
    ['port', `relaydesk://resume:80?session=${SID}`],
    ['bad profile', `relaydesk://resume?session=${SID}&profile=${enc('a b')}`],
    ['too long', `relaydesk://new?cwd=${'a'.repeat(5000)}`],
    ['not a url', 'relaydesk'],
  ])('rejects %s', (_name, url) => {
    expect(parseProtocolUrl(url)).toBeNull();
  });
});
