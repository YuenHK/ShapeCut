import type { AxisCandidate } from '../domain/axis/find-axis';
import { Wizard, type WizardServices } from './Wizard';

const suggestedAxis: AxisCandidate = {
  origin: [0, 0, 0], direction: [0, 0, 1], confidence: 0.9, confirmed: false,
  radialRmsError: 0, centroidOffset: 0, source: 'inertia',
};

const placeholderServices: WizardServices = {
  inspect: async () => ({ candidates: [suggestedAxis], issues: [] }),
  decompose: async () => ({ issues: [] }),
  engrave: async () => ({ issues: [] }),
  preflight: async () => ({ issues: [] }),
  exportKit: async () => undefined,
};

export function App() {
  return (
    <main>
      <h1>陀螺 Laser Kit</h1>
      <Wizard services={placeholderServices} />
    </main>
  )
}
