import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNativeDurableAssets } from '../../src/main/native/durableAssets';

const helper = vi.hoisted(() => ({ commands: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
    const input = (args[2] as { input?: string } | undefined)?.input;
    if (typeof input === 'string') helper.commands.push((JSON.parse(input) as { command: string }).command);
    return actual.spawnSync(...args);
  } };
});

const helperPath = resolve('tools/private-storage/bin/RelayPrivateStorage.exe');
const prototypeRoot = `C:\\RelayDeskNativePrototype\\durable-lazy-tests-${randomBytes(16).toString('hex')}`;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 0]);

describe.skipIf(process.platform !== 'win32')('native durable asset reopen cost', () => {
  beforeAll(() => { expect(existsSync(helperPath)).toBe(true); mkdirSync(prototypeRoot); });
  afterAll(() => {
    if (!existsSync(prototypeRoot)) return;
    expect(lstatSync(prototypeRoot).isSymbolicLink()).toBe(false);
    expect(realpathSync(prototypeRoot).toLowerCase()).toBe(prototypeRoot.toLowerCase());
    expect(prototypeRoot).toMatch(/^C:\\RelayDeskNativePrototype\\durable-lazy-tests-[a-f0-9]{32}$/);
    rmSync(prototypeRoot, { recursive: true, force: true });
  });

  it('reopens a session without a helper call per retained batch and verifies each batch on first use', () => {
    const lease = createNativeDurableAssets({ helperPath, prototypeRoot, profileId: 'lazy' }).openSession({ sessionId: 'many' });
    const files = Array.from({ length: 4 }, () => {
      const launch = lease.storage.createLaunch(); const file = lease.storage.writeBytes(launch, png, 'attachment-1.png');
      lease.retain(launch); lease.storage.removeLaunch(launch); return file;
    });
    lease.close();
    helper.commands.length = 0;
    const reopened = createNativeDurableAssets({ helperPath, prototypeRoot, profileId: 'lazy' })
      .openSession({ sessionId: 'many', resumeSessionId: 'many', requiredPaths: files.map((file) => file.path) });
    expect(helper.commands).toEqual(['ensure-task', 'verify-task', 'read-state']);
    expect(reopened.verifyPath(files[2].path)?.sha256).toBe(files[2].sha256);
    expect(helper.commands.slice(3)).toEqual(['verify-launch']);
    expect(reopened.listReferences().map((item) => item.path)).toEqual(files.map((file) => file.path));
    expect(helper.commands.filter((command) => command === 'verify-launch')).toHaveLength(5);
    reopened.close();
  }, 30_000);
});
