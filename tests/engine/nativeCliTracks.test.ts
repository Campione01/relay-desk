import { describe, expect, it } from 'vitest';
import { NATIVE_CLI_BUILDS, NATIVE_CLI_TRACKS, nativeCliBuild, nativeCliTrack } from '../../src/main/native/cliBuilds';
import { NATIVE_UI_PINNED_SHA256 } from '../../src/main/native/controls';

const STABLE = '966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680';
const LATEST = 'b9aa5b08dc2cc46ea77d334dce792d1b8fdbb3a43bb290efdebdc905b1181082';
const SDK_BUNDLED = '3ab075f78998efef8b87f491c2e4a39c309dddf44e51d0103eba4f3713d2a0ae';

describe('official CLI tracks', () => {
  it('admits the stable and the latest build, stable first', () => {
    expect(NATIVE_CLI_BUILDS.map((build) => ({ ...build }))).toEqual([{ version: '2.1.311', sha256: STABLE }, { version: '2.1.318', sha256: LATEST }]);
    expect(NATIVE_CLI_TRACKS).toEqual({ stable: { version: '2.1.311', verification: 'real-account-and-isolated' },
      latest: { version: '2.1.318', verification: 'isolated-only' } });
    expect(NATIVE_CLI_BUILDS[0].version).toBe(NATIVE_CLI_TRACKS.stable.version);
    expect(NATIVE_UI_PINNED_SHA256).toBe(STABLE);
    expect(Object.isFrozen(NATIVE_CLI_TRACKS) && Object.isFrozen(NATIVE_CLI_TRACKS.stable) && Object.isFrozen(NATIVE_CLI_TRACKS.latest)).toBe(true);
  });

  it('names exactly one build per track and a track for every build', () => {
    for (const track of Object.values(NATIVE_CLI_TRACKS)) expect(NATIVE_CLI_BUILDS.filter((build) => build.version === track.version)).toHaveLength(1);
    const versions = new Set(Object.values(NATIVE_CLI_TRACKS).map((track) => track.version));
    for (const build of NATIVE_CLI_BUILDS) expect(versions.has(build.version)).toBe(true);
    expect(new Set(NATIVE_CLI_BUILDS.map((build) => build.sha256)).size).toBe(NATIVE_CLI_BUILDS.length);
  });

  it('maps an installed binary hash to its track, and anything else to unadmitted', () => {
    expect(nativeCliTrack(STABLE)).toBe('stable');
    expect(nativeCliTrack(LATEST)).toBe('latest');
    expect(nativeCliTrack(LATEST.toUpperCase())).toBe('latest');
    for (const value of [SDK_BUNDLED, 'f'.repeat(64), '', undefined, null, 42, { sha256: STABLE }]) expect(nativeCliTrack(value)).toBe('unadmitted');
    expect(nativeCliBuild(LATEST)?.version).toBe('2.1.318');
  });
});
