import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { asksForInput, lastSentence, toTitle } from "../status";
import { normalizeUsageTimestamp, matchesUsageFilePattern, readObjectPath } from "../usage";
import type { AgentEvent, Config, CustomUsageAgent, HistoryEntry, Session } from "../types";
import type { Adapter } from "./types";
import { openUrl } from "../jump";

type CachedSessions = {
  mtime: number;
  size: number;
  sessions: HistoryEntry[];
};

const cache = new Map<string, CachedSessions>();

const DEFAULT_EVENT_NAMES = ["type", "status", "event", "event_type"];
const DEFAULT_SESSION_NAMES = ["sessionId", "session_id", "thread_id", "conversation_id", "id"];
const DEFAULT_TIMESTAMP_NAMES = ["timestamp", "time", "createdAt", "created_at", "updated_at"];
const DEFAULT_TITLE_NAMES = ["title", "name"];
const DEFAULT_CWD_NAMES = ["cwd", "working_directory", "project_path"];
const DEFAULT_SUMMARY_NAMES = ["summary", "message", "content"];
const DEFAULT_REQUEST_NAMES = ["request_id", "requestId", "call_id", "tool_call_id"];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstText(record: Record<string, unknown>, configured: string | undefined, fallbacks: string[]): string {
  const direct = configured ? text(readObjectPath(record, configured)) : "";
  if (direct) return direct;
  for (const field of fallbacks) {
    const value = text(readObjectPath(record, field));
    if (value) return value;
  }
  return "";
}

function timestamp(record: Record<string, unknown>, agent: CustomUsageAgent): number | null {
  const configured = text(readObjectPath(record, agent.timestampField));
  const normalized = normalizeUsageTimestamp(configured, agent.timestampUnit);
  if (normalized !== null) return normalized;
  for (const field of DEFAULT_TIMESTAMP_NAMES) {
    const value = normalizeUsageTimestamp(readObjectPath(record, field), agent.timestampUnit);
    if (value !== null) return value;
  }
  return null;
}

function eventType(record: Record<string, unknown>, agent: CustomUsageAgent): AgentEvent["type"] | null {
  const raw = firstText(record, agent.eventTypeField || "type", DEFAULT_EVENT_NAMES).toLocaleLowerCase();
  if (!raw) return null;
  if (/^(started|start|session_start|created)$/.test(raw)) return "started";
  if (/^(progress|running|in_progress|working|active)$/.test(raw)) return "progress";
  if (/^(needs_input|waiting|waiting_input|input_required|question|permission|pending)$/.test(raw)) return "needs_input";
  if (/^(resolved|answered|answer|approved|rejected|cancelled|canceled)$/.test(raw)) return "resolved";
  if (/^(stopped|ready|turn_end|turn_complete|idle)$/.test(raw)) return "stopped";
  if (/^(completed|complete|done|finished|success)$/.test(raw)) return "completed";
  if (/^(failed|error|failure)$/.test(raw)) return "failed";
  if (/^(quota|rate_limit|usage_limit)$/.test(raw)) return "quota";
  if (/^(interrupted|interrupt|cancelled|canceled|aborted)$/.test(raw)) return "interrupted";
  if (/^(tool|tool_call|tool_use|action)$/.test(raw)) return "tool";
  if (/^(ended|exit|closed)$/.test(raw)) return "ended";
  return null;
}

function attention(record: Record<string, unknown>, type: AgentEvent["type"]): AgentEvent["attention"] {
  const raw = text(readObjectPath(record, "attention") || readObjectPath(record, "request_type")).toLocaleLowerCase();
  if (["question", "permission", "failed", "quota", "interrupted", "input"].includes(raw)) {
    return raw as AgentEvent["attention"];
  }
  if (type === "failed" || type === "quota" || type === "interrupted") return type;
  if (type === "needs_input") return "input";
  return undefined;
}

function requestIds(record: Record<string, unknown>, agent: CustomUsageAgent, sessionId: string): string[] {
  const configured = firstText(record, agent.requestIdField || "request_id", DEFAULT_REQUEST_NAMES);
  return configured ? [configured] : [`custom:${sessionId}`];
}

function sessionIdFrom(record: Record<string, unknown>, agent: CustomUsageAgent, fallback: string): string {
  return firstText(record, agent.sessionIdField || "session_id", DEFAULT_SESSION_NAMES) || fallback;
}

function projectRecord(record: Record<string, unknown>, agent: CustomUsageAgent, fallback: string, path: string): HistoryEntry | null {
  const sessionId = sessionIdFrom(record, agent, fallback);
  if (!sessionId) return null;
  const at = timestamp(record, agent);
  const title = firstText(record, agent.titleField || "title", DEFAULT_TITLE_NAMES);
  const cwd = firstText(record, agent.cwdField || "cwd", DEFAULT_CWD_NAMES);
  const summary = firstText(record, agent.summaryField || "summary", DEFAULT_SUMMARY_NAMES);
  return {
    agent: agent.id,
    sessionId,
    host: "cli",
    title: toTitle(title || summary),
    cwd,
    summary: lastSentence(summary),
    startedAt: at ?? Date.now(),
    updatedAt: at ?? Date.now(),
    transcriptPath: path,
  };
}

function mergeEntries(entries: HistoryEntry[]): HistoryEntry[] {
  const bySession = new Map<string, HistoryEntry>();
  for (const entry of entries) {
    const previous = bySession.get(entry.sessionId);
    if (!previous) {
      bySession.set(entry.sessionId, entry);
      continue;
    }
    bySession.set(entry.sessionId, {
      ...previous,
      title: previous.title || entry.title,
      cwd: previous.cwd || entry.cwd,
      summary: entry.updatedAt >= previous.updatedAt && entry.summary ? entry.summary : previous.summary,
      startedAt: Math.min(previous.startedAt, entry.startedAt),
      updatedAt: Math.max(previous.updatedAt, entry.updatedAt),
      transcriptPath: entry.updatedAt >= previous.updatedAt ? entry.transcriptPath : previous.transcriptPath,
    });
  }
  return [...bySession.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function filesFor(agent: CustomUsageAgent): string[] {
  if (!existsSync(agent.path)) throw new Error(`路径不存在：${agent.path}`);
  const rootStat = statSync(agent.path);
  if (rootStat.isFile()) {
    if (!matchesUsageFilePattern(agent.filePattern, agent.path)) {
      throw new Error(`文件不符合模式 ${agent.filePattern}`);
    }
    return [agent.path];
  }
  const files: string[] = [];
  const stack = [agent.path];
  while (stack.length && files.length < 2000) {
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
      else if (entry.isFile() && matchesUsageFilePattern(agent.filePattern, path)) files.push(path);
    }
  }
  if (!files.length) throw new Error(`没有找到符合 ${agent.filePattern} 的会话记录`);
  return files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
}

async function parseFile(agent: CustomUsageAgent, path: string): Promise<HistoryEntry[]> {
  const stat = statSync(path);
  const signature = [
    agent.sessionIdField,
    agent.timestampField,
    agent.timestampUnit,
    agent.titleField,
    agent.cwdField,
    agent.summaryField,
  ].join("\0");
  const cacheKey = `${agent.id}\0${path}\0${signature}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.sessions;
  const fallback = basename(path).replace(/(?:\.jsonl|\.json|\.log)$/i, "");
  const grouped = new Map<string, HistoryEntry>();
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== "object" || Array.isArray(record)) continue;
        const projected = projectRecord(record as Record<string, unknown>, agent, fallback, path);
        if (!projected) continue;
        const previous = grouped.get(projected.sessionId);
        if (!previous) grouped.set(projected.sessionId, projected);
        else grouped.set(projected.sessionId, mergeEntries([previous, projected])[0]);
      } catch {
        // A malformed line is ignored without hiding other sessions in the file.
      }
    }
  } finally {
    lines.close();
    input.close();
  }
  const sessions = [...grouped.values()];
  cache.set(cacheKey, { mtime: stat.mtimeMs, size: stat.size, sessions });
  return sessions;
}

export async function discoverCustomSessions(agent: CustomUsageAgent): Promise<HistoryEntry[]> {
  const entries: HistoryEntry[] = [];
  for (const path of filesFor(agent).slice(0, 1000)) entries.push(...await parseFile(agent, path));
  return mergeEntries(entries).slice(0, 1000);
}

export function clearCustomSessionCache(): void {
  cache.clear();
}

export function parseCustomSessionRecord(
  record: Record<string, unknown>,
  agent: CustomUsageAgent,
  session: Pick<Session, "agent" | "sessionId">,
): AgentEvent[] {
  const fallback = session.sessionId;
  if (sessionIdFrom(record, agent, fallback) !== session.sessionId) return [];
  const at = timestamp(record, agent);
  if (at === null) return [];
  const type = eventType(record, agent);
  if (!type) return [];
  const title = firstText(record, agent.titleField || "title", DEFAULT_TITLE_NAMES);
  const cwd = firstText(record, agent.cwdField || "cwd", DEFAULT_CWD_NAMES);
  const summary = firstText(record, agent.summaryField || "summary", DEFAULT_SUMMARY_NAMES);
  const ids = type === "needs_input" || type === "resolved" || type === "tool"
    ? requestIds(record, agent, session.sessionId)
    : [];
  return [{
    agent: session.agent,
    sessionId: session.sessionId,
    type,
    host: "cli",
    cwd,
    title,
    summary: summary || undefined,
    attention: attention(record, type),
    requestIds: ids,
    source: "custom-jsonl",
    at,
  }];
}

function fill(template: string, session: Session): string {
  return template.split("{sessionId}").join(encodeURIComponent(session.sessionId)).split("{cwd}").join(session.cwd);
}

export function customSessionAdapter(agent: CustomUsageAgent): Adapter {
  return {
    id: agent.id,
    name: agent.name,
    custom: true,
    detect() {
      try {
        return { present: existsSync(agent.path), hooked: agent.enabled, hosts: ["cli"] };
      } catch {
        return { present: false, hooked: false, hosts: [] };
      }
    },
    planInstall() {
      return {
        changes: [],
        notes: [
          `只读扫描 ${agent.path}`,
          `文件模式：${agent.filePattern}`,
          `会话字段：${agent.sessionIdField || "session_id"}；状态字段：${agent.eventTypeField || "type"}`,
        ],
      };
    },
    planUninstall() {
      return { changes: [], notes: ["自定义 Agent 不含 Hook；从设置中删除即可停止扫描。"] };
    },
    source: agent.enabled ? {
      discover: () => discoverCustomSessions(agent),
      transcript: {
        parse: (record, session) => parseCustomSessionRecord(record, agent, session),
      },
      locateTranscript: async session => session.transcriptPath || undefined,
    } : undefined,
    async jump(session) {
      if (agent.jumpUrl && await openUrl(fill(agent.jumpUrl, session))) {
        return { ok: true, method: "url", message: `已向 ${agent.name} 发送打开此会话的请求。` };
      }
      return { ok: false, method: "none", message: "这个自定义 Agent 没有可用的回跳链接。" };
    },
  };
}
