import type { EffortGuide, ModelOption } from '@shared/types';
import type { MessageKey, Translate } from '../i18n';
import { currentModelOption } from './models';

const EXTENDED = '[1m]';

/**
 * What the CLI's model catalog says about the current model's effort levels. A 1M-context id without notes of its own
 * uses its base model's; the CLI default has none unless its own entry carries them.
 */
export function effortGuideFor(model: string | undefined, models: readonly ModelOption[]): EffortGuide | undefined {
  const guide = currentModelOption(model, models)?.effortGuide;
  if (guide || !model?.endsWith(EXTENDED)) return guide;
  const base = model.slice(0, -EXTENDED.length);
  return models.find((option) => (option.value === base || option.equivalentValues?.includes(base)) && option.effortGuide)?.effortGuide;
}

/**
 * The line above the levels: the current model's; for a model without notes (the CLI default, an unlisted id) the one
 * every model with notes shares, since the catalog gives them all the same sentence.
 */
export function effortGuideDescription(guide: EffortGuide | undefined, models: readonly ModelOption[]): string | undefined {
  if (guide) return guide.description;
  const guides = models.flatMap((option) => (option.effortGuide ? [option.effortGuide] : []));
  const shared = guides[0]?.description;
  return shared && guides.every((other) => other.description === shared) ? shared : undefined;
}

/** The catalog's English texts this version knows (CLI model catalog). */
const KNOWN_TEXTS = new Map<string, MessageKey>([
  ['Higher effort means more thorough responses, but takes longer and uses your limits faster.', 'effort.guide.description'],
  ['Recommended', 'effort.guide.recommended'],
  ['May use excessive tokens resulting in long response times and may hit token limits. Use sparingly for the hardest tasks.', 'effort.guide.maxTip'],
]);

/** Known texts whose usage multiple can change between catalog versions. */
const MULTIPLE_TEXTS: ReadonlyArray<readonly [RegExp, MessageKey]> = [
  [/^(\d+(?:\.\d+)?)× or more usage$/, 'effort.guide.usageBadge'],
  [/^Claude thinks longer with Max effort and can consume (\d+(?:\.\d+)?)× or more usage than Medium\.$/, 'effort.guide.maxUsageTip'],
];

/** A catalog text in the UI language; a text the catalog added later is shown as it came. */
export function localizeGuideText(text: string, t: Translate): string {
  const key = KNOWN_TEXTS.get(text);
  if (key) return t(key);
  for (const [pattern, withMultiple] of MULTIPLE_TEXTS) {
    const match = pattern.exec(text);
    if (match) return t(withMultiple, { multiple: match[1]! });
  }
  return text;
}
