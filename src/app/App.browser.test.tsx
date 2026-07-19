import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MeshProblemReport, MeshRepairResult, TriangleMesh } from '../domain/mesh/types'
import type { ImportRepairAnalysis } from '../workers/geometry-api'
import { App, createAppServices } from './App'

const tetrahedronSTL = `solid tetrahedron
facet normal 0 0 -1
outer loop
vertex 0 0 0
vertex 0 1 0
vertex 1 0 0
endloop
endfacet
facet normal 0 -1 0
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 0 1
endloop
endfacet
facet normal -1 0 0
outer loop
vertex 0 0 0
vertex 0 0 1
vertex 0 1 0
endloop
endfacet
facet normal 1 1 1
outer loop
vertex 1 0 0
vertex 0 1 0
vertex 0 0 1
endloop
endfacet
endsolid tetrahedron`

const openTriangleSTL = `solid triangle
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid triangle`

afterEach(() => vi.restoreAllMocks())

const zeroReport: MeshProblemReport = {
  inspection: { triangleCount: 4, boundaryEdgeCount: 0, nonManifoldEdgeCount: 0, degenerateTriangleCount: 0, invertedVolume: false },
  duplicateTriangleCount: 0,
  boundaryEdges: [],
  nonManifoldEdges: [],
  degenerateTriangles: [],
  duplicateTriangles: [],
  markersTruncated: { boundaryEdges: false, nonManifoldEdges: false, degenerateTriangles: false, duplicateTriangles: false },
}

const tinyMesh: TriangleMesh = {
  positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
}

function acceptedImport(sourceHash: string): ImportRepairAnalysis {
  const safeRepair: MeshRepairResult = {
    mode: 'safe',
    mesh: { positions: tinyMesh.positions.slice(), indices: tinyMesh.indices.slice() },
    before: zeroReport,
    after: zeroReport,
    changes: { removedDegenerate: 0, removedDuplicate: 0, weldedVertices: 0, splitVertices: 0, filledHoles: 0 },
    comparison: { beforeSize: [1, 1, 1], afterSize: [1, 1, 1], axisChangePercent: [0, 0, 0], beforeAbsoluteVolume: 1, afterAbsoluteVolume: 1, volumeChangePercent: 0 },
    accepted: true,
    blockingReasons: [],
  }
  return {
    sourceHash,
    originalMesh: { positions: tinyMesh.positions.slice(), indices: tinyMesh.indices.slice() },
    originalPreview: { positions: tinyMesh.positions.slice(), indices: tinyMesh.indices.slice() },
    originalReport: zeroReport,
    safeRepair,
    candidates: [],
  }
}

describe('App browser smoke test', () => {
  it('renders the application heading', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: '陀螺 Laser Kit' }),
    ).toBeInTheDocument()
  })

  it('keeps a parsed topology failure in repair and never calls it unreadable', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File([openTriangleSTL], 'open.stl', { type: 'model/stl' }))
    await user.click(screen.getByRole('button', { name: '分析模型' }))

    expect(await screen.findByText('開放邊界：3 → 3')).toBeVisible()
    expect(screen.getByRole('heading', { name: '匯入與修復' })).toBeVisible()
    expect(screen.queryByText(/讀不到檔案/)).not.toBeInTheDocument()
  })

  it('shows the exact worker parse exception', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File(['not an stl'], 'broken.stl', { type: 'model/stl' }))
    await user.click(screen.getByRole('button', { name: '分析模型' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('操作失敗：ASCII STL contains no triangles')
  })

  it('downloads a repaired STL with the original base name and revokes the blob URL', async () => {
    const user = userEvent.setup()
    let downloadedFilename = ''
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilename = this.download
    })
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:repaired-stl')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    render(<App />)

    await user.upload(screen.getByLabelText('STL 模型檔案'), new File([tetrahedronSTL], 'original-base.stl', { type: 'model/stl' }))
    await user.click(screen.getByRole('button', { name: '分析模型' }))
    const axisStep = screen.getByRole('button', { name: '軸心與尺寸' })
    await vi.waitFor(() => expect(axisStep).toHaveAttribute('aria-current', 'step'))
    await user.click(screen.getByRole('button', { name: '匯入與修復' }))
    await user.click(await screen.findByRole('button', { name: '下載已修復 STL' }))

    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:repaired-stl'))
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
    expect(downloadedFilename).toBe('original-base-repaired.stl')
  })

  it('submits worker jobs in selection order despite reversed fingerprint completion and exports the accepted fingerprint', async () => {
    const slowFingerprint = deferred<string>()
    const firstWorker = deferred<ImportRepairAnalysis>()
    const secondWorker = deferred<ImportRepairAnalysis>()
    const submissionOrder: string[] = []
    let active: ReturnType<typeof deferred<ImportRepairAnalysis>> | undefined
    const analyzeAndRepairForImport = vi.fn((input: ArrayBuffer) => {
      const label = new TextDecoder().decode(input)
      submissionOrder.push(label)
      active?.reject(new Error(`${label} superseded the prior job`))
      active = label === 'A' ? firstWorker : secondWorker
      return active.promise
    })
    const fingerprint = vi.fn((input: Blob | ArrayBuffer | ArrayBufferView) => {
      const label = input instanceof ArrayBuffer ? new TextDecoder().decode(input) : ''
      return label === 'A' ? slowFingerprint.promise : Promise.resolve('b'.repeat(64))
    })
    const packageBuilder = vi.fn().mockResolvedValue({ zip: new Uint8Array([1, 2, 3]) })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:kit')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const services = createAppServices({
      getGeometry: () => ({ analyzeAndRepairForImport } as never),
      fingerprint,
      packageBuilder: packageBuilder as never,
    })

    const first = services.inspectAndRepair(new File(['A'], 'a.stl')).catch((error: unknown) => error)
    await vi.waitFor(() => expect(fingerprint).toHaveBeenCalledTimes(1))
    const second = services.inspectAndRepair(new File(['B'], 'b.stl'))
    await vi.waitFor(() => expect(fingerprint).toHaveBeenCalledTimes(2))
    slowFingerprint.resolve('a'.repeat(64))
    firstWorker.resolve(acceptedImport('worker-a'))
    secondWorker.resolve(acceptedImport('worker-b'))

    await first
    const accepted = await second
    expect(submissionOrder).toEqual(['A', 'B'])
    expect(accepted.sourceSha256).toBe('b'.repeat(64))

    const zip = await services.buildKit({
      splitPositionPercent: 50,
      ribCount: 6,
      ringLayers: 2,
      shaftMm: 3,
      fit: 'snug',
      materialId: 'plywood-3',
      engravingLevels: 3,
      textureStrength: 0.6,
      sheetWidthMm: 300,
      sheetHeightMm: 200,
    }, accepted.sourceSha256)
    expect(packageBuilder).toHaveBeenCalledWith(expect.objectContaining({ sourceSha256: 'b'.repeat(64) }))
    await services.downloadKit(zip)
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1))
  })

  it('revokes exactly once when clicking a repaired-STL download throws', async () => {
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:throwing-download')
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('click failed exactly') })
    const services = createAppServices({ getGeometry: () => ({} as never) })

    await expect(services.downloadRepairedSTL(new ArrayBuffer(84), 'throwing.stl')).rejects.toThrow('click failed exactly')
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:throwing-download')
  })

  it('builds kit bytes without a browser side effect and revokes exactly once when the later click throws', async () => {
    const packageBuild = deferred<{ zip: Uint8Array }>()
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:throwing-kit')
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('kit click failed exactly') })
    const services = createAppServices({
      getGeometry: () => ({} as never),
      packageBuilder: vi.fn().mockReturnValue(packageBuild.promise) as never,
    })
    const settings = {
      splitPositionPercent: 50,
      ribCount: 8,
      ringLayers: 2,
      shaftMm: 3,
      fit: 'snug' as const,
      materialId: 'plywood-3' as const,
      engravingLevels: 3 as const,
      textureStrength: 0.6,
      sheetWidthMm: 300,
      sheetHeightMm: 200,
    }

    const building = services.buildKit(settings, 'a'.repeat(64))
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    packageBuild.resolve({ zip: new Uint8Array([1, 2, 3]) })
    const zip = await building
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()

    await expect(services.downloadKit(zip)).rejects.toThrow('kit click failed exactly')
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledTimes(1))
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:throwing-kit')
  })

  it('disposes the import worker and never submits after unmount during the initial file read', async () => {
    const user = userEvent.setup()
    const read = deferred<ArrayBuffer>()
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    const postMessage = vi.spyOn(Worker.prototype, 'postMessage')
    const file = new File([tetrahedronSTL], 'deferred.stl', { type: 'model/stl' })
    const arrayBuffer = vi.fn().mockReturnValue(read.promise)
    Object.defineProperty(file, 'arrayBuffer', { configurable: true, value: arrayBuffer })
    const view = render(<App />)

    await user.upload(screen.getByLabelText('STL 模型檔案'), file)
    await user.click(screen.getByRole('button', { name: '分析模型' }))
    expect(arrayBuffer).toHaveBeenCalledOnce()
    view.unmount()
    read.resolve(new TextEncoder().encode(tetrahedronSTL).buffer)
    await Promise.resolve()
    await Promise.resolve()

    expect(terminate).toHaveBeenCalledTimes(1)
    expect(postMessage.mock.calls.map(([message]) => message)).not.toContainEqual(
      expect.objectContaining({ type: 'APPLY' }),
    )
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail })
  return { promise, resolve, reject }
}
