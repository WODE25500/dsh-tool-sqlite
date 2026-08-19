import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  isReadonlySql,
  listDatabases,
  listTables,
  queryRows,
  resolveDbPath,
  tableSchema,
} from '../src/sqlite-core.ts'

let dir: string
let dbPath: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-sqlite-test-'))
  dbPath = join(dir, 'sample.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER);
    INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25), ('Carol', 35);
    CREATE VIEW adult_users AS SELECT name FROM users WHERE age >= 30;
  `)
  db.close()
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('isReadonlySql', () => {
  it('allows read-only statements', () => {
    expect(isReadonlySql('SELECT * FROM t')).toBe(true)
    expect(isReadonlySql('with x as (select 1) select * from x')).toBe(true)
    expect(isReadonlySql('PRAGMA table_info(t)')).toBe(true)
    expect(isReadonlySql('  EXPLAIN QUERY PLAN SELECT 1')).toBe(true)
  })
  it('rejects writes', () => {
    expect(isReadonlySql('INSERT INTO t VALUES (1)')).toBe(false)
    expect(isReadonlySql('UPDATE t SET a=1')).toBe(false)
    expect(isReadonlySql('DELETE FROM t')).toBe(false)
    expect(isReadonlySql('CREATE TABLE x (a)')).toBe(false)
    expect(isReadonlySql('DROP TABLE t')).toBe(false)
  })
})

describe('resolveDbPath', () => {
  it('resolves relative paths inside workspace', () => {
    expect(resolveDbPath(dir, 'sample.db')).toBe(dbPath)
    expect(resolveDbPath(dir, join('sub', 'x.db'))).toBe(join(dir, 'sub', 'x.db'))
  })
  it('rejects paths escaping the workspace', () => {
    expect(() => resolveDbPath(dir, '..' + sep + 'evil.db')).toThrow()
    expect(() => resolveDbPath(dir, join('..', 'evil.db'))).toThrow()
    expect(() => resolveDbPath(dir, dbPath + sep + '..' + sep + '..' + sep + 'evil.db')).toThrow()
  })
})

describe('listDatabases', () => {
  it('finds .db files in the workspace', () => {
    const found = listDatabases(dir)
    expect(found).toContain(dbPath)
  })
})

describe('listTables', () => {
  it('lists tables and views, excluding sqlite_*', () => {
    const tables = listTables(dbPath)
    expect(tables).toContain('users')
    expect(tables).toContain('adult_users')
    expect(tables.some((t) => t.startsWith('sqlite_'))).toBe(false)
  })
})

describe('tableSchema', () => {
  it('returns column info', () => {
    const cols = tableSchema(dbPath, 'users')
    const id = cols.find((c) => c.name === 'id')!
    expect(id.pk).toBe(1)
    const name = cols.find((c) => c.name === 'name')!
    expect(name.notnull).toBe(1)
  })
  it('errors on missing table', () => {
    expect(() => tableSchema(dbPath, 'nope')).toThrow(/表不存在/)
  })
})

describe('queryRows', () => {
  it('runs SELECT with params and respects limit', () => {
    const r = queryRows(dbPath, 'SELECT name, age FROM users WHERE age >= ?', [30], 10)
    expect(r.columns).toEqual(['name', 'age'])
    expect(r.rows.length).toBe(2)
    expect(r.truncated).toBe(false)
  })
  it('truncates over-limit results', () => {
    const r = queryRows(dbPath, 'SELECT * FROM users', [], 2)
    expect(r.rows.length).toBe(2)
    expect(r.truncated).toBe(true)
  })
  it('rejects non-readonly SQL', () => {
    expect(() => queryRows(dbPath, 'DROP TABLE users')).toThrow(/只允许只读语句|仅允许只读语句/)
  })
})
