import { describe, expect, it } from 'vitest';
import { EngravingError, normalizeEngravingSettings, validateEngravingSettings } from './settings';

describe('engraving settings', () => {
  it('defaults old projects to disabled and normalizes spaces', () => {
    expect(normalizeEngravingSettings()).toEqual({ name: '', workName: '' });
    expect(normalizeEngravingSettings({ name: ' 1A99 ', workName: ' 破滅   魔劍 ' })).toEqual({ name: '1A99', workName: '破滅 魔劍' });
  });
  it('rejects controls, bidi overrides, invalid fields and codepoint limits without echoing private text', () => {
    for (const name of ['x\n', 'x\u202e', '字'.repeat(25), 42]) {
      expect(() => normalizeEngravingSettings({ name, workName: '' })).toThrow(EngravingError);
      expect(validateEngravingSettings({ name, workName: '' })).toBeTruthy();
    }
    expect(normalizeEngravingSettings({ name: '𠮷'.repeat(24), workName: '' }).name).toHaveLength(48);
  });
});
