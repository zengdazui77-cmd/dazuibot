import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * PGlite 是一份跑在进程内的 PostgreSQL（WASM），只有一个会话，没有独立连接。`pg` 的连接池语义要在这里重建：
 *
 * - 连接池的每个「连接」其实共用同一个 PGlite 实例，所以并发查询会互相插队。
 * - 一旦某个连接处于事务中，别的连接发出的 SQL 会被算进这个事务里（连接池 + 事务 = 数据错乱）。
 * - `pg` 的 rowCount 语义：SELECT / RETURNING 等于返回行数，其余语句等于影响行数。PGlite 的
 *   `affectedRows` 是影响行数、`fields.length` 能区分「有没有返回列」，两者合起来才能还原 rowCount。
 *
 * 这里的实现用一把互斥锁把会话串起来：普通查询各自短暂持锁，事务从 BEGIN 到 COMMIT 全程独占。
 * 事务期间发出的 pool.query 会转到事务所在的那个客户端上，不会去抢已被占着的锁。
 */

export interface PGlitePoolOptions {
  /** 数据目录；不传就用内存库（退出即丢）。传了就落盘，重启后数据还在。 */
  dataDir?: string;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** 排队取锁；返回的函数用来放锁。 */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => next, () => next);
    await previous.catch(() => undefined);
    return release;
  }
}

interface NormalizedQuery {
  text: string;
  values: unknown[];
}

function normalizeQuery(config: unknown, values?: unknown): NormalizedQuery {
  if (typeof config === "string") return { text: config, values: Array.isArray(values) ? values : [] };
  if (config && typeof config === "object") {
    const record = config as { text?: unknown; values?: unknown };
    if (typeof record.text === "string") return { text: record.text, values: Array.isArray(record.values) ? record.values : [] };
  }
  throw new TypeError("The query must be a SQL string or a { text, values } object");
}

function commandOf(sql: string): string {
  const match = /^\s*([a-z]+)/i.exec(sql);
  return match ? match[1]!.toUpperCase() : "";
}

function emptyResult<R extends QueryResultRow>(command: string): QueryResult<R> {
  return { command, rowCount: 0, oid: 0, rows: [], fields: [] } as unknown as QueryResult<R>;
}

/** 把 PGlite 的结果还原成 `pg` 的形状：rowCount 按 pg 的规则算，而不是直接用 affectedRows。 */
function toQueryResult<R extends QueryResultRow>(result: { rows: R[]; fields?: unknown[]; affectedRows?: number }): QueryResult<R> {
  const rows = result.rows ?? [];
  const returnsRows = (result.fields?.length ?? 0) > 0;
  const rowCount = returnsRows ? rows.length : result.affectedRows ?? 0;
  return {
    command: "",
    rowCount,
    oid: 0,
    rows,
    fields: (result.fields ?? []) as QueryResult<R>["fields"],
  } as unknown as QueryResult<R>;
}

export class PGlitePoolClient extends EventEmitter {
  /** 事务进行中：SQL 只能由这个客户端发，不能让别的连接插进来。 */
  private inTransaction = false;
  private releaseLock: (() => void) | undefined;
  private readonly unlisteners = new Map<string, () => Promise<void>>();

  constructor(private readonly pool: PGlitePool) {
    super();
  }

  async query<R extends QueryResultRow = QueryResultRow>(config: unknown, values?: unknown): Promise<QueryResult<R>> {
    const query = normalizeQuery(config, values);
    const command = commandOf(query.text);

    // BEGIN 要独占会话：从这里到 COMMIT / ROLLBACK 都不放锁。
    // 这一段必须在抢锁之前处理，否则会自己等自己。
    if (command === "BEGIN" && !this.inTransaction) {
      this.releaseLock = await this.pool.lock.acquire();
      this.inTransaction = true;
      this.pool.activeTransaction = this;
      try {
        await this.pool.db.exec("BEGIN");
      } catch (error) {
        this.inTransaction = false;
        this.pool.activeTransaction = undefined;
        this.releaseLock?.();
        this.releaseLock = undefined;
        throw error;
      }
      return emptyResult<R>("BEGIN");
    }

    // 事务进行中：直接跑，不再抢锁（锁已经被事务持着）。
    if (this.inTransaction) return this.run<R>(query, command);

    const release = await this.pool.lock.acquire();
    try {
      return await this.run<R>(query, command);
    } finally {
      release();
    }
  }

  /** 释放连接：结束监听、退出事务、放锁。`destroy` 对应 `pg` 的 release(true)。 */
  async release(destroy?: boolean): Promise<void> {
    if (this.inTransaction) await this.rollback();
    for (const unlisten of this.unlisteners.values()) await unlisten().catch(() => undefined);
    this.unlisteners.clear();
    if (destroy) this.removeAllListeners();
  }

  private async run<R extends QueryResultRow>(query: NormalizedQuery, command: string): Promise<QueryResult<R>> {
    if (command === "COMMIT" || command === "ROLLBACK") {
      try {
        await this.pool.db.exec(command);
      } finally {
        this.inTransaction = false;
        if (this.pool.activeTransaction === this) this.pool.activeTransaction = undefined;
        const release = this.releaseLock;
        this.releaseLock = undefined;
        release?.();
      }
      return emptyResult<R>(command);
    }
    if (command === "LISTEN") {
      const channel = query.text.trim().split(/\s+/)[1] ?? "";
      await this.listen(channel);
      return emptyResult<R>("LISTEN");
    }
    if (command === "UNLISTEN") {
      const target = query.text.trim().split(/\s+/)[1] ?? "";
      if (target === "*") {
        for (const unlisten of this.unlisteners.values()) await unlisten().catch(() => undefined);
        this.unlisteners.clear();
      } else {
        const unlisten = this.unlisteners.get(target);
        if (unlisten) {
          await unlisten().catch(() => undefined);
          this.unlisteners.delete(target);
        }
      }
      return emptyResult<R>("UNLISTEN");
    }
    const result = await this.pool.db.query(query.text, query.values as never[]);
    return toQueryResult<R>(result as never);
  }

  /** LISTEN 必须走 PGlite 的 listen()：直接发 SQL 不会把通知回调到我们身上。 */
  private async listen(channel: string): Promise<void> {
    if (!channel || this.unlisteners.has(channel)) return;
    const unlisten = await this.pool.db.listen(channel, (payload) => {
      this.emit("notification", { channel, payload });
    });
    this.unlisteners.set(channel, unlisten);
  }

  private async rollback(): Promise<void> {
    try {
      await this.pool.db.exec("ROLLBACK");
    } catch {
      // 会话可能已经不在事务里；回滚失败不该盖住真正的错误。
    } finally {
      this.inTransaction = false;
      if (this.pool.activeTransaction === this) this.pool.activeTransaction = undefined;
      const release = this.releaseLock;
      this.releaseLock = undefined;
      release?.();
    }
  }
}

/**
 * PGlite 版连接池。对外是 `pg` 的 Pool / PoolClient 形状，所以 `Store` 不用改就能用。
 */
export class PGlitePool {
  readonly db: PGlite;
  readonly lock = new Mutex();
  /** 正在进行的事务客户端：事务期间 pool.query 要发到它身上，否则会死锁。 */
  activeTransaction: PGlitePoolClient | undefined;
  private readonly clients = new Set<PGlitePoolClient>();
  private shared: PGlitePoolClient | undefined;
  private closed = false;

  constructor(readonly options: PGlitePoolOptions = {}) {
    this.db = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  }

  async query<R extends QueryResultRow = QueryResultRow>(config: unknown, values?: unknown): Promise<QueryResult<R>> {
    // 事务进行中：pool.query 必须发到事务客户端身上，否则它会去抢已被事务占着的锁 → 死锁。
    if (this.activeTransaction) return this.activeTransaction.query<R>(config, values);
    const client = await this.sharedClient();
    return client.query<R>(config, values);
  }

  private async sharedClient(): Promise<PGlitePoolClient> {
    if (this.shared) return this.shared;
    const client = new PGlitePoolClient(this);
    this.clients.add(client);
    this.shared = client;
    return client;
  }

  async connect(): Promise<PoolClient> {
    if (this.closed) throw new Error("The PGlite pool is closed");
    const client = new PGlitePoolClient(this);
    this.clients.add(client);
    return client as unknown as PoolClient;
  }

  async end(): Promise<void> {
    this.closed = true;
    for (const client of this.clients) await client.release(true).catch(() => undefined);
    this.clients.clear();
    this.shared = undefined;
    await this.db.close();
  }
}

/** 造一个能直接喂给 `Store` 的连接池。 */
export function createPGlitePool(options: PGlitePoolOptions = {}): Pool {
  return new PGlitePool(options) as unknown as Pool;
}
