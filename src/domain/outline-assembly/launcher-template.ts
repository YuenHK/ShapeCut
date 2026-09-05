import type { Point2 } from '../decomposition/types';
import { validatePolygon } from '../engraving/geometry';
import { roundedLauncherLoops } from './rounded-launcher';

export const LAUNCHER_TEMPLATE_MAX_POINTS = 4_096;
export const LAUNCHER_RADIUS_TOLERANCE_RATIO = 0.05;
export const LAUNCHER_AREA_TOLERANCE_RATIO = 0.10;
export const LAUNCHER_MEAN_POINT_DISTANCE_TOLERANCE_MM = 0.50;

export type LauncherLoops = readonly [readonly Point2[], readonly Point2[], readonly Point2[]];
export type LauncherTemplate = {
  readonly version: number;
  readonly loops: LauncherLoops;
  readonly provenanceHashes: readonly [string, string];
};
export type LauncherReference = {
  readonly loops: readonly (readonly Point2[])[];
  readonly provenanceHash: string;
};

const PROVENANCE_HASH = /^[0-9a-f]{64}$/;

function assertProvenanceHashes(value: readonly string[], context: string): void {
  if (value.length !== 2 || value.some((hash) => !PROVENANCE_HASH.test(hash))) {
    throw new RangeError(`${context} requires exactly two lowercase 64-hex provenance hashes`);
  }
}

export function renderLauncherTemplateInitializer(template: LauncherTemplate): string {
  assertProvenanceHashes(template.provenanceHashes, 'Launcher template render');
  const numeric = JSON.stringify({
    version: template.version,
    loops: template.loops,
    provenanceHashes: template.provenanceHashes,
  }, null, 2);
  return `export const KNIGHT_FORTRESS_LAUNCHER_TEMPLATE = ${numeric} as const satisfies LauncherTemplate;\n`;
}

type LoopMetric = { readonly area: number; readonly centroid: Point2; readonly radius: number };

function checkpointRuntime(deadline: number, checkpoint: () => void): void {
  checkpoint();
  if (Date.now() > deadline) throw new RangeError('Launcher template processing exceeded the runtime budget');
}

class LauncherCheckpointInterruption {
  constructor(readonly original: unknown) {}
}

export function signedArea(
  points: readonly Point2[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): number {
  checkpointRuntime(deadline, checkpoint);
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    const next = points[(index + 1) % points.length];
    twiceArea += points[index][0] * next[1] - next[0] * points[index][1];
  }
  checkpointRuntime(deadline, checkpoint);
  return twiceArea / 2;
}

export function centroid(
  points: readonly Point2[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): Point2 {
  const area = signedArea(points, deadline, checkpoint);
  let x = 0, y = 0;
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    const point = points[index], next = points[(index + 1) % points.length];
    const cross = point[0] * next[1] - next[0] * point[1];
    x += (point[0] + next[0]) * cross;
    y += (point[1] + next[1]) * cross;
  }
  checkpointRuntime(deadline, checkpoint);
  return [x / (6 * area), y / (6 * area)];
}

function finiteSimpleLoop(points: readonly Point2[], deadline: number, checkpoint: () => void): boolean {
  return points.length >= 3
    && points.length <= LAUNCHER_TEMPLATE_MAX_POINTS
    && validatePolygon({ points }, () => checkpointRuntime(deadline, checkpoint));
}

function rounded(value: number): number {
  const result = Math.round(value * 1e9) / 1e9;
  return Object.is(result, -0) ? 0 : result;
}

function comparePoint(left: Point2, right: Point2): number {
  return left[0] - right[0] || left[1] - right[1];
}

export function canonicalLoop(
  points: readonly Point2[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): readonly Point2[] {
  const alreadyClockwise = signedArea(points, deadline, checkpoint) < 0;
  const clockwise = new Array<Point2>(points.length);
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    clockwise[index] = points[alreadyClockwise ? index : points.length - 1 - index];
  }
  let first = 0;
  for (let index = 1; index < clockwise.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    if (comparePoint(clockwise[index], clockwise[first]) < 0) first = index;
  }
  const output = new Array<Point2>(clockwise.length);
  for (let index = 0; index < clockwise.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    output[index] = clockwise[(first + index) % clockwise.length];
  }
  checkpointRuntime(deadline, checkpoint);
  return output;
}

export function compareLoops(
  left: LauncherLoops,
  right: LauncherLoops,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): number {
  for (let loopIndex = 0; loopIndex < 3; loopIndex += 1) {
    checkpointRuntime(deadline, checkpoint);
    const pointCount = Math.min(left[loopIndex].length, right[loopIndex].length);
    for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
      if ((pointIndex & 255) === 0) checkpointRuntime(deadline, checkpoint);
      const comparison = comparePoint(left[loopIndex][pointIndex], right[loopIndex][pointIndex]);
      if (comparison !== 0) return comparison;
    }
    if (left[loopIndex].length !== right[loopIndex].length) {
      return left[loopIndex].length - right[loopIndex].length;
    }
  }
  return 0;
}

function loopMetrics(
  loops: readonly (readonly Point2[])[],
  deadline: number,
  checkpoint: () => void,
): readonly LoopMetric[] {
  const centers = loops.map((loop) => centroid(loop, deadline, checkpoint));
  const groupCenter: Point2 = [
    centers.reduce((sum, point) => sum + point[0], 0) / centers.length,
    centers.reduce((sum, point) => sum + point[1], 0) / centers.length,
  ];
  return loops.map((loop, index) => ({
    area: Math.abs(signedArea(loop, deadline, checkpoint)),
    centroid: centers[index],
    radius: Math.hypot(centers[index][0] - groupCenter[0], centers[index][1] - groupCenter[1]),
  }));
}

/** Centers a three-loop interface and gives its first hook a deterministic +X direction. */
export function normalizeLauncherLoops(
  source: readonly (readonly Point2[])[],
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): LauncherLoops {
  checkpointRuntime(deadline, checkpoint);
  if (source.length !== 3) throw new RangeError('Launcher template requires three-loop topology');
  if (source.some((loop) => !finiteSimpleLoop(loop, deadline, checkpoint))) {
    throw new RangeError('Launcher template loops must be finite, simple, and within the point budget');
  }
  const centers = source.map((loop) => centroid(loop, deadline, checkpoint));
  const groupCenter: Point2 = [
    centers.reduce((sum, point) => sum + point[0], 0) / 3,
    centers.reduce((sum, point) => sum + point[1], 0) / 3,
  ];
  const ordered = source.map((loop, index) => ({
    loop,
    angle: (Math.atan2(centers[index][1] - groupCenter[1], centers[index][0] - groupCenter[0]) + Math.PI * 2) % (Math.PI * 2),
  })).sort((left, right) => left.angle - right.angle);
  let best: LauncherLoops | undefined;
  for (let start = 0; start < 3; start += 1) {
    checkpointRuntime(deadline, checkpoint);
    const rotation = -ordered[start].angle;
    const cosine = Math.cos(rotation), sine = Math.sin(rotation);
    const candidate = Array.from({ length: 3 }, (_, loopOffset) => {
      const loop = ordered[(start + loopOffset) % 3].loop;
      return canonicalLoop(loop.map(([x, y], index): Point2 => {
        if ((index & 63) === 0) checkpointRuntime(deadline, checkpoint);
        const localX = x - groupCenter[0], localY = y - groupCenter[1];
        return [rounded(localX * cosine - localY * sine), rounded(localX * sine + localY * cosine)];
      }), deadline, checkpoint);
    }) as unknown as LauncherLoops;
    if (!best || compareLoops(candidate, best, deadline, checkpoint) < 0) best = candidate;
  }
  return best!;
}

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.min(left, right);
}

function meanCorrespondingDistance(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let sum = 0;
  if (left.length !== right.length) throw new RangeError('Launcher aligned loops require one common point count');
  for (let index = 0; index < left.length; index += 1) {
    if ((index & 63) === 0) checkpointRuntime(deadline, checkpoint);
    sum += Math.hypot(left[index][0] - right[index][0], left[index][1] - right[index][1]);
  }
  return sum / left.length;
}

export function copyLoopPhase(
  right: readonly Point2[],
  shift: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): readonly Point2[] {
  const output = new Array<Point2>(right.length);
  for (let index = 0; index < right.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    output[index] = right[(index + shift) % right.length];
  }
  checkpointRuntime(deadline, checkpoint);
  return output;
}

function alignLoopPhase(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): readonly Point2[] {
  if (left.length !== right.length) throw new RangeError('Launcher phase alignment requires one common point count');
  let bestShift = 0, bestDistance = Infinity;
  for (let shift = 0; shift < right.length; shift += 1) {
    if ((shift & 63) === 0) checkpointRuntime(deadline, checkpoint);
    let distance = 0;
    for (let index = 0; index < left.length; index += 1) {
      if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
      const candidate = right[(index + shift) % right.length];
      distance += (left[index][0] - candidate[0]) ** 2 + (left[index][1] - candidate[1]) ** 2;
    }
    if (distance < bestDistance - 1e-18) {
      bestDistance = distance;
      bestShift = shift;
    }
  }
  return copyLoopPhase(right, bestShift, deadline, checkpoint);
}

type PreparedReferences = {
  readonly sourceLeft: LauncherLoops;
  readonly sourceRight: LauncherLoops;
  readonly samplesLeft: LauncherLoops;
  readonly samplesRight: LauncherLoops;
};

function cyclicNormalizedGroups(
  source: LauncherLoops,
  deadline: number,
  checkpoint: () => void,
): readonly LauncherLoops[] {
  const entries = source.map((loop) => {
    const center = centroid(loop, deadline, checkpoint);
    return { loop, center, angle: (Math.atan2(center[1], center[0]) + Math.PI * 2) % (Math.PI * 2) };
  }).sort((left, right) => left.angle - right.angle);
  return Array.from({ length: 3 }, (_, start) => {
    checkpointRuntime(deadline, checkpoint);
    const rotation = -entries[start].angle, cosine = Math.cos(rotation), sine = Math.sin(rotation);
    return Array.from({ length: 3 }, (__, offset) => canonicalLoop(
      entries[(start + offset) % 3].loop.map(([x, y], index): Point2 => {
        if ((index & 63) === 0) checkpointRuntime(deadline, checkpoint);
        return [rounded(x * cosine - y * sine), rounded(x * sine + y * cosine)];
      }),
      deadline,
      checkpoint,
    )) as unknown as LauncherLoops;
  });
}

function prepareReferences(
  leftSource: readonly (readonly Point2[])[],
  rightSource: readonly (readonly Point2[])[],
  deadline: number,
  checkpoint: () => void,
): PreparedReferences {
  const sourceLeft = normalizeLauncherLoops(leftSource, deadline, checkpoint);
  const rightCandidates = cyclicNormalizedGroups(
    normalizeLauncherLoops(rightSource, deadline, checkpoint), deadline, checkpoint,
  );
  const count = Math.max(
    ...sourceLeft.map((loop) => loop.length),
    ...rightCandidates[0].map((loop) => loop.length),
  );
  if (count > LAUNCHER_TEMPLATE_MAX_POINTS) throw new RangeError('Launcher template exceeds the point budget');
  const samplesLeft = sourceLeft.map((loop) => (
    resampleClosedLoop(loop, count, deadline, checkpoint)
  )) as unknown as LauncherLoops;
  let best: { readonly source: LauncherLoops; readonly samples: LauncherLoops; readonly distance: number } | undefined;
  for (const sourceRight of rightCandidates) {
    checkpointRuntime(deadline, checkpoint);
    const samplesRight = sourceRight.map((loop, index) => alignLoopPhase(
      samplesLeft[index], resampleClosedLoop(loop, count, deadline, checkpoint), deadline, checkpoint,
    )) as unknown as LauncherLoops;
    const distance = samplesLeft.reduce((sum, loop, index) => sum + meanCorrespondingDistance(
      loop, samplesRight[index], deadline, checkpoint,
    ), 0);
    if (!best || distance < best.distance - 1e-12
      || Math.abs(distance - best.distance) <= 1e-12
        && compareLoops(sourceRight, best.source, deadline, checkpoint) < 0) {
      best = { source: sourceRight, samples: samplesRight, distance };
    }
  }
  return { sourceLeft, sourceRight: best!.source, samplesLeft, samplesRight: best!.samples };
}

export function launcherReferencesAreCompatible(
  leftReference: LauncherReference,
  rightReference: LauncherReference,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): boolean {
  const guardedCheckpoint = (): void => {
    try {
      checkpoint();
    } catch (error) {
      throw new LauncherCheckpointInterruption(error);
    }
  };
  try {
    checkpointRuntime(deadline, guardedCheckpoint);
    if (leftReference.loops.length !== 3 || rightReference.loops.length !== 3) return false;
    const prepared = prepareReferences(leftReference.loops, rightReference.loops, deadline, guardedCheckpoint);
    const leftMetrics = loopMetrics(prepared.sourceLeft, deadline, guardedCheckpoint);
    const rightMetrics = loopMetrics(prepared.sourceRight, deadline, guardedCheckpoint);
    for (let index = 0; index < 3; index += 1) {
      checkpointRuntime(deadline, guardedCheckpoint);
      if (relativeDifference(leftMetrics[index].radius, rightMetrics[index].radius) > LAUNCHER_RADIUS_TOLERANCE_RATIO + 1e-9
        || relativeDifference(leftMetrics[index].area, rightMetrics[index].area) > LAUNCHER_AREA_TOLERANCE_RATIO + 1e-9
        || meanCorrespondingDistance(
          prepared.samplesLeft[index], prepared.samplesRight[index], deadline, guardedCheckpoint,
        ) > LAUNCHER_MEAN_POINT_DISTANCE_TOLERANCE_MM + 1e-9) return false;
    }
    return true;
  } catch (error) {
    if (error instanceof LauncherCheckpointInterruption) throw error.original;
    if (error instanceof RangeError && !/runtime budget/i.test(error.message)) return false;
    throw error;
  }
}

export function resampleClosedLoop(
  points: readonly Point2[],
  count: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): readonly Point2[] {
  checkpointRuntime(deadline, checkpoint);
  const lengths = new Array<number>(points.length);
  for (let index = 0; index < points.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    const point = points[index], next = points[(index + 1) % points.length];
    lengths[index] = Math.hypot(next[0] - point[0], next[1] - point[1]);
  }
  let perimeter = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    perimeter += lengths[index];
  }
  const output: Point2[] = [];
  let segment = 0, startDistance = 0;
  for (let index = 0; index < count; index += 1) {
    if ((index & 255) === 0) checkpointRuntime(deadline, checkpoint);
    const target = perimeter * index / count;
    while (segment + 1 < lengths.length && startDistance + lengths[segment] < target) {
      if ((segment & 255) === 0) checkpointRuntime(deadline, checkpoint);
      startDistance += lengths[segment++];
    }
    const start = points[segment], end = points[(segment + 1) % points.length];
    const ratio = lengths[segment] === 0 ? 0 : (target - startDistance) / lengths[segment];
    output.push([rounded(start[0] + (end[0] - start[0]) * ratio), rounded(start[1] + (end[1] - start[1]) * ratio)]);
  }
  checkpointRuntime(deadline, checkpoint);
  return output;
}

export function averageLauncherLoops(
  left: LauncherLoops,
  right: LauncherLoops,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): LauncherLoops {
  const averaged: Array<readonly Point2[]> = [];
  for (let loopIndex = 0; loopIndex < 3; loopIndex += 1) {
    checkpointRuntime(deadline, checkpoint);
    if (left[loopIndex].length !== right[loopIndex].length) {
      throw new RangeError('Launcher averaging requires corresponding loop point counts');
    }
    const points = new Array<Point2>(left[loopIndex].length);
    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      if ((pointIndex & 255) === 0) checkpointRuntime(deadline, checkpoint);
      points[pointIndex] = [
        rounded((left[loopIndex][pointIndex][0] + right[loopIndex][pointIndex][0]) / 2),
        rounded((left[loopIndex][pointIndex][1] + right[loopIndex][pointIndex][1]) / 2),
      ];
    }
    averaged.push(canonicalLoop(points, deadline, checkpoint));
  }
  return averaged as unknown as LauncherLoops;
}

export function averageCompatibleLauncherReferences(
  references: readonly LauncherReference[],
  version: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): LauncherTemplate {
  checkpointRuntime(deadline, checkpoint);
  if (references.length !== 2) throw new RangeError('Launcher template requires exactly two provenance references');
  assertProvenanceHashes(references.map(({ provenanceHash }) => provenanceHash), 'Launcher template averaging');
  if (references.some(({ loops }) => loops.length !== 3)) throw new RangeError('Launcher template requires three-loop topology');
  if (!Number.isInteger(version) || version <= 0) throw new RangeError('Launcher template version must be a positive integer');
  if (!launcherReferencesAreCompatible(references[0], references[1], deadline, checkpoint)) {
    throw new RangeError('Launcher references are incompatible and cannot be averaged');
  }
  const normalized = prepareReferences(references[0].loops, references[1].loops, deadline, checkpoint);
  const averaged = averageLauncherLoops(
    normalized.samplesLeft, normalized.samplesRight, deadline, checkpoint,
  );
  if (averaged.some((loop) => !finiteSimpleLoop(loop, deadline, checkpoint))) {
    throw new RangeError('Launcher averaged template is invalid after numeric canonicalization');
  }
  return {
    version,
    loops: averaged,
    provenanceHashes: [references[0].provenanceHash, references[1].provenanceHash],
  };
}

// Generated deterministically from two compatible external references; numeric geometry only.
export const KNIGHT_FORTRESS_LAUNCHER_TEMPLATE = {
  "version": 1,
  "loops": [
    [
      [
        10.575140991,
        16.715670682
      ],
      [
        10.904229946,
        17.667493679
      ],
      [
        10.910633231,
        18.624811701
      ],
      [
        11.780183721,
        18.509985397
      ],
      [
        12.789918104,
        18.489550766
      ],
      [
        13.744498461,
        18.319555588
      ],
      [
        14.638021874,
        17.830840745
      ],
      [
        15.487050645,
        17.278433283
      ],
      [
        16.083069393,
        16.539909897
      ],
      [
        16.241824069,
        15.687889759
      ],
      [
        17.139966681,
        15.591793558
      ],
      [
        17.846149839,
        14.862359682
      ],
      [
        18.53787258,
        14.115071592
      ],
      [
        19.100035787,
        13.266716659
      ],
      [
        19.693255981,
        12.454038115
      ],
      [
        19.737535385,
        11.598796722
      ],
      [
        20.293954064,
        10.964667259
      ],
      [
        20.920548739,
        10.270213212
      ],
      [
        21.398504841,
        9.37471318
      ],
      [
        21.778350825,
        8.471061059
      ],
      [
        22.026764466,
        7.483380512
      ],
      [
        22.410978873,
        6.582250113
      ],
      [
        22.54750447,
        5.654799286
      ],
      [
        22.632443993,
        4.663927383
      ],
      [
        22.460079477,
        3.691717474
      ],
      [
        21.971364633,
        2.798194062
      ],
      [
        21.355272447,
        2.00380049
      ],
      [
        20.915968748,
        1.219985347
      ],
      [
        21.018677879,
        0.246185822
      ],
      [
        20.92282563,
        -0.766084352
      ],
      [
        20.984479889,
        -1.723046366
      ],
      [
        21.582637096,
        -2.541146194
      ],
      [
        22.069054236,
        -3.419421666
      ],
      [
        22.376428825,
        -4.390107485
      ],
      [
        22.628356357,
        -5.249823711
      ],
      [
        22.528158788,
        -6.240686713
      ],
      [
        22.308773445,
        -7.21564534
      ],
      [
        21.928819021,
        -8.155824963
      ],
      [
        21.028784578,
        -8.475647296
      ],
      [
        21.436737542,
        -9.321537414
      ],
      [
        20.948022698,
        -10.215060827
      ],
      [
        20.459307855,
        -11.10858424
      ],
      [
        19.970593012,
        -12.002107653
      ],
      [
        19.481878168,
        -12.895631066
      ],
      [
        18.695368352,
        -13.297423643
      ],
      [
        18.175221584,
        -13.842105945
      ],
      [
        17.876704484,
        -14.769180071
      ],
      [
        17.208965852,
        -15.50962488
      ],
      [
        16.479111573,
        -16.181713888
      ],
      [
        15.708335726,
        -16.841902442
      ],
      [
        14.951990885,
        -17.523781022
      ],
      [
        14.100587111,
        -18.012937133
      ],
      [
        13.197052711,
        -18.447333698
      ],
      [
        12.309560415,
        -18.713608029
      ],
      [
        11.384450824,
        -18.383296866
      ],
      [
        11.075920518,
        -17.468517828
      ],
      [
        10.92988838,
        -16.593003516
      ],
      [
        11.681939726,
        -15.956371476
      ],
      [
        12.470279708,
        -15.351209765
      ],
      [
        13.276791648,
        -14.735116973
      ],
      [
        14.096218971,
        -14.130376918
      ],
      [
        14.884076828,
        -13.48980094
      ],
      [
        15.586517796,
        -12.752370961
      ],
      [
        16.22602708,
        -11.967785272
      ],
      [
        16.736651247,
        -11.086599266
      ],
      [
        17.247275414,
        -10.205413261
      ],
      [
        17.757899581,
        -9.324227256
      ],
      [
        18.268523747,
        -8.44304125
      ],
      [
        18.737396214,
        -7.54223241
      ],
      [
        19.089889969,
        -6.58673545
      ],
      [
        19.442383724,
        -5.63123849
      ],
      [
        19.79487748,
        -4.675741531
      ],
      [
        19.850304298,
        -3.666608257
      ],
      [
        19.878927803,
        -2.650329478
      ],
      [
        20.049531867,
        -1.677227665
      ],
      [
        20.177153602,
        -0.682220197
      ],
      [
        20.315821137,
        0.31795886
      ],
      [
        20.158128815,
        1.323404795
      ],
      [
        20.06008413,
        2.308350416
      ],
      [
        20.065073449,
        3.299917583
      ],
      [
        19.837106118,
        4.280342649
      ],
      [
        19.54285721,
        5.255311428
      ],
      [
        19.248608302,
        6.230280205
      ],
      [
        18.935546465,
        7.190128726
      ],
      [
        18.614863976,
        8.126883327
      ],
      [
        18.186694373,
        8.987904369
      ],
      [
        17.74758876,
        9.834020892
      ],
      [
        17.184468441,
        10.615645659
      ],
      [
        16.609659004,
        11.425051339
      ],
      [
        15.970618235,
        12.186054025
      ],
      [
        15.256613809,
        12.905961012
      ],
      [
        14.651011225,
        13.717747137
      ],
      [
        13.894088696,
        14.398168831
      ],
      [
        13.132215307,
        15.074016684
      ],
      [
        12.362187816,
        15.738240995
      ],
      [
        11.468664404,
        16.226955839
      ]
    ],
    [
      [
        -22.59170988,
        4.094606434
      ],
      [
        -22.449469556,
        5.087888949
      ],
      [
        -22.019689988,
        5.893022947
      ],
      [
        -21.479081131,
        6.445993509
      ],
      [
        -21.760221431,
        7.257773473
      ],
      [
        -21.494012819,
        8.211803723
      ],
      [
        -21.165667569,
        9.159129965
      ],
      [
        -20.767563173,
        10.080893781
      ],
      [
        -20.369458776,
        11.002657599
      ],
      [
        -19.599716386,
        11.410493486
      ],
      [
        -19.243552869,
        12.098559804
      ],
      [
        -19.132160591,
        13.010970101
      ],
      [
        -18.592815247,
        13.857875911
      ],
      [
        -17.949539678,
        14.609877052
      ],
      [
        -17.263120005,
        15.334475465
      ],
      [
        -16.578186792,
        16.044450057
      ],
      [
        -15.865459832,
        16.731496894
      ],
      [
        -15.040557517,
        17.303929442
      ],
      [
        -14.157131331,
        17.502579299
      ],
      [
        -13.183486976,
        17.644879284
      ],
      [
        -12.207681854,
        17.527292694
      ],
      [
        -11.301518896,
        17.355085338
      ],
      [
        -10.632287871,
        18.051225145
      ],
      [
        -9.752004731,
        18.475593452
      ],
      [
        -9.125833527,
        19.226746893
      ],
      [
        -8.549946963,
        20.049112353
      ],
      [
        -7.974060398,
        20.871477812
      ],
      [
        -7.372850067,
        21.650746486
      ],
      [
        -6.521698623,
        22.108462475
      ],
      [
        -5.637255392,
        22.440473488
      ],
      [
        -4.699517427,
        22.722141662
      ],
      [
        -3.832963166,
        22.48491645
      ],
      [
        -3.175573988,
        22.614335866
      ],
      [
        -2.401831913,
        22.893267348
      ],
      [
        -1.411236843,
        23.051668113
      ],
      [
        -0.420712253,
        23.124753748
      ],
      [
        0.537545655,
        23.137282167
      ],
      [
        1.509288124,
        23.104507365
      ],
      [
        2.146178431,
        22.40080257
      ],
      [
        2.951223691,
        22.720692595
      ],
      [
        3.884907077,
        22.792701227
      ],
      [
        4.872972035,
        22.614178143
      ],
      [
        5.824481863,
        22.309382339
      ],
      [
        6.754730628,
        21.933713456
      ],
      [
        7.700698281,
        21.622744101
      ],
      [
        8.569636927,
        21.120260749
      ],
      [
        9.410738376,
        20.586779769
      ],
      [
        10.002530014,
        19.818516151
      ],
      [
        9.928917962,
        18.982779858
      ],
      [
        9.393942949,
        18.136609759
      ],
      [
        8.582744669,
        17.917602323
      ],
      [
        7.658267247,
        18.309373108
      ],
      [
        6.733789825,
        18.701143892
      ],
      [
        5.785967517,
        19.030046596
      ],
      [
        4.829921802,
        19.33683552
      ],
      [
        3.873876088,
        19.643624443
      ],
      [
        2.90558431,
        19.901307165
      ],
      [
        1.914775369,
        20.054354481
      ],
      [
        0.929276074,
        20.030424216
      ],
      [
        -0.020336214,
        20.020401291
      ],
      [
        -0.971901094,
        20.014395725
      ],
      [
        -1.949783907,
        19.824855047
      ],
      [
        -2.912386042,
        19.741705149
      ],
      [
        -3.843943919,
        19.621461089
      ],
      [
        -4.797005293,
        19.437080621
      ],
      [
        -5.750157407,
        19.250798707
      ],
      [
        -6.666257683,
        18.874383899
      ],
      [
        -7.526063718,
        18.375623316
      ],
      [
        -8.434053125,
        17.974379637
      ],
      [
        -9.316290266,
        17.601991036
      ],
      [
        -10.220670447,
        17.31252251
      ],
      [
        -10.978354755,
        16.712862464
      ],
      [
        -11.88978975,
        16.432066423
      ],
      [
        -12.511710988,
        15.64697244
      ],
      [
        -13.244691366,
        14.971696514
      ],
      [
        -13.893599197,
        14.213130244
      ],
      [
        -14.608619604,
        13.520439475
      ],
      [
        -15.287576381,
        12.780739768
      ],
      [
        -15.975928997,
        12.071932774
      ],
      [
        -16.569941822,
        11.26243193
      ],
      [
        -17.088976145,
        10.406981463
      ],
      [
        -17.54848626,
        9.51460567
      ],
      [
        -17.94574423,
        8.593712238
      ],
      [
        -18.293472435,
        7.651841711
      ],
      [
        -18.64120064,
        6.709971184
      ],
      [
        -18.935170203,
        5.752402759
      ],
      [
        -19.151662317,
        4.771966193
      ],
      [
        -19.36815443,
        3.791529628
      ],
      [
        -19.584646543,
        2.811093063
      ],
      [
        -19.57221993,
        1.81480994
      ],
      [
        -19.763901263,
        0.989969679
      ],
      [
        -20.618233392,
        0.752559341
      ],
      [
        -21.390061139,
        0.488546499
      ],
      [
        -21.745669925,
        1.356249564
      ],
      [
        -22.328662437,
        2.171048606
      ],
      [
        -22.5488156,
        3.122332802
      ]
    ],
    [
      [
        -22.615513599,
        -3.510113739
      ],
      [
        -22.523452345,
        -2.524742012
      ],
      [
        -22.303871891,
        -1.569399171
      ],
      [
        -21.851578464,
        -0.667410245
      ],
      [
        -20.944328872,
        -0.771495731
      ],
      [
        -19.971454894,
        -0.820946868
      ],
      [
        -19.661089102,
        -1.655208843
      ],
      [
        -19.437849648,
        -2.547500977
      ],
      [
        -19.432485079,
        -3.437807456
      ],
      [
        -19.218519966,
        -4.380103342
      ],
      [
        -19.03510134,
        -5.322946379
      ],
      [
        -18.899275809,
        -6.270963244
      ],
      [
        -18.615490961,
        -7.239961691
      ],
      [
        -18.331706114,
        -8.20896014
      ],
      [
        -17.782880831,
        -9.044973829
      ],
      [
        -17.342794158,
        -9.918299519
      ],
      [
        -16.718435025,
        -10.711772286
      ],
      [
        -16.219751339,
        -11.577610333
      ],
      [
        -15.667548073,
        -12.382889875
      ],
      [
        -15.048270013,
        -13.149397181
      ],
      [
        -14.421280314,
        -13.902708794
      ],
      [
        -13.794650416,
        -14.694012504
      ],
      [
        -12.965696486,
        -15.245275099
      ],
      [
        -12.079844923,
        -15.729794283
      ],
      [
        -11.33609595,
        -16.40771345
      ],
      [
        -10.524598748,
        -16.986522153
      ],
      [
        -9.613234794,
        -17.421157144
      ],
      [
        -8.757885186,
        -17.924305103
      ],
      [
        -8.05111022,
        -18.574757618
      ],
      [
        -7.074039737,
        -18.660867953
      ],
      [
        -6.100677935,
        -18.894192063
      ],
      [
        -5.127007857,
        -19.161509123
      ],
      [
        -4.153337778,
        -19.428826183
      ],
      [
        -3.1796677,
        -19.696143243
      ],
      [
        -2.204609636,
        -19.948218637
      ],
      [
        -1.202713339,
        -19.90613524
      ],
      [
        -0.224486203,
        -20.129855225
      ],
      [
        0.760574554,
        -19.93329756
      ],
      [
        1.736277638,
        -19.782973888
      ],
      [
        2.688210634,
        -19.657533812
      ],
      [
        3.640108624,
        -19.536206126
      ],
      [
        4.607395233,
        -19.347948534
      ],
      [
        5.56941518,
        -19.051182017
      ],
      [
        6.530607661,
        -18.741987587
      ],
      [
        7.491800142,
        -18.432793158
      ],
      [
        8.329514181,
        -17.897805698
      ],
      [
        9.099879908,
        -17.64985319
      ],
      [
        9.813597761,
        -18.272928597
      ],
      [
        10.427660504,
        -18.836491925
      ],
      [
        9.902490134,
        -19.6985565
      ],
      [
        9.368185793,
        -20.55529802
      ],
      [
        8.59193224,
        -21.083964741
      ],
      [
        7.813734044,
        -21.650123943
      ],
      [
        6.911174746,
        -22.016525094
      ],
      [
        6.004026963,
        -22.10188303
      ],
      [
        5.263198189,
        -21.814559965
      ],
      [
        4.747168856,
        -22.466565299
      ],
      [
        3.773842796,
        -22.66262389
      ],
      [
        2.794276294,
        -22.907453014
      ],
      [
        1.796143163,
        -22.927078936
      ],
      [
        0.811116957,
        -23.113520756
      ],
      [
        -0.017915289,
        -22.736852417
      ],
      [
        -0.798775152,
        -22.737630604
      ],
      [
        -1.660438157,
        -22.998261715
      ],
      [
        -2.669369012,
        -22.999860344
      ],
      [
        -3.629986502,
        -22.765421497
      ],
      [
        -4.608611555,
        -22.525060149
      ],
      [
        -5.60421407,
        -22.368472462
      ],
      [
        -6.546160681,
        -22.023905119
      ],
      [
        -7.451653319,
        -21.578772397
      ],
      [
        -8.139977337,
        -20.916843895
      ],
      [
        -8.666718206,
        -20.079734535
      ],
      [
        -9.240790002,
        -19.275067836
      ],
      [
        -9.853455988,
        -18.567464883
      ],
      [
        -10.759517617,
        -18.121881942
      ],
      [
        -11.665579245,
        -17.676299
      ],
      [
        -12.610457153,
        -17.536315051
      ],
      [
        -13.588682545,
        -17.288422301
      ],
      [
        -14.585859269,
        -17.173571444
      ],
      [
        -15.501936019,
        -16.886462139
      ],
      [
        -16.360031095,
        -16.359064327
      ],
      [
        -17.099811898,
        -15.691285662
      ],
      [
        -17.786021197,
        -14.964896639
      ],
      [
        -17.655809403,
        -14.025750899
      ],
      [
        -18.416369468,
        -13.769851626
      ],
      [
        -19.027487315,
        -13.03869225
      ],
      [
        -19.630962956,
        -12.229901406
      ],
      [
        -20.080586373,
        -11.375762654
      ],
      [
        -20.528712201,
        -10.479972844
      ],
      [
        -20.769634056,
        -9.631999583
      ],
      [
        -20.696541833,
        -8.84023931
      ],
      [
        -21.481267499,
        -8.283946023
      ],
      [
        -21.759915801,
        -7.3567033
      ],
      [
        -22.076505714,
        -6.438157187
      ],
      [
        -22.250394094,
        -5.483423939
      ],
      [
        -22.372405428,
        -4.489184363
      ]
    ]
  ],
  "provenanceHashes": [
    "96d0ddd32cc660af31bedf4fb52552d54505169efb7887862bd9943c4f73d5b6",
    "17269a09c5a56b3c2e62683836781126421e30bfb9dce5599ff8f53667808b4d"
  ]
} as const satisfies LauncherTemplate;

export const OFFICIAL_THREE_PRONG_TEMPLATE_VERSION = 2 as const;
export const OFFICIAL_THREE_PRONG_TEMPLATE: LauncherTemplate = Object.freeze({
  version: OFFICIAL_THREE_PRONG_TEMPLATE_VERSION,
  loops: roundedLauncherLoops(),
  // Provenance identifies the source of the fit, not a claim of exact reproduction.
  provenanceHashes: KNIGHT_FORTRESS_LAUNCHER_TEMPLATE.provenanceHashes,
});

function templateFingerprint(template: Pick<LauncherTemplate, 'version' | 'loops'>): string {
  const serialized = JSON.stringify({ version: template.version, loops: template.loops });
  const lanes = [2166136261, 2246822519, 3266489917, 668265263];
  for (let lane = 0; lane < lanes.length; lane += 1) {
    for (const char of serialized) {
      lanes[lane] = Math.imul(lanes[lane] ^ (char.charCodeAt(0) + lane * 131), 16777619 + lane * 2) >>> 0;
    }
  }
  return lanes.map((lane) => lane.toString(16).padStart(8, '0')).join('');
}

export const OFFICIAL_THREE_PRONG_TEMPLATE_FINGERPRINT =
  templateFingerprint(OFFICIAL_THREE_PRONG_TEMPLATE);
