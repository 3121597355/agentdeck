import { createHash } from "node:crypto";
import type { Adapter } from "../adapters/types";
import { EventEngine } from "../engine";
import type { AgentEvent, Session } from "../types";

const key = (session: Pick<Session, "agent" | "sessionId">) => `${session.agent}:${session.sessionId}`;

/** Desktop sources share the same request reducer and notification outbox as hooks. */
export class HostSourceCollector {
  private initialized = new Set<string>();
  private seen = new Map<string, Set<string>>();
  readonly errors: Record<string, string> = {};

  constructor(private engine: EventEngine, private adapters: () => Adapter[], private onError = (_text: string) => {}) {}

  async poll() {
    const subscribed = await this.engine.store.subscribed();
    const known = new Set(subscribed.map(key));
    for (const old of this.initialized) if (!known.has(old)) { this.initialized.delete(old); this.seen.delete(old); }
    const results = await Promise.allSettled(this.adapters().filter(adapter => adapter.source?.poll).map(async adapter => {
      const sessions = subscribed.filter(session => session.agent === adapter.id);
      if (!sessions.length) { delete this.errors[adapter.id]; return; }
      try {
        const events = await adapter.source!.poll!(sessions);
        const owned = new Set(sessions.map(key));
        for (const event of events.sort((a, b) => a.at - b.at)) {
          if (event.agent !== adapter.id || !owned.has(key(event))) throw new Error("来源上报了不属于订阅会话的事件");
          if (!Number.isFinite(event.at) || event.at < 0) throw new Error("来源事件缺少真实时间");
          const identity = event.eventId || createHash("sha256").update(JSON.stringify(event)).digest("hex");
          const sessionKey = key(event);
          const seen = this.seen.get(sessionKey) ?? new Set<string>();
          if (seen.has(identity)) continue;
          await this.engine.ingest({ ...event, eventId: identity }, { silent: !this.initialized.has(sessionKey) });
          seen.add(identity);
          if (seen.size > 10000) seen.delete(seen.values().next().value!);
          this.seen.set(sessionKey, seen);
        }
        for (const session of sessions) this.initialized.add(key(session));
        delete this.errors[adapter.id];
      } catch (error) {
        const text = `${adapter.name}: ${String(error)}`;
        if (this.errors[adapter.id] !== text) this.onError(text);
        this.errors[adapter.id] = text;
      }
    }));
    for (const result of results) if (result.status === "rejected") this.onError(String(result.reason));
  }
}
