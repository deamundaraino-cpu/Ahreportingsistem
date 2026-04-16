'use client'

import { useState, useCallback } from 'react'
import { arrayMove } from '@dnd-kit/sortable'

interface Tab {
  id: string
  nombre: string
  position?: number
  [key: string]: any
}

export function useLayoutReorder(clienteId: string, initialTabs: Tab[]) {
  const [tabs, setTabs] = useState<Tab[]>(initialTabs)
  const [isSaving, setIsSaving] = useState(false)

  const handleReorder = useCallback(async (oldIndex: number, newIndex: number) => {
    const reordered = arrayMove(tabs, oldIndex, newIndex)
    const withPositions = reordered.map((tab, i) => ({ ...tab, position: i }))

    // Optimistic update
    setTabs(withPositions)

    // Persist to DB
    setIsSaving(true)
    try {
      const res = await fetch('/api/layouts/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clienteId,
          tabOrder: withPositions.map(t => ({ id: t.id, position: t.position })),
        }),
      })
      if (!res.ok) {
        // Revert on failure
        setTabs(initialTabs)
      }
    } catch {
      setTabs(initialTabs)
    } finally {
      setIsSaving(false)
    }
  }, [tabs, clienteId, initialTabs])

  return { tabs, setTabs, handleReorder, isSaving }
}
