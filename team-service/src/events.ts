import type { Pool, PoolClient } from "pg";

const CHANNEL = "team_conversation_updates";

export class TeamEventHub {
  private readonly listeners = new Map<string, Set<() => void>>();
  private stopped = true;
  private wakeListener: (() => void) | undefined;
  private loopPromise: Promise<void> | undefined;

  constructor(private readonly pool?: Pool) {}

  start(): void {
    if (this.loopPromise) return;
    this.stopped = false;
    const loop = this.listenLoop().finally(() => {
      if (this.loopPromise === loop) this.loopPromise = undefined;
    });
    this.loopPromise = loop;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeListener?.();
    await this.loopPromise;
  }

  subscribe(conversationId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(conversationId) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(conversationId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(conversationId);
    };
  }

  publish(conversationId: string): void {
    if (!this.pool) {
      for (const listener of this.listeners.get(conversationId) ?? []) listener();
      return;
    }
    void this.pool.query("SELECT pg_notify($1, $2)", [CHANNEL, conversationId]).catch(() => undefined);
  }

  private async listenLoop(): Promise<void> {
    while (!this.stopped && this.pool) {
      let client: PoolClient | undefined;
      try {
        client = await this.pool.connect();
        if (this.stopped) break;
        client.on("notification", (message) => {
          if (message.channel !== CHANNEL || !message.payload) return;
          for (const listener of this.listeners.get(message.payload) ?? []) listener();
        });
        await client.query(`LISTEN ${CHANNEL}`);
        await new Promise<void>((resolve) => {
          const wake = () => {
            if (this.wakeListener === wake) this.wakeListener = undefined;
            resolve();
          };
          this.wakeListener = wake;
          client!.once("error", wake);
          client!.once("end", wake);
          if (this.stopped) wake();
        });
      } catch {
        if (!this.stopped) await new Promise((resolve) => setTimeout(resolve, 1_000));
      } finally {
        try {
          if (client) client.release(true);
        } finally {
          this.wakeListener?.();
          this.wakeListener = undefined;
        }
      }
    }
  }
}
