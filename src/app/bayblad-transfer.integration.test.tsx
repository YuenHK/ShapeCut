import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  window.history.replaceState(null, '', '/');
  Object.defineProperty(window, 'opener', { configurable: true, value: null });
});
it('imports at 6 mm material selection without conversion or touching an existing saved project', async () => {
  const token = '12345678-1234-4234-8234-123456789abc';
  const opener = { postMessage: vi.fn() };
  Object.defineProperty(window, 'opener', { configurable: true, value: opener });
  window.history.replaceState(null, '', `/#bayblad-transfer=${token}`);
  const repository = { load: vi.fn(() => new Promise<undefined>(() => {})), save: vi.fn(), delete: vi.fn() };
  const services = { convert: vi.fn(), package: vi.fn(), cancel: vi.fn() };
  const rendered = render(<App services={services} materialRepository={{ list: vi.fn().mockResolvedValue([]), get: vi.fn(), importJson: vi.fn() }} oneClickProjectRepository={repository} />);
  await waitFor(() => expect(opener.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }), location.origin));
  const bytes = new ArrayBuffer(134);
  new DataView(bytes).setUint32(80, 1, true);
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: opener as unknown as Window, data: {
      protocol: 'bayblad-shapecut', version: 1, token, type: 'stl', fileName: 'bayblad-3layers-6mm-mm.stl', bytes,
    } }));
  });
  await waitFor(() => expect(opener.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'accepted' }), location.origin));
  expect(screen.getByRole('combobox')).toHaveValue('acrylic-6');
  expect(screen.getByText('bayblad-3layers-6mm-mm.stl')).toBeVisible();
  expect(services.convert).not.toHaveBeenCalled();
  expect(repository.load).not.toHaveBeenCalled();
  expect(repository.save).not.toHaveBeenCalled();
  expect(repository.delete).not.toHaveBeenCalled();
  rendered.unmount();
});
it('offers manual upload for an invalid transfer link', async () => {
  window.history.replaceState(null, '', '/#bayblad-transfer=invalid');
  render(<App services={{ convert: vi.fn(), package: vi.fn(), cancel: vi.fn() }} materialRepository={{ list: vi.fn().mockResolvedValue([]), get: vi.fn(), importJson: vi.fn() }} oneClickProjectRepository={{ load: vi.fn().mockResolvedValue(undefined), save: vi.fn(), delete: vi.fn() }} />);
  expect(await screen.findByText(/模型傳送失敗或已過期/)).toBeVisible();
  expect(screen.getByText('3D → LASER CUT')).toBeVisible();
});
