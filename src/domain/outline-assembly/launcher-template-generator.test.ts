import { describe, expect, it, vi } from 'vitest';
import type { TriangleMesh } from '../mesh/types';
import { generateLauncherTemplateFromMeshes } from '../../../scripts/launcher-template-generator';

const emptyMesh: TriangleMesh = {
  positions: new Float64Array(),
  indices: new Uint32Array(),
};

describe('launcher template generator budget boundary', () => {
  it('checks one caller deadline before axis or projection work begins', () => {
    const checkpoint = vi.fn();
    expect(() => generateLauncherTemplateFromMeshes([
      { mesh: emptyMesh, provenanceHash: 'a'.repeat(64) },
      { mesh: emptyMesh, provenanceHash: 'b'.repeat(64) },
    ], { deadline: Date.now() - 1, checkpoint })).toThrow(/runtime budget/i);
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });

  it('propagates caller cancellation without entering mesh analysis', () => {
    expect(() => generateLauncherTemplateFromMeshes([
      { mesh: emptyMesh, provenanceHash: 'a'.repeat(64) },
      { mesh: emptyMesh, provenanceHash: 'b'.repeat(64) },
    ], { deadline: Infinity, checkpoint: () => { throw new Error('generator cancelled'); } }))
      .toThrow(/generator cancelled/);
  });
});
