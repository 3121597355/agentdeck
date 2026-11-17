import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { activeDuration, clearUsageCache, collectUsage, normalizeUsageTimestamp } from "../src/core/usage";
import type { CustomUsageAgent } from "../src/core/types";
import { tempDir } from "./helpers";

function writeJsonl(path: string, records: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
}

test("active duration counts only gaps inside the idle cutoff", () => {
  assert.equal(activeDuration([0, 5 * 60_000, 20 * 60_000], 10 * 60_000), 5 * 60_000);
  assert.equal(activeDuration([0, 5 * 60_000, 5 * 60_000, 8 * 60_000], 10 * 60_000), 8 * 60_000);
  assert.equal(activeDuration([], 10 * 60_000), 0);
});

test("custom source timestamps support ISO, seconds, milliseconds and nested fields", () => {
  assert.equal(normalizeUsageTimestamp("2026-11-18T02:00:00Z", "iso"), Date.parse("2026-11-18T02:00:00Z"));
  assert.equal(normalizeUsageTimestamp(1_763_431_200, "seconds"), 1_763_431_200_000);
  assert.equal(normalizeUsageTimestamp(1_763_431_200_000, "ms"), 1_763_431_200_000);
  assert.equal(normalizeUsageTimestamp("1763431200", "seconds"), 1_763_431_200_000);
  assert.equal(normalizeUsageTimestamp("not-a-date", "auto"), null);
});

test("usage report merges providers while preserving independent source durations", async t => {
  clearUsageCache();
  const root = tempDir(t);
  const codex = join(root, "codex");
  const claude = join(root, "claude");
  const dsh = join(root, "dsh", "sessions");
  const workbuddy = join(root, "workbuddy", "projects");
  const cursor = join(root, "cursor", "projects");
  mkdirSync(codex, { recursive: true });
  mkdirSync(claude, { recursive: true });
  mkdirSync(dsh, { recursive: true });
  mkdirSync(workbuddy, { recursive: true });
  mkdirSync(cursor, { recursive: true });

  const at = (hour: number, minute: number) => Date.parse(`2026-11-18T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  writeJsonl(join(codex, "session.jsonl"), [
    { timestamp: new Date(at(2, 0)).toISOString() },
    { timestamp: new Date(at(2, 5)).toISOString() },
    { timestamp: new Date(at(2, 20)).toISOString() },
  ]);
  writeJsonl(join(claude, "session.jsonl"), [
    { timestamp: new Date(at(2, 3)).toISOString() },
    { timestamp: new Date(at(2, 7)).toISOString() },
    { timestamp: new Date(at(2, 9)).toISOString() },
  ]);
  const dshRecords = [
    { type: "session", id: "dsh", createdAt: at(2, 12) },
    { type: "turn/start", time: at(2, 12) },
    { type: "turn/end", time: at(2, 14) },
  ];
  writeFileSync(
    join(dsh, "session.v4.jsonl.zstd"),
    zstdCompressSync(Buffer.from(dshRecords.map(record => JSON.stringify(record)).join("\n") + "\n")),
  );
  writeJsonl(join(workbuddy, "session.jsonl"), [
    { timestamp: at(2, 4) },
    { timestamp: at(2, 8) },
  ]);
  writeJsonl(join(cursor, "session.jsonl"), [{ role: "user", message: "no timestamp" }]);

  const report = await collectUsage({
    days: 1,
    now: Date.parse("2026-11-18T03:00:00Z"),
    roots: { codex: [codex], claude: [claude], dsh: [dsh], workbuddy: [workbuddy], cursor: [cursor] },
  });
  const byId = Object.fromEntries(report.providers.map(provider => [provider.id, provider]));

  assert.equal(report.startDate, "2026-11-18");
  assert.equal(report.activeDays, 1);
  assert.equal(report.daily[0].providers.codex, 5 * 60_000);
  assert.equal(report.daily[0].providers.claude, 6 * 60_000);
  assert.equal(report.daily[0].providers.dsh, 2 * 60_000);
  assert.equal(report.daily[0].providers.workbuddy, 4 * 60_000);
  assert.equal(report.daily[0].totalMs, 20 * 60_000);
  assert.equal(byId.cursor.measurable, false);
  assert.equal(byId.cursor.durationMs, 0);
  assert.equal(report.filesScanned, 4);
  assert.equal(report.eventCount, 10);
  assert.deepEqual(report.errors, []);
  assert.match(report.explanation, /并行时总时长只计算一次/);
});

test("arbitrary custom agents are scanned dynamically and expose actionable source errors", async t => {
  clearUsageCache();
  const root = tempDir(t);
  const alpha = join(root, "alpha");
  const secondsFile = join(root, "seconds.jsonl");
  const millisFile = join(root, "millis.log");
  const disabledFile = join(root, "disabled.jsonl");
  const brokenFile = join(root, "broken.jsonl");
  const at = (minute: number) => Date.parse(`2026-11-18T02:${String(minute).padStart(2, "0")}:00Z`);

  writeJsonl(join(alpha, "events.custom"), [
    { event: { created_at: new Date(at(0)).toISOString() } },
    { event: { created_at: new Date(at(5)).toISOString() } },
    { event: { created_at: new Date(at(20)).toISOString() } },
  ]);
  writeJsonl(secondsFile, [
    { meta: { time: at(2) / 1000 } },
    { meta: { time: at(8) / 1000 } },
  ]);
  writeJsonl(millisFile, [
    { time: at(1) },
    { time: at(7) },
  ]);
  writeJsonl(disabledFile, [{ timestamp: at(3) }, { timestamp: at(9) }]);
  writeJsonl(brokenFile, [{ other: "missing timestamp" }, { other: "still missing" }]);

  const customAgents: CustomUsageAgent[] = [
    {
      id: "custom-alpha",
      name: "Alpha Agent",
      path: alpha,
      filePattern: "*.custom",
      timestampField: "event.created_at",
      timestampUnit: "iso",
      enabled: true,
    },
    {
      id: "custom-seconds",
      name: "Seconds Agent",
      path: secondsFile,
      filePattern: "*.jsonl",
      timestampField: "meta.time",
      timestampUnit: "seconds",
      enabled: true,
    },
    {
      id: "custom-millis",
      name: "Millis Agent",
      path: millisFile,
      filePattern: "*.log",
      timestampField: "time",
      timestampUnit: "ms",
      enabled: true,
    },
    {
      id: "custom-disabled",
      name: "Disabled Agent",
      path: disabledFile,
      filePattern: "*.jsonl",
      timestampField: "timestamp",
      timestampUnit: "auto",
      enabled: false,
    },
    {
      id: "custom-broken",
      name: "Broken Agent",
      path: brokenFile,
      filePattern: "*.jsonl",
      timestampField: "event.time",
      timestampUnit: "auto",
      enabled: true,
    },
    {
      id: "custom-missing",
      name: "Missing Agent",
      path: join(root, "does-not-exist"),
      filePattern: "*.jsonl",
      timestampField: "timestamp",
      timestampUnit: "auto",
      enabled: true,
    },
  ];

  const missing = join(root, "missing-built-in");
  const report = await collectUsage({
    days: 1,
    now: Date.parse("2026-11-18T03:00:00Z"),
    timeZone: "UTC",
    roots: { codex: [missing], claude: [missing], dsh: [missing], workbuddy: [missing], cursor: [missing] },
    customAgents,
  });
  const byId = Object.fromEntries(report.providers.map(provider => [provider.id, provider]));

  assert.equal(report.daily[0].providers["custom-alpha"], 5 * 60_000);
  assert.equal(report.daily[0].providers["custom-seconds"], 6 * 60_000);
  assert.equal(report.daily[0].providers["custom-millis"], 6 * 60_000);
  assert.equal(report.daily[0].providers["custom-disabled"], 0);
  assert.equal(report.daily[0].totalMs, 8 * 60_000);
  assert.equal(byId["custom-alpha"].custom, true);
  assert.equal(byId["custom-alpha"].editable, true);
  assert.equal(byId["custom-alpha"].files, 1);
  assert.equal(byId["custom-disabled"].enabled, false);
  assert.equal(byId["custom-disabled"].measurable, false);
  assert.match(byId["custom-broken"].error, /未在 event\.time 中找到可解析的时间戳/);
  assert.match(byId["custom-missing"].error, /路径不存在/);
});
