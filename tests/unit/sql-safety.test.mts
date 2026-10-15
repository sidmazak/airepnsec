import test from 'node:test'
import assert from 'node:assert/strict'

function assertReadOnlySql(query: string): string {
  const q = query.trim().replace(/;\s*$/, '')
  if (!q) throw new Error('A SQL query is required')
  if (q.includes(';')) throw new Error('Only a single SQL statement is allowed (no ";")')
  const lower = q.toLowerCase()
  if (!(lower.startsWith('select') || lower.startsWith('with'))) {
    throw new Error('Only read-only SELECT / WITH queries are allowed')
  }
  if (
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|attach|detach|pragma|vacuum|replace|merge|into|copy|call|do|exec|execute|load|outfile|dumpfile|load_file|load_extension|reindex)\b/.test(
      lower
    )
  ) {
    throw new Error('The query contains a write operation — only read-only SELECT queries are allowed')
  }
  return q
}

test('assertReadOnlySql accepts benign SELECT + WITH', () => {
  assert.equal(assertReadOnlySql('SELECT * FROM x;'), 'SELECT * FROM x')
  assert.equal(assertReadOnlySql('with cte as (select 1) select * from cte'), 'with cte as (select 1) select * from cte')
})

test('assertReadOnlySql rejects mutations', () => {
  for (const q of [
    'UPDATE x SET y=1',
    "INSERT INTO x VALUES (1)",
    "DELETE FROM x",
    "DROP TABLE x",
    'SELECT * FROM x; DROP TABLE y',
    'SELECT * FROM x INTO OUTFILE "/tmp/x"',
    "SELECT load_file('/etc/passwd')",
    'SELECT 1 INTO dumpfile "/tmp/x"',
  ]) {
    assert.throws(() => assertReadOnlySql(q), `expected rejection of: ${q}`)
  }
})