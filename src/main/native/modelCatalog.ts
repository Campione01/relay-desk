import type { ModelOption } from '@shared/types';
import { NATIVE_SESSION_MODELS } from './sessionSettings';

/**
 * Config enum values that NativeSessionSettings.setModel can apply ('default' and the attested models or aliases),
 * enriched from the already verified adapter registry, not a new native UI observation.
 */
export function nativeModelCatalog(options: readonly unknown[]): ModelOption[] {
  return options.filter((value): value is string => typeof value === 'string').flatMap((value): ModelOption[] => {
    if (value === 'default') return [{ value, label: value, catalogSource: 'native-config' }];
    const known = NATIVE_SESSION_MODELS.find((entry) => entry.alias === value || entry.model === value);
    return known ? [{ value, label: known.display, catalogSource: 'native-config', equivalentValues: [known.alias, known.model] }] : [];
  });
}
