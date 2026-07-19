import type { AxisCandidate } from '../domain/axis/find-axis';
import { useEffect, useMemo } from 'react';
import { ProjectRepository, sha256Hex } from '../persistence/project-repository';
import { Wizard, type WizardServices } from './Wizard';

const suggestedAxis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: false,
  radialRmsError: 0, centroidOffset: 0, source: 'inertia',
};

const placeholderServices: WizardServices = {
  inspect: async (file) => ({ candidates: [suggestedAxis], issues: [], sourceSha256: await sha256Hex(file) }),
  decompose: async () => ({ issues: [] }),
  engrave: async () => ({ issues: [] }),
  preflight: async () => ({ issues: [] }),
  exportKit: async () => undefined,
};

export function App() {
  const repository = useMemo(() => new ProjectRepository(), []);
  useEffect(() => () => repository.close(), [repository]);
  return (
    <main>
      <h1>陀螺 Laser Kit</h1>
      <Wizard services={placeholderServices} repository={repository} />
    </main>
  )
}
