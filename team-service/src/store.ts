import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { Config } from "./config.js";
import { PGlitePool } from "./pglite-pool.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsPath = path.resolve(here, "../migrations");

export class Store {
  readonly pool: Pool;

  constructor(config: Config, pool?: Pool) {
    this.pool = pool ?? new Pool({ connectionString: config.databaseUrl, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }

  /** 内嵌模式：用进程内的 PGlite 当数据库，不依赖外部 Postgres。 */
  static embedded(config: Config, dataDir?: string): Store {
    return new Store(config, new PGlitePool(dataDir ? { dataDir } : {}) as unknown as Pool);
  }

  async migrate(): Promise<void> {
    await this.pool.query("CREATE TABLE IF NOT EXISTS team_schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
    const files = (await readdir(migrationsPath)).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
    for (const version of files) {
      const applied = await this.pool.query("SELECT 1 FROM team_schema_migrations WHERE version=$1", [version]);
      if (applied.rowCount) continue;
      const sql = await readFile(path.join(migrationsPath, version), "utf8");
      await this.transaction(async (client) => {
        for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await client.query(statement);
        await client.query("INSERT INTO team_schema_migrations(version) VALUES($1)", [version]);
      });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async one<T extends QueryResultRow>(client: PoolClient, sql: string, values: unknown[] = []): Promise<T | undefined> {
    const result = await client.query<T>(sql, values);
    return result.rows[0];
  }
}
