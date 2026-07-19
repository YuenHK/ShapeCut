import type { Severity } from '../types';

export type FixAction = { readonly label: string; readonly targetStep: 'import' | 'axis' | 'decomposition' | 'engraving' | 'export' };
export type PreflightIssue = { readonly code: string; readonly severity: Severity; readonly message: string; readonly regionId?: string; readonly fixes: readonly FixAction[] };

export function issue(code: string, severity: Severity, message: string, targetStep: FixAction['targetStep'], regionId?: string): PreflightIssue {
  return { code, severity, message, ...(regionId ? { regionId } : {}), fixes: [{ label: `返回${targetStep}修正`, targetStep }] };
}
