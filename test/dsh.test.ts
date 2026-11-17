import { strict as assert } from "node:assert";
import { test } from "node:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createDshPoller, discoverDshSessions, dshZstdFrames, parseDshEvent, readDshTitles } from "../src/core/adapters/dsh";
import { applyEvent } from "../src/core/status";
import type { Session } from "../src/core/types";
import { tempDir } from "./helpers";

const frame = (entries: unknown[]) => zstdCompressSync(Buffer.from(entries.map(entry => JSON.stringify(entry)).join("\n") + "\n"));
const native = (type: string, seq: number, data: unknown) => ({ type, seq, time: 1000 + seq, data });
const header = { type: "session", version: 4, id: "native-session", createdAt: 1000, cwd: "C:\\真实项目", isSeeded: false };

test("DSH scans concatenated independent Zstandard frames and waits for torn final writes", () => {
  const one = frame([header]), two = frame([native("turn/start", 1, { turn: 1 })]);
  const complete = dshZstdFrames(Buffer.concat([one, two]));
  assert.deepEqual(complete, [{ start: 0, end: one.length }, { start: one.length, end: one.length + two.length }]);
  assert.equal(dshZstdFrames(Buffer.concat([one, two.subarray(0, two.length - 1)])).length, 1);
  assert.throws(() => dshZstdFrames(Buffer.from("not a zstd frame")), /magic invalid/);
});

test("DSH discovers header identities and cached titles without starting the host or writing its records", async t => {
  const root = tempDir(t), sessionDir = join(root, "sessions", "encoded-workspace", "native-session");
  mkdirSync(sessionDir, { recursive: true }); mkdirSync(join(root, "storages", "session_projcache", "sessions"), { recursive: true });
  const file = join(sessionDir, "session.v4.jsonl.zstd"); writeFileSync(file, frame([header]));
  writeFileSync(join(root, "storages", "session_projcache", "sessions", "native-session.json"), JSON.stringify({ version: 1, record: { identity: {}, rows: { title: { ver: 1, seq: 3, val: "真实中文标题" }, sessionListMetadata: { val: { lastPromptAt: 1010 } } } } }));
  const entries = discoverDshSessions(root);
  assert.equal(entries.length, 1); assert.equal(entries[0].sessionId, "native-session");
  assert.equal(entries[0].title, "真实中文标题"); assert.equal(entries[0].cwd, "C:\\真实项目");
  assert.equal(entries[0].transcriptPath, file);
  const named = await readDshTitles([{ ...entries[0], status: "idle", attention: null, locator: {}, subscribed: true, handledAt: null }], root);
  assert.equal(named[0].title, "真实中文标题"); assert.equal(named[0].source, "dsh-title-projection");
});

test("DSH polling restores history once, reads newly appended frames, and resolves only the matching native question", async t => {
  const root = tempDir(t), sessionDir = join(root, "sessions", "workspace", "native-session");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, "session.v4.jsonl.zstd");
  writeFileSync(file, Buffer.concat([frame([header]), frame([
    native("turn/start", 1, { turn: 1 }),
    native("tool/call", 2, { name: "ask_user_question", callId: "q1", arguments: JSON.stringify({ questions: [{ question: "选哪一个？" }] }) }),
    native("turn/end", 3, { turn: 1, reason: { kind: "completed" } }),
  ])]));
  const session: Session = { ...discoverDshSessions(root)[0], status: "idle", attention: null, locator: {}, subscribed: true, handledAt: null };
  const poll = createDshPoller(root);
  const restored = await poll([session]);
  assert.equal(restored.length, 1); assert.equal(restored[0].type, "snapshot");
  assert.equal(restored[0].snapshot!.phase, "ready");
  assert.deepEqual(restored[0].snapshot!.pending.map(request => request.id), ["question:q1"]);
  assert.deepEqual(await poll([session]), []);
  appendFileSync(file, frame([
    native("turn/start", 4, { turn: 2 }),
    native("approval/asked", 5, { id: "approval2", toolName: "shell" }),
    native("tool/result", 6, { message: { toolCallId: "q1", content: [{ type: "text", text: '{"pending":true}' }] } }),
    native("user/message", 7, { source: { kind: "user-question-reply", callId: "q1" }, content: [{ type: "text", text: "第一个" }] }),
  ]));
  const live = await poll([session]);
  assert.deepEqual(live.map(event => event.type), ["progress", "needs_input", "resolved"]);
  assert.deepEqual(live.at(-1)!.requestIds, ["question:q1"]);
  let state = applyEvent(undefined, restored[0])!.next;
  for (const ev of live) state = applyEvent(state, ev)?.next || state;
  assert.deepEqual(state.state!.pending.map(request => request.id), ["approval:approval2"]);
  appendFileSync(file, frame([native("approval/decided", 8, { id: "approval2", outcome: "denied" }), native("turn/end", 9, { turn: 2, reason: { kind: "completed" } })]));
  for (const ev of await poll([session])) state = applyEvent(state, ev)?.next || state;
  assert.equal(state.status, "ready"); assert.equal(state.state!.pending.length, 0);
});

test("DSH continued and unknown-outcome tool results preserve the question until the actual answer", () => {
  const session = { sessionId: "id" }, context = { turnId: "dsh-turn:1" };
  assert.deepEqual(parseDshEvent(native("tool/result", 1, { message: { toolCallId: "q", content: [{ type: "text", text: '{"pending":true}' }] } }), session, context), []);
  assert.deepEqual(parseDshEvent(native("tool/result", 2, { message: { toolCallId: "q", content: [] }, error: { code: "TOOL_OUTCOME_UNKNOWN" } }), session, context), []);
  const answered = parseDshEvent(native("tool/result", 3, { message: { toolCallId: "q", content: [{ type: "text", text: '{"answers":[]}' }] } }), session, context);
  assert.deepEqual(answered[0].requestIds, ["question:q"]);
});

test("DSH normal stops are ready; native errors and interruptions remain attention states", () => {
  const session = { sessionId: "id" };
  assert.equal(parseDshEvent(native("turn/end", 1, { reason: { kind: "completed" } }), session)[0].type, "stopped");
  assert.equal(parseDshEvent(native("turn/end", 2, { reason: { kind: "error", error: { code: "RATE_LIMIT", message: "额度不足" } } }), session)[0].type, "quota");
  assert.equal(parseDshEvent(native("turn/end", 3, { reason: { kind: "aborted" } }), session)[0].type, "interrupted");
  assert.deepEqual(parseDshEvent({ type: "turn/end", seq: 4, data: {} }, session), []);
});

test("DSH poll rejects outside record paths and does not inspect unrelated files", async t => {
  const root = tempDir(t);
  await assert.rejects(createDshPoller(root)([{ sessionId: "x", transcriptPath: join(root, "outside.jsonl") } as Session]), /outside its sessions directory/);
});
