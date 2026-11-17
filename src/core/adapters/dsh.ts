import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { applyEvent, lastSentence, toTitle } from "../status";
import { copyToClipboard, openUrl } from "../jump";
import type { AgentEvent, HistoryEntry, Session, SessionTitle } from "../types";
import type { Adapter } from "./types";

/** The desktop shell persists its harness state here, rather than in its Electron cache. */
export const DSH_ROOT = process.env.AGENT_INBOX_DSH_ROOT || process.env.DSH_HOME ||
  (process.env.AGENT_INBOX_TEST_HOME ? join(process.env.AGENT_INBOX_TEST_HOME, "dsh") : join(homedir(), ".dsh"));
export const DSH_OPEN_URL = "dsh://open";
const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_DECOMPRESSED = 128 * 1024 * 1024;
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const blocksText = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.filter(x => x?.type === "text").map(x => text(x.text)).join("\n") : "";

/** Zstandard frames are independently appended; Node's public decoder only reads one frame. */
export function dshZstdFrames(bytes: Buffer, maxFrames = Infinity): Array<{ start: number; end: number }> {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < bytes.length && frames.length < maxFrames) {
    const start = offset;
    if (bytes.length - offset < 5) break;
    if (bytes.readUInt32LE(offset) !== 0xfd2fb528) throw new Error(`DSH Zstandard frame magic invalid at ${offset}`);
    const flags = bytes[offset + 4];
    if (flags & 0x18) throw new Error("DSH Zstandard frame has reserved header bits");
    offset += 5;
    const sizeFlag = flags >>> 6;
    offset += (flags & 32 ? 0 : 1) + [0, 1, 2, 4][flags & 3] + (sizeFlag ? 2 ** sizeFlag : flags & 32 ? 1 : 0);
    if (offset > bytes.length) break;
    for (;;) {
      if (offset + 3 > bytes.length) return frames;
      const block = bytes.readUIntLE(offset, 3);
      const type = (block >>> 1) & 3;
      if (type === 3) throw new Error("DSH Zstandard frame has reserved block type");
      offset += 3 + (type === 1 ? 1 : block >>> 3);
      if (offset > bytes.length) return frames;
      if (block & 1) break;
    }
    if (flags & 4) offset += 4;
    if (offset > bytes.length) break;
    frames.push({ start, end: offset });
  }
  return frames;
}

function decodeFrame(bytes: Buffer, frame: { start: number; end: number }): string {
  return zstdDecompressSync(bytes.subarray(frame.start, frame.end), { maxOutputLength: 16 * 1024 * 1024 }).toString("utf8");
}

function parseLines(value: string): Record<string, any>[] {
  return value.split(/\r?\n/).filter(Boolean).map(line => record(JSON.parse(line)));
}

function headerFromFile(file: string): Record<string, any> {
  const handle = openSync(file, "r");
  try {
    const prefix = Buffer.alloc(128 * 1024);
    const bytes = prefix.subarray(0, readSync(handle, prefix, 0, prefix.length, 0));
    if (!file.endsWith(".zstd")) return record(JSON.parse(bytes.toString("utf8").split(/\r?\n/, 1)[0]));
    const first = dshZstdFrames(bytes, 1)[0];
    if (!first) throw new Error(`DSH session header is incomplete or larger than 128 KiB: ${basename(file)}`);
    return parseLines(decodeFrame(bytes, first))[0] || {};
  } finally { closeSync(handle); }
}

type CatalogRecord = { identity?: Record<string, any>; rows?: Record<string, any> };
function readCatalog(root: string): Map<string, CatalogRecord> {
  const catalog = new Map<string, CatalogRecord>();
  const shared = join(root, "storages", "session_projcache.json");
  if (existsSync(shared)) {
    const all = record(record(JSON.parse(readFileSync(shared, "utf8"))).tables).sessions;
    for (const [id, value] of Object.entries(record(all))) catalog.set(id, record(value));
  }
  const local = join(root, "storages", "session_projcache", "sessions");
  if (existsSync(local)) for (const name of readdirSync(local).filter(name => name.endsWith(".json")).slice(0, 2000)) {
    const contents = record(JSON.parse(readFileSync(join(local, name), "utf8")));
    catalog.set(name.slice(0, -5), record(contents.record));
  }
  return catalog;
}

export function discoverDshSessions(root = DSH_ROOT): HistoryEntry[] {
  const sessionsDir = join(root, "sessions");
  if (!existsSync(sessionsDir)) return [];
  const catalog = readCatalog(root);
  const out: HistoryEntry[] = [];
  for (const workspace of readdirSync(sessionsDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 1000)) {
    const directory = join(sessionsDir, workspace.name);
    for (const folder of readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).slice(0, 2000)) {
      const sessionDir = join(directory, folder.name);
      const fileName = readdirSync(sessionDir).find(name => /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name));
      if (!fileName) continue;
      const transcriptPath = join(sessionDir, fileName);
      const header = headerFromFile(transcriptPath);
      if (header.type !== "session" || !text(header.id)) continue;
      const cached = catalog.get(header.id);
      const rows = record(cached?.rows);
      const start = Number(header.createdAt);
      if (!Number.isFinite(start) || start < 0) throw new Error(`DSH session ${header.id} has no valid creation time`);
      const title = toTitle(text(record(rows.title).val));
      const cwd = text(header.cwd) || text(cached?.identity?.cwd);
      const lastPrompt = Number(record(record(rows.sessionListMetadata).val).lastPromptAt) || start;
      out.push({ agent: "dsh", sessionId: header.id, host: "app", title: title || `DeepSeek Harness · ${header.id.slice(-8)}`,
        cwd, summary: "", startedAt: start, updatedAt: Math.max(start, lastPrompt, statSync(transcriptPath).mtimeMs), transcriptPath, locator: {} });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 1000);
}

export async function readDshTitles(sessions: Session[], root = DSH_ROOT): Promise<SessionTitle[]> {
  const observedAt = Date.now(), catalog = readCatalog(root);
  return sessions.flatMap(session => {
    const title = toTitle(text(record(record(catalog.get(session.sessionId)?.rows).title).val));
    return title ? [{ agent: "dsh", sessionId: session.sessionId, title, observedAt, source: "dsh-title-projection" }] : [];
  });
}

export interface DshParserContext { turnId?: string; }
/** Translate only observed native events; every question/approval retains its native identity. */
export function parseDshEvent(entry: Record<string, unknown>, session: Pick<Session, "sessionId">, context: DshParserContext = {}): AgentEvent[] {
  const type = text(entry.type), data = record(entry.data);
  const at = Number(entry.time);
  if (!Number.isFinite(at) || at < 0 || !Number.isInteger(entry.seq)) return [];
  if (type === "turn/start") context.turnId = `dsh-turn:${data.turn}`;
  const base: Omit<AgentEvent, "type"> = { agent: "dsh", sessionId: session.sessionId, host: "app", at,
    source: "dsh-native-log", eventId: `dsh:${session.sessionId}:${entry.seq}`, turnId: context.turnId };
  const event = (eventType: AgentEvent["type"], extra: Partial<AgentEvent> = {}): AgentEvent[] => [{ ...base, type: eventType, ...extra }];
  switch (type) {
    case "turn/start": return event("progress");
    case "approval/asked": return text(data.id) ? event("needs_input", { attention: "permission", requestIds: [`approval:${data.id}`], summary: lastSentence(text(data.reason) || `等待授权：${text(data.toolName)}`) }) : [];
    case "approval/decided": return text(data.id) ? event("resolved", { requestIds: [`approval:${data.id}`] }) : [];
    case "tool/call": {
      if (data.name !== "ask_user_question" || !text(data.callId)) return event("tool");
      let args: Record<string, any> = {};
      try { args = record(typeof data.arguments === "string" ? JSON.parse(data.arguments) : data.arguments); } catch { /* malformed tool input still requires a response */ }
      return event("needs_input", { attention: "question", requestIds: [`question:${data.callId}`], summary: lastSentence((Array.isArray(args.questions) ? args.questions.map(q => text(q.question)).join("；") : "") || "DeepSeek Harness 正在等待你的回答。") });
    }
    case "tool/ptc-dispatch": {
      if (data.name !== "ask_user_question" || data.isError || !text(data.subCallId) || !pendingResult(data.content)) return [];
      return event("needs_input", { attention: "question", requestIds: [`question:${data.subCallId}`], summary: "DeepSeek Harness 正在等待你的回答。" });
    }
    case "tool/result": {
      const message = record(data.message);
      if (pendingResult(message.content) || record(data.error).code === "TOOL_OUTCOME_UNKNOWN") return [];
      return event("tool", { requestIds: text(message.toolCallId) ? [`question:${message.toolCallId}`] : [] });
    }
    case "user/message": {
      const source = record(data.source);
      if (source.kind === "user-question-reply" && text(source.callId)) return event("resolved", { requestIds: [`question:${source.callId}`] });
      return event("progress");
    }
    case "turn/end": {
      const reason = record(data.reason);
      if (reason.kind === "error") {
        const failure = record(reason.error), quota = /RATE_LIMIT|QUOTA|RESOURCE_EXHAUSTED/i.test(text(failure.code));
        return event(quota ? "quota" : "failed", { attention: quota ? "quota" : "failed", summary: lastSentence(text(failure.message) || "DeepSeek Harness 回合执行失败。") });
      }
      if (reason.kind === "aborted") return event("interrupted", { attention: "interrupted", summary: "DeepSeek Harness 回合已中断。" });
      return event("stopped");
    }
    default: return [];
  }
}

function pendingResult(content: unknown): boolean {
  try { return record(JSON.parse(blocksText(content))).pending === true; } catch { return false; }
}

type ReaderState = { file: string; offset: number; size: number; modified: number; context: DshParserContext; folded?: Session; };
export function createDshPoller(root = DSH_ROOT) {
  const readers = new Map<string, ReaderState>();
  return async (sessions: Session[]): Promise<AgentEvent[]> => {
    const active = new Set(sessions.map(session => session.sessionId));
    for (const key of readers.keys()) if (!active.has(key)) readers.delete(key);
    const result: AgentEvent[] = [];
    for (const session of sessions) {
      const file = resolve(session.transcriptPath);
      const owned = resolve(join(root, "sessions")) + sep;
      if (!file.toLowerCase().startsWith(owned.toLowerCase())) throw new Error("DSH record path is outside its sessions directory");
      const info = statSync(file);
      if (info.size > MAX_COMPRESSED) throw new Error(`DSH session exceeds the 64 MiB compressed read limit: ${session.sessionId}`);
      const prior = readers.get(session.sessionId);
      if (prior && prior.file === file && prior.size === info.size && prior.modified === info.mtimeMs) continue;
      if (prior && prior.file === file && info.size < prior.offset) throw new Error("DSH session log shrank; waiting for a complete replacement before recovery");
      const initial = !prior || prior.file !== file;
      const state: ReaderState = initial ? { file, offset: 0, size: info.size, modified: info.mtimeMs, context: {} } : prior;
      const bytes = readFileSync(file);
      let decompressed = 0;
      const records: Record<string, any>[] = [];
      if (file.endsWith(".zstd")) {
        const frames = dshZstdFrames(bytes.subarray(state.offset));
        for (const frame of frames) {
          const value = decodeFrame(bytes.subarray(state.offset), frame);
          decompressed += Buffer.byteLength(value);
          if (decompressed > MAX_DECOMPRESSED) throw new Error("DSH session exceeds the 128 MiB decoded read limit");
          records.push(...parseLines(value));
        }
        state.offset += frames.at(-1)?.end ?? 0;
      } else {
        const unread = bytes.subarray(state.offset), boundary = unread.lastIndexOf(10);
        if (boundary >= 0) { records.push(...parseLines(unread.subarray(0, boundary + 1).toString("utf8"))); state.offset += boundary + 1; }
      }
      for (const entry of records) for (const ev of parseDshEvent(entry, session, state.context)) {
        const transition = applyEvent(state.folded, ev);
        if (transition) state.folded = transition.next;
        if (!initial) result.push(ev);
      }
      if (initial && state.folded?.state) result.push({ agent: "dsh", sessionId: session.sessionId, type: "snapshot", at: state.folded.state.at,
        source: "dsh-native-log", host: "app", eventId: `dsh:${session.sessionId}:recovered:${state.offset}`, snapshot: state.folded.state, snapshotComplete: true });
      state.size = info.size; state.modified = info.mtimeMs;
      readers.set(session.sessionId, state);
    }
    return result;
  };
}

const poll = createDshPoller();
export const dshAdapter: Adapter = {
  id: "dsh", name: "DeepSeek Harness", icon: "agent-icons/dsh.png",
  detect: () => ({ present: existsSync(join(DSH_ROOT, "sessions")), hooked: false, hosts: ["app"] }),
  planInstall: () => ({ changes: [], notes: ["通过只读本地 Zstandard 会话日志持续采集回合、提问/回答、授权/决定和异常事件，无需修改 DeepSeek Harness 配置。"] }),
  planUninstall: () => ({ changes: [], notes: ["本地记录只读接入没有写入客户端配置；退订会话即可停止该会话的状态采集。"] }),
  source: { discover: async () => discoverDshSessions(), poll, titles: sessions => readDshTitles(sessions) },
  async jump(session) {
    const copied = await copyToClipboard(session.sessionId);
    const opened = await openUrl(DSH_OPEN_URL);
    return { ok: opened || copied, method: opened ? "activate" : copied ? "copied" : "none",
      message: opened ? "已打开 DeepSeek Harness，并复制会话 ID。此版本仅提供应用入口，请在客户端选择对应会话。" : copied ? "DeepSeek Harness 应用入口不可用，已复制会话 ID，可在客户端中查找。" : "DeepSeek Harness 应用入口和剪贴板当前不可用。" };
  },
};
