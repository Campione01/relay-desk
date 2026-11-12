import type { ModelOption } from '@shared/types';
import { NATIVE_SESSION_MODELS } from './sessionSettings';

/**
 * Config enum values that NativeSessionSettings.setModel can apply ('default' and the attested models or aliases),
 * enriched from the already verified adapter registry, not a new native UI observation. An alias with more than one
 * attested model (`fable`, 5.2 or 5.1 depending on build and account) names only its family; the session getter says
 * which model it runs.
 */
export function nativeModelCatalog(options: readonly unknown[]): ModelOption[] {
  return options.filter((value): value is string => typeof value === 'string').flatMap((value): ModelOption[] => {
    if (value === 'default') return [{ value, label: value, catalogSource: 'native-config' }];
    const exact = NATIVE_SESSION_MODELS.find((entry) => entry.model === value);
    if (exact) return [{ value, label: exact.display, catalogSource: 'native-config', equivalentValues: [exact.alias, exact.model] }];
    const models = NATIVE_SESSION_MODELS.filter((entry) => entry.alias === value);
    if (!models.length) return [];
    return [{ value, label: models.length === 1 ? models[0].display : models[0].label, catalogSource: 'native-config',
      equivalentValues: [value, ...models.map((entry) => entry.model)] }];
  });
}
