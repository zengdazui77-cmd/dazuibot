import type { PoolClient } from "pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { TeamEventHub } from "../src/events.js";

const databaseUrl = process.env.TEAM_TEST_DATABASE_URL;
const CHANNEL = "team_conversation_updates";

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error("Timed out waiting for PostgreSQL LISTEN/NOTIFY"));
      setTimeout(check, 10);
    };
    check();
  });
}

function trackedPool(pool: Pool): { pool: Pool; listening: Promise<void> } {
  let resolveListening!: () => void;
  const listening = new Promise<void>((resolve) => { resolveListening = resolve; });
  const connect = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    client.query = (async (...args: Parameters<PoolClient["query"]>) => {
      const result = await query(...args);
      if (typeof args[0] === "string" && args[0].trim().toUpperCase() === `LISTEN ${CHANNEL.toUpperCase()}`) resolveListening();
      return result;
    }) as PoolClient["query"];
    return client;
  };
  return {
    pool: { connect, query: (...args: Parameters<Pool["query"]>) => pool.query(...args) } as Pool,
    listening,
  };
}

describe.skipIf(!databaseUrl)("real PostgreSQL event hub integration", () => {
  it("delivers a transactional notification to listeners on two independent pools after commit", async () => {
    const rawPoolA = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
    const rawPoolB = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
    const publisher = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
    const poolA = trackedPool(rawPoolA);
    const poolB = trackedPool(rawPoolB);
    const hubA = new TeamEventHub(poolA.pool);
    const hubB = new TeamEventHub(poolB.pool);
    const first = { calls: 0 };
    const second = { calls: 0 };
    const conversationId = `postgres-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    hubA.subscribe(conversationId, () => { first.calls += 1; });
    hubB.subscribe(conversationId, () => { second.calls += 1; });
    hubA.start();
    hubB.start();
    try {
      await Promise.all([poolA.listening, poolB.listening]);
      await publisher.query("BEGIN");
      await publisher.query("SELECT pg_notify($1, $2)", [CHANNEL, conversationId]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(first.calls).toBe(0);
      expect(second.calls).toBe(0);
      await publisher.query("COMMIT");
      await waitFor(() => first.calls === 1 && second.calls === 1);
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(1);
    } finally {
      await Promise.all([hubA.stop(), hubB.stop()]);
      await Promise.all([rawPoolA.end(), rawPoolB.end(), publisher.end()]);
    }
  });
});
