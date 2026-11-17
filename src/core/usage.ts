import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { zstdDecompressSync } from "node:zlib";
import { dshZstdFrames, DSH_ROOT } from "./adapters/dsh";
import { CLAUDE_PROJECTS, CODEX_DIR, CODEX_SESSIONS } from "./paths";
import type { CustomUsageAgent, UsageTimestampUnit } from "./types";

export type UsageProviderId = string;

export interface UsageRootOverrides {
  codex?: string[];
  claude?: string[];
  dsh?: string[];
  workbuddy?: string[];
  cursor?: string[];
}

export interface UsageOptions {
  days?: number;
  now?: number;
  idleCutoffMinutes?: number;
  timeZone?: string;
  roots?: UsageRootOverrides;
  customAgents?: CustomUsageAgent[];
}

export interface UsageProvider {
  id: UsageProviderId;
  name: string;
  available: boolean;
  measurable: boolean;
  durationMs: number;
  ratio: number;
  files: number;
  note: string;
  custom: boolean;
  editable: boolean;
  enabled: boolean;
  path: string;
  filePattern: string;
  timestampField: string;
  timestampUnit: UsageTimestampUnit;
  error: string;
}

export interface UsageDay {
  date: string;
  totalMs: number;
  providers: Record<UsageProviderId, number>;
}

export interface UsageReport {
  days: number;
  timeZone: string;
  idleCutoffMinutes: number;
  generatedAt: number;
  startDate: string;
  endDate: string;
  totalMs: number;
  activeDays: number;
  averageActiveDayMs: number;
  longestDay: UsageDay | null;
  filesScanned: number;
  eventCount: number;
  providers: UsageProvider[];
  daily: UsageDay[];
  errors: string[];
  explanation: string;
}

type ProviderDefinition = {
  id: UsageProviderId;
  name: string;
  roots: string[];
  candidate: (file: string) => boolean;
  measurable: boolean;
  note: string;
  custom: boolean;
  enabled: boolean;
  path?: string;
  filePattern?: string;
  timestampField?: string;
  timestampUnit?: UsageTimestampUnit;
};

type CachedEvents = {
  mtime: number;
  size: number;
  scannedFrom: number;
  events: number[];
  timestampCount: number;
};

const DAY_MS = 86_400_000;
const MAX_DAYS = 30;
const MAX_DSH_COMPRESSED = 64 * 1024 * 1024;
const MAX_DSH_DECOMPRESSED = 128 * 1024 * 1024;
const eventCache = new Map<string, CachedEvents>();

function workbuddyProjectsRoot(): string {
  const root =
    process.env.AGENT_INBOX_WORKBUDDY_ROOT ||
    process.env.AGENT_INBOX_TEST_HOME && join(process.env.AGENT_INBOX_TEST_HOME, "sources", "workbuddy") ||
    process.env.WORKBUDDY_CONFIG_DIR ||
    process.env.CODEBUDDY_CONFIG_DIR ||
    join(homedir(), ".workbuddy");
  return join(root, "projects");
}

function cursorProjectsRoot(): string {
  const root =
    process.env.AGENT_INBOX_CURSOR_ROOT ||
    (process.env.AGENT_INBOX_TEST_HOME
      ? join(process.env.AGENT_INBOX_TEST_HOME, "cursor")
      : join(homedir(), ".cursor"));
  return join(root, "projects");
}

function definitions(overrides: UsageRootOverrides = {}, customAgents: CustomUsageAgent[] = []): ProviderDefinition[] {
  const builtIns: ProviderDefinition[] = [
    {
      id: "codex",
      name: "Codex",
      roots: overrides.codex ?? [CODEX_SESSIONS, join(CODEX_DIR, "archived_sessions")],
      candidate: file => file.endsWith(".jsonl"),
      measurable: true,
      note: "读取本地 JSONL 中的会话事件时间戳。",
      custom: false,
      enabled: true,
    },
    {
      id: "claude",
      name: "Claude Code",
      roots: overrides.claude ?? [CLAUDE_PROJECTS],
      candidate: file => file.endsWith(".jsonl"),
      measurable: true,
      note: "读取 Claude Code 本地会话事件时间戳。",
      custom: false,
      enabled: true,
    },
    {
      id: "dsh",
      name: "DeepSeek Harness",
      roots: overrides.dsh ?? [join(DSH_ROOT, "sessions")],
      candidate: file => /(?:^|[\\/])session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(file),
      measurable: true,
      note: "读取 DSH 原始 JSONL 或 Zstandard 会话帧。",
      custom: false,
      enabled: true,
    },
    {
      id: "workbuddy",
      name: "WorkBuddy",
      roots: overrides.workbuddy ?? [workbuddyProjectsRoot()],
      candidate: file => file.endsWith(".jsonl"),
      measurable: true,
      note: "读取 WorkBuddy 会话记录中的事件时间戳。",
      custom: false,
      enabled: true,
    },
    {
      id: "cursor",
      name: "Cursor",
      roots: overrides.cursor ?? [cursorProjectsRoot()],
      candidate: file => file.endsWith(".jsonl"),
      measurable: false,
      note: "当前本地 JSONL 没有逐条时间戳，因此不计入时长统计。",
      custom: false,
      enabled: true,
    },
  ];
  const customDefinitions: ProviderDefinition[] = customAgents.map(agent => ({
    id: agent.id,
    name: agent.name,
    roots: [agent.path],
    candidate: customCandidate(agent.filePattern),
    measurable: agent.enabled,
    note: agent.enabled
      ? `读取 ${agent.filePattern || "*.jsonl"} 中 ${agent.timestampField} 的时间戳。`
      : "此自定义来源已停用，不参与统计。",
    custom: true,
    enabled: agent.enabled,
    path: agent.path,
    filePattern: agent.filePattern,
    timestampField: agent.timestampField,
    timestampUnit: agent.timestampUnit,
  }));
  return [...builtIns, ...customDefinitions];
}

export function matchesUsageFilePattern(filePattern: string, file: string): boolean {
  const patterns = filePattern
    .split(",")
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => new RegExp(
      "^" + value.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
      "i",
    ));
  if (!patterns.length) return false;
  const name = basename(file);
  return patterns.some(pattern => pattern.test(name));
}

function customCandidate(filePattern: string): (file: string) => boolean {
  return file => matchesUsageFilePattern(filePattern, file);
}

function dayFormatter(timeZone: string): (value: number) => string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format;
}

function recentDays(now: number, count: number, formatDay: (value: number) => string): string[] {
  const output: string[] = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) output.push(formatDay(now - offset * DAY_MS));
  return output;
}

function walk(root: string, candidate: (file: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && candidate(path)) files.push(path);
    }
  }
  return files;
}

export function normalizeUsageTimestamp(value: unknown, unit: UsageTimestampUnit = "auto"): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    if (unit === "seconds") return Math.trunc(value * 1000);
    if (unit === "ms") return Math.trunc(value);
    if (unit === "iso") return null;
    return value < 100_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return normalizeUsageTimestamp(Number(trimmed), unit === "iso" ? "iso" : unit);
  if (unit === "seconds" || unit === "ms") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readObjectPath(value: unknown, field: string): unknown {
  let current = value;
  for (const segment of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function timestampFromRecord(
  value: unknown,
  field = "",
  unit: UsageTimestampUnit = "auto",
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (field) return normalizeUsageTimestamp(readObjectPath(record, field), unit);
  for (const key of ["timestamp", "time", "createdAt", "created_at"]) {
    const timestamp = normalizeUsageTimestamp(record[key], unit);
    if (timestamp !== null) return timestamp;
  }
  return null;
}

function timestampFromLine(
  line: string,
  field = "",
  unit: UsageTimestampUnit = "auto",
): { validJson: boolean; timestamp: number | null } {
  try {
    return { validJson: true, timestamp: timestampFromRecord(JSON.parse(line), field, unit) };
  } catch {
    return { validJson: false, timestamp: null };
  }
}

async function readTextEvents(
  path: string,
  since: number,
  until: number,
  field: string,
  unit: UsageTimestampUnit,
): Promise<{ events: number[]; timestampCount: number }> {
  const events = new Set<number>();
  let timestampCount = 0;
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line) continue;
      const { timestamp } = timestampFromLine(line, field, unit);
      if (timestamp !== null) timestampCount += 1;
      if (timestamp !== null && timestamp >= since && timestamp <= until) events.add(timestamp);
    }
  } finally {
    lines.close();
    input.close();
  }
  return { events: [...events].sort((a, b) => a - b), timestampCount };
}

function readCompressedEvents(
  path: string,
  since: number,
  until: number,
): { events: number[]; timestampCount: number } {
  const stat = statSync(path);
  if (stat.size > MAX_DSH_COMPRESSED) throw new Error("会话记录超过 64 MiB 读取上限");
  const bytes = readFileSync(path);
  const frames = dshZstdFrames(bytes);
  const events = new Set<number>();
  let timestampCount = 0;
  let decompressed = 0;
  for (const frame of frames) {
    const text = zstdDecompressSync(bytes.subarray(frame.start, frame.end), {
      maxOutputLength: 16 * 1024 * 1024,
    }).toString("utf8");
    decompressed += Buffer.byteLength(text);
    if (decompressed > MAX_DSH_DECOMPRESSED) throw new Error("会话记录超过 128 MiB 解码上限");
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      const timestamp = timestampFromLine(line);
      if (timestamp.timestamp !== null) timestampCount += 1;
      if (timestamp.timestamp !== null && timestamp.timestamp >= since && timestamp.timestamp <= until) {
        events.add(timestamp.timestamp);
      }
    }
  }
  return { events: [...events].sort((a, b) => a - b), timestampCount };
}

async function eventsForFile(
  path: string,
  since: number,
  until: number,
  field = "",
  unit: UsageTimestampUnit = "auto",
): Promise<{ events: number[]; timestampCount: number }> {
  const stat = statSync(path);
  const cacheKey = `${path}\0${field}\0${unit}`;
  const cached = eventCache.get(cacheKey);
  if (
    cached &&
    cached.mtime === stat.mtimeMs &&
    cached.size === stat.size &&
    cached.scannedFrom <= since
  ) {
    return {
      events: cached.events.filter(timestamp => timestamp >= since && timestamp <= until),
      timestampCount: cached.timestampCount,
    };
  }
  const parsed = path.endsWith(".zstd")
    ? readCompressedEvents(path, since, until)
    : await readTextEvents(path, since, until, field, unit);
  eventCache.set(cacheKey, {
    mtime: stat.mtimeMs,
    size: stat.size,
    scannedFrom: since,
    events: parsed.events,
    timestampCount: parsed.timestampCount,
  });
  return parsed;
}

/** Sum adjacent timestamp gaps while each gap remains within the idle threshold. */
export function activeDuration(timestamps: Iterable<number>, idleCutoffMs: number): number {
  const ordered = [...new Set(timestamps)].sort((a, b) => a - b);
  let duration = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index] - ordered[index - 1];
    if (gap > 0 && gap <= idleCutoffMs) duration += gap;
  }
  return duration;
}

export async function collectUsage(options: UsageOptions = {}): Promise<UsageReport> {
  const days = Math.max(1, Math.min(MAX_DAYS, Math.trunc(options.days ?? 7)));
  const now = options.now ?? Date.now();
  const idleCutoffMinutes = Math.max(1, Math.min(60, options.idleCutoffMinutes ?? 10));
  const idleCutoffMs = idleCutoffMinutes * 60_000;
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const formatDay = dayFormatter(timeZone);
  const dayKeys = recentDays(now, days, formatDay);
  const daySet = new Set(dayKeys);
  const since = now - (days + 1) * DAY_MS;
  const until = now + 60_000;
  const errors: string[] = [];
  const providerEvents = new Map<UsageProviderId, Map<string, Set<number>>>();
  const providerFiles = new Map<UsageProviderId, number>();
  let filesScanned = 0;
  const sourceDefinitions = definitions(options.roots, options.customAgents ?? []);
  const providerErrors = new Map<UsageProviderId, string>();

  for (const provider of sourceDefinitions) {
    if (!provider.enabled) {
      providerFiles.set(provider.id, 0);
      continue;
    }
    const existingRoots = provider.roots.filter(root => existsSync(root));
    if (provider.custom && provider.path && !existingRoots.length) {
      providerFiles.set(provider.id, 0);
      providerErrors.set(provider.id, `路径不存在：${provider.path}`);
      continue;
    }
    const files = existingRoots.flatMap(root => {
      try {
        return statSync(root).isFile()
          ? provider.candidate(root) ? [root] : []
          : walk(root, provider.candidate);
      } catch {
        return [];
      }
    });
    const recentFiles = files.filter(path => {
      try {
        const stat = statSync(path);
        const root = provider.custom ? provider.path : "";
        return root && statSync(root).isFile() ? true : stat.mtimeMs >= since;
      } catch {
        return false;
      }
    });
    providerFiles.set(provider.id, recentFiles.length);
    if (!provider.measurable) continue;
    const byDay = new Map<string, Set<number>>();
    providerEvents.set(provider.id, byDay);
    let timestampCount = 0;

    for (const path of recentFiles) {
      filesScanned += 1;
      try {
        const parsed = await eventsForFile(
          path,
          since,
          until,
          provider.timestampField ?? "",
          provider.timestampUnit ?? "auto",
        );
        timestampCount += parsed.timestampCount;
        for (const timestamp of parsed.events) {
          const day = formatDay(timestamp);
          if (!daySet.has(day)) continue;
          if (!byDay.has(day)) byDay.set(day, new Set());
          byDay.get(day)!.add(timestamp);
        }
      } catch (error) {
        errors.push(`${provider.name}：${error instanceof Error ? error.message : String(error)}`);
        providerErrors.set(provider.id, error instanceof Error ? error.message : String(error));
      }
    }
    if (provider.custom && recentFiles.length && timestampCount === 0) {
      providerErrors.set(
        provider.id,
        `未在 ${provider.timestampField} 中找到可解析的时间戳，请检查字段名和格式。`,
      );
    }
  }

  let eventCount = 0;
  const daily = dayKeys.map(date => {
    const providers = Object.fromEntries(
      sourceDefinitions.map(provider => [provider.id, activeDuration(providerEvents.get(provider.id)?.get(date) ?? [], idleCutoffMs)]),
    ) as Record<UsageProviderId, number>;
    const combined = new Set<number>();
    for (const byDay of providerEvents.values()) for (const timestamp of byDay.get(date) ?? []) combined.add(timestamp);
    eventCount += combined.size;
    return { date, totalMs: activeDuration(combined, idleCutoffMs), providers };
  });
  const totalMs = daily.reduce((sum, day) => sum + day.totalMs, 0);
  const activeDays = daily.filter(day => day.totalMs > 0).length;
  const longestDay = daily.reduce<UsageDay | null>(
    (longest, day) => day.totalMs > (longest?.totalMs ?? 0) ? day : longest,
    null,
  );
  const providers: UsageProvider[] = sourceDefinitions.map(provider => {
    const durationMs = daily.reduce((sum, day) => sum + day.providers[provider.id], 0);
    return {
      id: provider.id,
      name: provider.name,
      available: provider.roots.some(root => existsSync(root)),
      measurable: provider.measurable,
      durationMs,
      ratio: totalMs > 0 ? durationMs / totalMs : 0,
      files: providerFiles.get(provider.id) ?? 0,
      note: provider.note,
      custom: provider.custom,
      editable: provider.custom,
      enabled: provider.enabled,
      path: provider.path ?? "",
      filePattern: provider.filePattern ?? "",
      timestampField: provider.timestampField ?? "",
      timestampUnit: provider.timestampUnit ?? "auto",
      error: providerErrors.get(provider.id) ?? "",
    };
  });

  return {
    days,
    timeZone,
    idleCutoffMinutes,
    generatedAt: now,
    startDate: dayKeys[0],
    endDate: dayKeys.at(-1)!,
    totalMs,
    activeDays,
    averageActiveDayMs: activeDays ? totalMs / activeDays : 0,
    longestDay,
    filesScanned,
    eventCount,
    providers,
    daily,
    errors,
    explanation: `合并各 Agent 的活动时间戳；相邻活动间隔不超过 ${idleCutoffMinutes} 分钟时计入。多个 Agent 并行时总时长只计算一次，各 Agent 独立时长可相互重叠。`,
  };
}

/** Tests and explicit manual refreshes can discard local scan metadata without touching transcripts. */
export function clearUsageCache(): void {
  eventCache.clear();
}
