import { EventEmitter } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { TeamEventHub } from "../src/events.js";

class FakeListenerClient extends EventEmitter {
  readonly queries: string[] = [];
  releaseCount = 0;

  async query(sql: string) {
    this.queries.push(sql);
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.releaseCount += 1;
  }
}

class FakePool {
  readonly clients: FakeListenerClient[] = [];

  async connect(): Promise<PoolClient> {
    const client = new FakeListenerClient();
    this.clients.push(client);
    return client as unknown as PoolClient;
  }
}

class PGliteListenerClient extends EventEmitter {
  private unlisten: (() => Promise<void>) | undefined;
  private resolveListening!: () => void;
  readonly listening = new Promise<void>((resolve) => { this.resolveListening = resolve; });

  constructor(private readonly db: PGlite) { super(); }

  async query(sql: string) {
    const listen = /^LISTEN ([a-z_]+)$/.exec(sql);
    if (listen) {
      const channel = listen[1]!;
      this.unlisten = await this.db.listen(channel, (payload) => this.emit("notification", { channel, payload }));
      this.resolveListening();
      return { rows: [], rowCount: 0 };
    }
    return this.db.query(sql);
  }

  release(): void {
    const unlisten = this.unlisten;
    this.unlisten = undefined;
    if (unlisten) void unlisten();
    this.emit("end");
  }
}

class PGlitePool {
  readonly clients: PGliteListenerClient[] = [];

  constructor(readonly db: PGlite) {}

  async connect(): Promise<PoolClient> {
    const client = new PGliteListenerClient(this.db);
    this.clients.push(client);
    return client as unknown as PoolClient;
  }

  query(sql: string, params: unknown[] = []) { return this.db.query(sql, params); }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!predicate()) throw new Error("Timed out waiting for the event listener");
}

describe("team event hub", () => {
  it("publishes locally and removes unsubscribed listeners", () => {
    const hub = new TeamEventHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe("conversation-a", listener);
    hub.publish("conversation-a");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    hub.publish("conversation-a");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("listens on the update channel and routes only matching conversation notifications", async () => {
    const pool = new FakePool();
    const hub = new TeamEventHub(pool as unknown as Pool);
    const first = vi.fn();
    const second = vi.fn();
    hub.subscribe("conversation-a", first);
    hub.subscribe("conversation-b", second);
    hub.start();
    await waitFor(() => pool.clients[0]?.queries.includes("LISTEN team_conversation_updates") ?? false);

    pool.clients[0]!.emit("notification", { channel: "team_conversation_updates", payload: "conversation-a" });
    pool.clients[0]!.emit("notification", { channel: "some_other_channel", payload: "conversation-b" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    await hub.stop();
    expect(pool.clients[0]!.releaseCount).toBe(1);
  });

  it("waits for an in-flight connection and releases it once when stopped", async () => {
    const pool = new FakePool();
    const hub = new TeamEventHub(pool as unknown as Pool);
    hub.start();
    await hub.stop();
    await hub.stop();
    expect(pool.clients).toHaveLength(1);
    expect(pool.clients[0]!.releaseCount).toBe(1);
  });

  it("broadcasts a PGlite LISTEN/NOTIFY event between separate event hubs", async () => {
    const db = new PGlite();
    const poolA = new PGlitePool(db);
    const poolB = new PGlitePool(db);
    const hubA = new TeamEventHub(poolA as unknown as Pool);
    const hubB = new TeamEventHub(poolB as unknown as Pool);
    const first = vi.fn();
    const second = vi.fn();
    hubA.subscribe("conversation-a", first);
    hubB.subscribe("conversation-a", second);
    hubA.start();
    hubB.start();
    try {
      await waitFor(() => poolA.clients.length === 1 && poolB.clients.length === 1);
      await Promise.all([poolA.clients[0]!.listening, poolB.clients[0]!.listening]);
      hubA.publish("conversation-a");
      await waitFor(() => first.mock.calls.length === 1 && second.mock.calls.length === 1);
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    } finally {
      await Promise.all([hubA.stop(), hubB.stop()]);
      await db.close();
    }
  });

  it("reconnects the LISTEN connection after it ends", async () => {
    const pool = new FakePool();
    const hub = new TeamEventHub(pool as unknown as Pool);
    const listener = vi.fn();
    hub.subscribe("conversation-a", listener);
    hub.start();
    await waitFor(() => pool.clients[0]?.queries.includes("LISTEN team_conversation_updates") ?? false);
    pool.clients[0]!.emit("end");
    await waitFor(() => pool.clients[1]?.queries.includes("LISTEN team_conversation_updates") ?? false);
    pool.clients[1]!.emit("notification", { channel: "team_conversation_updates", payload: "conversation-a" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(listener).toHaveBeenCalledOnce();
    await hub.stop();
  });
});
