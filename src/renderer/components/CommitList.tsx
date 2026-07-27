import { useMemo, useState, type ReactNode } from 'react'
import type { CommitSummary } from '../../shared/types'
import { plain, relativeTime } from '../lib/format'
import { TableView, useMeasure } from './charts/primitives'

/**
 * The commit stream.
 *
 * Windowed by hand — a list capped at 500 rows of fixed height needs an index
 * range and two spacers, not a dependency. Rows are DELIBERATELY not
 * interactive: there is no commit detail view in v1, so nothing here gets a
 * hover background, a pointer cursor or a focus ring. Making a row look
 * clickable and then doing nothing is worse than a plain row.
 *
 * The scroll container itself is focusable so the list is reachable and
 * scrollable from the keyboard.
 */

const ROW_H = 46
const OVERSCAN = 6
const MAX_ROWS = 500

/** `type(scope)!: subject` — the conventional-commit grammar. */
const CONVENTIONAL = /^([a-zA-Z]+)(\([^)]*\))?(!?):\s*/

interface Split {
  type: string | null
  rest: string
}

function splitSubject(subject: string, conventional: boolean): Split {
  if (!conventional) return { type: null, rest: subject }
  const m = CONVENTIONAL.exec(subject)
  if (!m) return { type: null, rest: subject }
  const [full = '', type = '', , bang = ''] = m
  const rest = subject.slice(full.length)
  if (!rest) return { type: null, rest: subject }
  return { type: `${type.toLowerCase()}${bang}`, rest }
}

export interface CommitListProps {
  commits: readonly CommitSummary[]
  /** Anchors relative times so every row in one render agrees. */
  now?: number
}

export function CommitList({ commits, now }: CommitListProps): ReactNode {
  const [ref, size] = useMeasure<HTMLDivElement>()
  const [scrollTop, setScrollTop] = useState(0)

  const items = useMemo(() => commits.slice(0, MAX_ROWS), [commits])
  const stamp = now ?? Date.now()

  const viewport = size.height || ROW_H * 8
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN)
  const visible = items.slice(start, end)

  if (items.length === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-[11px]"
        style={{ color: 'var(--ink-muted)' }}
      >
        No commits in range.
      </div>
    )
  }

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="group"
      aria-label={`${plain(items.length)} most recent commits, newest first`}
      data-selectable
      className="h-full w-full overflow-y-auto rounded-md"
      style={{ background: 'var(--surface-inset)' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <ul className="relative m-0 list-none p-0" style={{ height: items.length * ROW_H }}>
        {visible.map((c, i) => (
          <Row key={c.sha} commit={c} top={(start + i) * ROW_H} now={stamp} />
        ))}
      </ul>
    </div>
  )
}

function Row({
  commit,
  top,
  now
}: {
  commit: CommitSummary
  top: number
  now: number
}): ReactNode {
  const { type, rest } = splitSubject(commit.subject, commit.conventional)
  return (
    <li
      className="absolute left-0 flex w-full items-center gap-3 border-b px-3"
      style={{ top, height: ROW_H, borderColor: 'var(--hairline)' }}
    >
      <span
        className="tnum w-[54px] shrink-0 truncate font-mono text-[10px]"
        style={{ color: 'var(--ink-faint)' }}
        title={commit.sha}
      >
        {commit.shortSha}
      </span>

      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          {type ? (
            <span
              className="shrink-0 rounded-[4px] px-1 py-px font-mono text-[9px] leading-4 tracking-wide uppercase"
              style={{ background: 'var(--surface-2)', color: 'var(--ink-muted)' }}
            >
              {type}
            </span>
          ) : null}
          <span className="truncate text-[12px]" style={{ color: 'var(--ink-primary)' }}>
            {rest}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[10px]">
          <span className="truncate" style={{ color: 'var(--ink-muted)' }}>
            {commit.author}
          </span>
          <span aria-hidden="true" style={{ color: 'var(--ink-faint)' }}>
            ·
          </span>
          <span className="shrink-0" style={{ color: 'var(--ink-muted)' }}>
            {relativeTime(commit.authoredAt, now)}
          </span>
          {commit.isMega ? (
            <span
              className="tnum ml-1 shrink-0 rounded-[4px] px-1.5 py-px text-[9px] leading-4 font-medium tracking-wide uppercase"
              style={{ background: 'var(--surface-3)', color: 'var(--ink-secondary)' }}
            >
              {`mega · ${plain(commit.filesChanged)} files`}
            </span>
          ) : null}
        </span>
      </span>

      <span className="tnum shrink-0 text-right text-[10px] leading-4">
        <span className="block" style={{ color: 'var(--ink-secondary)' }}>
          {`+${plain(commit.insertions)} / −${plain(commit.deletions)}`}
        </span>
        <span className="block" style={{ color: 'var(--ink-faint)' }}>
          {`${plain(commit.filesChanged)} files`}
        </span>
      </span>
    </li>
  )
}

export function CommitListTable({ commits }: { commits: readonly CommitSummary[] }): ReactNode {
  const rows = useMemo(
    () =>
      commits
        .slice(0, MAX_ROWS)
        .map((c) => [
          c.shortSha,
          c.subject,
          c.author,
          c.authoredAt.slice(0, 10),
          `+${plain(c.insertions)}`,
          `−${plain(c.deletions)}`,
          plain(c.filesChanged)
        ]),
    [commits]
  )
  return (
    <TableView
      columns={['SHA', 'Subject', 'Author', 'Date', '+ lines', '− lines', 'Files']}
      rows={rows}
      caption={`${plain(rows.length)} most recent commits, newest first.`}
    />
  )
}
