export const sampleModels = [
  { id: 'sample1', label: '下載 sample1', fileName: 'sample1.stl' },
  { id: 'sample2', label: '下載 sample2', fileName: 'sample2.stl' },
] as const

export function sampleModelUrl(fileName: string, base = import.meta.env.BASE_URL) {
  return `${base.replace(/\/+$/, '')}/samples/${fileName}`
}
