import { strict as assert } from "node:assert";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { applyEvent } from "../src/core/status";
import {
  clearCustomSessionCache,
  customSessionAdapter,
  discoverCustomSessions,
  parseCustomSessionRecord,
} from "../src/core/adapters/custom-session";
import type { CustomUsageAgent, Session } from "../src/core/types";
import { tempDir } from "./helpers";

function jsonLines(path: string, records: unknown[], append = false): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const content = records.map(record => JSON.stringify(record)).join("\n") + "\n";
  if (append) appendFileSync(path, content);
  else writeFileSync(path, content);
}

function agent(path: string): CustomUsageAgent {
  return {
    id: "custom-test-agent",
    name: "Test Agent",
    path,
    filePattern: "*.jsonl",
    timestampField: "event.at",
    timestampUnit: "iso",
    enabled: true,
    scanSessions: true,
    sessionIdField: "meta.session",
    eventTypeField: "event.type",
    titleField: "meta.name",
    cwdField: "meta.cwd",
    summaryField: "payload.summary",
    requestIdField: "event.request",
  };
}

test("custom session discovery projects arbitrary JSONL metadata", async t => {
  clearCustomSessionCache();
  const root = tempDir(t);
  const file = join(root, "records.jsonl");
  const at = (minute: number) => new Date(Date.parse(`2026-11-18T02:${String(minute).padStart(2, "0")}:00Z`)).toISOString();
  jsonLines(file, [
    { meta: { session: "s1", name: "Build parser", cwd: "C:\\work\\one" }, event: { type: "started", at: at(0) } },
    { meta: { session: "s2", name: "Review output", cwd: "C:\\work\\two" }, event: { type: "running", at: at(1) } },
    { meta: { session: "s1" }, event: { type: "progressive", at: at(2) } },
    { meta: { session: "s1" }, payload: { summary: "Parser is ready." }, event: { type: "stopped", at: at(3) } },
  ]);

  const entries = await discoverCustomSessions(agent(root));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].sessionId, "s1");
  assert.equal(entries[0].title, "Build parser");
  assert.equal(entries[0].cwd, "C:\\work\\one");
  assert.equal(entries[0].summary, "Parser is ready.");
  assert.equal(entries[0].updatedAt, Date.parse(at(3)));
  assert.equal(entries[1].sessionId, "s2");
});

test("custom JSONL events update subscribed session status and resolve mapped requests", () => {
  const config = agent("C:\\logs");
  const at = (minute: number) => Date.parse(`2026-11-18T02:${String(minute).padStart(2, "0")}:00Z`);
  const records = [
    { meta: { session: "s1", name: "Build parser", cwd: "C:\\work" }, event: { type: "started", at: new Date(at(0)).toISOString() } },
    { meta: { session: "s1" }, event: { type: "running", at: new Date(at(1)).toISOString() } },
    { meta: { session: "s1" }, event: { type: "needs_input", at: new Date(at(2)).toISOString(), request: "q1" } },
    { meta: { session: "s1" }, event: { type: "resolved", at: new Date(at(3)).toISOString(), request: "q1" } },
    { meta: { session: "s1" }, payload: { summary: "Build complete." }, event: { type: "stopped", at: new Date(at(4)).toISOString() } },
  ];

  let session: Session | undefined;
  for (const record of records) {
    for (const event of parseCustomSessionRecord(record, config, { agent: config.id, sessionId: "s1" })) {
      session = applyEvent(session, event)?.next ?? session;
    }
  }
  assert.ok(session);
  assert.equal(session.status, "ready");
  assert.equal(session.title, "Build parser");
  assert.equal(session.cwd, "C:\\work");
  assert.equal(session.summary, "Build complete.");
  assert.deepEqual(session.state?.pending, []);
  assert.equal(session.state?.resolved.includes("q1"), true);
});

test("custom session cache refreshes after append and disabled sources expose no scanner", async t => {
  clearCustomSessionCache();
  const root = tempDir(t);
  const file = join(root, "events.jsonl");
  const config = agent(root);
  const first = { meta: { session: "s1", name: "First" }, event: { type: "started", at: "2026-11-18T02:00:00Z" } };
  jsonLines(file, [first]);
  assert.equal((await discoverCustomSessions(config))[0].updatedAt, Date.parse("2026-11-18T02:00:00Z"));
  jsonLines(file, [{ meta: { session: "s1" }, event: { type: "stopped", at: "2026-11-18T02:05:00Z" } }], true);
  assert.equal((await discoverCustomSessions(config))[0].updatedAt, Date.parse("2026-11-18T02:05:00Z"));

  const disabled = customSessionAdapter({ ...config, enabled: false });
  assert.equal(disabled.source, undefined);
  await assert.rejects(() => discoverCustomSessions({ ...config, path: join(root, "missing") }), /路径不存在/);
});
