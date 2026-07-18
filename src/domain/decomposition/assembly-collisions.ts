import { DecompositionError, type JointFeature, type LathedProfile, type MaterialInput, type Part2D, type PartInstance, type Point2, type Polygon2, type SpinnerKit } from './types';

type InstanceGeometry = { readonly instance: PartInstance; readonly part: Part2D };
type RadialInterval = readonly [number, number];
type Linear = { readonly slope: number; readonly intercept: number };
type ChainSegment = { readonly minimum: number; readonly maximum: number; readonly value: Linear };
type RibBand = { readonly minimum: number; readonly maximum: number; readonly inner: Linear; readonly outer: Linear };

function cross(a: Point2, b: Point2, c: Point2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function polygonArea(polygon: readonly Point2[]): number {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const point = polygon[index], next = polygon[(index + 1) % polygon.length];
    twiceArea += point[0] * next[1] - next[0] * point[1];
  }
  return Math.abs(twiceArea) / 2;
}

function geometryScale(kit: SpinnerKit, material: MaterialInput, profile: LathedProfile): number {
  let scale = material.thicknessMm;
  for (const { z, radius } of profile.samples) scale = Math.max(scale, Math.abs(z), Math.abs(radius));
  for (const part of kit.parts) for (const polygon of [part.outline, ...part.holes]) {
    for (const [x, y] of polygon.points) scale = Math.max(scale, Math.abs(x), Math.abs(y));
  }
  for (const instance of kit.instances) scale = Math.max(scale, Math.abs(instance.axialZ));
  return scale;
}

function instanceError(left: InstanceGeometry, right: InstanceGeometry, detail: string): never {
  throw new DecompositionError(
    'JOINT',
    `Assembly collision between instances ${left.instance.id} (${left.part.id}) and ${right.instance.id} (${right.part.id}): ${detail}`,
  );
}

function axialDomain(polygon: Polygon2): RadialInterval {
  let minimum = Infinity, maximum = -Infinity;
  for (const [axial] of polygon.points) { minimum = Math.min(minimum, axial); maximum = Math.max(maximum, axial); }
  return [minimum, maximum];
}

/** Exact open scanline interval for the x-monotone rib polygons emitted by generateParts. */
function ribIntervalAt(polygon: Polygon2, axial: number): RadialInterval | undefined {
  const crossings: number[] = [];
  for (let index = 0; index < polygon.points.length; index += 1) {
    const a = polygon.points[index], b = polygon.points[(index + 1) % polygon.points.length];
    if ((a[0] <= axial && axial < b[0]) || (b[0] <= axial && axial < a[0])) {
      crossings.push(a[1] + (b[1] - a[1]) * (axial - a[0]) / (b[0] - a[0]));
    }
  }
  crossings.sort((left, right) => left - right);
  return crossings.length >= 2 && crossings.at(-1)! > crossings[0] ? [crossings[0], crossings.at(-1)!] : undefined;
}

function ribRectangle(interval: RadialInterval, angle: number, halfThickness: number): Polygon2 {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const transform = (radial: number, tangential: number): Point2 => [
    radial * cosine - tangential * sine,
    radial * sine + tangential * cosine,
  ];
  return { points: [
    transform(interval[0], -halfThickness), transform(interval[1], -halfThickness),
    transform(interval[1], halfThickness), transform(interval[0], halfThickness),
  ] };
}

function lineThrough(left: Point2, right: Point2): Linear {
  const slope = (right[1] - left[1]) / (right[0] - left[0]);
  return { slope, intercept: left[1] - slope * left[0] };
}

function lineValue(line: Linear, axial: number): number { return line.slope * axial + line.intercept; }

function chainSegments(polygon: Polygon2, step: 1 | -1): ChainSegment[] {
  const { points } = polygon;
  let minimum = 0, maximum = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index][0] < points[minimum][0] || (points[index][0] === points[minimum][0] && points[index][1] < points[minimum][1])) minimum = index;
    if (points[index][0] > points[maximum][0] || (points[index][0] === points[maximum][0] && points[index][1] < points[maximum][1])) maximum = index;
  }
  const segments: ChainSegment[] = [];
  let index = minimum;
  for (let visited = 0; index !== maximum && visited <= points.length; visited += 1) {
    const nextIndex = (index + step + points.length) % points.length;
    const start = points[index], end = points[nextIndex];
    if (end[0] < start[0]) return [];
    if (end[0] > start[0]) segments.push({ minimum: start[0], maximum: end[0], value: lineThrough(start, end) });
    index = nextIndex;
  }
  return index === maximum ? segments : [];
}

/** Piecewise-linear inner/outer intervals for the complete x-monotone rib silhouette. */
function ribBands(polygon: Polygon2): RibBand[] {
  const forward = chainSegments(polygon, 1), backward = chainSegments(polygon, -1);
  const bands: RibBand[] = [];
  let forwardIndex = 0, backwardIndex = 0;
  while (forwardIndex < forward.length && backwardIndex < backward.length) {
    const first = forward[forwardIndex], second = backward[backwardIndex];
    const minimum = Math.max(first.minimum, second.minimum), maximum = Math.min(first.maximum, second.maximum);
    if (maximum > minimum) {
      const middle = (minimum + maximum) / 2;
      const firstValue = lineValue(first.value, middle), secondValue = lineValue(second.value, middle);
      bands.push({ minimum, maximum, inner: firstValue <= secondValue ? first.value : second.value, outer: firstValue <= secondValue ? second.value : first.value });
    }
    if (first.maximum <= second.maximum) forwardIndex += 1;
    if (second.maximum <= first.maximum) backwardIndex += 1;
  }
  return bands;
}

function scaleLine(line: Linear, factor: number, constant = 0): Linear {
  return { slope: line.slope * factor, intercept: line.intercept * factor + constant };
}

function subtractLines(left: Linear, right: Linear): Linear {
  return { slope: left.slope - right.slope, intercept: left.intercept - right.intercept };
}

function rectangleProjectionRange(band: RibBand, angle: number, axis: Point2, halfThickness: number): { readonly minimum: Linear; readonly maximum: Linear } {
  const radial: Point2 = [Math.cos(angle), Math.sin(angle)], tangential: Point2 = [-radial[1], radial[0]];
  const radialProjection = radial[0] * axis[0] + radial[1] * axis[1];
  const tangentialExtent = Math.abs(tangential[0] * axis[0] + tangential[1] * axis[1]) * halfThickness;
  return radialProjection >= 0
    ? { minimum: scaleLine(band.inner, radialProjection, -tangentialExtent), maximum: scaleLine(band.outer, radialProjection, tangentialExtent) }
    : { minimum: scaleLine(band.outer, radialProjection, -tangentialExtent), maximum: scaleLine(band.inner, radialProjection, tangentialExtent) };
}

function restrictPositive(line: Linear, threshold: number, interval: { minimum: number; maximum: number }, tolerance: number): boolean {
  const slopeTolerance = Number.EPSILON * Math.max(1, Math.abs(line.slope));
  if (Math.abs(line.slope) <= slopeTolerance) return line.intercept > threshold;
  const crossing = (threshold - line.intercept) / line.slope;
  if (line.slope > 0) interval.minimum = Math.max(interval.minimum, crossing);
  else interval.maximum = Math.min(interval.maximum, crossing);
  return interval.maximum - interval.minimum > tolerance;
}

function ribBandsCollide(left: RibBand, leftAngle: number, right: RibBand, rightAngle: number, minimum: number, maximum: number, halfThickness: number, tolerance: number): boolean {
  const leftRadial: Point2 = [Math.cos(leftAngle), Math.sin(leftAngle)], leftTangential: Point2 = [-leftRadial[1], leftRadial[0]];
  const rightRadial: Point2 = [Math.cos(rightAngle), Math.sin(rightAngle)], rightTangential: Point2 = [-rightRadial[1], rightRadial[0]];
  const interval = { minimum, maximum };
  for (const axis of [leftRadial, leftTangential, rightRadial, rightTangential]) {
    const leftRange = rectangleProjectionRange(left, leftAngle, axis, halfThickness);
    const rightRange = rectangleProjectionRange(right, rightAngle, axis, halfThickness);
    if (!restrictPositive(subtractLines(leftRange.maximum, rightRange.minimum), tolerance, interval, tolerance)
      || !restrictPositive(subtractLines(rightRange.maximum, leftRange.minimum), tolerance, interval, tolerance)) return false;
  }
  return interval.maximum - interval.minimum > tolerance;
}

function ribPairCollides(left: InstanceGeometry, right: InstanceGeometry, leftBands: readonly RibBand[], rightBands: readonly RibBand[], halfThickness: number, tolerance: number): boolean {
  let leftIndex = 0, rightIndex = 0;
  while (leftIndex < leftBands.length && rightIndex < rightBands.length) {
    const leftBand = leftBands[leftIndex], rightBand = rightBands[rightIndex];
    const minimum = Math.max(leftBand.minimum, rightBand.minimum), maximum = Math.min(leftBand.maximum, rightBand.maximum);
    if (maximum - minimum > tolerance && ribBandsCollide(
      leftBand, left.instance.angleRad ?? 0, rightBand, right.instance.angleRad ?? 0,
      minimum, maximum, halfThickness, tolerance,
    )) return true;
    if (leftBand.maximum <= rightBand.maximum) leftIndex += 1;
    if (rightBand.maximum <= leftBand.maximum) rightIndex += 1;
  }
  return false;
}

function convexContains(container: Polygon2, contained: Polygon2, tolerance: number): boolean {
  let twiceArea = 0;
  for (let index = 0; index < container.points.length; index += 1) {
    const a = container.points[index], b = container.points[(index + 1) % container.points.length];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  const winding = Math.sign(twiceArea);
  if (winding === 0) return false;
  for (const point of contained.points) {
    for (let index = 0; index < container.points.length; index += 1) {
      const a = container.points[index], b = container.points[(index + 1) % container.points.length];
      if (winding * cross(a, b, point) < -tolerance * Math.hypot(b[0] - a[0], b[1] - a[1])) return false;
    }
  }
  return true;
}

function lineIntersection(start: Point2, end: Point2, clipStart: Point2, clipEnd: Point2): Point2 {
  const sx = end[0] - start[0], sy = end[1] - start[1];
  const cx = clipEnd[0] - clipStart[0], cy = clipEnd[1] - clipStart[1];
  const denominator = sx * cy - sy * cx;
  if (denominator === 0) return end;
  const t = ((clipStart[0] - start[0]) * cy - (clipStart[1] - start[1]) * cx) / denominator;
  return [start[0] + t * sx, start[1] + t * sy];
}

function clipConvex(subjectValue: Polygon2, clipValue: Polygon2, tolerance: number): Point2[] {
  let output = [...subjectValue.points];
  let clipTwiceArea = 0;
  for (let index = 0; index < clipValue.points.length; index += 1) {
    const point = clipValue.points[index], next = clipValue.points[(index + 1) % clipValue.points.length];
    clipTwiceArea += point[0] * next[1] - next[0] * point[1];
  }
  const winding = Math.sign(clipTwiceArea);
  for (let clipIndex = 0; clipIndex < clipValue.points.length && output.length > 0; clipIndex += 1) {
    const clipStart = clipValue.points[clipIndex], clipEnd = clipValue.points[(clipIndex + 1) % clipValue.points.length];
    const edgeTolerance = tolerance * Math.hypot(clipEnd[0] - clipStart[0], clipEnd[1] - clipStart[1]);
    const input = output; output = [];
    let start = input.at(-1)!;
    for (const end of input) {
      const startInside = winding * cross(clipStart, clipEnd, start) >= -edgeTolerance;
      const endInside = winding * cross(clipStart, clipEnd, end) >= -edgeTolerance;
      if (endInside) {
        if (!startInside) output.push(lineIntersection(start, end, clipStart, clipEnd));
        output.push(end);
      } else if (startInside) output.push(lineIntersection(start, end, clipStart, clipEnd));
      start = end;
    }
  }
  return output;
}

function convexMaterialOverlapArea(rectangle: Polygon2, horizontal: Part2D, tolerance: number): number {
  const outer = clipConvex(rectangle, horizontal.outline, tolerance);
  let materialArea = outer.length >= 3 ? polygonArea(outer) : 0;
  for (const hole of horizontal.holes) {
    const clippedHole = clipConvex(rectangle, hole, tolerance);
    if (clippedHole.length >= 3) materialArea -= polygonArea(clippedHole);
  }
  return Math.max(0, materialArea);
}

function overlapSamples(polygon: Polygon2, minimum: number, maximum: number, tolerance: number): number[] {
  const breakpoints = [minimum, maximum, ...polygon.points.map(([axial]) => axial).filter((axial) => axial > minimum && axial < maximum)]
    .sort((left, right) => left - right)
    .filter((value, index, values) => index === 0 || value !== values[index - 1]);
  const samples: number[] = [];
  for (let index = 0; index + 1 < breakpoints.length; index += 1) {
    const width = breakpoints[index + 1] - breakpoints[index];
    if (width > tolerance) {
      const inset = Math.min(width / 4, Math.max(tolerance * 4, width * Number.EPSILON));
      samples.push(breakpoints[index] + inset, (breakpoints[index] + breakpoints[index + 1]) / 2, breakpoints[index + 1] - inset);
    }
  }
  return samples;
}

function jointFor(kit: SpinnerKit, horizontal: PartInstance, rib: PartInstance): JointFeature | undefined {
  return kit.joints.find((feature) => feature.role === 'slot' && feature.partInstanceId === horizontal.id && feature.mateInstanceId === rib.id);
}

function ribHorizontalCollides(kit: SpinnerKit, rib: InstanceGeometry, horizontal: InstanceGeometry, halfThickness: number, tolerance: number): boolean {
  const [ribMinimum, ribMaximum] = axialDomain(rib.part.outline);
  const slabMinimum = horizontal.instance.axialZ - halfThickness, slabMaximum = horizontal.instance.axialZ + halfThickness;
  const minimum = Math.max(ribMinimum, slabMinimum), maximum = Math.min(ribMaximum, slabMaximum);
  if (maximum - minimum <= tolerance) return false;
  const slot = jointFor(kit, horizontal.instance, rib.instance);
  if (slot) {
    const frameHalfWidth = slot.frame.tangentialWidth / 2;
    if (Math.abs(horizontal.instance.axialZ - slot.frame.axialZ) + halfThickness > frameHalfWidth + tolerance) return true;
    const inset = Math.min((maximum - minimum) / 4, Math.max(tolerance * 4, (maximum - minimum) * 1e-9));
    const samples = [(minimum + maximum) / 2, minimum + inset, maximum - inset];
    for (const axial of samples) {
      const interval = ribIntervalAt(rib.part.outline, axial);
      if (interval && !convexContains(slot.polygon, ribRectangle(interval, rib.instance.angleRad ?? 0, halfThickness), tolerance)) return true;
    }
    return false;
  }
  if (horizontal.part.kind !== 'spacer') return true;
  let ribInner = Infinity, horizontalOuter = -Infinity;
  for (const [, radial] of rib.part.outline.points) ribInner = Math.min(ribInner, radial);
  for (const [x, y] of horizontal.part.outline.points) horizontalOuter = Math.max(horizontalOuter, Math.hypot(x, y));
  if (ribInner >= horizontalOuter - tolerance) return false;
  const areaTolerance = Math.max(Number.MIN_VALUE, tolerance * tolerance);
  for (const axial of overlapSamples(rib.part.outline, minimum, maximum, tolerance)) {
    const interval = ribIntervalAt(rib.part.outline, axial);
    if (interval && convexMaterialOverlapArea(ribRectangle(interval, rib.instance.angleRad ?? 0, halfThickness), horizontal.part, tolerance) > areaTolerance) return true;
  }
  return false;
}

function normalizeAngle(angle: number): number {
  const full = Math.PI * 2, result = angle % full;
  return result < 0 ? result + full : result;
}

function radialBoundaryAt(polygon: Polygon2, angle: number, tolerance: number): number | undefined {
  const direction: Point2 = [Math.cos(angle), Math.sin(angle)];
  let maximum = -Infinity;
  for (let index = 0; index < polygon.points.length; index += 1) {
    const start = polygon.points[index], end = polygon.points[(index + 1) % polygon.points.length];
    const edge: Point2 = [end[0] - start[0], end[1] - start[1]];
    const denominator = direction[0] * edge[1] - direction[1] * edge[0];
    if (Math.abs(denominator) <= tolerance) continue;
    const segmentT = (start[0] * direction[1] - start[1] * direction[0]) / denominator;
    const radius = (start[0] * edge[1] - start[1] * edge[0]) / denominator;
    if (segmentT >= -tolerance && segmentT <= 1 + tolerance && radius >= -tolerance) maximum = Math.max(maximum, radius);
  }
  return Number.isFinite(maximum) ? maximum : undefined;
}

function materialRadialInterval(part: Part2D, angle: number, tolerance: number): RadialInterval | undefined {
  const outer = radialBoundaryAt(part.outline, angle, tolerance);
  if (outer === undefined) return undefined;
  let inner = 0;
  for (const hole of part.holes) inner = Math.max(inner, radialBoundaryAt(hole, angle, tolerance) ?? 0);
  return outer - inner > tolerance ? [inner, outer] : undefined;
}

function horizontalRadialOverlap(left: Part2D, right: Part2D, tolerance: number): boolean {
  const angularTolerance = 128 * Number.EPSILON;
  const angles = [left.outline, ...left.holes, right.outline, ...right.holes]
    .flatMap((polygon) => polygon.points.map(([x, y]) => normalizeAngle(Math.atan2(y, x))))
    .sort((a, b) => a - b)
    .filter((value, index, values) => index === 0 || value - values[index - 1] > angularTolerance);
  if (angles.length === 0) return false;
  for (let index = 0; index < angles.length; index += 1) {
    const start = angles[index], end = index + 1 < angles.length ? angles[index + 1] : angles[0] + Math.PI * 2;
    const width = end - start;
    if (width <= angularTolerance) continue;
    const inset = Math.min(width / 4, Math.max(angularTolerance * 4, width * Number.EPSILON));
    for (const rawAngle of [start + inset, (start + end) / 2, end - inset]) {
      const angle = normalizeAngle(rawAngle);
      const leftInterval = materialRadialInterval(left, angle, tolerance), rightInterval = materialRadialInterval(right, angle, tolerance);
      if (leftInterval && rightInterval && Math.min(leftInterval[1], rightInterval[1]) - Math.max(leftInterval[0], rightInterval[0]) > tolerance) return true;
    }
  }
  return false;
}

/**
 * Production collision gate for the specialized assembly solids:
 * radial-plane rib slabs, horizontal extrusions, and their actual open-notch polygons.
 */
export function validateAssemblyCollisions(kit: SpinnerKit, material: MaterialInput, profile: LathedProfile): void {
  const partById = new Map(kit.parts.map((part) => [part.id, part]));
  const geometries: InstanceGeometry[] = kit.instances.map((instance) => {
    const part = partById.get(instance.partId);
    if (!part) throw new DecompositionError('JOINT', `Assembly instance ${instance.id} references missing part ${instance.partId}`);
    return { instance, part };
  });
  const scale = geometryScale(kit, material, profile);
  const tolerance = Math.max(Number.MIN_VALUE, scale * 128 * Number.EPSILON);
  const halfThickness = material.thicknessMm / 2;
  const ribs = geometries.filter(({ part }) => part.kind === 'rib');
  const horizontal = geometries.filter(({ part }) => part.kind !== 'rib');
  const bandsByOutline = new Map<Polygon2, readonly RibBand[]>();
  const bandsFor = (polygon: Polygon2): readonly RibBand[] => {
    let bands = bandsByOutline.get(polygon);
    if (!bands) { bands = ribBands(polygon); bandsByOutline.set(polygon, bands); }
    return bands;
  };

  for (let left = 0; left < ribs.length; left += 1) for (let right = left + 1; right < ribs.length; right += 1) {
    if (ribPairCollides(ribs[left], ribs[right], bandsFor(ribs[left].part.outline), bandsFor(ribs[right].part.outline), halfThickness, tolerance)) {
      instanceError(ribs[left], ribs[right], 'rib slabs have positive-volume overlap');
    }
  }
  for (const rib of ribs) for (const plate of horizontal) {
    if (ribHorizontalCollides(kit, rib, plate, halfThickness, tolerance)) instanceError(rib, plate, 'rib and horizontal solid overlap outside their actual joint cut');
  }
  for (let left = 0; left < horizontal.length; left += 1) for (let right = left + 1; right < horizontal.length; right += 1) {
    const axialOverlap = material.thicknessMm - Math.abs(horizontal[left].instance.axialZ - horizontal[right].instance.axialZ);
    if (axialOverlap > tolerance && horizontalRadialOverlap(horizontal[left].part, horizontal[right].part, tolerance)) {
      instanceError(horizontal[left], horizontal[right], 'horizontal slabs and actual radial material intervals overlap');
    }
  }
}
