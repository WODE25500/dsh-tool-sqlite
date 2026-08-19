/**
 * dsh-tool-sqlite 核心逻辑（纯函数、可单测）。
 *
 * 安全边界：
 * - 只读：始终以 `readOnly: true` 打开数据库，任何写语句（INSERT/UPDATE/DELETE/
 *   CREATE/DROP/ATTACH 等）都会被 SQLite 拒绝；
 * - 单语句：只用 `prepare`（一次只编译第一条语句），不走多语句 `exec`；
 * - 语句白名单：只放行 SELECT / WITH / PRAGMA / EXPLAIN / VALUES 类只读语句，
 *   防止 SELECT INTO 等边角写路径；
 * - 行数上限：查询结果默认 100 行、硬上限 500 行，防止输出膨胀；
 * - 路径边界：所有数据库路径解析后必须位于工作区内。
 */

import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { join, resolve, relative, extname } from 'node:path'
import { readdirSync } from 'node:fs'

export const MAX_ROWS = 500
export const DEFAULT_ROWS = 100

export interface SqliteListArgs {
  dir?: string
}

export interface SqliteTablesArgs {
  db: string
}

export interface SqliteSchemaArgs {
  db: string
  table: string
}

export interface SqliteQueryArgs {
  db: string
  sql: string
  params?: unknown[]
  limit?: number
}

export interface ColumnInfo {
  name: string
  type: string
  notnull: number
  default: unknown
  pk: number
}

/** 语句白名单：只允许以这些只读关键字开头的单条语句。 */
const READONLY_PREFIXES = ['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN', 'VALUES']

export function isReadonlySql(sql: string): boolean {
  const head = sql.trimStart().toUpperCase()
  return READONLY_PREFIXES.some((p) => head === p || head.startsWith(p + ' '))
}

/** 确保路径位于工作区目录内；非法路径直接抛错。 */
export function resolveDbPath(workspace: string, db: string): string {
  if (!db || typeof db !== 'string') {
    throw new Error('sqlite: db 参数不能为空')
  }
  const abs = resolve(workspace, db)
  const rel = relative(resolve(workspace), abs)
  if (rel.startsWith('..') || (rel !== '' && rel.startsWith('..' + '\\')) || rel.startsWith('..' + '/')) {
    throw new Error(`sqlite: 数据库路径超出工作区: ${db}`)
  }
  return abs
}

/** 扫描工作区（一层递归）内所有 sqlite 数据库文件。 */
export function listDatabases(workspace: string, dir?: string): string[] {
  const root = resolve(workspace, dir ?? '.')
  const abs = resolve(workspace, root)
  const rel = relative(resolve(workspace), abs)
  if (rel.startsWith('..') || rel.startsWith('..' + '\\') || rel.startsWith('..' + '/')) {
    throw new Error(`sqlite: 目录超出工作区: ${dir}`)
  }
  const exts = new Set(['.db', '.sqlite', '.sqlite3', '.db3'])
  const found: string[] = []
  const scan = (d: string, depth: number) => {
    if (depth > 2) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue
        scan(full, depth + 1)
      } else if (e.isFile() && exts.has(extname(e.name).toLowerCase())) {
        found.push(full)
      }
    }
  }
  scan(abs, 0)
  return found.sort()
}

function openDb(absPath: string): DatabaseSync {
  try {
    statSync(absPath)
  } catch {
    throw new Error(`sqlite: 数据库文件不存在: ${absPath}`)
  }
  // readOnly: true —— 写语句在此被 SQLite 拒绝（“attempt to write a readonly database”）。
  return new DatabaseSync(absPath, { readOnly: true })
}

/** 列出库内所有表（含视图）。 */
export function listTables(absPath: string): string[] {
  const db = openDb(absPath)
  try {
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
    return rows.map((r) => r.name)
  } finally {
    db.close()
  }
}

/** 列出单表结构。 */
export function tableSchema(absPath: string, table: string): ColumnInfo[] {
  const db = openDb(absPath)
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${quoteIdent(table)})`)
      .all() as unknown as ColumnInfo[]
    if (rows.length === 0) {
      // 表不存在时 PRAGMA 返回空；给出明确错误
      const exists = listTables(absPath)
      throw new Error(`sqlite: 表不存在: ${table}；现有表: ${exists.join(', ') || '(无)'}`)
    }
    return rows
  } finally {
    db.close()
  }
}

/** 执行只读查询，返回 JSON 行数组。 */
export function queryRows(
  absPath: string,
  sql: string,
  params: unknown[] = [],
  limit = DEFAULT_ROWS,
): { columns: string[]; rows: unknown[][]; truncated: boolean } {
  if (!isReadonlySql(sql)) {
    throw new Error(
      'sqlite: 仅允许只读语句（SELECT / WITH / PRAGMA / EXPLAIN / VALUES）；写入请使用其他工具',
    )
  }
  const cap = Math.max(1, Math.min(limit, MAX_ROWS))
  const db = openDb(absPath)
  try {
    // prepare 只编译第一条语句：多语句输入在此会被 SQLite 拒绝
    const stmt = db.prepare(sql)
    const all = stmt.all(...(params as never[])) as Record<string, unknown>[]
    const columns = stmt.columns().map((c) => c.name)
    const truncated = all.length > cap
    const rows = all.slice(0, cap).map((r) => columns.map((c) => r[c] ?? null))
    return { columns, rows, truncated }
  } finally {
    db.close()
  }
}

/** 标识符加引号，防止注入（仅用于表名/列名包装）。 */
function quoteIdent(name: string): string {
  return '"' + String(name).replaceAll('"', '""') + '"'
}
