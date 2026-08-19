/**
 * dsh-tool-sqlite 插件入口。
 *
 * 注册 `sqlite` 工具：列出工作区内的数据库、列库表结构、执行只读查询。
 * 接入方式：在 cordis.yml 追加：
 *   - id: tool-sqlite
 *     name: 'dsh-tool-sqlite'
 *
 * 安全边界：只读打开（readOnly: true）；单语句 prepare；SELECT/WITH/PRAGMA/
 * EXPLAIN/VALUES 白名单；路径限制在工作区内；结果行数上限 500。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  listDatabases,
  listTables,
  queryRows,
  resolveDbPath,
  tableSchema,
  tableSummary,
  type ColumnInfo,
} from './sqlite-core.js'

export const name = 'dsh-tool-sqlite'
export const inject = ['tools']

function workspaceOf(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string {
  return exec.agent?.session?.header?.cwd || process.cwd()
}

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'sqlite_list',
      description:
        'List SQLite database files (.db/.sqlite/.sqlite3/.db3) inside the workspace ' +
        '(up to 2 levels deep, skipping node_modules and dot dirs). ' +
        'Use before sqlite_tables / sqlite_query to discover available databases.',
      parameters: {
        dir: {
          type: 'string',
          description: 'Optional subdirectory to scan; defaults to the workspace root.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const ws = workspaceOf(exec)
        const dbs = listDatabases(ws, args.dir)
        if (dbs.length === 0) return 'sqlite: 工作区内未发现数据库文件'
        return dbs.join('\n')
      },
      timeoutMs: 3000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'sqlite_tables',
      description:
        'List all tables and views in a SQLite database file (read-only). ' +
        'db must be a path inside the workspace.',
      parameters: {
        db: {
          type: 'string',
          required: true,
          description: 'Path to the .db/.sqlite file, relative to the workspace.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const ws = workspaceOf(exec)
        const abs = resolveDbPath(ws, args.db)
        const tables = listTables(abs)
        return tables.length ? tables.join('\n') : 'sqlite: 库中没有表或视图'
      },
      timeoutMs: 3000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'sqlite_schema',
      description:
        'Show the column schema of one table in a SQLite database (read-only). ' +
        'Returns columns with type / notnull / default / primary-key flags.',
      parameters: {
        db: {
          type: 'string',
          required: true,
          description: 'Path to the .db/.sqlite file, relative to the workspace.',
        },
        table: {
          type: 'string',
          required: true,
          description: 'Table name.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const ws = workspaceOf(exec)
        const abs = resolveDbPath(ws, args.db)
        const cols = tableSchema(abs, args.table)
        const lines = cols.map((c: ColumnInfo) =>
          [c.name, c.type, c.notnull ? 'NOT NULL' : '', c.pk ? `PK(${c.pk})` : '']
            .filter(Boolean)
            .join(' '),
        )
        return lines.join('\n')
      },
      timeoutMs: 3000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'sqlite_query',
      description:
        'Run a read-only SQL query against a SQLite database inside the workspace. ' +
        'Only SELECT / WITH / PRAGMA / EXPLAIN / VALUES are allowed; writes are rejected. ' +
        'Use ? placeholders with params for values. Results are JSON with columns + rows.',
      parameters: {
        db: {
          type: 'string',
          required: true,
          description: 'Path to the .db/.sqlite file, relative to the workspace.',
        },
        sql: {
          type: 'string',
          required: true,
          description: 'Single read-only SQL statement (SELECT / WITH / PRAGMA / EXPLAIN / VALUES).',
        },
        params: {
          type: 'array',
          items: { type: 'json' },
          description: 'Optional bound parameters for ? placeholders.',
        },
        limit: {
          type: 'integer',
          description: 'Max rows to return (default 100, hard cap 500).',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const ws = workspaceOf(exec)
        const abs = resolveDbPath(ws, args.db)
        const { columns, rows, truncated } = queryRows(
          abs,
          args.sql,
          Array.isArray(args.params) ? (args.params as unknown[]) : [],
          typeof args.limit === 'number' ? args.limit : undefined,
        )
        const head = JSON.stringify({ columns, rows })
        return truncated ? head + `\n(结果超过上限，已截断为 ${rows.length} 行)` : head
      },
      timeoutMs: 5000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'sqlite_summary',
      description:
        'Column-wise statistics summary of one table (read-only): total rows + per-column type, ' +
        'non-null count, distinct count, and min/max/avg for numeric columns. ' +
        'Use instead of SELECT * to understand a table before querying — saves tokens.',
      parameters: {
        db: {
          type: 'string',
          required: true,
          description: 'Path to the .db/.sqlite file, relative to the workspace.',
        },
        table: {
          type: 'string',
          required: true,
          description: 'Table name.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const ws = workspaceOf(exec)
        const abs = resolveDbPath(ws, args.db)
        return JSON.stringify(tableSummary(abs, args.table))
      },
      timeoutMs: 5000,
    }),
  )
}
