import type { Vec3 } from '../types';

export type RadialSymmetry = {
  readonly radialRmsError: number;
  readonly centroidOffset: number;
  readonly confidence: number;
};

export function radialSymmetry(
  points: readonly Vec3[],
  origin: Vec3,
  direction: Vec3,
): RadialSymmetry {
  const projected = points.map(([x, y, z]) => {
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];
    const axial = dx * direction[0] + dy * direction[1] + dz * direction[2];
    const squaredDistance = dx * dx + dy * dy + dz * dz;
    return { axial, radius: Math.sqrt(Math.max(0, squaredDistance - axial * axial)), dx, dy, dz };
  });
  const minAxial = Math.min(...projected.map(({ axial }) => axial));
  const maxAxial = Math.max(...projected.map(({ axial }) => axial));
  const scale = Math.max(Number.MIN_VALUE, ...projected.map(({ radius }) => radius), maxAxial - minAxial);
  const binCount = Math.max(4, Math.min(32, Math.round(Math.sqrt(projected.length))));
  const sums = new Float64Array(binCount);
  const squaredSums = new Float64Array(binCount);
  const counts = new Uint32Array(binCount);
  for (const point of projected) {
    const fraction = (point.axial - minAxial) / Math.max(Number.MIN_VALUE, maxAxial - minAxial);
    const bin = Math.min(binCount - 1, Math.floor(fraction * binCount));
    sums[bin] += point.radius;
    squaredSums[bin] += point.radius * point.radius;
    counts[bin] += 1;
  }
  let residual = 0;
  let residualCount = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    if (counts[bin] === 0) continue;
    residual += Math.max(0, squaredSums[bin] - sums[bin] * sums[bin] / counts[bin]);
    residualCount += counts[bin];
  }
  const radialRmsError = Math.sqrt(residual / Math.max(1, residualCount)) / scale;

  const helper: Vec3 = Math.abs(direction[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const dot = helper[0] * direction[0] + helper[1] * direction[1] + helper[2] * direction[2];
  const rawU: Vec3 = [helper[0] - dot * direction[0], helper[1] - dot * direction[1], helper[2] - dot * direction[2]];
  const uLength = Math.hypot(...rawU);
  const u: Vec3 = [rawU[0] / uLength, rawU[1] / uLength, rawU[2] / uLength];
  const v: Vec3 = [
    direction[1] * u[2] - direction[2] * u[1],
    direction[2] * u[0] - direction[0] * u[2],
    direction[0] * u[1] - direction[1] * u[0],
  ];
  let meanU = 0;
  let meanV = 0;
  let varianceU = 0;
  let varianceV = 0;
  for (const point of projected) {
    const pu = point.dx * u[0] + point.dy * u[1] + point.dz * u[2];
    const pv = point.dx * v[0] + point.dy * v[1] + point.dz * v[2];
    meanU += pu;
    meanV += pv;
    varianceU += pu * pu;
    varianceV += pv * pv;
  }
  meanU /= points.length;
  meanV /= points.length;
  varianceU = varianceU / points.length - meanU * meanU;
  varianceV = varianceV / points.length - meanV * meanV;
  const centroidOffset = Math.hypot(meanU, meanV) / scale;
  const transverseAnisotropy = Math.abs(varianceU - varianceV) / Math.max(Number.MIN_VALUE, varianceU + varianceV);
  const confidence = Math.max(0, Math.min(1, Math.exp(
    -8 * radialRmsError - 2.5 * transverseAnisotropy - 4 * centroidOffset,
  )));
  return { radialRmsError, centroidOffset, confidence };
}
