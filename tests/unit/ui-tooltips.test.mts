import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('../../src/components', import.meta.url))

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
