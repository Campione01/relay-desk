import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertPrivateStorageRoot, createPrivateStorage } from '../../src/main/native/privateStorage';
import type { PrivateFileInfo } from '../../src/main/native/privateStorage';

const helperPath = resolve('tools/private-storage/bin/RelayPrivateStorage.exe');
const prototypeRoot = `C:\\RelayDeskNativePrototype\\private-storage-tests-${randomBytes(16).toString('hex')}`;
const fixture = { mcpServers: { synthetic: { command: 'not-executed', env: { SYNTHETIC_TOKEN: 'fake-local-only-private-storage-test' } } } };
const psQuote = (text: string) => `'${text.replaceAll("'", "''")}'`;
function powershell(script: string): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  env.PSModulePath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; ${script}`], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    env,
  });
  if (result.error || result.status !== 0) throw new Error(`Bounded synthetic-fixture PowerShell failed: ${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.status}: ${result.stderr.slice(0, 2000)}`);
  return result.stdout.trim();
}
function raw(request: Record<string, unknown>) {
  const result = spawnSync(helperPath, [], { input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, response: JSON.parse(result.stdout) as { ok: boolean; code?: string; result?: unknown } };
}
function rawAsync(request: Record<string, unknown>): Promise<ReturnType<typeof raw>> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(helperPath, [], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic helper fixture timed out.')); }, 15_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; }); child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (status) => {
      clearTimeout(timer);
      try { resolveResult({ status, stdout, stderr, response: JSON.parse(stdout) }); }
      catch { reject(new Error('Synthetic helper fixture returned invalid JSON.')); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
function rawLaunch() {
  const task = raw({ command: 'create-task', prototypeRoot, name: `private-task-${randomBytes(16).toString('hex')}` });
  expect(task.response.ok).toBe(true);
  const launch = raw({ command: 'create-launch', task: task.response.result, name: `launch-${randomBytes(16).toString('hex')}` });
  expect(launch.response.ok).toBe(true);
  return {
    receipt: launch.response.result,
    finish(files: unknown[]) {
      expect(raw({ command: 'remove-launch', launch: launch.response.result, files }).response.ok).toBe(true);
      expect(raw({ command: 'remove-task', task: task.response.result }).response.ok).toBe(true);
    },
  };
}
function storage() { return createPrivateStorage({ helperPath, prototypeRoot }); }
function acl(path: string) {
  return JSON.parse(powershell(`$a=Get-Acl -LiteralPath ${psQuote(path)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); [pscustomobject]@{currentSid=$sid;owner=$a.GetOwner([Security.Principal.SecurityIdentifier]).Value;protected=$a.AreAccessRulesProtected;rules=@($rules | ForEach-Object {[pscustomobject]@{sid=$_.IdentityReference.Value;inherited=$_.IsInherited;rights=[int]$_.FileSystemRights;type=$_.AccessControlType.ToString();inheritance=[int]$_.InheritanceFlags}})} | ConvertTo-Json -Depth 5 -Compress`)) as {
    currentSid: string; owner: string; protected: boolean; rules: { sid: string; inherited: boolean; rights: number; type: string; inheritance: number }[];
  };
}
function assertAcl(path: string, directory: boolean) {
  const result = acl(path);
  expect(result.owner).toBe(result.currentSid);
  expect(result.protected).toBe(true);
  expect(result.rules).toHaveLength(2);
  expect(result.rules.map((rule) => rule.sid).sort()).toEqual([result.currentSid, 'S-1-5-18'].sort());
  for (const rule of result.rules) expect(rule).toMatchObject({ inherited: false, rights: 0x1f01ff, type: 'Allow', inheritance: directory ? 3 : 0 });
}

describe('private-storage lexical boundary', () => {
  it('only admits canonical approved local prototype roots', () => {
    for (const root of ['C:\\RelayDeskNativePrototype', 'C:\\RelayDeskNativePrototype\\gui\\native-123']) expect(() => assertPrivateStorageRoot(root)).not.toThrow();
    for (const root of ['D:\\other app', 'D:\\demos\\relay-desk', 'C:\\RelayDeskNativePrototype-foreign', 'C:\\RelayDeskNativePrototype\\..\\outside', 'C:\\RelayDeskNativePrototype\\x:stream', 'C:\\RelayDeskNativePrototype\\x.', 'C:\\RelayDeskNativePrototype\\x\\', 'C:/RelayDeskNativePrototype', '\\\\?\\C:\\RelayDeskNativePrototype']) expect(() => assertPrivateStorageRoot(root)).toThrow();
  });
});

// Each case starts the real .NET helper several times; under a full parallel run that alone can exceed 5 s.
describe.skipIf(process.platform !== 'win32')('real Windows private-storage gate', { timeout: 30_000 }, () => {
  beforeAll(() => {
    expect(existsSync(helperPath), 'Run tools/private-storage/build-helper.ps1 before this gate.').toBe(true);
    mkdirSync(prototypeRoot);
  });
  afterAll(() => {
    if (!existsSync(prototypeRoot)) return;
    expect(lstatSync(prototypeRoot).isSymbolicLink()).toBe(false);
    expect(realpathSync(prototypeRoot).toLowerCase()).toBe(prototypeRoot.toLowerCase());
    expect(prototypeRoot).toMatch(/^C:\\RelayDeskNativePrototype\\private-storage-tests-[a-f0-9]{32}$/);
    // Every descendant is a synthetic fixture created in this suite; production paths are never cleanup targets.
    powershell(`Remove-Item -LiteralPath ${psQuote(prototypeRoot)} -Recurse -Force`);
    expect(existsSync(prototypeRoot)).toBe(false);
  });

  it('creates protected current-user/SYSTEM-only directories and atomically publishes exact JSON', () => {
    const store = storage();
    const root = store.ensureTaskRoot();
    const launch = store.createLaunch();
    const file = store.writeJson(launch, fixture);
    expect(file.sha256).toBe(createHash('sha256').update(JSON.stringify(fixture)).digest('hex'));
    expect(file.byteLength).toBe(Buffer.byteLength(JSON.stringify(fixture)));
    expect(JSON.parse(readFileSync(file.path, 'utf8'))).toEqual(fixture);
    for (const path of [root.path, launch.path]) assertAcl(path, true);
    assertAcl(file.path, false);
    expect(store.ensureTaskRoot().id).toBe(root.id);
    const checked = store.verify(launch);
    expect(checked.files[0]).toMatchObject({ id: file.id, sha256: file.sha256, protectedDacl: true, inheritedAceCount: 0, linkCount: 1 });
    expect(JSON.stringify(checked)).not.toContain('fake-local-only');
    expect(readdirSync(launch.path)).toEqual(['mcp.json']);
    store.removeLaunch(launch); expect(existsSync(launch.path)).toBe(false);
    store.dispose(); expect(existsSync(root.path)).toBe(false);
  });

  it('uses stdin, no secret argv/output, no shell, windowsHide and bounded invocation', async () => {
    vi.resetModules();
    const task = { task: { path: 'private', id: 'id' }, ancestors: [], prototypeRoot };
    const receipt = { task, launch: { path: 'private-launch', id: 'launch-id' } };
    const content = JSON.stringify(fixture);
    const run = vi.fn((_helper, _args, options) => {
      const request = JSON.parse(options.input);
      const material = request.command === 'write-bytes' ? Buffer.from(request.contentBase64, 'base64') : Buffer.from(content);
      const result = request.command === 'create-task' ? task : request.command === 'create-launch' ? receipt : { sha256: createHash('sha256').update(material).digest('hex'), byteLength: material.byteLength };
      return { status: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' };
    });
    vi.doMock('node:child_process', () => ({ spawnSync: run }));
    try {
      const isolated = await import('../../src/main/native/privateStorage');
      const store = isolated.createPrivateStorage({ helperPath, prototypeRoot });
      const launch = store.createLaunch(); store.writeJson(launch, fixture);
      const [executable, args, options] = run.mock.calls.at(-1)!;
      expect(executable).toBe(helperPath); expect(args).toEqual([]);
      expect(options).toMatchObject({ windowsHide: true, shell: false, timeout: 15_000, maxBuffer: 128 * 1024, cwd: prototypeRoot });
      expect(JSON.parse(options.input)).toMatchObject({ command: 'write-json', content });
      expect(JSON.stringify({ executable, args, ...options, input: undefined })).not.toContain('fake-local-only');
      expect(Object.keys(options.env).sort()).toEqual(['SystemRoot', 'TEMP', 'TMP', 'WINDIR']);
      const binary = Buffer.from('synthetic-private-binary-stdin'); store.writeBytes(launch, binary, 'attachment-1.pdf');
      const [, binaryArgs, binaryOptions] = run.mock.calls.at(-1)!;
      expect(binaryArgs).toEqual([]);
      expect(JSON.parse(binaryOptions.input)).toMatchObject({ command: 'write-bytes', contentBase64: binary.toString('base64') });
      expect(JSON.stringify({ binaryArgs, ...binaryOptions, input: undefined })).not.toContain(binary.toString('base64'));
    } finally { vi.doUnmock('node:child_process'); vi.resetModules(); }
  });

  it('creation-time protected DACLs suppress a deliberately broad inheritable parent ACE', () => {
    const broadParent = join(prototypeRoot, 'broad-parent'); mkdirSync(broadParent);
    powershell(`$a=Get-Acl -LiteralPath ${psQuote(broadParent)}; $a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','ContainerInherit,ObjectInherit','None','Allow')); Set-Acl -LiteralPath ${psQuote(broadParent)} -AclObject $a`);
    const store = createPrivateStorage({ helperPath, prototypeRoot: broadParent });
    const root = store.ensureTaskRoot(); const launch = store.createLaunch(); const file = store.writeJson(launch, fixture);
    assertAcl(root.path, true); assertAcl(launch.path, true); assertAcl(file.path, false);
    const collision = raw({ command: 'create-task', prototypeRoot: broadParent, name: root.path.split('\\').at(-1) });
    expect(collision.response).toMatchObject({ ok: false, code: 'already_exists' });
    store.dispose(); rmdirSync(broadParent);
  });

  it('rejects foreign roots in the native helper, before path creation', () => {
    for (const root of ['D:\\other app', 'D:\\demos\\relay-desk', 'C:\\RelayDeskNativePrototype-foreign', `${prototypeRoot}\\..\\foreign`]) {
      const result = raw({ command: 'create-task', prototypeRoot: root, name: `private-task-${'1'.repeat(32)}`, content: 'synthetic-not-returned' });
      expect(result.status).toBe(1); expect(result.response.ok).toBe(false);
      expect(result.stdout).not.toContain('synthetic-not-returned'); expect(result.stderr).toBe('');
    }
  });

  it('does not follow a junction in a configured ancestor', () => {
    const outside = join(prototypeRoot, 'junction-target'); mkdirSync(outside);
    const link = join(prototypeRoot, 'junction-entry'); symlinkSync(outside, link, 'junction');
    try {
      const result = raw({ command: 'create-task', prototypeRoot: link, name: `private-task-${'2'.repeat(32)}` });
      expect(result.response).toMatchObject({ ok: false, code: 'reparse_point' });
      expect(readdirSync(outside)).toEqual([]);
    } finally { unlinkSync(link); rmdirSync(outside); }
  });

  it('refuses broad or inherited ACLs instead of silently repairing an existing object', () => {
    const store = storage(); const launch = store.createLaunch(); const file = store.writeJson(launch, fixture);
    const original = powershell(`(Get-Acl -LiteralPath ${psQuote(file.path)}).Sddl`);
    for (const change of [
      "$a.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'))",
      '$a.SetAccessRuleProtection($false,$true)',
    ]) {
      powershell(`$a=Get-Acl -LiteralPath ${psQuote(file.path)}; ${change}; Set-Acl -LiteralPath ${psQuote(file.path)} -AclObject $a`);
      expect(() => store.verify(launch)).toThrow('private_acl_required');
      powershell(`$a=Get-Acl -LiteralPath ${psQuote(file.path)}; $a.SetSecurityDescriptorSddlForm(${psQuote(original)}); Set-Acl -LiteralPath ${psQuote(file.path)} -AclObject $a`);
    }
    store.dispose();
  });

  it('rejects a foreign private owner even when the two allow ACEs are preserved', () => {
    const store = storage(); const root = store.ensureTaskRoot(); const launch = store.createLaunch();
    const original = powershell(`(Get-Acl -LiteralPath ${psQuote(root.path)}).Sddl`);
    powershell(`$a=Get-Acl -LiteralPath ${psQuote(root.path)}; $a.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')); Set-Acl -LiteralPath ${psQuote(root.path)} -AclObject $a`);
    expect(() => store.verify(launch)).toThrow('foreign_owner');
    powershell(`$a=Get-Acl -LiteralPath ${psQuote(root.path)}; $a.SetSecurityDescriptorSddlForm(${psQuote(original)}); Set-Acl -LiteralPath ${psQuote(root.path)} -AclObject $a`);
    store.dispose();
  });

  it('rejects hard links and refuses to overwrite an existing config or injected junction', () => {
    const store = storage(); const launch = store.createLaunch(); const file = store.writeJson(launch, fixture);
    const hardLink = join(prototypeRoot, 'synthetic-hard-link.json'); linkSync(file.path, hardLink);
    expect(() => store.verify(launch)).toThrow('hard_link'); unlinkSync(hardLink);
    expect(() => store.writeJson(launch, { different: 'synthetic' })).toThrow('already_exists');
    expect(readFileSync(file.path, 'utf8')).toBe(JSON.stringify(fixture));
    expect(readdirSync(launch.path)).toEqual(['mcp.json']);
    const target = join(prototypeRoot, 'publish-target'); mkdirSync(target);
    const junction = join(launch.path, 'blocked.json'); symlinkSync(target, junction, 'junction');
    expect(() => store.writeJson(launch, fixture, 'blocked.json')).toThrow();
    expect(readdirSync(target)).toEqual([]); expect(readdirSync(launch.path).sort()).toEqual(['blocked.json', 'mcp.json']);
    unlinkSync(junction); rmdirSync(target); store.dispose();
  });

  it('rejects same-path file replacement despite matching contents, owner and DACL', () => {
    const store = storage(); const launch = store.createLaunch(); const file = store.writeJson(launch, fixture);
    const parked = join(launch.path, 'parked.json'); renameSync(file.path, parked); copyFileSync(parked, file.path);
    powershell(`Set-Acl -LiteralPath ${psQuote(file.path)} -AclObject (Get-Acl -LiteralPath ${psQuote(parked)})`);
    assertAcl(file.path, false);
    expect(() => store.verify(launch)).toThrow('identity_changed');
    expect(() => store.removeLaunch(launch)).toThrow('identity_changed');
    expect(existsSync(parked)).toBe(true);
    unlinkSync(file.path); renameSync(parked, file.path); store.dispose();
  });

  it('rejects replaced private roots and launch junctions without touching the substitute', () => {
    const store = storage(); const root = store.ensureTaskRoot(); const launch = store.createLaunch();
    const parked = `${root.path}-parked`; renameSync(root.path, parked); mkdirSync(root.path);
    powershell(`Set-Acl -LiteralPath ${psQuote(root.path)} -AclObject (Get-Acl -LiteralPath ${psQuote(parked)})`);
    expect(() => store.ensureTaskRoot()).toThrow('identity_changed'); expect(readdirSync(root.path)).toEqual([]);
    rmdirSync(root.path); renameSync(parked, root.path);
    const parkedLaunch = `${launch.path}-parked`; renameSync(launch.path, parkedLaunch); symlinkSync(parkedLaunch, launch.path, 'junction');
    expect(() => store.writeJson(launch, fixture)).toThrow('reparse_point'); expect(readdirSync(parkedLaunch)).toEqual([]);
    unlinkSync(launch.path); renameSync(parkedLaunch, launch.path); store.dispose();
  });

  it('fails closed on content tampering, unexpected children and foreign handles', () => {
    const store = storage(); const launch = store.createLaunch(); const file = store.writeJson(launch, fixture);
    writeFileSync(file.path, JSON.stringify({ synthetic: 'tampered' }));
    expect(() => store.verify(launch)).toThrow('content_changed');
    writeFileSync(file.path, JSON.stringify(fixture));
    const injected = join(launch.path, 'unexpected.txt'); writeFileSync(injected, 'synthetic-only');
    expect(() => store.removeLaunch(launch)).toThrow('unexpected_children'); expect(existsSync(file.path)).toBe(true);
    unlinkSync(injected);
    expect(() => store.writeJson({ ...launch }, fixture)).toThrow('not owned');
    for (const name of ['../escape.json', 'a.json:stream', 'a.json.', 'NUL.json', 'nul.json', 'com1.json']) expect(() => store.writeJson(launch, fixture, name)).toThrow();
    expect(() => store.writeJson(launch, { value: 'x'.repeat(1024 * 1024) }, 'large.json')).toThrow('1 MiB');
    store.dispose();
  });

  it('publishes exact attachment byte views with protected ACLs and preserves the JSON API', () => {
    const store = storage(); const root = store.ensureTaskRoot(); const launch = store.createLaunch();
    const whole = Uint8Array.from([91, 0, 255, 13, 10, 128, 0, 92]);
    const selected = whole.subarray(1, whole.length - 1);
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf']) {
      const file = store.writeBytes(launch, selected, `attachment-${extension}.${extension}`);
      expect(readFileSync(file.path)).toEqual(Buffer.from(selected));
      expect(file).toMatchObject({ byteLength: selected.byteLength, sha256: createHash('sha256').update(selected).digest('hex'), protectedDacl: true, inheritedAceCount: 0, linkCount: 1 });
      if (extension === 'png' || extension === 'pdf') assertAcl(file.path, false);
    }
    const json = store.writeJson(launch, fixture);
    expect(JSON.parse(readFileSync(json.path, 'utf8'))).toEqual(fixture);
    expect(store.verify(launch).files).toHaveLength(7);
    expect(() => store.writeBytes(launch, selected, 'attachment-png.png')).toThrow('already_exists');
    expect(readdirSync(launch.path)).not.toContain('private-operation.lock');
    for (const name of ['../escape.png', 'attachment.exe', 'attachment.PNG', 'attachment.pdf:stream', 'nul.png', 'bad\nname.pdf', 'bad name.png']) expect(() => store.writeBytes(launch, selected, name)).toThrow();
    store.dispose(); expect(existsSync(root.path)).toBe(false);
  });

  it('enforces image/PDF and message-count limits without consuming budget on a refusal', () => {
    const store = storage(); const launch = store.createLaunch();
    expect(() => store.writeBytes(launch, new Uint8Array(5 * 1024 * 1024 + 1), 'image.png')).toThrow('5 MiB');
    expect(() => store.writeBytes(launch, new Uint8Array(20 * 1024 * 1024 + 1), 'document.pdf')).toThrow('20 MiB');
    for (let index = 0; index < 10; index++) store.writeBytes(launch, Uint8Array.of(index), `attachment-${index}.gif`);
    expect(() => store.writeBytes(launch, Uint8Array.of(10), 'eleventh.gif')).toThrow('count exceeds 10');
    store.writeJson(launch, fixture);
    expect(store.verify(launch).files).toHaveLength(11);
    const nextMessage = store.createLaunch(); store.writeBytes(nextMessage, Uint8Array.of(11), 'attachment-1.png');
    expect(store.verify(nextMessage).files).toHaveLength(1);
    store.removeLaunch(launch); expect(existsSync(nextMessage.path)).toBe(true);
    store.dispose();
  });

  it('accepts exactly 20 MiB of PDF bytes with a separate 1 MiB JSON budget', () => {
    const store = storage(); const launch = store.createLaunch();
    const bytes = Buffer.alloc(20 * 1024 * 1024, 0xa7);
    const file = store.writeBytes(launch, bytes, 'document.pdf');
    expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readFileSync(file.path).equals(bytes)).toBe(true);
    assertAcl(file.path, false);
    const json = store.writeJson(launch, 'j'.repeat(1024 * 1024 - 2)); expect(json.byteLength).toBe(1024 * 1024);
    expect(() => store.writeBytes(launch, Uint8Array.of(1), 'one-more.png')).toThrow('cumulative 20 MiB');
    expect(store.verify(launch).files).toHaveLength(2);
    store.dispose(); expect(existsSync(launch.path)).toBe(false);
  }, 30_000);

  it('native binary requests independently reject oversized files, invalid base64 and unsupported extensions', () => {
    const fixtureLaunch = rawLaunch();
    for (const [name, size] of [['oversized.png', 5 * 1024 * 1024 + 1], ['oversized.pdf', 20 * 1024 * 1024 + 1]] as const) {
      const result = raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name, contentBase64: Buffer.alloc(size, 4).toString('base64') });
      expect(result.response).toMatchObject({ ok: false, code: 'content_too_large' }); expect(result.stderr).toBe('');
    }
    for (const [name, contentBase64] of [['invalid.pdf', '%%%synthetic-only%%%'], ['spaced.pdf', 'AQ==\n'], ['unsupported.exe', 'AQ==']]) {
      const result = raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name, contentBase64 });
      expect(result.response.ok).toBe(false); expect(result.stdout).not.toContain('synthetic-only');
    }
    const oversizedFrame = raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: 'frame.pdf', contentBase64: 'A'.repeat(28 * 1024 * 1024) });
    expect(oversizedFrame.response).toMatchObject({ ok: false, code: 'request_too_large' });
    fixtureLaunch.finish([]);
  }, 30_000);

  it('native counts and actual sizes cannot be bypassed by omitting caller-side budget state', () => {
    const fixtureLaunch = rawLaunch(); const files: unknown[] = [];
    for (let index = 0; index < 10; index++) {
      const result = raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: `attachment-${index}.png`, contentBase64: 'AQ==' });
      expect(result.response.ok).toBe(true); files.push(result.response.result);
    }
    expect(raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: 'eleventh.png', contentBase64: 'AQ==' }).response).toMatchObject({ ok: false, code: 'attachment_count_limit' });
    fixtureLaunch.finish(files);
  });

  it('serializes concurrent native writers so their combined bytes cannot exceed 20 MiB', async () => {
    const fixtureLaunch = rawLaunch();
    const seeded = raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: 'seed.pdf', contentBase64: Buffer.alloc(10 * 1024 * 1024, 3).toString('base64') });
    expect(seeded.response.ok).toBe(true);
    const files = [seeded.response.result]; const contentBase64 = Buffer.alloc(6 * 1024 * 1024, 9).toString('base64');
    const first = rawAsync({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: 'first.pdf', contentBase64 });
    const second = rawAsync({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: 'second.pdf', contentBase64 });
    const results = [await first, await second];
    const succeeded = results.filter((result) => result.response.ok); expect(succeeded).toHaveLength(1);
    for (const result of succeeded) files.push(result.response.result);
    const refused = results.find((result) => !result.response.ok)!;
    expect(['attachment_total_limit', 'already_exists', 'native_open_c0000056', 'native_open_c0000043']).toContain(refused.response.code);
    expect(raw({ command: 'write-bytes', launch: fixtureLaunch.receipt, name: 'overflow.pdf', contentBase64 }).response).toMatchObject({ ok: false, code: 'attachment_total_limit' });
    expect(raw({ command: 'verify-launch', launch: fixtureLaunch.receipt, files }).response.ok).toBe(true);
    fixtureLaunch.finish(files);
  }, 30_000);

  it('rejects attachment hard links and same-path replacements before cleanup or another write', () => {
    const store = storage(); const launch = store.createLaunch(); const bytes = Uint8Array.of(0, 1, 255, 2);
    const file: PrivateFileInfo = store.writeBytes(launch, bytes, 'attachment.png');
    const hardLink = join(prototypeRoot, 'attachment-link.png'); linkSync(file.path, hardLink);
    expect(() => store.verify(launch)).toThrow('hard_link');
    expect(() => store.writeBytes(launch, bytes, 'another.png')).toThrow('hard_link');
    expect(() => store.removeLaunch(launch)).toThrow('hard_link'); unlinkSync(hardLink);
    const parked = join(launch.path, 'parked.png'); renameSync(file.path, parked); copyFileSync(parked, file.path);
    powershell(`Set-Acl -LiteralPath ${psQuote(file.path)} -AclObject (Get-Acl -LiteralPath ${psQuote(parked)})`);
    expect(() => store.verify(launch)).toThrow('identity_changed'); expect(() => store.removeLaunch(launch)).toThrow('identity_changed');
    unlinkSync(file.path); renameSync(parked, file.path); store.dispose();
  });
});
