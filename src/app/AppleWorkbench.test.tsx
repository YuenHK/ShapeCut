import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AppleWorkbench } from './AppleWorkbench';

describe('AppleWorkbench', () => {
  it.each(['upload', 'reading', 'material', 'processing', 'result', 'failure'] as const)(
    'maps %s to a stable workbench state', (state) => {
      render(<AppleWorkbench state={state} level="full"><p>內容</p></AppleWorkbench>);

      expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-state', state);
      expect(screen.getByTestId('apple-workbench')).toHaveAttribute('data-effect-level', 'full');
    },
  );
});
