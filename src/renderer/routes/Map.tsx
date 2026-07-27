import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, LayoutGrid, TriangleAlert } from 'lucide-react'
import type { FileNode } from '../../shared/types'
import { useStore } from '../store'
import { dirname, plain } from '../lib/format'
import { ChartCard, TableView, useHeldValue, useMeasure } from '../components/charts/primitives'
import {
  buildColorScale,
  COLOR_METRICS,
  indexTree,
  SIZE_METRICS,
  sizeLabel,
  topBySize,
  Treemap,
  type TreemapColorMetric,
  type TreemapSizeMetric
} from '../components/charts/Treemap'
import { ColorLegend } from '../components/ui/ColorLegend'
import { EmptyState } from '../components/ui/EmptyState'
import { Segmented } from '../components/ui/Segmented'
import { FileInspector } from '../components/FileInspector'

/**
 * The Map: "where in this repository is the problem?"
 *
 * One toolbar row — breadcrumb, size-by, colour-by, colour key — then the
 * treemap filling every remaining pixel with the inspector docked right. The
 * map's height is measured, never assumed: a fixed pixel height would either
 * clip the map or strand it in the middle of the window.
 */

/** Header + padding budget of ChartCard, so the card fills the measured region. */
const CARD_CHROME = 67
const MIN_CHART_H = 200

const EMPTY_TREE: FileNode = {
  path: '',
  name: '',
  type: 'directory',
  children: [],
  lines: 0,
  bytes: 0,
  language: null,
  commits: 0,
  authors: 0,
  lastModified: '',
  ageDays: 0,
  addedLines: 0,
  deletedLines: 0,
  reworkRatio: 0,
  complexity: null,
  functions: null,
  risk: 0,
  flags: []
}

function isWithin(focus: string, path: string): boolean {
  return focus === '' || path === focus || path.startsWith(`${focus}/`)
}

export function MapView(): ReactNode {
  const report = useStore((s) => s.report)
  const loading = useStore((s) => s.loading)
  const reportError = useStore((s) => s.reportError)
  const activeRepoId = useStore((s) => s.activeRepoId)
  const selectedPath = useStore((s) => s.selectedPath)
  const setSelectedPath = useStore((s) => s.setSelectedPath)

  const [size, setSize] = useState<TreemapSizeMetric>('lines')
  const [color, setColor] = useState<TreemapColorMetric>('risk')
  const [focusPath, setFocusPath] = useState('')
  const [drawn, setDrawn] = useState({ cells: 0, hidden: 0 })

  const [mapRef, mapBox] = useMeasure<HTMLDivElement>()
  const held = useHeldValue(report, loading)
  const shown = held.value
  const tree = shown?.tree ?? EMPTY_TREE
  const repoName = shown?.repo.name ?? 'repository'

  const index = useMemo(() => indexTree(tree), [tree])
  const scale = useMemo(() => buildColorScale(tree, color), [tree, color])
  const table = useMemo(() => topBySize(tree, focusPath, size, scale, 100), [tree, focusPath, size, scale])

  // Zooming is view state, so it resets when the repository changes and is
  // repaired whenever a rescan removes the directory we were looking at.
  useEffect(() => {
    setFocusPath('')
  }, [activeRepoId])

  useEffect(() => {
    if (focusPath !== '' && !index.byPath.has(focusPath)) setFocusPath('')
  }, [index, focusPath])

  // Another view (a signal's driver list, say) can select a path that is not in
  // the current zoom. Follow it rather than showing an unrelated rectangle.
  useEffect(() => {
    if (selectedPath === null || isWithin(focusPath, selectedPath)) return
    const parent = dirname(selectedPath)
    setFocusPath(index.byPath.has(parent) ? parent : '')
  }, [selectedPath, focusPath, index])

  const onCellCount = useCallback((cells: number, hidden: number) => {
    setDrawn((prev) => (prev.cells === cells && prev.hidden === hidden ? prev : { cells, hidden }))
  }, [])

  const onSelect = useCallback(
    (node: FileNode) => {
      setSelectedPath(node.path)
    },
    [setSelectedPath]
  )

  const focusNode = index.byPath.get(focusPath) ?? tree
  const selectedNode =
    (selectedPath === null ? undefined : index.byPath.get(selectedPath)) ?? focusNode
  const focusAgg = index.agg.get(focusNode.path)
  const chartHeight = Math.max(MIN_CHART_H, Math.round(mapBox.height) - CARD_CHROME)

  const subtitle =
    `${plain(focusAgg?.files ?? 0)} files · ${plain(drawn.cells)} tiles drawn` +
    (drawn.hidden > 0 ? ` · ${plain(drawn.hidden)} too small to draw` : '') +
    ` · sized by ${sizeLabel(size).toLowerCase()}, coloured by ${scale.label.toLowerCase()}`

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Breadcrumb rootLabel={repoName} focusPath={focusPath} onNavigate={setFocusPath} />
        <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
          <Control label="Size">
            <Segmented label="Size metric" value={size} options={SIZE_METRICS} onChange={setSize} />
          </Control>
          <Control label="Colour">
            <Segmented
              label="Colour metric"
              value={color}
              options={COLOR_METRICS}
              onChange={setColor}
            />
          </Control>
          <ColorLegend {...scale.legend} />
        </div>
      </div>

      {/* On a refetch the previous map is held at reduced opacity rather than
          being replaced by a skeleton — a flash of empty chrome reads as a bug. */}
      <div
        className="flex flex-1 gap-3"
        aria-busy={held.stale}
        style={{ minHeight: 360, opacity: held.stale ? 0.55 : 1 }}
      >
        <div ref={mapRef} className="min-w-0 flex-1 overflow-hidden">
          {shown === null ? (
            <MapEmptyState loading={loading} hasRepo={activeRepoId !== null} error={reportError} />
          ) : (
            <ChartCard
              title="Repository map"
              subtitle={subtitle}
              height={chartHeight}
              chart={
                <Treemap
                  root={tree}
                  focusPath={focusPath}
                  size={size}
                  color={color}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  onDrillDown={setFocusPath}
                  onCellCount={onCellCount}
                />
              }
              table={<TableView columns={table.columns} rows={table.rows} caption={table.caption} />}
            />
          )}
        </div>
        <div className="w-[318px] shrink-0">
          <FileInspector node={shown === null ? null : selectedNode} repoId={activeRepoId} />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Toolbar pieces
// ---------------------------------------------------------------------------

function Breadcrumb({
  rootLabel,
  focusPath,
  onNavigate
}: {
  rootLabel: string
  focusPath: string
  onNavigate: (path: string) => void
}): ReactNode {
  const segments = focusPath === '' ? [] : focusPath.split('/')
  const crumbs = segments.map((name, i) => ({
    name,
    path: segments.slice(0, i + 1).join('/')
  }))

  return (
    <nav aria-label="Map location" className="flex min-w-0 items-center">
      <ol className="flex min-w-0 flex-wrap items-center gap-0.5">
        <li className="flex items-center">
          {focusPath === '' ? (
            <span
              aria-current="location"
              className="max-w-[220px] truncate px-1 text-[12px] font-medium"
              style={{ color: 'var(--ink-primary)' }}
            >
              {rootLabel}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('')}
              className="max-w-[220px] truncate rounded px-1 text-[12px]"
              style={{ color: 'var(--ink-secondary)' }}
            >
              {rootLabel}
            </button>
          )}
        </li>
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1
          return (
            <li key={crumb.path} className="flex min-w-0 items-center">
              <ChevronRight aria-hidden="true" size={12} style={{ color: 'var(--ink-faint)' }} />
              {last ? (
                <span
                  aria-current="location"
                  className="max-w-[220px] truncate px-1 text-[12px] font-medium"
                  style={{ color: 'var(--ink-primary)' }}
                >
                  {crumb.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(crumb.path)}
                  className="max-w-[180px] truncate rounded px-1 text-[12px]"
                  style={{ color: 'var(--ink-secondary)' }}
                >
                  {crumb.name}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** A visible caption beside a Segmented, whose own label is for assistive tech. */
function Control({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="text-[10px] tracking-[0.06em] uppercase"
        style={{ color: 'var(--ink-muted)' }}
      >
        {label}
      </span>
      {children}
    </div>
  )
}

function MapEmptyState({
  loading,
  hasRepo,
  error
}: {
  loading: boolean
  hasRepo: boolean
  error: string | null
}): ReactNode {
  const headline = error
    ? 'The report could not be read'
    : !hasRepo
      ? 'No repository selected'
      : loading
        ? 'Analysing the repository'
        : 'Nothing scanned yet'
  const body = error
    ? error
    : !hasRepo
      ? 'Add a repository to see how its files are laid out.'
      : loading
        ? 'The map appears as soon as the file tree has been read.'
        : 'Run a scan to build the file tree this map draws from.'

  return (
    <section className="card flex h-full items-center justify-center">
      <EmptyState
        icon={error ? TriangleAlert : LayoutGrid}
        headline={headline}
        body={body}
        footnote={
          error || !hasRepo || loading
            ? undefined
            : 'The map sizes every file by lines, bytes or commits and colours it by risk.'
        }
      />
    </section>
  )
}

export { MapView as Map }
export default MapView
