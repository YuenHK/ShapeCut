import type { Point2 } from '../decomposition/types';
import { validatePolygon } from '../engraving/geometry';

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

export function renderLauncherTemplateInitializer(template: LauncherTemplate): string {
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

function signedArea(points: readonly Point2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    twiceArea += points[index][0] * next[1] - next[0] * points[index][1];
  }
  return twiceArea / 2;
}

function centroid(points: readonly Point2[]): Point2 {
  const area = signedArea(points);
  let x = 0, y = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index], next = points[(index + 1) % points.length];
    const cross = point[0] * next[1] - next[0] * point[1];
    x += (point[0] + next[0]) * cross;
    y += (point[1] + next[1]) * cross;
  }
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

function canonicalLoop(points: readonly Point2[]): readonly Point2[] {
  const clockwise = signedArea(points) < 0 ? [...points] : [...points].reverse();
  let first = 0;
  for (let index = 1; index < clockwise.length; index += 1) {
    if (comparePoint(clockwise[index], clockwise[first]) < 0) first = index;
  }
  return Array.from({ length: clockwise.length }, (_, index) => clockwise[(first + index) % clockwise.length]);
}

function loopMetrics(loops: readonly (readonly Point2[])[]): readonly LoopMetric[] {
  const centers = loops.map((loop) => centroid(loop));
  const groupCenter: Point2 = [
    centers.reduce((sum, point) => sum + point[0], 0) / centers.length,
    centers.reduce((sum, point) => sum + point[1], 0) / centers.length,
  ];
  return loops.map((loop, index) => ({
    area: Math.abs(signedArea(loop)),
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
  const centers = source.map((loop) => centroid(loop));
  const groupCenter: Point2 = [
    centers.reduce((sum, point) => sum + point[0], 0) / 3,
    centers.reduce((sum, point) => sum + point[1], 0) / 3,
  ];
  const ordered = source.map((loop, index) => ({
    loop,
    angle: Math.atan2(centers[index][1] - groupCenter[1], centers[index][0] - groupCenter[0]),
  })).sort((left, right) => left.angle - right.angle);
  const rotation = -ordered[0].angle;
  const cosine = Math.cos(rotation), sine = Math.sin(rotation);
  const rotated = ordered.map(({ loop }) => canonicalLoop(loop.map(([x, y], index): Point2 => {
    if ((index & 63) === 0) checkpointRuntime(deadline, checkpoint);
    const localX = x - groupCenter[0], localY = y - groupCenter[1];
    return [rounded(localX * cosine - localY * sine), rounded(localX * sine + localY * cosine)];
  })));
  return rotated as unknown as LauncherLoops;
}

function relativeDifference(left: number, right: number): number {
  return Math.abs(left - right) / Math.min(left, right);
}

function meanNearestDistance(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    if ((index & 63) === 0) checkpointRuntime(deadline, checkpoint);
    const point = left[index];
    let nearest = Infinity;
    for (let candidateIndex = 0; candidateIndex < right.length; candidateIndex += 1) {
      if ((candidateIndex & 255) === 0) checkpointRuntime(deadline, checkpoint);
      const candidate = right[candidateIndex];
      nearest = Math.min(nearest, Math.hypot(point[0] - candidate[0], point[1] - candidate[1]));
    }
    sum += nearest;
  }
  return sum / left.length;
}

function symmetricMeanPointDistance(
  left: readonly Point2[],
  right: readonly Point2[],
  deadline: number,
  checkpoint: () => void,
): number {
  return (meanNearestDistance(left, right, deadline, checkpoint)
    + meanNearestDistance(right, left, deadline, checkpoint)) / 2;
}

export function launcherReferencesAreCompatible(
  leftReference: LauncherReference,
  rightReference: LauncherReference,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): boolean {
  checkpointRuntime(deadline, checkpoint);
  if (leftReference.loops.length !== 3 || rightReference.loops.length !== 3) return false;
  let left: LauncherLoops, right: LauncherLoops;
  try {
    left = normalizeLauncherLoops(leftReference.loops, deadline, checkpoint);
    right = normalizeLauncherLoops(rightReference.loops, deadline, checkpoint);
  } catch (error) {
    if (error instanceof RangeError && !/runtime budget/i.test(error.message)) return false;
    throw error;
  }
  const leftMetrics = loopMetrics(left), rightMetrics = loopMetrics(right);
  for (let index = 0; index < 3; index += 1) {
    checkpointRuntime(deadline, checkpoint);
    if (relativeDifference(leftMetrics[index].radius, rightMetrics[index].radius) > LAUNCHER_RADIUS_TOLERANCE_RATIO + 1e-9
      || relativeDifference(leftMetrics[index].area, rightMetrics[index].area) > LAUNCHER_AREA_TOLERANCE_RATIO + 1e-9
      || symmetricMeanPointDistance(left[index], right[index], deadline, checkpoint) > LAUNCHER_MEAN_POINT_DISTANCE_TOLERANCE_MM + 1e-9) return false;
  }
  return true;
}

function resampleClosedLoop(points: readonly Point2[], count: number): readonly Point2[] {
  if (points.length === count) return points.map(([x, y]): Point2 => [x, y]);
  const lengths = points.map((point, index) => Math.hypot(
    points[(index + 1) % points.length][0] - point[0],
    points[(index + 1) % points.length][1] - point[1],
  ));
  const perimeter = lengths.reduce((sum, length) => sum + length, 0);
  const output: Point2[] = [];
  let segment = 0, startDistance = 0;
  for (let index = 0; index < count; index += 1) {
    const target = perimeter * index / count;
    while (segment + 1 < lengths.length && startDistance + lengths[segment] < target) {
      startDistance += lengths[segment++];
    }
    const start = points[segment], end = points[(segment + 1) % points.length];
    const ratio = lengths[segment] === 0 ? 0 : (target - startDistance) / lengths[segment];
    output.push([rounded(start[0] + (end[0] - start[0]) * ratio), rounded(start[1] + (end[1] - start[1]) * ratio)]);
  }
  return output;
}

export function averageCompatibleLauncherReferences(
  references: readonly LauncherReference[],
  version: number,
  deadline = Infinity,
  checkpoint: () => void = () => undefined,
): LauncherTemplate {
  checkpointRuntime(deadline, checkpoint);
  if (references.length !== 2) throw new RangeError('Launcher template requires exactly two provenance references');
  if (references.some(({ loops }) => loops.length !== 3)) throw new RangeError('Launcher template requires three-loop topology');
  if (!Number.isInteger(version) || version <= 0) throw new RangeError('Launcher template version must be a positive integer');
  if (!launcherReferencesAreCompatible(references[0], references[1], deadline, checkpoint)) {
    throw new RangeError('Launcher references are incompatible and cannot be averaged');
  }
  const normalized = references.map(({ loops }) => normalizeLauncherLoops(loops, deadline, checkpoint));
  const count = Math.max(...normalized.flatMap((loops) => loops.map((loop) => loop.length)));
  if (count > LAUNCHER_TEMPLATE_MAX_POINTS) throw new RangeError('Launcher template exceeds the point budget');
  const averaged = [0, 1, 2].map((loopIndex) => {
    const resampled = normalized.map((loops) => resampleClosedLoop(loops[loopIndex], count));
    return canonicalLoop(Array.from({ length: count }, (_, pointIndex): Point2 => [
      rounded((resampled[0][pointIndex][0] + resampled[1][pointIndex][0]) / 2),
      rounded((resampled[0][pointIndex][1] + resampled[1][pointIndex][1]) / 2),
    ]));
  }) as unknown as LauncherLoops;
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
        10.676253769,
        0.095143614
      ],
      [
        11.044968462,
        0.682173689
      ],
      [
        11.287554737,
        1.254741851
      ],
      [
        11.918694819,
        1.243126447
      ],
      [
        12.545667223,
        1.41872557
      ],
      [
        13.102046699,
        1.194694298
      ],
      [
        13.638507424,
        1.180629257
      ],
      [
        14.1241771,
        0.873250225
      ],
      [
        14.844077116,
        1.011103928
      ],
      [
        14.99317664,
        0.581700469
      ],
      [
        15.626754684,
        0.854427003
      ],
      [
        16.053967944,
        0.47359657
      ],
      [
        17.338147417,
        1.086315465
      ],
      [
        17.738095351,
        0.993391263
      ],
      [
        18.285755638,
        0.855363144
      ],
      [
        18.798179769,
        1.447842414
      ],
      [
        19.24906518,
        1.4626026
      ],
      [
        19.634346499,
        1.368741599
      ],
      [
        20.055468901,
        1.181768382
      ],
      [
        20.210678915,
        0.89883533
      ],
      [
        20.445360725,
        0.536885428
      ],
      [
        20.618406737,
        0.258318974
      ],
      [
        21.028939675,
        0.477189201
      ],
      [
        21.04355084,
        0.929552427
      ],
      [
        21.132024949,
        1.150596135
      ],
      [
        20.822835729,
        1.844025192
      ],
      [
        20.780337122,
        1.81164869
      ],
      [
        20.460725652,
        1.890293147
      ],
      [
        20.364122318,
        1.511742825
      ],
      [
        19.772343811,
        3.414408394
      ],
      [
        19.678473231,
        3.346204655
      ],
      [
        19.693452187,
        3.372230719
      ],
      [
        19.521667864,
        3.203205942
      ],
      [
        19.538302666,
        3.0724303
      ],
      [
        19.351656853,
        2.692009099
      ],
      [
        19.230180563,
        2.329287436
      ],
      [
        18.845579076,
        2.027217417
      ],
      [
        18.412908292,
        1.954083443
      ],
      [
        18.230179328,
        1.78496622
      ],
      [
        18.030268351,
        1.491730495
      ],
      [
        17.588380876,
        1.207406704
      ],
      [
        17.263512527,
        0.974293986
      ],
      [
        15.713982846,
        1.724121948
      ],
      [
        14.765402124,
        1.634040347
      ],
      [
        14.352898906,
        1.679766979
      ],
      [
        14.471689794,
        1.313908272
      ],
      [
        14.16619101,
        1.650059521
      ],
      [
        13.979782546,
        1.319809624
      ],
      [
        14.749290639,
        0.946642945
      ],
      [
        14.438373324,
        0.486359154
      ],
      [
        14.704320967,
        -0.152400354
      ],
      [
        14.841679177,
        -0.833600862
      ],
      [
        14.343913713,
        -1.544406636
      ],
      [
        14.348962708,
        -1.544904067
      ],
      [
        14.134356149,
        -1.298700938
      ],
      [
        14.682321941,
        -1.678140334
      ],
      [
        15.071973155,
        -1.64347246
      ],
      [
        15.85755539,
        -1.821700103
      ],
      [
        16.109439785,
        -2.142615371
      ],
      [
        16.988908841,
        -2.051541992
      ],
      [
        17.341294923,
        -1.877876102
      ],
      [
        18.124503517,
        -2.230514863
      ],
      [
        18.478270858,
        -2.12048466
      ],
      [
        19.233189961,
        -2.893066504
      ],
      [
        19.557891668,
        -3.595638446
      ],
      [
        19.646604094,
        -3.394856857
      ],
      [
        19.528201732,
        -3.695685586
      ],
      [
        19.529877111,
        -3.587699145
      ],
      [
        19.866141162,
        -4.614375425
      ],
      [
        20.169729331,
        -4.26552918
      ],
      [
        20.482986322,
        -4.36213274
      ],
      [
        20.988531633,
        -4.518228205
      ],
      [
        20.989677777,
        -5.16954614
      ],
      [
        20.794129506,
        -4.987831856
      ],
      [
        20.837398173,
        -4.879182453
      ],
      [
        20.390002389,
        -4.523018865
      ],
      [
        20.481928895,
        -4.208543486
      ],
      [
        20.476315298,
        -4.091651733
      ],
      [
        20.248054832,
        -4.393676817
      ],
      [
        19.922748293,
        -4.009490716
      ],
      [
        19.70752645,
        -3.795091538
      ],
      [
        19.207981028,
        -3.761022239
      ],
      [
        18.96021583,
        -3.594156526
      ],
      [
        18.323730212,
        -3.117399942
      ],
      [
        18.208761428,
        -3.202314454
      ],
      [
        17.496687977,
        -3.174172142
      ],
      [
        17.366000957,
        -2.815256971
      ],
      [
        16.800629877,
        -2.683153938
      ],
      [
        16.35566998,
        -2.294431929
      ],
      [
        15.852599438,
        -2.161633926
      ],
      [
        15.157240576,
        -1.969344016
      ],
      [
        14.401357318,
        -2.035265468
      ],
      [
        13.398058366,
        -2.028991047
      ],
      [
        12.134691628,
        -1.773698922
      ],
      [
        11.622521786,
        -0.929110495
      ],
      [
        10.979546314,
        -0.459941569
      ]
    ],
    [
      [
        -22.772743175,
        4.441772322
      ],
      [
        -22.574038374,
        5.440643023
      ],
      [
        -21.758126743,
        5.950543635
      ],
      [
        -22.059297209,
        6.709307914
      ],
      [
        -21.89286847,
        7.701114447
      ],
      [
        -21.592435488,
        8.674236381
      ],
      [
        -21.193182431,
        9.607248739
      ],
      [
        -20.73045647,
        10.514503367
      ],
      [
        -20.248027539,
        11.215494708
      ],
      [
        -19.625067567,
        11.752376119
      ],
      [
        -19.558973513,
        12.724401851
      ],
      [
        -18.992306373,
        13.556573625
      ],
      [
        -18.469428493,
        14.391786318
      ],
      [
        -17.737713928,
        15.100178617
      ],
      [
        -17.07268251,
        15.835964387
      ],
      [
        -16.441799225,
        16.549785484
      ],
      [
        -15.64789931,
        17.099002428
      ],
      [
        -14.769134193,
        17.608600705
      ],
      [
        -13.750944416,
        17.631313128
      ],
      [
        -12.739295652,
        17.607129605
      ],
      [
        -11.766173718,
        17.306696622
      ],
      [
        -10.960251394,
        17.866804071
      ],
      [
        -10.107526456,
        18.36470479
      ],
      [
        -9.21101245,
        18.768798019
      ],
      [
        -8.706429798,
        19.637820291
      ],
      [
        -8.278893937,
        20.553741375
      ],
      [
        -7.608942267,
        21.316370522
      ],
      [
        -7.089349607,
        22.119096156
      ],
      [
        -6.135647951,
        22.454562533
      ],
      [
        -5.234081161,
        22.854102025
      ],
      [
        -4.236326817,
        23.036205822
      ],
      [
        -3.439969281,
        22.603557124
      ],
      [
        -2.815649761,
        22.961592086
      ],
      [
        -1.96501127,
        23.242341944
      ],
      [
        -0.946821493,
        23.265054368
      ],
      [
        0.071368283,
        23.287766791
      ],
      [
        1.089558061,
        23.310479214
      ],
      [
        2.002796643,
        23.142705616
      ],
      [
        2.618150895,
        22.494347275
      ],
      [
        3.514324975,
        22.855242908
      ],
      [
        4.510566622,
        22.764861824
      ],
      [
        5.476259764,
        22.513934369
      ],
      [
        6.410438278,
        22.129915478
      ],
      [
        7.378867581,
        21.81507615
      ],
      [
        8.279940024,
        21.41188634
      ],
      [
        9.117344822,
        20.853399992
      ],
      [
        9.909675321,
        20.328130023
      ],
      [
        10.255887998,
        19.388938057
      ],
      [
        9.81815659,
        18.592690531
      ],
      [
        9.261991807,
        17.78021629
      ],
      [
        8.32662093,
        18.00270508
      ],
      [
        7.408842527,
        18.384194831
      ],
      [
        6.463599539,
        18.717853815
      ],
      [
        5.530498632,
        19.125867108
      ],
      [
        4.597397724,
        19.5338804
      ],
      [
        3.61232967,
        19.787891709
      ],
      [
        2.62266699,
        20.02829565
      ],
      [
        1.604846873,
        20.035855524
      ],
      [
        0.586406569,
        20.038286043
      ],
      [
        -0.432033735,
        20.040716562
      ],
      [
        -1.450474039,
        20.04314708
      ],
      [
        -2.468914343,
        20.045577599
      ],
      [
        -3.474024174,
        19.888777628
      ],
      [
        -4.477892551,
        19.717096072
      ],
      [
        -5.481760929,
        19.545414516
      ],
      [
        -6.425489385,
        19.206042163
      ],
      [
        -7.309844302,
        18.700936527
      ],
      [
        -8.231670727,
        18.331345076
      ],
      [
        -9.179625493,
        17.999645579
      ],
      [
        -10.100757844,
        17.590093039
      ],
      [
        -10.935721055,
        17.02930873
      ],
      [
        -11.726827309,
        16.388411544
      ],
      [
        -12.547676853,
        15.869453177
      ],
      [
        -13.369760372,
        15.309508617
      ],
      [
        -14.067580655,
        14.567744713
      ],
      [
        -14.765400938,
        13.825980809
      ],
      [
        -15.463221221,
        13.084216907
      ],
      [
        -16.08369549,
        12.32116625
      ],
      [
        -16.692662156,
        11.542633615
      ],
      [
        -17.166957743,
        10.744453601
      ],
      [
        -17.716740047,
        9.926532039
      ],
      [
        -18.10316,
        9.018162694
      ],
      [
        -18.459000108,
        8.10090543
      ],
      [
        -18.676575444,
        7.106605166
      ],
      [
        -19.091102035,
        6.181330572
      ],
      [
        -19.340701136,
        5.197676154
      ],
      [
        -19.545859737,
        4.200111401
      ],
      [
        -19.751018337,
        3.202546647
      ],
      [
        -19.79376301,
        2.190282713
      ],
      [
        -19.771050587,
        1.172092936
      ],
      [
        -20.417493321,
        0.713299765
      ],
      [
        -21.237299384,
        0.231127864
      ],
      [
        -21.679389193,
        0.72132546
      ],
      [
        -22.207450769,
        1.556018619
      ],
      [
        -22.727318329,
        2.405392768
      ],
      [
        -22.750030753,
        3.423582545
      ]
    ],
    [
      [
        -22.600320439,
        -3.258242969
      ],
      [
        -22.373189738,
        -2.302572928
      ],
      [
        -21.978700355,
        -1.604997819
      ],
      [
        -21.354252926,
        -1.164696073
      ],
      [
        -20.733156357,
        -1.182511391
      ],
      [
        -20.171286403,
        -1.685180569
      ],
      [
        -19.70501858,
        -2.370322271
      ],
      [
        -19.551008383,
        -3.361572996
      ],
      [
        -19.384137086,
        -4.350661932
      ],
      [
        -19.195246284,
        -5.336022403
      ],
      [
        -18.961061474,
        -6.311097692
      ],
      [
        -18.675939776,
        -7.270112468
      ],
      [
        -18.322788735,
        -8.197952113
      ],
      [
        -17.908903202,
        -9.075029005
      ],
      [
        -17.403630317,
        -9.910119045
      ],
      [
        -16.826348593,
        -10.685350283
      ],
      [
        -16.325182862,
        -11.492920783
      ],
      [
        -15.7249067,
        -12.249942003
      ],
      [
        -15.165991536,
        -13.046987163
      ],
      [
        -14.544676775,
        -13.766374132
      ],
      [
        -13.790863266,
        -14.416716005
      ],
      [
        -13.083077666,
        -15.039639822
      ],
      [
        -12.332839124,
        -15.698038862
      ],
      [
        -11.491440658,
        -16.214571709
      ],
      [
        -10.727229248,
        -16.814812809
      ],
      [
        -9.885344157,
        -17.266883192
      ],
      [
        -9.23170189,
        -17.993556332
      ],
      [
        -8.24149066,
        -18.14322278
      ],
      [
        -7.473206624,
        -18.708670094
      ],
      [
        -6.485635741,
        -18.87556375
      ],
      [
        -5.535185158,
        -19.162662174
      ],
      [
        -4.55528471,
        -19.381582571
      ],
      [
        -3.571791365,
        -19.579197153
      ],
      [
        -2.582509146,
        -19.74248381
      ],
      [
        -1.620467249,
        -19.923175969
      ],
      [
        -0.620706891,
        -19.942154815
      ],
      [
        0.380036339,
        -19.938485248
      ],
      [
        1.376501424,
        -19.841865676
      ],
      [
        2.36732982,
        -19.685228396
      ],
      [
        3.349971425,
        -19.487293607
      ],
      [
        4.32519991,
        -19.258954652
      ],
      [
        5.298538015,
        -19.022736409
      ],
      [
        6.256101241,
        -18.720766867
      ],
      [
        7.174475993,
        -18.331143577
      ],
      [
        8.041410632,
        -18.024520556
      ],
      [
        8.787308084,
        -18.10334514
      ],
      [
        9.508374904,
        -18.148788523
      ],
      [
        9.526711859,
        -18.878059273
      ],
      [
        9.770535018,
        -19.491690322
      ],
      [
        9.171498063,
        -20.16907225
      ],
      [
        8.535551477,
        -20.89543492
      ],
      [
        7.787605793,
        -21.488944487
      ],
      [
        6.907366602,
        -21.700934928
      ],
      [
        6.085649964,
        -21.831967275
      ],
      [
        5.352110582,
        -22.340780445
      ],
      [
        4.459787684,
        -22.204443302
      ],
      [
        3.69552909,
        -22.610503921
      ],
      [
        2.759395885,
        -22.839579736
      ],
      [
        1.77205871,
        -23.012322137
      ],
      [
        0.927489221,
        -22.787405412
      ],
      [
        0.034031602,
        -22.925790625
      ],
      [
        -0.844921433,
        -23.030619319
      ],
      [
        -1.697084704,
        -22.770677142
      ],
      [
        -2.578098734,
        -22.978234055
      ],
      [
        -3.569220322,
        -22.845147453
      ],
      [
        -4.517785492,
        -22.606758241
      ],
      [
        -5.466546755,
        -22.349728648
      ],
      [
        -6.414747366,
        -22.047839184
      ],
      [
        -7.222844694,
        -21.642067839
      ],
      [
        -7.940569229,
        -21.044139053
      ],
      [
        -8.509902577,
        -20.289056656
      ],
      [
        -8.94121191,
        -19.4282958
      ],
      [
        -9.686622758,
        -18.938980589
      ],
      [
        -10.175925062,
        -18.128885395
      ],
      [
        -11.090442963,
        -17.902199372
      ],
      [
        -12.015161142,
        -17.638593952
      ],
      [
        -12.96594843,
        -17.443326897
      ],
      [
        -13.966027995,
        -17.354982629
      ],
      [
        -14.846259664,
        -17.010841814
      ],
      [
        -15.731697167,
        -16.693843811
      ],
      [
        -16.46895719,
        -16.154788605
      ],
      [
        -17.025600839,
        -15.42161005
      ],
      [
        -17.553456105,
        -14.774085005
      ],
      [
        -18.086396348,
        -14.155960955
      ],
      [
        -18.525887561,
        -13.431100852
      ],
      [
        -19.163539285,
        -12.831041938
      ],
      [
        -19.732884654,
        -12.042614723
      ],
      [
        -20.266082058,
        -11.198295837
      ],
      [
        -20.341039384,
        -10.265794028
      ],
      [
        -20.920993393,
        -9.591654141
      ],
      [
        -21.093123046,
        -8.803283912
      ],
      [
        -21.48732384,
        -8.004680947
      ],
      [
        -21.931964176,
        -7.186163516
      ],
      [
        -22.190618214,
        -6.21958049
      ],
      [
        -22.382664314,
        -5.239472984
      ],
      [
        -22.443512553,
        -4.238019517
      ]
    ]
  ],
  "provenanceHashes": [
    "96d0ddd32cc660af31bedf4fb52552d54505169efb7887862bd9943c4f73d5b6",
    "17269a09c5a56b3c2e62683836781126421e30bfb9dce5599ff8f53667808b4d"
  ]
} as const satisfies LauncherTemplate;
