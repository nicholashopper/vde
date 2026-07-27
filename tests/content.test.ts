/**
 * Scratch verification for src/analyzer/content/*.
 *
 * The classification histogram at the bottom runs against the read-only
 * calibration specimen when it is present, and is skipped otherwise so the
 * suite stays green on a machine that does not have it.
 */

import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, type Settings } from '../src/shared/types'
import type { FileKind } from '../src/analyzer/model'
import {
  KNOWN_LANGUAGES,
  detectLanguage,
  extensionOf,
  isBinaryExtension,
  isSourceLanguage
} from '../src/analyzer/content/language'
import { classifyFile, isExcluded, matchesAnyGlob, __testing as classifyTesting } from '../src/analyzer/content/classify'
import { countLines, isBinaryBuffer } from '../src/analyzer/content/loc'
import { run } from '../src/analyzer/git/exec'

const S: Settings = DEFAULT_SETTINGS

// ---------------------------------------------------------------------------
// language.ts
// ---------------------------------------------------------------------------

describe('extensionOf', () => {
  it('takes only the final segment', () => {
    expect(extensionOf('a/b/report.doc.meta.yml')).toBe('yml')
    expect(extensionOf('Foo.TSX')).toBe('tsx')
  })
  it('treats a leading dot as part of the name, not an extension', () => {
    expect(extensionOf('.gitignore')).toBe('')
    expect(extensionOf('.env.example')).toBe('example')
  })
  it('returns empty for extension-less files', () => {
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('src/Dockerfile')).toBe('')
  })
})

describe('detectLanguage', () => {
  it('resolves the common extensions', () => {
    expect(detectLanguage('src/a.ts')).toBe('TypeScript')
    expect(detectLanguage('src/a.tsx')).toBe('TSX')
    expect(detectLanguage('src/a.mjs')).toBe('JavaScript')
    expect(detectLanguage('src/a.cjs')).toBe('JavaScript')
    expect(detectLanguage('a.py')).toBe('Python')
    expect(detectLanguage('a.go')).toBe('Go')
    expect(detectLanguage('a.rs')).toBe('Rust')
    expect(detectLanguage('a.kt')).toBe('Kotlin')
    expect(detectLanguage('a.swift')).toBe('Swift')
    expect(detectLanguage('a.ex')).toBe('Elixir')
    expect(detectLanguage('a.zig')).toBe('Zig')
    expect(detectLanguage('a.sol')).toBe('Solidity')
    expect(detectLanguage('a.nix')).toBe('Nix')
    expect(detectLanguage('a.tf')).toBe('Terraform')
    expect(detectLanguage('a.proto')).toBe('Protocol Buffers')
    expect(detectLanguage('a.graphql')).toBe('GraphQL')
    expect(detectLanguage('a.jl')).toBe('Julia')
    expect(detectLanguage('a.hs')).toBe('Haskell')
    expect(detectLanguage('a.ml')).toBe('OCaml')
    expect(detectLanguage('a.clj')).toBe('Clojure')
    expect(detectLanguage('a.dart')).toBe('Dart')
    expect(detectLanguage('a.lua')).toBe('Lua')
  })

  it('handles the documented ambiguous cases', () => {
    expect(detectLanguage('src/util.h')).toBe('C/C++ Header')
    expect(detectLanguage('src/View.m')).toBe('Objective-C')
    expect(detectLanguage('src/View.mm')).toBe('Objective-C++')
    expect(detectLanguage('types/index.d.ts')).toBe('TypeScript Declaration')
    expect(detectLanguage('types/index.ts')).toBe('TypeScript')
  })

  it('handles extension-less well-known filenames', () => {
    expect(detectLanguage('Dockerfile')).toBe('Dockerfile')
    expect(detectLanguage('svc/Dockerfile.prod')).toBe('Dockerfile')
    expect(detectLanguage('Makefile')).toBe('Makefile')
    expect(detectLanguage('Makefile.am')).toBe('Makefile')
    expect(detectLanguage('Rakefile')).toBe('Ruby')
    expect(detectLanguage('Gemfile')).toBe('Ruby')
    expect(detectLanguage('Procfile')).toBe('YAML')
    expect(detectLanguage('.env')).toBe('Dotenv')
    expect(detectLanguage('.env.local')).toBe('Dotenv')
    expect(detectLanguage('.gitignore')).toBe('Ignore List')
    expect(detectLanguage('LICENSE')).toBe('Text')
    expect(detectLanguage('CMakeLists.txt')).toBe('CMake')
  })

  it('falls back to the shebang only when the path says nothing', () => {
    expect(detectLanguage('bin/deploy', Buffer.from('#!/usr/bin/env python3\n'))).toBe('Python')
    expect(detectLanguage('bin/run', Buffer.from('#!/bin/bash\nset -e\n'))).toBe('Shell')
    expect(detectLanguage('bin/x', Buffer.from('#!/usr/bin/env -S node --enable-source-maps\n'))).toBe('JavaScript')
    // Path wins over content.
    expect(detectLanguage('a.py', Buffer.from('#!/bin/bash\n'))).toBe('Python')
    expect(detectLanguage('bin/mystery', Buffer.from('#!/usr/bin/myrunner thing.foo\n'))).toBeNull()
  })

  it('returns null for the genuinely unknown', () => {
    expect(detectLanguage('a.qqqq')).toBeNull()
    expect(detectLanguage('')).toBeNull()
  })

  it('exports a non-trivial, sorted catalogue', () => {
    expect(KNOWN_LANGUAGES.length).toBeGreaterThan(90)
    expect([...KNOWN_LANGUAGES].sort((a, b) => a.localeCompare(b, 'en'))).toEqual([...KNOWN_LANGUAGES])
    expect(new Set(KNOWN_LANGUAGES).size).toBe(KNOWN_LANGUAGES.length)
  })
})

describe('isBinaryExtension', () => {
  it('covers images, fonts, archives, office docs and media', () => {
    for (const p of [
      'a.png', 'a.jpg', 'a.gif', 'a.webp', 'a.ico',
      'a.ttf', 'a.woff2', 'a.otf',
      'a.zip', 'a.tar.gz', 'a.7z', 'a.whl',
      'a.docx', 'a.xlsx', 'a.doc', 'a.xls', 'a.pdf', 'a.pptx',
      'a.mp4', 'a.mp3', 'a.mov',
      'a.so', 'a.dylib', 'a.exe', 'a.class', 'a.pyc'
    ]) {
      expect(isBinaryExtension(p), p).toBe(true)
    }
  })
  it('leaves text formats alone', () => {
    for (const p of ['a.ts', 'a.svg', 'a.md', 'a.json', 'Makefile', 'a.csv']) {
      expect(isBinaryExtension(p), p).toBe(false)
    }
  })
})

describe('isSourceLanguage', () => {
  it('separates code from prose and data', () => {
    expect(isSourceLanguage('TypeScript')).toBe(true)
    expect(isSourceLanguage('CSS')).toBe(true)
    expect(isSourceLanguage('Markdown')).toBe(false)
    expect(isSourceLanguage('JSON')).toBe(false)
    expect(isSourceLanguage('YAML')).toBe(false)
    expect(isSourceLanguage(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// classify.ts — glob matcher
// ---------------------------------------------------------------------------

describe('matchesAnyGlob', () => {
  const m = (p: string, g: string): boolean => matchesAnyGlob(p, [g])

  it('matches * within a single segment only', () => {
    expect(m('a.js', '*.js')).toBe(true)
    expect(m('src/a.js', '*.js')).toBe(false)
    expect(m('src/a.js', 'src/*.js')).toBe(true)
    expect(m('src/deep/a.js', 'src/*.js')).toBe(false)
  })

  it('matches ? as exactly one non-separator character', () => {
    expect(m('a.js', '?.js')).toBe(true)
    expect(m('ab.js', '?.js')).toBe(false)
    expect(m('a/b', '?/b')).toBe(true)
    expect(m('ab', 'a?b')).toBe(false)
  })

  it('treats ** as zero or more whole segments', () => {
    expect(m('node_modules/x.js', '**/node_modules/**')).toBe(true)
    expect(m('a/b/node_modules/c/x.js', '**/node_modules/**')).toBe(true)
    expect(m('a/node_modules', '**/node_modules/**')).toBe(false)
    expect(m('foo.min.js', '**/*.min.js')).toBe(true)
    expect(m('a/b/foo.min.js', '**/*.min.js')).toBe(true)
    expect(m('src/test.js', 'src/**/test.js')).toBe(true)
    expect(m('src/a/b/test.js', 'src/**/test.js')).toBe(true)
    expect(m('dist/a/b.js', '**/dist/**')).toBe(true)
    expect(m('notdist/a/b.js', '**/dist/**')).toBe(false)
  })

  it('expands braces, including nested ones', () => {
    expect(m('a.js', '*.{js,ts}')).toBe(true)
    expect(m('a.ts', '*.{js,ts}')).toBe(true)
    expect(m('a.py', '*.{js,ts}')).toBe(false)
    expect(m('src/a.tsx', '**/*.{js,ts{,x}}')).toBe(true)
    expect(m('src/a.jsx', '**/*.{js,ts{,x}}')).toBe(false)
  })

  it('treats regex and bracket metacharacters literally', () => {
    expect(m('app/[slug]/page.tsx', 'app/[slug]/page.tsx')).toBe(true)
    expect(m('app/a/page.tsx', 'app/[slug]/page.tsx')).toBe(false)
    expect(m('a+b.ts', 'a+b.ts')).toBe(true)
    expect(m('axb.ts', 'a.b.ts')).toBe(false)
  })

  it('is anchored at both ends', () => {
    expect(m('xa.js', 'a.js')).toBe(false)
    expect(m('a.jsx', 'a.js')).toBe(false)
  })

  it('does not throw on an unbalanced brace', () => {
    expect(() => m('a.js', '*.{js')).not.toThrow()
  })

  it('returns false for an empty glob list', () => {
    expect(matchesAnyGlob('a.js', [])).toBe(false)
  })
})

describe('isExcluded', () => {
  it('applies the default exclude list', () => {
    expect(isExcluded('node_modules/react/index.js', S)).toBe(true)
    expect(isExcluded('packages/ui/node_modules/x/y.js', S)).toBe(true)
    expect(isExcluded('dist/main.js', S)).toBe(true)
    expect(isExcluded('src/main.js', S)).toBe(false)
    expect(isExcluded('assets/app.min.css', S)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// classify.ts — the rules
// ---------------------------------------------------------------------------

describe('classifyFile', () => {
  const k = (p: string): FileKind => classifyFile(p, S)

  it('rule 1 — vendored beats everything', () => {
    expect(k('node_modules/react/index.js')).toBe('vendored')
    expect(k('vendor/github.com/pkg/errors/errors.go')).toBe('vendored')
    expect(k('third_party/zlib/zlib.c')).toBe('vendored')
    expect(k('.venv/lib/python3.12/site-packages/x.py')).toBe('vendored')
    expect(k('ios/Pods/Alamofire/Source/Alamofire.swift')).toBe('vendored')
    expect(k('Godeps/_workspace/src/x.go')).toBe('vendored')
    // Even a test inside vendored code is vendored.
    expect(k('node_modules/x/test/a.test.js')).toBe('vendored')
  })

  it('rule 2 — generated', () => {
    expect(k('pnpm-lock.yaml')).toBe('generated')
    expect(k('Cargo.lock')).toBe('generated')
    expect(k('package-lock.json')).toBe('generated')
    expect(k('web/static/app.min.js')).toBe('generated')
    expect(k('web/static/app.js.map')).toBe('generated')
    expect(k('api/service_pb2.py')).toBe('generated')
    expect(k('api/service.pb.go')).toBe('generated')
    expect(k('lib/model.g.dart')).toBe('generated')
    expect(k('packages/api-contract/src/schema.d.ts')).toBe('generated')
    expect(k('dist/index.js')).toBe('generated')
    expect(k('build/out.css')).toBe('generated')
    expect(k('out/x.js')).toBe('generated')
    expect(k('.next/server/app.js')).toBe('generated')
    expect(k('target/debug/build.rs')).toBe('generated')
  })

  it('rule 2 — generated headers, when the blob is available', () => {
    const head = Buffer.from('// Code generated by protoc-gen-go. DO NOT EDIT.\npackage api\n')
    expect(classifyFile('api/service.go', S, head)).toBe('generated')
    expect(classifyFile('api/service.go', S)).toBe('source')
    expect(classifyFile('mig/0001.py', S, Buffer.from('# Generated by Django 4.2\n'))).toBe('generated')
  })

  it('rule 3 — test', () => {
    expect(k('services/api/tests/test_auth.py')).toBe('test')
    expect(k('src/__tests__/App.tsx')).toBe('test')
    expect(k('spec/models/user_spec.rb')).toBe('test')
    expect(k('e2e/login.ts')).toBe('test')
    expect(k('src/util.test.ts')).toBe('test')
    expect(k('src/util.spec.ts')).toBe('test')
    expect(k('pkg/thing_test.go')).toBe('test')
    expect(k('src/main/java/com/x/UserTest.java')).toBe('test')
    expect(k('conftest.py')).toBe('test')
    expect(k('services/api/tests/fixtures/payload.json')).toBe('test')
    // 'latest' must not be read as a Java test class.
    expect(k('src/latest.json')).toBe('config')
  })

  it('rule 4 — doc', () => {
    expect(k('README.md')).toBe('doc')
    expect(k('docs/architecture.md')).toBe('doc')
    expect(k('corpus/_authoring/authoring-guide.md')).toBe('doc')
    expect(k('CHANGELOG')).toBe('doc')
    expect(k('LICENSE')).toBe('doc')
    expect(k('LICENSE-MIT')).toBe('doc')
    expect(k('docs/guide.rst')).toBe('doc')
    expect(k('docs/guide.adoc')).toBe('doc')
    expect(k('docs/bugs/evidence/BUG-004/note.txt')).toBe('doc')
    // A .txt outside a docs-ish location is not prose by default.
    expect(k('requirements.txt')).toBe('config')
  })

  it('rule 5 — config', () => {
    expect(k('package.json')).toBe('config')
    expect(k('tsconfig.json')).toBe('config')
    expect(k('tsconfig.base.json')).toBe('config')
    expect(k('eslint.config.js')).toBe('config')
    expect(k('vite.config.ts')).toBe('config')
    expect(k('.prettierrc')).toBe('config')
    expect(k('docker-compose.yml')).toBe('config')
    expect(k('.github/workflows/ci.yaml')).toBe('config')
    expect(k('azure-pipelines.yml')).toBe('config')
    expect(k('pyproject.toml')).toBe('config')
    expect(k('infra/main.tf')).toBe('config')
    expect(k('infra/main.bicep')).toBe('config')
    expect(k('Dockerfile')).toBe('config')
    expect(k('services/api/Dockerfile')).toBe('config')
    expect(k('.env.example')).toBe('config')
    expect(k('Makefile')).toBe('config')
    expect(k('.gitignore')).toBe('config')
  })

  it('rule 6 — asset', () => {
    expect(k('corpus/x/blank.docx')).toBe('asset')
    expect(k('corpus/x/filled.xlsx')).toBe('asset')
    expect(k('corpus/x/legacy.doc')).toBe('asset')
    expect(k('corpus/x/legacy.xls')).toBe('asset')
    expect(k('docs/diagram.pdf')).toBe('asset')
    expect(k('public/logo.svg')).toBe('asset')
    expect(k('public/hero.png')).toBe('asset')
    expect(k('fonts/Inter.woff2')).toBe('asset')
  })

  it('rule 7 — data', () => {
    expect(k('corpus/bluewater/golden.jsonl')).toBe('data')
    expect(k('analytics/events.csv')).toBe('data')
    expect(k('db/backup.dump')).toBe('data')
    expect(k('warehouse/facts.parquet')).toBe('data')
    expect(k('db/seed_dump.sql')).toBe('data')
    // Migrations are schema definitions, not payloads.
    expect(k('services/document/migrations/0001_custody.sql')).toBe('source')
  })

  it('rule 8 — source, and data directories do not swallow it', () => {
    expect(k('src/analyzer/content/loc.ts')).toBe('source')
    expect(k('services/api/app.py')).toBe('source')
    expect(k('web/src/styles/app.css')).toBe('source')
    expect(k('web/src/index.html')).toBe('source')
    expect(k('scripts/deploy.sh')).toBe('source')
    // A helper that lives beside fixtures is still code.
    expect(k('src/fixtures/build-fixture.ts')).toBe('source')
    expect(k('src/analyzer/snapshots/backfill.ts')).toBe('source')
  })

  it('rule 9 — unknown', () => {
    expect(k('weird.qqqq')).toBe('unknown')
  })

  it('honours user-supplied generated globs', () => {
    const custom: Settings = { ...S, generatedGlobs: ['**/legacy/**/*.ts'] }
    expect(classifyFile('src/legacy/deep/a.ts', custom)).toBe('generated')
    expect(classifyFile('src/modern/a.ts', custom)).toBe('source')
  })

  it('never returns anything outside the FileKind union', () => {
    const valid = new Set<FileKind>([
      'source', 'test', 'doc', 'config', 'data', 'asset', 'generated', 'vendored', 'unknown'
    ])
    for (const set of [classifyTesting.DOC_EXTENSIONS, classifyTesting.CONFIG_EXTENSIONS, classifyTesting.DATA_EXTENSIONS]) {
      for (const ext of set) expect(valid.has(classifyFile(`a/b.${ext}`, S))).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// loc.ts
// ---------------------------------------------------------------------------

describe('isBinaryBuffer', () => {
  it('flags a NUL in the first 8000 bytes', () => {
    expect(isBinaryBuffer(Buffer.from([0x61, 0x00, 0x62]))).toBe(true)
  })
  it('flags a control-character-dense window', () => {
    expect(isBinaryBuffer(Buffer.from(Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0x01 : 0x61))))).toBe(true)
  })
  it('does not flag UTF-8 text', () => {
    expect(isBinaryBuffer(Buffer.from('const x = "日本語 🎉 — em dash"\n', 'utf8'))).toBe(false)
  })
  it('does not flag an empty buffer', () => {
    expect(isBinaryBuffer(Buffer.alloc(0))).toBe(false)
  })
  it('ignores a NUL beyond the window', () => {
    const buf = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])])
    expect(isBinaryBuffer(buf)).toBe(false)
  })
})

describe('countLines — line arithmetic', () => {
  it('counts an empty file as zero lines', () => {
    expect(countLines(Buffer.alloc(0), 'TypeScript')).toEqual({ lines: 0, codeLines: 0, binary: false })
  })
  it('counts a newline-terminated file', () => {
    expect(countLines(Buffer.from('a\nb\n'), null).lines).toBe(2)
  })
  it('counts a file with no trailing newline', () => {
    expect(countLines(Buffer.from('a\nb'), null).lines).toBe(2)
  })
  it('counts a lone newline as one line', () => {
    expect(countLines(Buffer.from('\n'), null).lines).toBe(1)
  })
  it('handles CRLF', () => {
    const r = countLines(Buffer.from('const a = 1\r\n\r\n// x\r\n'), 'TypeScript')
    expect(r.lines).toBe(3)
    expect(r.codeLines).toBe(1)
  })
  it('returns null codeLines for an unknown language', () => {
    expect(countLines(Buffer.from('a\nb\n'), null).codeLines).toBeNull()
    expect(countLines(Buffer.from('a\nb\n'), 'Text').codeLines).toBeNull()
  })
  it('short-circuits binary blobs', () => {
    const r = countLines(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]), 'PNG')
    expect(r).toEqual({ lines: 0, codeLines: null, binary: true })
  })
})

describe('countLines — comment grammars', () => {
  const code = (src: string, lang: string): number | null => countLines(Buffer.from(src), lang).codeLines

  it('C-family line and block comments, with state across lines', () => {
    const src = [
      '// header',
      '#include <stdio.h>',
      '',
      '/* a block',
      '   spanning lines */',
      'int main(void) { /* trailing */',
      '  return 0; // done',
      '}'
    ].join('\n')
    expect(code(src, 'C')).toBe(4)
  })

  it('does not open a block comment inside a string literal', () => {
    expect(code('const s = "/*";\nconst t = 1;\n', 'TypeScript')).toBe(2)
    expect(code("const s = '//not a comment';\n", 'TypeScript')).toBe(1)
  })

  it('closes a block comment mid-line and counts the code after it', () => {
    expect(code('/* x */ const a = 1\n', 'TypeScript')).toBe(1)
    expect(code('/* x\ny */ const a = 1\n', 'TypeScript')).toBe(1)
  })

  it('Python hash comments and docstrings', () => {
    const src = [
      '#!/usr/bin/env python3',
      '"""Module docstring',
      'continues here."""',
      '',
      'import os  # trailing',
      '',
      'def f():',
      "    '''doc'''",
      '    return os.sep'
    ].join('\n')
    expect(code(src, 'Python')).toBe(3)
  })

  it('shell / YAML / TOML hash comments', () => {
    expect(code('# c\nset -e\n\necho "# not a comment"\n', 'Shell')).toBe(2)
    expect(code('# c\nkey: value\n\nother: 1 # trailing\n', 'YAML')).toBe(2)
    expect(code('# c\n[table]\nkey = 1\n', 'TOML')).toBe(2)
  })

  it('SQL, Haskell and Lua dashes', () => {
    expect(code('-- c\nSELECT 1;\n/* b */\nSELECT 2;\n', 'SQL')).toBe(2)
    expect(code('-- c\nmain = pure ()\n{- b\n-}\nx = 1\n', 'Haskell')).toBe(2)
    expect(code('-- c\nlocal x = 1\n--[[ b\n]]\nreturn x\n', 'Lua')).toBe(2)
  })

  it('Lisp semicolons', () => {
    expect(code(';; c\n(defn f [] 1)\n', 'Clojure')).toBe(1)
  })

  it('markup comments', () => {
    expect(code('<!-- c -->\n<div>\n</div>\n', 'HTML')).toBe(2)
    expect(code('# Title\n\n<!-- hidden\nstill hidden -->\nProse.\n', 'Markdown')).toBe(2)
    expect(code('<!-- c -->\n<root/>\n', 'XML')).toBe(1)
  })

  it('Julia and PowerShell, where a longer opener must beat a shorter one', () => {
    expect(code('#= block\nstill =#\nx = 1\n', 'Julia')).toBe(1)
    expect(code('<# block\nstill #>\n$x = 1\n', 'PowerShell')).toBe(1)
  })

  it('Ruby =begin blocks only at the start of a line', () => {
    expect(code('=begin\ndoc\n=end\nputs 1\n', 'Ruby')).toBe(1)
    expect(code('x = 1\nputs x\n', 'Ruby')).toBe(2)
  })

  it('JSON has no comments, so every non-blank line is code', () => {
    expect(code('{\n  "a": 1\n\n}\n', 'JSON')).toBe(3)
  })

  it('Rust lifetimes are not string literals', () => {
    expect(code("fn f<'a>(s: &'a str) -> &'a str { s }\n", 'Rust')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Throughput
// ---------------------------------------------------------------------------

describe('countLines — throughput', () => {
  it('sustains a workable rate on a 6000-line source file', () => {
    const line = 'export function handler(req: Request, res: Response): void { res.send("ok"); } // note'
    const parts: string[] = []
    for (let i = 0; i < 6000; i++) {
      parts.push(i % 7 === 0 ? '' : i % 11 === 0 ? '// a standalone comment line' : line)
    }
    const buf = Buffer.from(parts.join('\n') + '\n')

    // Warm up so the measured pass is JIT-compiled rather than interpreted.
    for (let i = 0; i < 20; i++) countLines(buf, 'TypeScript')

    const iterations = 200
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < iterations; i++) countLines(buf, 'TypeScript')
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6

    const mbPerSec = (buf.length * iterations) / 1024 / 1024 / (elapsedMs / 1000)
    const linesPerSec = (6000 * iterations) / (elapsedMs / 1000)
    // eslint-disable-next-line no-console
    console.log(
      `countLines throughput: ${mbPerSec.toFixed(1)} MB/s, ` +
        `${(linesPerSec / 1e6).toFixed(2)}M lines/s, ` +
        `${(elapsedMs / iterations).toFixed(3)} ms per 6000-line file`
    )

    const r = countLines(buf, 'TypeScript')
    expect(r.lines).toBe(6000)
    expect(r.codeLines).toBeGreaterThan(4000)
    // Generous floor: the point is to catch an accidental O(n^2), not to pin a machine.
    expect(mbPerSec).toBeGreaterThan(20)
  })
})

// ---------------------------------------------------------------------------
// Specimen histogram (read-only, skipped when absent)
// ---------------------------------------------------------------------------

const SPECIMEN = join(homedir(), 'codebase', 'apxstream', 'apx-response')
const haveSpecimen = existsSync(join(SPECIMEN, '.git'))

describe.skipIf(!haveSpecimen)('classification against the calibration specimen', () => {
  it('produces the expected kind histogram', async () => {
    const out = await run(SPECIMEN, ['ls-files'])
    const paths = out.split('\n').filter((p) => p.length > 0)
    expect(paths.length).toBe(4227)

    const hist = new Map<FileKind, number>()
    const langs = new Map<string, number>()
    for (const p of paths) {
      const kind = classifyFile(p, S)
      hist.set(kind, (hist.get(kind) ?? 0) + 1)
      const lang = detectLanguage(p)
      if (lang !== null) langs.set(lang, (langs.get(lang) ?? 0) + 1)
    }

    const rows = [...hist.entries()].sort((a, b) => b[1] - a[1])
    // eslint-disable-next-line no-console
    console.log('kind histogram:', Object.fromEntries(rows))

    const get = (k: FileKind): number => hist.get(k) ?? 0
    // Expectations from the brief: ~394 md docs, ~1150 office assets,
    // ~1600 json/yaml config, and py+ts split between source and test.
    expect(get('doc')).toBeGreaterThanOrEqual(394)
    expect(get('asset')).toBeGreaterThanOrEqual(1150)
    expect(get('asset')).toBeLessThan(1250)
    expect(get('config')).toBeGreaterThan(1500)
    expect(get('config')).toBeLessThan(1750)
    expect(get('source') + get('test')).toBeGreaterThan(700)
    expect(get('source') + get('test')).toBeLessThan(830)
    // The failure mode the brief calls out explicitly.
    expect(get('source')).toBeLessThan(600)
    expect(get('unknown')).toBeLessThan(20)
  })
})
