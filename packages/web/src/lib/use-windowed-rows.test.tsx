import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TABLE_ROW_HEIGHT_PX, useWindowedRows, type RowWindow } from '@/lib/use-windowed-rows'

let anchorTop = 0
let latest: RowWindow<HTMLTableSectionElement> | undefined

function Table({ count }: { count: number }) {
  const rows = useWindowedRows<HTMLTableSectionElement>(count)
  latest = rows
  return (
    <div data-slot="main">
      <table>
        <tbody
          ref={(node) => {
            rows.anchorRef.current = node
            if (node) node.getBoundingClientRect = () => ({ top: anchorTop }) as DOMRect
          }}
        />
      </table>
    </div>
  )
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this)
  }
  observe(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  anchorTop = 0
  latest = undefined
  FakeResizeObserver.instances = []
  vi.unstubAllGlobals()
})

describe('useWindowedRows', () => {
  it('gives a windowed table its full row count and each row its place in the full list', () => {
    render(<Table count={300} />)
    expect(latest?.ariaRowCount).toBe(301)
    expect(latest?.ariaRowIndex(0)).toBe(2)
    expect(latest?.ariaRowIndex(150)).toBe(152)
  })

  it('leaves the row count to the browser while every row is mounted', () => {
    render(<Table count={60} />)
    expect(latest?.ariaRowCount).toBeUndefined()
    expect(latest?.ariaRowIndex(3)).toBeUndefined()
  })

  it('moves the window when content above the table grows without a scroll', () => {
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    anchorTop = -100 * TABLE_ROW_HEIGHT_PX
    render(<Table count={300} />)
    const before = latest?.start

    anchorTop = -80 * TABLE_ROW_HEIGHT_PX
    act(() => {
      for (const observer of FakeResizeObserver.instances) observer.callback()
    })

    expect(before).toBe(88)
    expect(latest?.start).toBe(68)
  })
})
