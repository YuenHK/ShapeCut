import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

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
    await user.click(await screen.findByRole('button', { name: '匯入與修復' }))
    await user.click(await screen.findByRole('button', { name: '下載已修復 STL' }))

    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:repaired-stl'))
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob))
    expect(click).toHaveBeenCalledOnce()
    expect(downloadedFilename).toBe('original-base-repaired.stl')
  })
})
