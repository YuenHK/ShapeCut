import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App', () => {
  it('shows the spinner laser kit workflow', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: '陀螺 Laser Kit' }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })

  it('cleans up the rendered application between tests', () => {
    expect(
      screen.queryByRole('heading', { name: '陀螺 Laser Kit' }),
    ).toBeNull()
  })
})
