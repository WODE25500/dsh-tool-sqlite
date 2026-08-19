# dsh-tool-sqlite

DeepSeek Harness 的 SQLite 数据工具插件 —— 列出工作区内的数据库文件、查看表结构、执行只读 SQL 查询。**零依赖**（直接使用 Node 内置 `node:sqlite`），不引入任何第三方数据库库。

> 定位：生态工具全家桶（`dsh-tool-csv` / `dsh-tool-json` / `dsh-tool-markdown` …）处理的是"文本形态"的数据；本插件补齐"文件形态"的数据库数据——Agent 会话里出现 `.db` / `.sqlite` 文件（导出快照、爬虫结果、本地应用数据）时，不需要再起 bash 调 `sqlite3` 命令行，一次函数调用即可拿到结构化结果。

## 注册工具

| 工具 | 功能 |
| --- | --- |
| `sqlite_list` | 扫描工作区（2 层内，跳过 node_modules 与隐藏目录）找出所有 `.db/.sqlite/.sqlite3/.db3` 文件 |
| `sqlite_tables` | 列出某库内所有表与视图 |
| `sqlite_schema` | 查看某表的列结构（类型 / NOT NULL / 默认值 / 主键） |
| `sqlite_summary` | 单表列统计摘要（总行数 + 每列类型/distinct/min/max/avg）——**省 token**：不用 SELECT * 全表即可了解数据分布 |
| `sqlite_query` | 执行只读 SQL，返回 `{ columns, rows }` JSON |

> **省 token 工作流**：面对一张大表时，先 `sqlite_summary` 看分布 → 再 `sqlite_schema` 看类型 → 最后用 `sqlite_query` 精准取数。三步替代"SELECT * 全表拉进上下文"。

## 安全模型

- **只读硬约束**：数据库始终以 `readOnly: true` 打开，INSERT/UPDATE/DELETE/CREATE/DROP/ATTACH 等写语句直接被 SQLite 拒绝（`attempt to write a readonly database`）；
- **语句白名单**：仅放行 `SELECT / WITH / PRAGMA / EXPLAIN / VALUES` 开头的单条语句；只走 `prepare`（单语句），不走多语句 `exec`；
- **路径边界**：所有 `db` 参数解析后必须位于工作区内，`../` 与绝对路径越界直接报错；
- **输出预算**：结果默认 100 行、硬上限 500 行，超限明确标注截断，防输出膨胀；
- **超时兜底**：查询 5000ms、其余 3000ms。

## 安装

```yaml
# cordis.yml / dsh.profile 引用
plugins:
  - id: tool-sqlite
    name: 'dsh-tool-sqlite'
```

或本地路径方式：

```yaml
plugins:
  ./src/index.ts: {}
```

启动后控制台出现 `[tool-sqlite]` 相关日志即加载成功。

## 使用示例

```
sqlite_list → data/app.db
sqlite_tables db: data/app.db → users, orders
sqlite_schema db: data/app.db table: users → id INTEGER PK(1) / name TEXT NOT NULL …
sqlite_query db: data/app.db sql: "SELECT name, age FROM users WHERE age >= ?" params: [30]
```

## 开发

```sh
npm install
npm run check   # typecheck + test + build
```

- Node 要求：`^22.19.0 || >=24.0.0`（`node:sqlite` 需要 Node 22.5+）。
- 核心逻辑在 `src/sqlite-core.ts`（纯函数、可单测），插件入口在 `src/index.ts`。

## 许可

MIT
