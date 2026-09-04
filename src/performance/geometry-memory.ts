export type GeometryBuffer = ArrayBuffer | ArrayBufferView;

export type GeometryBufferOwnership = Readonly<{
  owner: string;
  buffers: readonly GeometryBuffer[];
}>;

export type GeometryLiveByteObservation = Readonly<{
  stage: string;
  totalBytes: number;
  owners: Readonly<Record<string, number>>;
}>;

export type GeometryLiveByteReporter = (
  stage: string,
  replacements: readonly GeometryBufferOwnership[],
) => void;

function backingBuffer(value: GeometryBuffer): ArrayBuffer {
  return value instanceof ArrayBuffer ? value : value.buffer as ArrayBuffer;
}

export function measureGeometryLiveBytes(
  stage: string,
  ownership: readonly GeometryBufferOwnership[],
): GeometryLiveByteObservation {
  const claimed = new Map<ArrayBuffer, string>();
  const owners: Record<string, number> = {};
  let totalBytes = 0;
  for (const entry of ownership) {
    const owned = new Set<ArrayBuffer>();
    for (const value of entry.buffers) {
      const buffer = backingBuffer(value);
      if (buffer.byteLength === 0 || owned.has(buffer)) continue;
      const existingOwner = claimed.get(buffer);
      if (existingOwner === entry.owner) continue;
      if (existingOwner !== undefined && existingOwner !== entry.owner) {
        throw new RangeError(`geometry buffer is claimed by both ${existingOwner} and ${entry.owner}`);
      }
      claimed.set(buffer, entry.owner);
      owned.add(buffer);
      owners[entry.owner] = (owners[entry.owner] ?? 0) + buffer.byteLength;
      totalBytes += buffer.byteLength;
    }
  }
  return Object.freeze({ stage, totalBytes, owners: Object.freeze(owners) });
}

export class GeometryLiveByteTracker {
  readonly #owned = new Map<string, readonly GeometryBuffer[]>();
  readonly #onObservation: (observation: GeometryLiveByteObservation) => void;

  constructor(
    onObservation: (observation: GeometryLiveByteObservation) => void,
  ) {
    this.#onObservation = onObservation;
  }

  update(stage: string, replacements: readonly GeometryBufferOwnership[]): GeometryLiveByteObservation {
    for (const replacement of replacements) {
      if (replacement.buffers.length === 0) this.#owned.delete(replacement.owner);
      else this.#owned.set(replacement.owner, replacement.buffers);
    }
    const observation = measureGeometryLiveBytes(
      stage,
      [...this.#owned].map(([owner, buffers]) => ({ owner, buffers })),
    );
    this.#onObservation(observation);
    return observation;
  }

  clear(stage: string): GeometryLiveByteObservation {
    this.#owned.clear();
    const observation = measureGeometryLiveBytes(stage, []);
    this.#onObservation(observation);
    return observation;
  }
}
