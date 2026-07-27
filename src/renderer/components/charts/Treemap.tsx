import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode
} from 'react'
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy'
import type { FileNode } from '../../../shared/types'
import { foldToTopN, SEQUENTIAL, sequential, seriesScale } from '../../lib/colors'
import { bytes as fmtBytes, compact, plain, relativeTime } from '../../lib/format'
import { TooltipProvider, useMeasure, useTooltip, type TooltipRow } from './primitives'
import type { ColorLegendProps, SequentialBin } from '../ui/ColorLegend'

/**
 * The repository map.
 *
 * A squarified treemap over `report.tree`. d3-hierarchy does the LAYOUT MATHS
 * only — `hierarchy()`, `sum()` and `treemap()` compute rectangles into plain
 * objects, and React renders every one of them. d3 never touches the DOM.
 *
 * Three decisions are worth stating up front, because they are the difference
 * between a treemap that can be read and one that only looks impressive:
 *
 * 1. THE COLOUR SCALE IS ANCHORED TO THE FULL TREE, NEVER TO THE CURRENT VIEW.
 *    Drilling into `src/renderer` must not repaint anything: a file that was
 *    the third bin at the root is still the third bin four levels down, and a
 *    language keeps its slot no matter which subdirectory you are inside.
 *    Colour follows the ENTITY, not its rank in whatever slice is on screen.
 *    That is why `buildColorScale` takes the whole tree and why the size metric
 *    is not allowed to influence the language ranking.
 *
 * 2. SEQUENTIAL METRICS ARE BINNED TO AT MOST SEVEN CLASSES. Past about seven,
 *    adjacent bins are indistinguishable and the ramp becomes decoration. The
 *    bins and their value ranges ship in the ColorLegend, so a tile can always
 *    be turned back into a number without hovering it.
 *
 * 3. THE RAMP RUNS DARK → LIGHT FOR LOW → HIGH. `colors.ts` documents its
 *    sequential steps as light → dark with index 0 "nearest the surface", which
 *    is written for a light surface. VDE's default surface is near-black, so the
 *    step nearest the surface is the DARK end: low values recede into the plane
 *    and high values glow. It is still one hue, still the same thirteen steps,
 *    still never a rainbow — only the orientation is chosen for the surface it
 *    is drawn on, and the legend states the direction explicitly.
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type TreemapSizeMetric = 'lines' | 'bytes' | 'commits'
export type TreemapColorMetric = 'risk' | 'churn' | 'age' | 'rework' | 'language'

/** Shaped as SegmentedOption so the shared control can consume them directly. */
export const SIZE_METRICS: ReadonlyArray<{ value: TreemapSizeMetric; label: string; hint: string }> = [
  { value: 'lines', label: 'Lines', hint: 'tile area is the file’s line count' },
  { value: 'bytes', label: 'Bytes', hint: 'tile area is the file’s size on disk' },
  { value: 'commits', label: 'Commits', hint: 'tile area is how often the file was touched' }
]

export const COLOR_METRICS: ReadonlyArray<{
  value: TreemapColorMetric
  label: string
  hint: string
}> = [
  { value: 'risk', label: 'Risk', hint: 'the composite 0 to 1 risk score' },
  { value: 'churn', label: 'Churn', hint: 'commits touching the file, scaled to the 95th percentile' },
  { value: 'age', label: 'Age', hint: 'days since the file last changed' },
  { value: 'rework', label: 'Rework', hint: 'deleted lines per added line' },
  { value: 'language', label: 'Language', hint: 'categorical, the top 7 languages plus Other' }
]

export function sizeLabel(metric: TreemapSizeMetric): string {
  return metric === 'lines' ? 'Lines' : metric === 'bytes' ? 'Bytes' : 'Commits'
}

export function sizeOf(node: FileNode, metric: TreemapSizeMetric): number {
  const raw = metric === 'lines' ? node.lines : metric === 'bytes' ? node.bytes : node.commits
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

export function formatSize(value: number, metric: TreemapSizeMetric): string {
  return metric === 'bytes' ? fmtBytes(value) : plain(value)
}

// ---------------------------------------------------------------------------
// Tree index — one O(n) pass, shared by everything that needs aggregates
// ---------------------------------------------------------------------------

export interface SubtreeAgg {
  /** Files in this subtree (the node itself when it is a file). */
  files: number
  /** Directories strictly beneath this node. */
  dirs: number
  lines: number
  bytes: number
  commits: number
  maxRisk: number
}

export interface TreeIndex {
  byPath: Map<string, FileNode>
  agg: Map<string, SubtreeAgg>
  /** Every file leaf in the whole tree, in tree order. */
  leaves: FileNode[]
}

const INDEX_CACHE = new WeakMap<FileNode, TreeIndex>()

function walkIndex(node: FileNode, ix: TreeIndex): SubtreeAgg {
  ix.byPath.set(node.path, node)
  const kids = node.children
  if (node.type === 'file' || !kids || kids.length === 0) {
    if (node.type === 'file') ix.leaves.push(node)
    const own: SubtreeAgg = {
      files: node.type === 'file' ? 1 : 0,
      dirs: 0,
      lines: Math.max(0, node.lines),
      bytes: Math.max(0, node.bytes),
      commits: Math.max(0, node.commits),
      maxRisk: Number.isFinite(node.risk) ? node.risk : 0
    }
    ix.agg.set(node.path, own)
    return own
  }
  const total: SubtreeAgg = { files: 0, dirs: 0, lines: 0, bytes: 0, commits: 0, maxRisk: 0 }
  for (const child of kids) {
    const sub = walkIndex(child, ix)
    total.files += sub.files
    total.dirs += sub.dirs + (child.type === 'directory' ? 1 : 0)
    total.lines += sub.lines
    total.bytes += sub.bytes
    total.commits += sub.commits
    if (sub.maxRisk > total.maxRisk) total.maxRisk = sub.maxRisk
  }
  ix.agg.set(node.path, total)
  return total
}

/** Indexes a tree once and memoises it against the tree object itself. */
export function indexTree(root: FileNode): TreeIndex {
  const hit = INDEX_CACHE.get(root)
  if (hit) return hit
  const built: TreeIndex = { byPath: new Map(), agg: new Map(), leaves: [] }
  walkIndex(root, built)
  INDEX_CACHE.set(root, built)
  return built
}

/** Total nodes in a subtree, used to count what pruning hid. */
function subtreeNodes(node: FileNode, ix: TreeIndex): number {
  const agg = ix.agg.get(node.path)
  if (!agg) return 1
  return agg.files + agg.dirs + (node.type === 'directory' ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

const BINS = 7

/**
 * One bin of the sequential ramp. `t` is 0 at the low end and 1 at the high end;
 * the ramp is inverted so high values are the LIGHT, high-contrast step against
 * VDE's near-black surface. See the file header.
 *
 * The colour itself still comes from `colors.ts`. Its `steps` parameter is typed
 * to the literal length of the ramp and so cannot be passed a bin count, so this
 * picks the ramp step for the bin and asks `sequential()` for exactly that step
 * — the same stride the helper applies internally, and no new colour values.
 */
export function sequentialBinColor(t: number, steps = BINS): string {
  const top = SEQUENTIAL.length - 1
  const n = Math.max(2, Math.min(Math.round(steps), SEQUENTIAL.length))
  const inverted = Number.isFinite(t) ? Math.min(1, Math.max(0, 1 - t)) : 1
  const bin = Math.round(inverted * (n - 1))
  const step = Math.round((bin * top) / (n - 1))
  return sequential(step / top)
}

/** The fixed 0–1 risk ramp, shared with the file inspector so both agree. */
export function riskBinColor(risk: number): string {
  return sequentialBinColor(binIndexFor(risk, 1, BINS) / (BINS - 1), BINS)
}

function binIndexFor(value: number, hi: number, count: number): number {
  if (!Number.isFinite(value) || value <= 0 || hi <= 0) return 0
  const i = Math.floor((value / hi) * count)
  return i < 0 ? 0 : i >= count ? count - 1 : i
}

export interface TreemapColorScale {
  metric: TreemapColorMetric
  /** Short name of the measure, used as a tooltip and table column header. */
  label: string
  fill: (node: FileNode) => string
  /** The node's value in this metric, formatted for display. */
  format: (node: FileNode) => string
  legend: ColorLegendProps
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(p * (sortedAsc.length - 1))))
  return sortedAsc[i] ?? 0
}

function buildBins(
  hi: number,
  count: number,
  fmt: (v: number) => string,
  openTop: boolean
): SequentialBin[] {
  const out: SequentialBin[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({
      color: sequentialBinColor(count === 1 ? 0 : i / (count - 1), count),
      fromLabel: fmt((hi * i) / count),
      toLabel: fmt((hi * (i + 1)) / count),
      open: openTop && i === count - 1
    })
  }
  return out
}

function sequentialScale(
  metric: TreemapColorMetric,
  label: string,
  value: (n: FileNode) => number,
  hi: number,
  fmt: (v: number) => string,
  openTop: boolean,
  note?: string
): TreemapColorScale {
  // An integer-valued measure gets at most one bin per unit, otherwise two
  // adjacent bins would carry the same printed range.
  const integral = metric === 'churn' || metric === 'age'
  const count = integral ? Math.max(2, Math.min(BINS, Math.ceil(hi))) : BINS
  const bins = buildBins(hi, count, fmt, openTop)
  const fallback = sequentialBinColor(0, count)
  return {
    metric,
    label,
    fill: (n) => bins[binIndexFor(value(n), hi, count)]?.color ?? fallback,
    format: (n) => fmt(value(n)),
    legend: { mode: 'sequential', label, bins, ...(note === undefined ? {} : { note }) }
  }
}

const SCALE_CACHE = new WeakMap<FileNode, Map<TreemapColorMetric, TreemapColorScale>>()

/**
 * Builds the colour scale for the WHOLE tree. Never pass a drilled-in subtree:
 * the whole point is that a tile's colour means the same thing at every depth.
 */
export function buildColorScale(root: FileNode, metric: TreemapColorMetric): TreemapColorScale {
  let perRoot = SCALE_CACHE.get(root)
  if (!perRoot) {
    perRoot = new Map()
    SCALE_CACHE.set(root, perRoot)
  }
  const hit = perRoot.get(metric)
  if (hit) return hit
  const built = computeColorScale(root, metric)
  perRoot.set(metric, built)
  return built
}

function computeColorScale(root: FileNode, metric: TreemapColorMetric): TreemapColorScale {
  const ix = indexTree(root)
  const leaves = ix.leaves

  if (metric === 'language') {
    // Languages are ranked by total LINES across the full tree — not by the
    // currently selected size metric and not by the current subtree. Ranking by
    // anything view-dependent would repaint every tile when the view changed,
    // which is exactly the failure the "colour follows the entity" rule exists
    // to prevent.
    const folded = foldToTopN(
      leaves,
      (n) => n.language ?? 'Unknown',
      (n) => Math.max(1, n.lines)
    )
    const top = folded.names.filter((n) => n !== 'Other')
    // seriesScale is built from the top names only, so every folded language —
    // and the "Other" bucket itself — resolves to the reserved grey.
    const scale = seriesScale(top)
    const entries = top.map((name) => ({ name, color: scale(name) }))
    if (folded.foldedCount > 0) {
      entries.push({ name: `Other (${folded.foldedCount})`, color: scale('Other') })
    }
    return {
      metric,
      label: 'Language',
      fill: (n) => scale(n.language ?? 'Unknown'),
      format: (n) => n.language ?? 'Unknown',
      legend: { mode: 'categorical', label: 'Language', entries }
    }
  }

  if (metric === 'risk') {
    return sequentialScale(
      'risk',
      'Risk',
      (n) => (Number.isFinite(n.risk) ? n.risk : 0),
      1,
      (v) => v.toFixed(2),
      false
    )
  }

  if (metric === 'rework') {
    // Fixed 0–1 domain: 1.0 is "as many lines deleted as added", which is the
    // meaningful ceiling. Ratios above 1 clamp into the top bin.
    return sequentialScale(
      'rework',
      'Rework',
      (n) => (Number.isFinite(n.reworkRatio) ? Math.max(0, n.reworkRatio) : 0),
      1,
      (v) => v.toFixed(2),
      true,
      'del ÷ add'
    )
  }

  if (metric === 'churn') {
    // Normalised by the 95th percentile: one 400-commit outlier would otherwise
    // push every other file into the bottom bin and flatten the whole map.
    const sorted = leaves.map((n) => Math.max(0, n.commits)).sort((a, b) => a - b)
    const hi = Math.max(1, percentile(sorted, 0.95))
    return sequentialScale('churn', 'Commits', (n) => Math.max(0, n.commits), hi, (v) => compact(v), true, 'p95')
  }

  const sorted = leaves.map((n) => Math.max(0, n.ageDays)).sort((a, b) => a - b)
  const hi = Math.max(1, percentile(sorted, 0.95))
  return sequentialScale(
    'age',
    'Age',
    (n) => Math.max(0, n.ageDays),
    hi,
    (v) => `${Math.round(v)}d`,
    true,
    'days, p95'
  )
}

// ---------------------------------------------------------------------------
// The table twin
// ---------------------------------------------------------------------------

export interface TreemapTable {
  columns: string[]
  rows: (string | number)[][]
  caption: string
}

/**
 * The table twin: the largest cells in the current view, exactly as drawn
 * (directories included, because they are tiles too). No value on this screen is
 * reachable only by hovering.
 */
export function topBySize(
  root: FileNode,
  focusPath: string,
  size: TreemapSizeMetric,
  scale: TreemapColorScale,
  limit = 100
): TreemapTable {
  const ix = indexTree(root)
  const focus = ix.byPath.get(focusPath) ?? root
  const rows: (string | number)[][] = []
  const collected: Array<{ node: FileNode; value: number }> = []

  const visit = (node: FileNode): void => {
    if (node !== focus) {
      const agg = ix.agg.get(node.path)
      const value =
        node.type === 'file'
          ? sizeOf(node, size)
          : size === 'lines'
            ? (agg?.lines ?? 0)
            : size === 'bytes'
              ? (agg?.bytes ?? 0)
              : (agg?.commits ?? 0)
      collected.push({ node, value })
    }
    for (const child of node.children ?? []) visit(child)
  }
  visit(focus)

  collected.sort((a, b) => b.value - a.value || a.node.path.localeCompare(b.node.path))
  for (const row of collected.slice(0, limit)) {
    rows.push([
      row.node.path === '' ? '/' : row.node.path,
      row.node.type === 'directory' ? 'dir' : 'file',
      formatSize(row.value, size),
      row.node.type === 'directory' ? '—' : scale.format(row.node)
    ])
  }

  return {
    columns: ['Path', 'Kind', sizeLabel(size), scale.label],
    rows,
    caption: `Largest ${rows.length} cells in ${focusPath === '' ? 'the repository root' : focusPath}, by ${sizeLabel(size).toLowerCase()}.`
  }
}

// ---------------------------------------------------------------------------
// Text measurement — labels are drawn only when they genuinely fit
// ---------------------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null | undefined
const TEXT_CACHE = new Map<string, number>()

function textWidth(text: string, fontSize: number, weight = 500): number {
  const key = `${fontSize}|${weight}|${text}`
  const hit = TEXT_CACHE.get(key)
  if (hit !== undefined) return hit
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  let w: number
  if (measureCtx) {
    measureCtx.font = `${weight} ${fontSize}px system-ui, -apple-system, "Segoe UI", sans-serif`
    w = measureCtx.measureText(text).width
  } else {
    // Conservative fallback: over-estimating only ever drops a label, it never
    // lets one overflow its cell.
    w = text.length * fontSize * 0.62
  }
  if (TEXT_CACHE.size > 6000) TEXT_CACHE.clear()
  TEXT_CACHE.set(key, w)
  return w
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

/** Gap between adjacent tiles. Surface-coloured, never a border on the mark. */
const GAP = 2
/** Below this, a tile is a smear rather than a mark, so it is not drawn. */
const MIN_CELL = 1.5
/**
 * DOM budget, in tiles. Scaled to the viewport so a big window is allowed more
 * detail than a small one — a fixed cap drops 19×17px tiles on a 2400×1400 map
 * while leaving a 420×300 map with headroom it cannot use. At ~150px² per tile
 * the smallest thing drawn is still a mark rather than a smear.
 */
function cellBudget(width: number, height: number): number {
  return Math.max(2000, Math.min(9000, Math.round((width * height) / 150)))
}
const HEADER_H = 15
const HEADER_MIN_W = 46
const HEADER_MIN_H = 34
const LABEL_FONT = 10
const LABEL_PAD = 4
/** A leaf needs this much room before it earns a name plate. */
const LEAF_LABEL_MIN_W = 96
const LEAF_LABEL_MIN_H = 28

interface Cell {
  key: string
  node: FileNode
  x: number
  y: number
  w: number
  h: number
  dir: boolean
  depth: number
  parentPath: string
  header: number
  fill: string
  /** Null when the full text would not fit — a clipped label is worse than none. */
  label: string | null
  labelW: number
  countLabel: string | null
}

interface Layout {
  cells: Cell[]
  /** Nodes the culling and the cell cap kept off screen. */
  hidden: number
  /** Total size-metric value of the focused subtree. */
  total: number
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TreemapProps {
  /** The FULL tree. The colour scale is always anchored to this, never to the view. */
  root: FileNode
  /** Repo-relative path of the directory currently zoomed into. '' is the root. */
  focusPath: string
  size: TreemapSizeMetric
  color: TreemapColorMetric
  selectedPath: string | null
  onSelect: (node: FileNode) => void
  /** Asks the owner to zoom to `path`. Called for drill-down and for Backspace. */
  onDrillDown: (path: string) => void
  /** Reports how many tiles were actually drawn, for the card subtitle. */
  onCellCount?: (drawn: number, hidden: number) => void
}

export function Treemap(props: TreemapProps): ReactNode {
  return (
    <TooltipProvider>
      <TreemapCanvas {...props} />
    </TooltipProvider>
  )
}

function TreemapCanvas({
  root,
  focusPath,
  size,
  color,
  selectedPath,
  onSelect,
  onDrillDown,
  onCellCount
}: TreemapProps): ReactNode {
  const [wrapRef, box] = useMeasure<HTMLDivElement>()
  const tooltip = useTooltip()
  const [hover, setHover] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState<number | null>(null)

  const ix = useMemo(() => indexTree(root), [root])
  const scale = useMemo(() => buildColorScale(root, color), [root, color])
  const focusNode = ix.byPath.get(focusPath) ?? root

  const width = Math.max(0, Math.floor(box.width))
  const height = Math.max(0, Math.floor(box.height))

  const layout = useMemo<Layout>(
    () => computeLayout(focusNode, ix, scale, size, width, height),
    [focusNode, ix, scale, size, width, height]
  )
  const cells = layout.cells

  const cellIndexByPath = useMemo(() => {
    const m = new Map<string, number>()
    cells.forEach((c, i) => m.set(c.node.path, i))
    return m
  }, [cells])

  /** Siblings, in reading order, for keyboard navigation. */
  const siblings = useMemo(() => {
    const m = new Map<string, number[]>()
    cells.forEach((c, i) => {
      const list = m.get(c.parentPath)
      if (list) list.push(i)
      else m.set(c.parentPath, [i])
    })
    for (const list of m.values()) {
      list.sort((a, b) => {
        const ca = cells[a]
        const cb = cells[b]
        if (!ca || !cb) return 0
        return ca.y - cb.y || ca.x - cb.x
      })
    }
    return m
  }, [cells])

  useEffect(() => {
    onCellCount?.(cells.length, layout.hidden)
  }, [cells.length, layout.hidden, onCellCount])

  // A layout change invalidates the old indices, so drop transient state.
  useEffect(() => {
    setHover(null)
    setFocusIndex(null)
  }, [cells])

  const selectedIndex = selectedPath === null ? -1 : (cellIndexByPath.get(selectedPath) ?? -1)

  const showTooltipFor = useCallback(
    (index: number, px: number, py: number) => {
      const cell = cells[index]
      if (!cell) return
      tooltip.show({
        x: px,
        y: py,
        title: cell.node.path === '' ? '/' : cell.node.path,
        rows: tooltipRows(cell, ix, scale)
      })
    },
    [cells, ix, scale, tooltip]
  )

  const onPointerMove = useCallback(
    (e: PointerEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const target = e.target as Element | null
      const raw = target === null ? null : target.getAttribute('data-cell')
      let index = raw === null ? -1 : Number.parseInt(raw, 10)
      if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
        // The pointer is in a 2px gap. Snap to the nearest cell rather than
        // dropping the tooltip — small tiles are hard enough to hit already.
        index = nearestCell(cells, px, py, 14)
      }
      if (index < 0) {
        setHover(null)
        tooltip.hide()
        return
      }
      setHover(index)
      showTooltipFor(index, px, py)
    },
    [cells, showTooltipFor, tooltip]
  )

  const onPointerLeave = useCallback(() => {
    setHover(null)
    tooltip.hide()
  }, [tooltip])

  const activate = useCallback(
    (index: number) => {
      const cell = cells[index]
      if (!cell) return
      onSelect(cell.node)
      if (cell.dir) onDrillDown(cell.node.path)
    },
    [cells, onDrillDown, onSelect]
  )

  const moveFocus = useCallback(
    (index: number) => {
      const cell = cells[index]
      if (!cell) return
      setFocusIndex(index)
      onSelect(cell.node)
    },
    [cells, onSelect]
  )

  const onKeyDown = useCallback(
    (e: KeyboardEvent<SVGSVGElement>) => {
      if (cells.length === 0) return
      const current = focusIndex ?? (selectedIndex >= 0 ? selectedIndex : 0)
      const cell = cells[current]

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault()
          if (focusIndex === null) {
            moveFocus(current)
            return
          }
          const group = cell ? (siblings.get(cell.parentPath) ?? []) : []
          const next = stepSibling(cells, group, current, e.key)
          if (next >= 0) moveFocus(next)
          return
        }
        case 'Home':
        case 'End': {
          e.preventDefault()
          const group = cell ? (siblings.get(cell.parentPath) ?? []) : []
          const pick = e.key === 'Home' ? group[0] : group[group.length - 1]
          if (pick !== undefined) moveFocus(pick)
          return
        }
        case 'Enter':
        case ' ': {
          e.preventDefault()
          activate(current)
          return
        }
        case 'Backspace': {
          e.preventDefault()
          if (focusPath !== '') onDrillDown(parentOf(focusPath))
          return
        }
        default:
      }
    },
    [activate, cells, focusIndex, focusPath, moveFocus, onDrillDown, selectedIndex, siblings]
  )

  // The fills never change on hover or focus, so the tile layer is memoised and
  // React skips reconciling several thousand rects on every pointer move. The
  // rects are a flat list — a wrapper <g> per tile would double the DOM for
  // nothing, and only a couple of hundred tiles ever earn a label.
  const tileLayer = useMemo(() => {
    const labelled = cells
      .map((cell, i) => ({ cell, i }))
      .filter((entry) => entry.cell.label !== null)
    return (
      <>
        <g>
          {cells.map((cell, i) => (
            <rect
              key={cell.key}
              data-cell={i}
              x={cell.x}
              y={cell.y}
              width={cell.w}
              height={cell.h}
              rx={cell.w > 6 && cell.h > 6 ? 2 : 0}
              fill={cell.fill}
            />
          ))}
        </g>
        <g>
          {labelled.map(({ cell, i }) =>
            cell.dir ? (
              <g key={cell.key}>
                <text
                  data-cell={i}
                  x={cell.x + LABEL_PAD}
                  y={cell.y + cell.header / 2}
                  dy="0.34em"
                  fontSize={LABEL_FONT}
                  fontWeight={500}
                  fill="var(--ink-secondary)"
                >
                  {cell.label}
                </text>
                {cell.countLabel !== null ? (
                  <text
                    data-cell={i}
                    x={cell.x + cell.w - LABEL_PAD}
                    y={cell.y + cell.header / 2}
                    dy="0.34em"
                    textAnchor="end"
                    fontSize={LABEL_FONT}
                    className="tnum"
                    fill="var(--ink-faint)"
                  >
                    {cell.countLabel}
                  </text>
                ) : null}
              </g>
            ) : (
              // A leaf's name sits on a data colour, so it gets a surface plate
              // to stand on: ink tokens keep their contrast, and text never
              // wears the series colour.
              <g key={cell.key}>
                <rect
                  data-cell={i}
                  x={cell.x + LABEL_PAD}
                  y={cell.y + LABEL_PAD}
                  width={cell.labelW + 8}
                  height={15}
                  rx={3}
                  fill="var(--surface-1)"
                  fillOpacity={0.82}
                />
                <text
                  data-cell={i}
                  x={cell.x + LABEL_PAD + 4}
                  y={cell.y + LABEL_PAD + 7.5}
                  dy="0.34em"
                  fontSize={LABEL_FONT}
                  fontWeight={500}
                  fill="var(--ink-primary)"
                >
                  {cell.label}
                </text>
              </g>
            )
          )}
        </g>
      </>
    )
  }, [cells])

  const ariaLabel = useMemo(() => {
    const agg = ix.agg.get(focusNode.path)
    const where = focusNode.path === '' ? 'the repository root' : focusNode.path
    return (
      `Treemap of ${where}: ${plain(agg?.files ?? 0)} files, ` +
      `${cells.length} tiles drawn, sized by ${sizeLabel(size).toLowerCase()} and coloured by ` +
      `${scale.label.toLowerCase()}. Switch to the table view for exact values. ` +
      `Arrow keys move between sibling tiles, Enter opens a directory, Backspace goes up.`
    )
  }, [cells.length, focusNode, ix, scale.label, size])

  const focusedCell = focusIndex === null ? null : (cells[focusIndex] ?? null)

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      {width > 0 && height > 0 && cells.length === 0 ? (
        <p
          className="absolute inset-0 flex items-center justify-center text-center text-[12px]"
          style={{ color: 'var(--ink-muted)' }}
        >
          {layout.total > 0
            ? 'Every file here is too small to draw at this size.'
            : `Nothing to map: no ${sizeLabel(size).toLowerCase()} in this directory.`}
        </p>
      ) : null}
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${Math.max(1, width)} ${Math.max(1, height)}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        className="block"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        onClick={(e) => {
          const target = e.target as Element | null
          const raw = target === null ? null : target.getAttribute('data-cell')
          const index = raw === null ? -1 : Number.parseInt(raw, 10)
          if (Number.isInteger(index) && index >= 0 && index < cells.length) {
            setFocusIndex(index)
            activate(index)
          }
        }}
        onBlur={() => setFocusIndex(null)}
      >
        {tileLayer}
        {/* State outlines paint last so they are never overdrawn by a child
            tile. They carry the same data-cell attribute as the tile beneath,
            so landing on an outline still resolves to the right cell — no
            pointer-events tricks anywhere in this chart. */}
        <g>
          {hover !== null && hover !== selectedIndex ? (
            <Outline cell={cells[hover]} index={hover} stroke="var(--ink-secondary)" width={1.5} />
          ) : null}
          {selectedIndex >= 0 ? (
            <Outline cell={cells[selectedIndex]} index={selectedIndex} stroke="var(--ink-primary)" width={2} />
          ) : null}
          {focusedCell && focusIndex !== null ? (
            <Outline cell={focusedCell} index={focusIndex} stroke="var(--focus-ring)" width={2} />
          ) : null}
        </g>
      </svg>
      <span className="sr-only" aria-live="polite">
        {focusedCell
          ? `${focusedCell.node.path === '' ? '/' : focusedCell.node.path}, ${
              focusedCell.dir ? 'directory' : 'file'
            }, ${scale.label} ${scale.format(focusedCell.node)}`
          : ''}
      </span>
    </div>
  )
}

function Outline({
  cell,
  index,
  stroke,
  width
}: {
  cell: Cell | undefined
  index: number
  stroke: string
  width: number
}): ReactNode {
  if (!cell) return null
  const inset = width / 2
  return (
    <rect
      data-cell={index}
      x={cell.x + inset}
      y={cell.y + inset}
      width={Math.max(0, cell.w - width)}
      height={Math.max(0, cell.h - width)}
      rx={cell.w > 8 && cell.h > 8 ? 2 : 0}
      fill="none"
      stroke={stroke}
      strokeWidth={width}
    />
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function computeLayout(
  focusNode: FileNode,
  ix: TreeIndex,
  scale: TreemapColorScale,
  size: TreemapSizeMetric,
  width: number,
  height: number
): Layout {
  if (width < 8 || height < 8) return { cells: [], hidden: 0, total: 0 }

  const rootNode = hierarchy<FileNode>(focusNode, (d) => d.children)
    // Only leaves carry value; a directory's size is therefore exactly the sum
    // of its children, which is what the treemap's geometry already means.
    .sum((d) => (d.children && d.children.length > 0 ? 0 : sizeOf(d, size)))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || a.data.path.localeCompare(b.data.path))

  const total = rootNode.value ?? 0
  if (total <= 0) return { cells: [], hidden: 0, total: 0 }

  const laid = treemap<FileNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(GAP)
    .paddingOuter(1)
    // The header band is reserved by the layout itself, so a directory's label
    // can never sit on top of one of its own children.
    .paddingTop((d) =>
      d.depth > 0 &&
      d.children !== undefined &&
      d.x1 - d.x0 >= HEADER_MIN_W &&
      d.y1 - d.y0 >= HEADER_MIN_H
        ? HEADER_H
        : 1
    )(rootNode)

  const kept: HierarchyRectangularNode<FileNode>[] = []
  let hidden = 0
  const stack: HierarchyRectangularNode<FileNode>[] = [...(laid.children ?? [])]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) break
    const w = node.x1 - node.x0
    const h = node.y1 - node.y0
    if (w < MIN_CELL || h < MIN_CELL) {
      // The whole subtree is inside this rectangle, so it is all too small too.
      hidden += subtreeNodes(node.data, ix)
      continue
    }
    kept.push(node)
    if (node.children) for (const child of node.children) stack.push(child)
  }

  const budget = cellBudget(width, height)
  if (kept.length > budget) {
    // A parent's area is always at least its children's, so keeping the largest
    // N by area can never orphan a tile from a dropped ancestor.
    kept.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
    hidden += kept.length - budget
    kept.length = budget
  }
  // Parents paint before children, so a directory's remainder shows through
  // wherever its tiny children were dropped.
  kept.sort((a, b) => a.depth - b.depth)

  const cells: Cell[] = kept.map((node) => {
    const data = node.data
    const isDir = data.type === 'directory'
    const w = node.x1 - node.x0
    const h = node.y1 - node.y0
    const header =
      isDir && node.children !== undefined && w >= HEADER_MIN_W && h >= HEADER_MIN_H ? HEADER_H : 0

    let label: string | null = null
    let labelW = 0
    let countLabel: string | null = null

    if (header > 0) {
      const avail = w - LABEL_PAD * 2
      const nameW = textWidth(data.name, LABEL_FONT)
      if (nameW <= avail) {
        label = data.name
        labelW = nameW
        const files = ix.agg.get(data.path)?.files ?? 0
        if (files > 0) {
          const text = compact(files)
          if (nameW + 8 + textWidth(text, LABEL_FONT) <= avail) countLabel = text
        }
      }
    } else if (!isDir && w >= LEAF_LABEL_MIN_W && h >= LEAF_LABEL_MIN_H) {
      const nameW = textWidth(data.name, LABEL_FONT)
      if (nameW + 8 <= w - LABEL_PAD * 2) {
        label = data.name
        labelW = nameW
      }
    }

    return {
      key: data.path === '' ? ' root' : data.path,
      node: data,
      x: node.x0,
      y: node.y0,
      w,
      h,
      dir: isDir,
      depth: node.depth,
      parentPath: node.parent?.data.path ?? focusNode.path,
      header,
      fill: isDir ? 'var(--surface-2)' : scale.fill(data),
      label,
      labelW,
      countLabel
    }
  })

  return { cells, hidden, total }
}

// ---------------------------------------------------------------------------
// Interaction helpers
// ---------------------------------------------------------------------------

function nearestCell(cells: Cell[], px: number, py: number, tolerance: number): number {
  let best = -1
  let bestDist = tolerance * tolerance
  for (let i = 0; i < cells.length; i += 1) {
    const c = cells[i]
    if (!c) continue
    const dx = px < c.x ? c.x - px : px > c.x + c.w ? px - (c.x + c.w) : 0
    const dy = py < c.y ? c.y - py : py > c.y + c.h ? py - (c.y + c.h) : 0
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      bestDist = d
      best = i
      if (d === 0) break
    }
  }
  return best
}

/** Spatial sibling movement: the nearest sibling in the requested direction. */
function stepSibling(cells: Cell[], group: number[], from: number, key: string): number {
  const origin = cells[from]
  if (!origin || group.length === 0) return -1
  const ox = origin.x + origin.w / 2
  const oy = origin.y + origin.h / 2
  const horizontal = key === 'ArrowLeft' || key === 'ArrowRight'
  const sign = key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 1

  let best = -1
  let bestScore = Number.POSITIVE_INFINITY
  for (const i of group) {
    if (i === from) continue
    const c = cells[i]
    if (!c) continue
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    const along = horizontal ? (cx - ox) * sign : (cy - oy) * sign
    if (along <= 0.5) continue
    const across = horizontal ? Math.abs(cy - oy) : Math.abs(cx - ox)
    const score = along + across * 2
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  if (best >= 0) return best

  // Nothing that way: fall through to reading order so focus is never stuck.
  const at = group.indexOf(from)
  if (at === -1) return group[0] ?? -1
  const next = group[at + sign]
  return next ?? -1
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

const FLAG_SHORT: Record<string, string> = {
  'god-file': 'god file',
  'write-once': 'write-once',
  'high-rework': 'high rework',
  stale: 'stale',
  'sibling-sprawl': 'sprawl',
  generated: 'generated',
  binary: 'binary',
  vendored: 'vendored'
}

function tooltipRows(cell: Cell, ix: TreeIndex, scale: TreemapColorScale): TooltipRow[] {
  const node = cell.node
  const rows: TooltipRow[] = []

  if (cell.dir) {
    const agg = ix.agg.get(node.path)
    rows.push({ label: 'Files', value: plain(agg?.files ?? 0) })
    if ((agg?.dirs ?? 0) > 0) rows.push({ label: 'Directories', value: plain(agg?.dirs ?? 0) })
    rows.push({ label: 'Lines', value: plain(agg?.lines ?? 0) })
    rows.push({ label: 'Bytes', value: fmtBytes(agg?.bytes ?? 0) })
    rows.push({ label: 'Commits', value: plain(agg?.commits ?? 0) })
    rows.push({ label: 'Highest risk', value: (agg?.maxRisk ?? 0).toFixed(2) })
    rows.push({ label: '', value: 'Click to zoom in' })
    return rows
  }

  rows.push({ label: 'Lines', value: plain(node.lines) })
  rows.push({ label: 'Bytes', value: fmtBytes(node.bytes) })
  rows.push({ label: 'Commits', value: plain(node.commits) })
  rows.push({ label: 'Authors', value: plain(node.authors) })
  rows.push({ label: 'Language', value: node.language ?? 'Unknown' })
  rows.push({ label: 'Rework', value: node.reworkRatio.toFixed(2) })
  rows.push({ label: 'Last change', value: relativeTime(node.lastModified) })
  rows.push({ label: 'Risk', value: node.risk.toFixed(2), color: riskBinColor(node.risk) })
  if (scale.metric !== 'risk') {
    rows.push({ label: scale.label, value: scale.format(node), color: cell.fill })
  }
  if (node.flags.length > 0) {
    rows.push({
      label: 'Flags',
      value: node.flags.map((f) => FLAG_SHORT[f] ?? f).join(' · ')
    })
  }
  return rows
}

export default Treemap
