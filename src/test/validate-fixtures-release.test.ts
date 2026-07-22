import { execFile, type ExecException } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const viteNode = resolve(root, 'node_modules/vite-node/vite-node.mjs');
const validator = resolve(root, 'scripts/validate-fixtures.ts');
const publicFixture = resolve(root, 'fixtures/acceptance/symmetric-textured.stl');
const privateInputs = {
  first: process.env.KNIGHT_FORTRESS_STL,
  second: process.env.KNIGHT_FORTRESS_GROUP_STL,
};

type ChildResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

function runValidator(options: {
  readonly first?: string;
  readonly second?: string;
  readonly arguments?: readonly string[];
} = {}): Promise<ChildResult> {
  const env = { ...process.env };
  delete env.KNIGHT_FORTRESS_STL;
  delete env.KNIGHT_FORTRESS_GROUP_STL;
  if (options.first !== undefined) env.KNIGHT_FORTRESS_STL = options.first;
  if (options.second !== undefined) env.KNIGHT_FORTRESS_GROUP_STL = options.second;
  return new Promise((resolve) => {
    execFile(process.execPath, [viteNode, validator, ...(options.arguments ?? [])], {
      cwd: root,
      env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 180_000,
    }, (error: ExecException | null, stdout, stderr) => {
      resolve({ code: typeof error?.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
    });
  });
}

describe.sequential('release fixture validation command', () => {
  it('fails when neither private input is present', async () => {
    const result = await runValidator();
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('requires both private reference inputs');
  }, 30_000);

  it.each([
    { first: publicFixture },
    { second: publicFixture },
  ])('fails when exactly one private input is present', async (inputs) => {
    const result = await runValidator(inputs);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('requires both private reference inputs');
  }, 30_000);

  it('runs public acceptance only through the explicit developer flag', async () => {
    const result = await runValidator({ arguments: ['--public-only'] });
    expect(result.code, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(summary).toMatchObject({
      autoSuccess: 8,
      total: 10,
      outputComparisonPass: true,
      launcherTemplatePass: 'not-requested',
      launcherTemplateDeterministic: 'not-requested',
      launcherRuntimeValidation: 'not-requested',
    });
  }, 30_000);

  it.runIf(Boolean(privateInputs.first && privateInputs.second))(
    'runs full deterministic validation when both private inputs are present',
    async () => {
      const result = await runValidator({ first: privateInputs.first, second: privateInputs.second });
      expect(result.code, result.stderr).toBe(0);
      const summary = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(summary).toMatchObject({
        autoSuccess: 8,
        total: 10,
        outputComparisonPass: true,
        launcherTemplatePass: true,
        launcherTemplateDeterministic: true,
      });
      expect(summary.launcherRuntimeValidation).toEqual([
        expect.objectContaining({
          caseId: 'reference-a', runtimeStatus: 'omitted', safePlanCount: 0,
          artifactCutCount: 0,
        }),
        expect.objectContaining({
          caseId: 'reference-b', runtimeStatus: 'omitted', safePlanCount: 0,
          artifactCutCount: 0,
        }),
      ]);
      expect(JSON.stringify(summary.launcherRuntimeValidation)).not.toMatch(/Knight|Fortress|\.stl|\//i);
    },
    180_000,
  );
});
