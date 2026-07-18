import type { Vec3 } from '../types';

export type SurfaceSample = {
  readonly point: Vec3;
  readonly weight: number;
};

export type RadialSymmetry = {
  readonly radialRmsError: number;
  readonly centroidOffset: number;
  readonly confidence: number;
};

export function radialSymmetry(
  samples: readonly SurfaceSample[],
  origin: Vec3,
  direction: Vec3,
): RadialSymmetry {
  const helper: Vec3 = Math.abs(direction[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0];
  const dot = helper[0] * direction[0] + helper[1] * direction[1] + helper[2] * direction[2];
  const rawU: Vec3 = [helper[0] - dot * direction[0], helper[1] - dot * direction[1], helper[2] - dot * direction[2]];
  const uLength = Math.hypot(rawU[0], rawU[1], rawU[2]);
  const u: Vec3 = [rawU[0] / uLength, rawU[1] / uLength, rawU[2] / uLength];
  const v: Vec3 = [
    direction[1] * u[2] - direction[2] * u[1],
    direction[2] * u[0] - direction[0] * u[2],
    direction[0] * u[1] - direction[1] * u[0],
  ];
  const projected = samples.map(({ point: [x, y, z], weight }) => {
    const dx = x - origin[0];
    const dy = y - origin[1];
    const dz = z - origin[2];
    const axial = dx * direction[0] + dy * direction[1] + dz * direction[2];
    const pu = dx * u[0] + dy * u[1] + dz * u[2];
    const pv = dx * v[0] + dy * v[1] + dz * v[2];
    return { axial, radius: Math.hypot(pu, pv), pu, pv, weight };
  });
  let minAxial = Infinity;
  let maxAxial = -Infinity;
  let totalWeight = 0;
  let weightedRadiusSquared = 0;
  for (const point of projected) {
    minAxial = Math.min(minAxial, point.axial);
    maxAxial = Math.max(maxAxial, point.axial);
    totalWeight += point.weight;
    weightedRadiusSquared += point.weight * point.radius * point.radius;
  }
  const transverseScale = Math.max(Number.MIN_VALUE, Math.sqrt(weightedRadiusSquared / totalWeight));
  const axialSpan = Math.max(Number.MIN_VALUE, maxAxial - minAxial);
  const binCount = Math.max(4, Math.min(32, Math.round(Math.sqrt(projected.length))));
  const angularSectorCount = 16;
  const weightSums = new Float64Array(binCount);
  const radiusSums = new Float64Array(binCount);
  const radiusSquaredSums = new Float64Array(binCount);
  const sectorWeights = new Float64Array(binCount * angularSectorCount);
  const sectorRadiusSums = new Float64Array(binCount * angularSectorCount);
  let meanU = 0;
  let meanV = 0;
  let varianceU = 0;
  let varianceV = 0;
  for (const point of projected) {
    const bin = Math.min(binCount - 1, Math.floor((point.axial - minAxial) / axialSpan * binCount));
    weightSums[bin] += point.weight;
    radiusSums[bin] += point.weight * point.radius;
    radiusSquaredSums[bin] += point.weight * point.radius * point.radius;
    const angle = Math.atan2(point.pv, point.pu);
    const sector = Math.min(angularSectorCount - 1, Math.floor((angle + Math.PI) / (2 * Math.PI) * angularSectorCount));
    const sectorIndex = bin * angularSectorCount + sector;
    sectorWeights[sectorIndex] += point.weight;
    sectorRadiusSums[sectorIndex] += point.weight * point.radius;
    meanU += point.weight * point.pu;
    meanV += point.weight * point.pv;
    varianceU += point.weight * point.pu * point.pu;
    varianceV += point.weight * point.pv * point.pv;
  }
  meanU /= totalWeight;
  meanV /= totalWeight;
  varianceU = varianceU / totalWeight - meanU * meanU;
  varianceV = varianceV / totalWeight - meanV * meanV;
  let radialResidual = 0;
  let angularResidual = 0;
  let angularCount = 0;
  for (let bin = 0; bin < binCount; bin += 1) {
    if (weightSums[bin] > 0) {
      radialResidual += Math.max(0, radiusSquaredSums[bin] - radiusSums[bin] ** 2 / weightSums[bin]);
    }
    let occupied = 0;
    let representativeSum = 0;
    let representativeSquaredSum = 0;
    for (let sector = 0; sector < angularSectorCount; sector += 1) {
      const index = bin * angularSectorCount + sector;
      if (sectorWeights[index] === 0) continue;
      const representative = sectorRadiusSums[index] / sectorWeights[index];
      occupied += 1;
      representativeSum += representative;
      representativeSquaredSum += representative * representative;
    }
    if (occupied >= 4) {
      angularResidual += Math.max(0, representativeSquaredSum - representativeSum ** 2 / occupied);
      angularCount += occupied;
    }
  }
  const axialRadialError = Math.sqrt(radialResidual / totalWeight) / transverseScale;
  const angularError = Math.sqrt(angularResidual / Math.max(1, angularCount)) / transverseScale;
  const radialRmsError = Math.hypot(axialRadialError, angularError);
  const centroidOffset = Math.hypot(meanU, meanV) / transverseScale;
  const transverseAnisotropy = Math.abs(varianceU - varianceV) / Math.max(Number.MIN_VALUE, varianceU + varianceV);
  const samplingFloor = 1 / Math.sqrt(samples.length);
  const rawConfidence = Math.exp(
    -1.8 * Math.max(0, radialRmsError - samplingFloor)
    -2.5 * Math.max(0, transverseAnisotropy - samplingFloor)
    -4 * Math.max(0, centroidOffset - samplingFloor),
  );
  const samplingReliability = Math.min(1, samples.length / 256);
  const confidence = Math.max(0, Math.min(
    1,
    samplingReliability * rawConfidence + (1 - samplingReliability) * 0.5,
  ));
  return { radialRmsError, centroidOffset, confidence };
}
