import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlitePool } from "../src/pglite-pool.js";

const pool = new PGlitePool();

describe("PGlite 连接池", () => {
  beforeAll(async () => {
    await pool.query("CREATE TABLE items(id TEXT PRIMARY KEY, name TEXT, qty INT)");
    await pool.query("INSERT INTO items(id, name, qty) VALUES('a','apple',3),('b','banana',5)");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("按 pg 的规则算 rowCount：查询看返回行数，写入看影响行数", async () => {
    const selected = await pool.query("SELECT * FROM items");
    expect(selected.rowCount).toBe(2);
    expect(selected.rows).toHaveLength(2);

    const inserted = await pool.query("INSERT INTO items(id, name, qty) VALUES('c','cherry',1)");
    expect(inserted.rowCount).toBe(1);
    expect(inserted.rows).toHaveLength(0);

    const updated = await pool.query("UPDATE items SET qty = qty + 1 WHERE qty > $1", [1]);
    expect(updated.rowCount).toBe(2);

    const deleted = await pool.query("DELETE FROM items WHERE id=$1", ["c"]);
    expect(deleted.rowCount).toBe(1);

    // UPDATE ... RETURNING 按返回行数算，不是 affectedRows
    const returning = await pool.query("UPDATE items SET name='x' WHERE id=$1 RETURNING id", ["a"]);
    expect(returning.rowCount).toBe(1);
    expect(returning.rows[0]?.id).toBe("a");
  });

  it("没有命中任何行时 rowCount 为 0", async () => {
    const missing = await pool.query("UPDATE items SET name='y' WHERE id=$1", ["nope"]);
    expect(missing.rowCount).toBe(0);
    const none = await pool.query("SELECT * FROM items WHERE id=$1", ["nope"]);
    expect(none.rowCount).toBe(0);
    expect(none.rows).toHaveLength(0);
  });

  it("保留 PostgreSQL 的类型：int 是数字，timestamptz 是 Date，jsonb 是对象", async () => {
    await pool.query("CREATE TABLE typed(id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), meta JSONB)");
    const inserted = await pool.query("INSERT INTO typed(meta) VALUES($1) RETURNING id, at, meta", [JSON.stringify({ a: 1, b: "x" })]);
    const row = inserted.rows[0]!;
    expect(typeof row.id).toBe("number");
    expect(row.at instanceof Date).toBe(true);
    expect(row.meta).toEqual({ a: 1, b: "x" });
  });

  it("事务失败时回滚，不留下半截数据", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO items(id, name, qty) VALUES('rollback-me','x',1)");
    await client.query("ROLLBACK");
    const after = await pool.query("SELECT * FROM items WHERE id=$1", ["rollback-me"]);
    expect(after.rowCount).toBe(0);
  });

  it("事务提交后数据可见", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO items(id, name, qty) VALUES('committed','x',1)");
    await client.query("COMMIT");
    const after = await pool.query("SELECT * FROM items WHERE id=$1", ["committed"]);
    expect(after.rowCount).toBe(1);
  });

  it("事务期间 pool.query 发到同一个客户端，不会卡住", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("INSERT INTO items(id, name, qty) VALUES('inside-tx','x',1)");
    // 事务开着的时候用 pool.query：应该走同一个事务，不死锁
    const inside = await pool.query("SELECT * FROM items WHERE id=$1", ["inside-tx"]);
    expect(inside.rowCount).toBe(1);
    await client.query("COMMIT");
    const outside = await pool.query("SELECT * FROM items WHERE id=$1", ["inside-tx"]);
    expect(outside.rowCount).toBe(1);
  });

  it("事务回滚时，事务期间用 pool.query 写的行也一起消失", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await pool.query("INSERT INTO items(id, name, qty) VALUES('tx-pool-write','x',1)");
    await client.query("ROLLBACK");
    const after = await pool.query("SELECT * FROM items WHERE id=$1", ["tx-pool-write"]);
    expect(after.rowCount).toBe(0);
  });

  it("唯一约束冲突时抛出带 23505 的错误", async () => {
    await expect(pool.query("INSERT INTO items(id, name, qty) VALUES('a','dup',1)")).rejects.toMatchObject({ code: "23505" });
  });

  it("支持 FOR UPDATE 与 advisory lock", async () => {
    const client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["some-key"]);
    const locked = await client.query("SELECT * FROM items WHERE id=$1 FOR UPDATE", ["a"]);
    expect(locked.rowCount).toBe(1);
    await client.query("COMMIT");
  });

  it("LISTEN 能收到通知", async () => {
    const client = await pool.connect();
    const received: string[] = [];
    client.on("notification", (message: { payload: string }) => { received.push(message.payload); });
    await client.query("LISTEN test_channel");
    await pool.query("SELECT pg_notify($1, $2)", ["test_channel", "hello"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received).toContain("hello");
    await client.release();
  });

  it("并发查询不会互相插队", async () => {
    const results = await Promise.all([
      pool.query("SELECT 1 AS n"),
      pool.query("SELECT 2 AS n"),
      pool.query("SELECT 3 AS n"),
    ]);
    expect(results.map((r) => r.rows[0]?.n)).toEqual([1, 2, 3]);
  });
});
