import { DecompositionError, type LathedProfile } from './types';

function validProfile(profile: LathedProfile): boolean {
  return Array.isArray(profile?.samples) && profile.samples.length >= 2 && profile.samples.every((sample, index) =>
    Number.isFinite(sample?.z) && Number.isFinite(sample?.radius) && sample.radius >= 0 && (index === 0 || sample.z > profile.samples[index - 1].z));
}

function radiusAt(profile: LathedProfile, z: number): number {
  let low = 1, high = profile.samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (profile.samples[middle].z < z) low = middle + 1; else high = middle;
  }
  const right = profile.samples[low], left = profile.samples[low - 1];
  return left.radius + (right.radius - left.radius) * (z - left.z) / (right.z - left.z);
}

/** Exact minimum of a piecewise-linear lathed profile over a closed interval. */
export function minimumRadiusOverInterval(profile: LathedProfile, z0: number, z1: number): number {
  if (!validProfile(profile) || !Number.isFinite(z0) || !Number.isFinite(z1) || z0 > z1 || z0 < profile.samples[0].z || z1 > profile.samples.at(-1)!.z) {
    throw new DecompositionError('PROFILE', 'Radius interval must be ordered and contained by a valid profile');
  }
  let minimum = Math.min(radiusAt(profile, z0), radiusAt(profile, z1));
  for (const sample of profile.samples) {
    if (sample.z > z0 && sample.z < z1) minimum = Math.min(minimum, sample.radius);
  }
  return minimum;
}
