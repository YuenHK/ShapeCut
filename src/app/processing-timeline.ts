import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import type { OutlinePreviewPayload } from '../domain/outline-features/types';

const STAGES: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];
const MINIMUM_STAGE_MS = 1_500;
const MINIMUM_PRESENTATION_MS = 8_000;

export type ProcessingTimeline = {
  readonly advance: (stage: AutomaticOutlineProgressStage, preview?: OutlinePreviewPayload) => void;
  readonly finish: () => Promise<void>;
  readonly cancel: () => void;
};

export type ProcessingTimelineClock<Timer = unknown> = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delay: number) => Timer;
  readonly clearTimeout: (timer: Timer) => void;
  readonly onStage: (stage: AutomaticOutlineProgressStage, preview?: OutlinePreviewPayload) => void;
};

export class ProcessingTimelineCancelledError extends Error {
  readonly name = 'ProcessingTimelineCancelledError';
}

type StageEvent = { readonly stage: AutomaticOutlineProgressStage; readonly preview?: OutlinePreviewPayload };

/**
 * Keeps UI pacing separate from the conversion worker. The worker can report
 * immediately; this timeline is the only place that deliberately delays what
 * the user sees.
 */
export function createProcessingTimeline<Timer>(clock: ProcessingTimelineClock<Timer>): ProcessingTimeline {
  const startedAt = clock.now();
  const queued: StageEvent[] = [];
  let acceptedStage = -1;
  let displayed: StageEvent | undefined;
  let displayedAt = startedAt;
  let timer: Timer | undefined;
  let cancelled = false;
  let finishRequested = false;
  let finishPromise: Promise<void> | undefined;
  let resolveFinish: (() => void) | undefined;
  let rejectFinish: ((error: Error) => void) | undefined;

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clock.clearTimeout(timer);
    timer = undefined;
  };
  const elapsed = (): number => Math.max(0, clock.now() - startedAt);
  const show = (event: StageEvent): void => {
    displayed = event;
    displayedAt = clock.now();
    clock.onStage(event.stage, event.preview);
  };
  const completeIfReady = (): boolean => {
    if (!finishRequested || queued.length > 0 || !displayed) return false;
    const wait = Math.max(
      MINIMUM_STAGE_MS - Math.max(0, clock.now() - displayedAt),
      MINIMUM_PRESENTATION_MS - elapsed(),
      0,
    );
    if (wait > 0) {
      timer = clock.setTimeout(() => {
        timer = undefined;
        if (!cancelled) completeIfReady();
      }, wait);
      return true;
    }
    resolveFinish?.();
    resolveFinish = undefined;
    rejectFinish = undefined;
    return true;
  };
  const schedule = (): void => {
    if (cancelled || timer !== undefined) return;
    if (queued.length === 0) {
      completeIfReady();
      return;
    }
    const wait = Math.max(0, MINIMUM_STAGE_MS - Math.max(0, clock.now() - displayedAt));
    if (wait === 0) {
      show(queued.shift()!);
      schedule();
      return;
    }
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (cancelled) return;
      show(queued.shift()!);
      schedule();
    }, wait);
  };

  return {
    advance(stage, preview) {
      if (cancelled || finishRequested) return;
      const index = STAGES.indexOf(stage);
      if (index < 0 || index <= acceptedStage) return;
      acceptedStage = index;
      const event = { stage, ...(preview ? { preview } : {}) };
      if (!displayed) {
        show(event);
      } else if (elapsed() >= MINIMUM_PRESENTATION_MS) {
        // A genuinely slow conversion has already earned its overall hold.
        // Keep only its newest truthful worker state instead of replaying it.
        clearTimer();
        queued.length = 0;
        show(event);
      } else {
        queued.push(event);
      }
      schedule();
    },
    finish() {
      if (finishPromise) return finishPromise;
      if (cancelled) return Promise.reject(new ProcessingTimelineCancelledError());
      finishRequested = true;
      finishPromise = new Promise<void>((resolve, reject) => {
        resolveFinish = resolve;
        rejectFinish = reject;
      });
      schedule();
      return finishPromise;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      queued.length = 0;
      clearTimer();
      rejectFinish?.(new ProcessingTimelineCancelledError());
      resolveFinish = undefined;
      rejectFinish = undefined;
    },
  };
}
