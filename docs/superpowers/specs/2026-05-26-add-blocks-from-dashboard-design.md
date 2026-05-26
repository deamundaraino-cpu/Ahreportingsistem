# Spec: Add Blocks Directly from Dashboard

**Date:** 2026-05-26  
**Status:** Approved

## Summary

Add a "+" button to the dashboard toolbar that lets admins/traffickers create new cards, charts, ranking tables, and text blocks without opening the LayoutConfigModal. The new block is created with sensible defaults, appended to the layout, and immediately opened in QuickEditModal for configuration.

## Context

Currently, adding any block (card, chart, ranking table) requires opening the full LayoutConfigModal. Only text blocks and separators can be added directly from the "Modo Rompecabezas" toolbar. The QuickEditModal already provides per-block inline editing — this feature reuses it as the creation UI.

## Design

### Entry Point

A `+` button appears in the existing dashboard toolbar, alongside "Modo Rompecabezas" and "Configurar layout". Visible only to `isTeam` users (admin, trafficker), same gate as the other edit controls. Always visible — no need to enter any special mode first.

### Dropdown Menu

Clicking `+` opens a Radix Popover (same pattern as FormulaInput) with four options:

| Option | Block type | Defaults |
|---|---|---|
| Tarjeta | `card:` | label: "Nueva tarjeta", formula: "meta_spend", color: "default", prefix: "$", decimals: 2 |
| Gráfico | `chart:` | title: "Nuevo gráfico", type: "line", valueFormulas: ["meta_spend"], colors: ["blue"] |
| Tabla ranking | `ranking:` | title: "Nueva tabla", dimension: "campaigns", topN: 10, sortOrder: "desc", sortColumnIndex: 0, columns: [{ label: "Gasto", formula: "meta_spend", prefix: "$", decimals: 2 }] |
| Texto / Sección | `text:` | content: "Nueva sección", style: "h2", align: "left", color: "white" |

### Creation Flow

1. User clicks `+` → dropdown opens
2. User selects a block type → dropdown closes
3. A new block with defaults is created with `crypto.randomUUID()`
4. Block is appended to the end of `orderedBlocks` (e.g., `card:<id>`)
5. `setTabLayoutOverrides` updates local state immediately (not saved to DB yet)
6. `setQuickEditTarget` opens the QuickEditModal for the new block
7. User configures the block in QuickEditModal and clicks "Guardar" → saved to DB

### What does NOT happen

- No auto-save on creation — the block exists only in local state until the user saves from QuickEditModal
- No creation modal — QuickEditModal is the configuration UI
- No change to Modo Rompecabezas — that toolbar is unchanged

## Files Affected

- `src/app/(app)/dashboard/components/DashboardClient.tsx` — add `handleAddNewBlock(type)` function and `+` button with Popover in toolbar
- No other files needed (QuickEditModal and layout types already support all block types)

## Edge Cases

- If the user closes QuickEditModal without saving, the block remains in local state (unsaved). This is consistent with existing duplicate behavior — the user can still save via "Guardar Visualización" in Puzzle Mode or simply reload to discard.
- The `+` button uses the same `isTeam` guard as other edit controls, so public/viewer users never see it.
