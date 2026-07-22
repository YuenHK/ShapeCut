import { describe, expect, it, vi } from 'vitest';
import type { AutomaticOutlineProgressStage } from '../domain/pipeline/automatic-outline-pipeline';
import { ProcessingTimelineCancelledError, createProcessingTimeline } from './processing-timeline';

type Timer = { readonly due: number; readonly callback: () => void };

function fakeClock() {
  let time = 0;
  let nextTimer = 1;
  const timers = new Map<number, Timer>();
  const advance = (milliseconds: number): void => {
    const target = time + milliseconds;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      time = timer.due;
      timer.callback();
    }
    time = target;
  };
  return {
    now: () => time,
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { due: time + delay, callback });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    advance,
    pending: () => timers.size,
  };
}

const stages: readonly AutomaticOutlineProgressStage[] = ['reading', 'analyzing', 'simplifying', 'slicing', 'packaging'];

describe('createProcessingTimeline', () => {
  it('shows every reached fast-worker stage for 1,500 ms and holds the result until 8,000 ms', async () => {
    const clock = fakeClock();
    const shown: Array<{ stage: AutomaticOutlineProgressStage; at: number }> = [];
    const timeline = createProcessingTimeline({
      ...clock,
      onStage: (stage) => shown.push({ stage, at: clock.now() }),
    });

    for (const stage of stages) timeline.advance(stage);
    const done = timeline.finish();
    clock.advance(7_999);
    await Promise.resolve();
    expect(shown).toEqual([
      { stage: 'reading', at: 0 },
      { stage: 'analyzing', at: 1_500 },
      { stage: 'simplifying', at: 3_000 },
      { stage: 'slicing', at: 4_500 },
      { stage: 'packaging', at: 6_000 },
    ]);
    let settled = false;
    void done.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    clock.advance(1);
    await expect(done).resolves.toBeUndefined();
  });

  it('does not add another eight seconds to a slow job and keeps stage updates monotonic', async () => {
    const clock = fakeClock();
    const shown = vi.fn();
    const timeline = createProcessingTimeline({ ...clock, onStage: shown });

    timeline.advance('reading');
    clock.advance(10_000);
    timeline.advance('slicing');
    timeline.advance('analyzing');
    timeline.advance('packaging');
    const done = timeline.finish();

    expect(shown.mock.calls.map(([stage]) => stage)).toEqual(['reading', 'slicing', 'packaging']);
    clock.advance(1_499);
    let settled = false;
    void done.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    await expect(done).resolves.toBeUndefined();
  });

  it('cancels pending presentation timers and never emits another UI update', async () => {
    const clock = fakeClock();
    const shown = vi.fn();
    const timeline = createProcessingTimeline({ ...clock, onStage: shown });
    timeline.advance('reading');
    timeline.advance('analyzing');
    const done = timeline.finish();

    timeline.cancel();
    expect(clock.pending()).toBe(0);
    clock.advance(20_000);
    expect(shown.mock.calls.map(([stage]) => stage)).toEqual(['reading']);
    await expect(done).rejects.toBeInstanceOf(ProcessingTimelineCancelledError);
  });

  it('settles the final hold when a late worker event arrives after finish', async () => {
    const clock = fakeClock();
    const shown = vi.fn();
    const timeline = createProcessingTimeline({ ...clock, onStage: shown });
    timeline.advance('reading');
    const done = timeline.finish();

    clock.advance(100);
    timeline.advance('analyzing');
    clock.advance(7_900);

    await expect(done).resolves.toBeUndefined();
    expect(shown.mock.calls.map(([stage]) => stage)).toEqual(['reading']);
    expect(clock.pending()).toBe(0);
  });
});
