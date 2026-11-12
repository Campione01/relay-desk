/**
 * Official Claude Code builds whose dialogs, footer and Mod API this Relay build was verified against.
 * Accepting a new build is one entry here, its track below and a passing compatibility run (docs/CLI-TRACKS.md).
 * An unlisted build still runs: Relay's automatic dialog drivers stay off and the CLI's own panels are mirrored.
 */
export interface NativeCliBuild { readonly version: string; readonly sha256: string }

export const NATIVE_CLI_BUILDS: readonly NativeCliBuild[] = Object.freeze([
  Object.freeze({ version: '2.1.311', sha256: '966f4b2ce962298f5dee6a942e8c47c8f97392e69e728e622319a98b259c0680' }),
  Object.freeze({ version: '2.1.322', sha256: '345996b4bdbae21d817f750fae2f34cbf8d81224a5444c78136091d121beb298' }),
]);

/** `builds` other than the default comes only from the fixture admission seam (NativeUiControllerOptions.admittedBuilds). */
export function nativeCliBuild(sha256: unknown, builds: readonly NativeCliBuild[] = NATIVE_CLI_BUILDS): NativeCliBuild | undefined {
  return typeof sha256 === 'string' ? builds.find((build) => build.sha256 === sha256.toLowerCase()) : undefined;
}

/** The official npm dist-tags this source follows. "Nightly" is only a description of latest, not a tag. */
export type NativeCliTrack = 'stable' | 'latest';
export type NativeCliVerification = 'real-account-and-isolated' | 'isolated-only';
export interface NativeCliTrackInfo { readonly version: string; readonly verification: NativeCliVerification }

/** Each track names exactly one entry of NATIVE_CLI_BUILDS; the stable entry stays first. */
export const NATIVE_CLI_TRACKS: Readonly<Record<NativeCliTrack, NativeCliTrackInfo>> = Object.freeze({
  stable: Object.freeze({ version: '2.1.311', verification: 'real-account-and-isolated' }),
  latest: Object.freeze({ version: '2.1.322', verification: 'isolated-only' }),
});

/** The track of an installed binary, by its sha256; when both tracks name one version it is stable. */
export function nativeCliTrack(sha256: unknown): NativeCliTrack | 'unadmitted' {
  const build = nativeCliBuild(sha256);
  if (!build) return 'unadmitted';
  if (build.version === NATIVE_CLI_TRACKS.stable.version) return 'stable';
  return build.version === NATIVE_CLI_TRACKS.latest.version ? 'latest' : 'unadmitted';
}
