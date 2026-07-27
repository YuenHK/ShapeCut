import type {
  AutomaticOutlineResult,
  PublicAutomaticOutlineResult,
} from '../domain/pipeline/automatic-outline-pipeline';

export const INTERNAL_AUTOMATIC_RESULT_CACHE_LIMIT = 4;

function cacheKey(
  result: Pick<PublicAutomaticOutlineResult, 'sourceHash' | 'featureEvidenceFingerprint'>,
): string {
  return `${result.sourceHash}:${result.featureEvidenceFingerprint}`;
}

/** Worker-local cache; it is deliberately absent from GeometryApi. */
export class InternalAutomaticResultCache {
  readonly #entries = new Map<string, AutomaticOutlineResult>();

  constructor(
    readonly maximumEntries = INTERNAL_AUTOMATIC_RESULT_CACHE_LIMIT,
  ) {
    if (!Number.isSafeInteger(maximumEntries)
      || maximumEntries < 1
      || maximumEntries > INTERNAL_AUTOMATIC_RESULT_CACHE_LIMIT) {
      throw new RangeError('Internal automatic result cache requires a 1 to 4 entry bound');
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  store(result: AutomaticOutlineResult): void {
    if (!result.internalValidationEvidence) {
      throw new RangeError('Internal automatic result cache requires validation evidence');
    }
    const key = cacheKey(result);
    this.#entries.delete(key);
    this.#entries.set(key, result);
    while (this.#entries.size > this.maximumEntries) {
      this.#entries.delete(this.#entries.keys().next().value!);
    }
  }

  resolve(result: PublicAutomaticOutlineResult): AutomaticOutlineResult | undefined {
    return this.#entries.get(cacheKey(result));
  }
}
