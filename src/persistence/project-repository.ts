import { z } from 'zod';
import type { Axis, WorkflowStep } from '../domain/types';
import type { WizardSettings } from '../app/project-store';
import { createMaterialDatabase, type MaterialDatabase } from './database';

const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const AxisSchema = z.object({ origin: Vec3Schema, direction: Vec3Schema.refine((direction) => Math.hypot(...direction) > 0, 'Axis direction must be non-zero'), confidence: z.number().finite().min(0).max(1), confirmed: z.boolean() }).strict();
const StoredRepairSchema = z.object({
  mode: z.enum(['safe', 'advanced']),
  algorithmVersion: z.string().trim().min(1).max(200),
  meshSha256: z.string().regex(/^[0-9a-f]{64}$/i, 'Invalid repaired mesh SHA-256').transform((value) => value.toLowerCase()),
}).strict();
const SettingsSchema = z.object({
  splitPositionPercent: z.number().finite().min(10).max(90),
  ribCount: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
  ringLayers: z.number().int().min(1).max(24),
  shaftMm: z.number().finite().positive(),
  fit: z.enum(['loose', 'slip', 'snug', 'press']),
  materialId: z.string().trim().min(1).max(500),
  engravingLevels: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  textureStrength: z.number().finite().min(0).max(1),
  sheetWidthMm: z.number().finite().positive(),
  sheetHeightMm: z.number().finite().positive(),
}).strict();
const StoredProjectBaseSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().trim().min(1).max(500), name: z.string().trim().min(1).max(500),
  step: z.enum(['import', 'axis', 'decomposition', 'engraving', 'export']), axis: AxisSchema.optional(), settings: SettingsSchema,
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/i, 'Invalid source SHA-256').transform((value) => value.toLowerCase()),
  repair: StoredRepairSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
const StoredProjectSchema = StoredProjectBaseSchema.superRefine((project, context) => {
  if (['decomposition', 'engraving', 'export'].includes(project.step) && project.axis?.confirmed !== true) {
    context.addIssue({ code: 'custom', path: ['axis'], message: 'This workflow step requires a confirmed axis.' });
  }
  if (project.step !== 'import' && !project.repair) {
    context.addIssue({ code: 'custom', path: ['repair'], message: 'Downstream workflow state requires repair provenance and repaired mesh fingerprint.' });
  }
});

export type StoredRepairV1 = {
  readonly mode: 'safe' | 'advanced';
  readonly algorithmVersion: string;
  readonly meshSha256: string;
};

export type StoredProjectV1 = {
  readonly schemaVersion: 1; readonly id: string; readonly name: string; readonly step: WorkflowStep;
  readonly axis?: Axis; readonly settings: WizardSettings; readonly sourceSha256: string; readonly repair?: StoredRepairV1; readonly updatedAt: string;
};

function parseStoredProject(value: unknown): StoredProjectV1 {
  const parsed = StoredProjectBaseSchema.parse(value) as StoredProjectV1;
  if (parsed.step !== 'import' && !parsed.repair) {
    return { ...parsed, step: 'import', axis: undefined };
  }
  return StoredProjectSchema.parse(parsed) as StoredProjectV1;
}

export async function sha256Hex(input: Blob | ArrayBuffer | ArrayBufferView): Promise<string> {
  let bytes: ArrayBuffer;
  if (input instanceof Blob) bytes = await input.arrayBuffer();
  else if (input instanceof ArrayBuffer) bytes = input.slice(0);
  else bytes = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export class SourceFingerprintError extends Error {
  readonly name = 'SourceFingerprintError';
  constructor() { super('STL fingerprint mismatch'); }
}

export class ProjectRepository {
  constructor(readonly database: MaterialDatabase = createMaterialDatabase()) {}
  async save(value: unknown): Promise<StoredProjectV1> {
    const project = StoredProjectSchema.parse(value) as StoredProjectV1;
    await this.database.projects.put(structuredClone(project));
    return structuredClone(project);
  }
  async get(id: string): Promise<StoredProjectV1 | undefined> {
    const value = await this.database.projects.get(z.string().trim().min(1).max(500).parse(id));
    return value === undefined ? undefined : structuredClone(parseStoredProject(value));
  }
  async list(): Promise<readonly StoredProjectV1[]> {
    const values = await this.database.projects.orderBy('updatedAt').reverse().toArray();
    return values.map((value) => structuredClone(parseStoredProject(value)));
  }
  async attachSource(id: string, source: Blob | ArrayBuffer | ArrayBufferView): Promise<StoredProjectV1> {
    const project = await this.get(id);
    if (!project) throw new Error('Project not found');
    if (await sha256Hex(source) !== project.sourceSha256) throw new SourceFingerprintError();
    return project;
  }
  async delete(id: string): Promise<void> { await this.database.projects.delete(id); }
  close(): void { this.database.close(); }
}

export function createProjectAutosave(repository: ProjectRepository, onError: (message: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const save = async (project: StoredProjectV1): Promise<void> => {
    try { await repository.save(project); }
    catch (error) { onError(error instanceof Error ? error.message : 'Project autosave failed'); }
  };
  return {
    schedule(project: StoredProjectV1) {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      const snapshot = structuredClone(project);
      timer = setTimeout(() => { timer = undefined; void save(snapshot); }, 500);
    },
    async flush(project: StoredProjectV1) {
      if (timer) clearTimeout(timer);
      timer = undefined;
      await save(structuredClone(project));
    },
    dispose() { disposed = true; if (timer) clearTimeout(timer); timer = undefined; },
  };
}
