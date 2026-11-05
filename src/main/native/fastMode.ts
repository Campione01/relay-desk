import type { NativeFastControl } from '@shared/types';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Only the real native core row establishes availability; no entitlement or model-family inference. */
export function nativeFastControl(rows: unknown): NativeFastControl {
  const matches = Array.isArray(rows) ? rows.filter(row => record(row) && row.key === 'fast') : [];
  const row = matches.length === 1 ? matches[0] : undefined;
  if (!record(row) || row.kind !== 'boolean' || typeof row.value !== 'boolean' || typeof row.isLocked !== 'boolean' ||
    !record(row.provider) || row.provider.plugin !== 'engine' || row.provider.tier !== 'core') return { source: 'native-config', available: false };
  return { source: 'native-config', available: true, requested: row.value, locked: row.isLocked,
    ...(typeof row.label === 'string' && row.label.length ? { label: row.label } : {}),
    // Pinned native tJ requires the requested flag for on/cooldown. True alone proves neither.
    ...(!row.value ? { state: 'off' as const } : {}),
  };
}
