import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App browser smoke test', () => {
  it('renders the application heading', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: '陀螺 Laser Kit' }),
    ).toBeInTheDocument()
  })
})
