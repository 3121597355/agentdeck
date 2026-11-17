import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join } from "node:path";
import { Store } from "../src/core/db";
import { EventEngine } from "../src/core/engine";
import { HostSourceCollector } from "../src/core/sources/hosts";
import { DEFAULT_CONFIG } from "../src/core/config";
import { deliverNotifications } from "../src/core/notifications";
import type { Adapter } from "../src/core/adapters/types";
import type { AgentEvent, Session } from "../src/core/types";
import { tempDir } from "./helpers";

function adapter(id: string, poll: (sessions: Session[]) => Promise<AgentEvent[]>): Adapter {
  return { id, name: id, detect: () => ({ present: true, hooked: false, hosts: ["app"] }),
    planInstall: () => ({ changes: [], notes: [] }), planUninstall: () => ({ changes: [], notes: [] }),
    jump: async () => ({ ok: false, method: "none" }), source: { poll } };
}

test("desktop polling restores pending history silently, retains it through stops, and notifies once for a new request", async t => {
  const store = new Store(join(tempDir(t), "inbox.sqlite"));
  const config = { ...DEFAULT_CONFIG, notificationChannels: ["windows"] };
  const engine = new EventEngine(store, () => config);
  const event = (type: AgentEvent["type"], at: number, requestIds?: string[]): AgentEvent =>
    ({ agent: "workbuddy", sessionId: "real-session", type, at, requestIds, eventId: `host-${at}`, attention: type === "needs_input" ? "question" : undefined });
  await engine.ingest(event("started", 0));
  await store.setSubscribed("workbuddy", "real-session", true);
  let events = [event("progress", 1), event("needs_input", 2, ["old"]), event("stopped", 3)];
  const collector = new HostSourceCollector(engine, () => [adapter("workbuddy", async () => events)]);
  const delivered: string[] = [];
  const drain = () => deliverNotifications(store, config, [{ id: "windows", async send(value) { delivered.push(value.id); } }]);
  await collector.poll(); await drain();
  assert.equal((await store.get("workbuddy", "real-session"))!.status, "needs_input");
  assert.equal(delivered.length, 0);
  events = [...events, event("resolved", 4, ["old"]), event("progress", 5), event("needs_input", 6, ["new"])];
  await collector.poll(); await drain(); await collector.poll(); await drain();
  assert.deepEqual((await store.get("workbuddy", "real-session"))!.state!.pending.map(request => request.id), ["new"]);
  assert.equal(delivered.length, 1);
  events = [...events, event("resolved", 7, ["new"]), event("stopped", 8)];
  await collector.poll();
  assert.equal((await store.get("workbuddy", "real-session"))!.status, "ready");
});

test("one failing desktop source does not stop another source; errors clear after recovery", async t => {
  const store = new Store(join(tempDir(t), "inbox.sqlite"));
  const engine = new EventEngine(store, () => DEFAULT_CONFIG);
  for (const agent of ["dsh", "cursor"]) {
    await engine.ingest({ agent, sessionId: "session", type: "started", at: 0 });
    await store.setSubscribed(agent, "session", true);
  }
  let unavailable = true;
  const sources = [adapter("dsh", async () => { if (unavailable) throw new Error("database busy"); return []; }),
    adapter("cursor", async () => [{ agent: "cursor", sessionId: "session", type: "progress", at: 1, eventId: "cursor-1" }])];
  const collector = new HostSourceCollector(engine, () => sources);
  await collector.poll();
  assert.match(collector.errors.dsh, /database busy/);
  assert.equal((await store.get("cursor", "session"))!.status, "running");
  unavailable = false; await collector.poll();
  assert.equal(collector.errors.dsh, undefined);
});
