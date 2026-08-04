import { describe, expect, it } from 'vitest'

import { sampleModels, sampleModelUrl } from './sample-models'

describe('sample models', () => {
  it('exposes the fixed public sample catalogue', () => {
    expect(sampleModels).toEqual([
      { id: 'sample1', label: '下載 sample1', fileName: 'sample1.stl' },
      { id: 'sample2', label: '下載 sample2', fileName: 'sample2.stl' },
    ])
  })

  it('builds sample URLs relative to the configured base', () => {
    expect(sampleModelUrl('sample1.stl', '/')).toBe('/samples/sample1.stl')
    expect(sampleModelUrl('sample2.stl', '/ShapeCut/')).toBe('/ShapeCut/samples/sample2.stl')
  })
})
