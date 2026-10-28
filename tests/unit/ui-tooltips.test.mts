import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../src', import.meta.url))
const GLOBALS_CSS = fileURLToPath(new URL('../../src/app/globals.css', import.meta.url))
const INTERACTIVE = new Set(['Button', 'button', 'a', 'Link'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return walk(path)
    return path.endsWith('.tsx') ? [path] : []
  })
}

function visibleText(node: ts.JsxElement, sf: ts.SourceFile): string {
  return node.children
    .map((child) => {
      if (ts.isJsxText(child)) return child.getText(sf)
      if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteralLike(child.expression)) return child.expression.text
      if (ts.isJsxElement(child)) return visibleText(child, sf)
      return ''
    })
    .join('')
    .trim()
}

function titleProblem(attr: ts.JsxAttribute, sf: ts.SourceFile): string | null {
  const init = attr.initializer
  if (!init) return 'has an empty title'
  if (ts.isStringLiteral(init)) return init.text.trim() ? null : 'has an empty title'
  if (ts.isJsxExpression(init)) {
    const expression = init.expression
    if (!expression) return 'has an empty title'
    const text = expression.getText(sf)
    return /\bundefined\b/.test(text) ? `has a conditional undefined title (${text})` : null
  }
  return 'has an unsupported title'
}

test('every button and link has a meaningful native title', () => {
  const missing: string[] = []
  for (const file of walk(ROOT)) {
    const source = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        INTERACTIVE.has(node.tagName.getText(sf))
      ) {
        const attrs = node.attributes.properties
        const attr = (name: string) =>
          attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name)
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const title = attr('title')
        if (!title) {
          missing.push(`${file}:${line} has no title`)
        } else {
          const problem = titleProblem(title, sf)
          if (problem) missing.push(`${file}:${line} ${problem}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  assert.deepEqual(missing, [], `Buttons and links need a meaningful title:\n${missing.join('\n')}`)
})

test('toggles, tabs and selects expose a native title', () => {
  const missing: string[] = []
  for (const file of walk(ROOT)) {
    const source = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ['Switch', 'TabsTrigger', 'SelectTrigger'].includes(node.tagName.getText(sf))
      ) {
        const attrs = node.attributes.properties
        const attr = (name: string) =>
          attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name)
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const title = attr('title')
        const aria = attr('aria-label')
        const problem = title ? titleProblem(title, sf) : null
        const fallback = Boolean(aria) || (
          node.tagName.getText(sf) === 'TabsTrigger' &&
          ts.isJsxOpeningElement(node) &&
          node.parent.children
            .filter((child) => !(ts.isJsxText(child) && !child.getText(sf).trim()))
            .every((child) => ts.isJsxText(child))
        )
        if (problem) missing.push(`${file}:${line} ${problem}`)
        else if (!title && !fallback) missing.push(`${file}:${line} has no title or aria-label fallback`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  assert.deepEqual(missing, [], `Toggles, tabs and selects need a native title:\n${missing.join('\n')}`)
})

test('icon-only buttons have an accessible name and a native tooltip', () => {
  const missing: string[] = []
  for (const file of walk(ROOT)) {
    const source = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node: ts.Node) => {
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ['Button', 'button'].includes(node.tagName.getText(sf))
      ) {
        const attrs = node.attributes.properties
        const attr = (name: string) =>
          attrs.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name)
        const text = ts.isJsxOpeningElement(node) ? visibleText(node.parent, sf) : ''
        const aria = attr('aria-label')
        const title = attr('title')
        const size = attr('size')?.initializer?.getText(sf)
        const iconOnly = size === '"icon"' || (!text && Boolean(aria))
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        if (iconOnly && !aria) missing.push(`${file}:${line} has no aria-label`)
        if (iconOnly && !title) missing.push(`${file}:${line} has no title`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  assert.deepEqual(missing, [], `Icon-only buttons need aria-label and title:\n${missing.join('\n')}`)
})

test('interactive controls use a pointer cursor', () => {
  const css = readFileSync(GLOBALS_CSS, 'utf8')
  for (const selector of ['button:not(:disabled)', '[role="button"]', 'a[href]', 'summary']) {
    assert.ok(css.includes(selector), `globals.css must cover ${selector}`)
  }
  assert.match(css, /cursor:\s*pointer/)
})
