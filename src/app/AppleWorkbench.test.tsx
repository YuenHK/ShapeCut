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

  it.each([
    ['upload', undefined, '上載 STL 模型'],
    ['reading', undefined, '讀取 STL 檔案'],
    ['material', undefined, '選擇製作材料'],
    ['result', undefined, '下載切片檔案'],
    ['failure', undefined, '處理失敗'],
  ] as const)('announces a direct current step for %s', (state, stage, expected) => {
    render(
      <AppleWorkbench state={state} stage={stage} fileName="fortress.stl" level="full">
        <p>內容</p>
      </AppleWorkbench>,
    );

    const wayfinding = screen.getByRole('navigation', { name: '目前步驟' });
    expect(wayfinding).toHaveAttribute('aria-live', 'polite');
    expect(wayfinding).toHaveTextContent(expected);
    expect(wayfinding).toHaveTextContent('模型：fortress.stl');
  });

  it.each([
    ['reading', '讀取模型幾何'],
    ['analyzing', '分析模型'],
    ['simplifying', '簡化模型'],
    ['slicing', '產生切片'],
    ['packaging', '準備下載'],
  ] as const)('announces the %s processing stage directly', (stage, expected) => {
    render(
      <AppleWorkbench state="processing" stage={stage} fileName="fortress.stl" level="full">
        <p>內容</p>
      </AppleWorkbench>,
    );

    expect(screen.getByRole('navigation', { name: '目前步驟' })).toHaveTextContent(expected);
  });

  it('keeps decorative environment and interactive stage in a stable hierarchy', () => {
    const { container } = render(
      <AppleWorkbench state="upload" level="full">
        <button type="button">選擇模型</button>
      </AppleWorkbench>,
    );

    const root = screen.getByTestId('apple-workbench');
    const environment = container.querySelector('.workbench-environment');
    const stage = container.querySelector('.workbench-stage');
    expect(environment).toHaveAttribute('aria-hidden', 'true');
    expect(environment?.parentElement).toBe(root);
    expect(stage?.parentElement).toBe(root);
    expect(stage).toContainElement(screen.getByRole('button', { name: '選擇模型' }));
  });
});
