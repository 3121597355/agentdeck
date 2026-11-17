import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../exec";
import { copyToClipboard, openUrl } from "../jump";
import { sqliteBinary, q } from "../sqlite";
import { asksForInput, lastSentence } from "../status";
import type { AgentEvent, HistoryEntry, Session } from "../types";
import type { SourceContext } from "../sources/types";
import { findTranscript } from "../sources/locate";
import { isAsyncAcknowledgement, object, questionTool, string } from "./events";
import type { Adapter } from "./types";

export const WORKBUDDY_ROOT = join(homedir(), ".workbuddy");

export function workbuddyRoot(): string {
  if (process.env.AGENT_INBOX_WORKBUDDY_ROOT) return process.env.AGENT_INBOX_WORKBUDDY_ROOT;
  if (process.env.AGENT_INBOX_TEST_HOME) return join(process.env.AGENT_INBOX_TEST_HOME, "sources", "workbuddy");
  return process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || WORKBUDDY_ROOT;
}

interface WorkbuddyRow {
  id: string;
  cwd: string;
  title: string | null;
  custom_title: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  last_activity_at: number | null;
}

/** External WorkBuddy databases are always opened with SQLite's read-only flag. */
async function readRows(root: string, where = "", limit = 1000): Promise<WorkbuddyRow[]> {
  const database = join(root, "workbuddy.db");
  if (!existsSync(database)) return [];
  const sql = `SELECT id,cwd,title,custom_title,status,created_at,updated_at,last_activity_at
    FROM sessions WHERE (deleted_at IS NULL OR deleted_at <= 0) ${where}
    ORDER BY COALESCE(last_activity_at,updated_at,created_at) DESC LIMIT ${Math.max(1, Math.min(limit, 2000))};`;
  const result = await run(sqliteBinary(), ["-readonly", "-json", "-bail", "-cmd", ".timeout 1500", database], sql, 5000);
  if (!result.ok) throw new Error(`WorkBuddy 本地数据库读取失败：${result.stderr.trim().slice(0, 160)}`);
  try { return result.stdout.trim() ? JSON.parse(result.stdout) as WorkbuddyRow[] : []; }
  catch { throw new Error("WorkBuddy 本地数据库返回了无法识别的数据。"); }
}

function transcriptMap(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const ambiguous = new Set<string>();
  const projects = join(root, "projects");
  if (!existsSync(projects)) return found;
  // WorkBuddy stores one JSONL directly inside each encoded project directory.
  for (const project of readdirSync(projects, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const directory = join(projects, project.name);
    for (const file of readdirSync(directory, { withFileTypes: true })) {
      if (!file.isFile() || !/^[A-Za-z0-9_-]+\.jsonl$/.test(file.name)) continue;
      const id = file.name.slice(0, -6);
      if (found.has(id)) ambiguous.add(id);
      else found.set(id, join(directory, file.name));
    }
  }
  for (const id of ambiguous) found.delete(id);
  return found;
}

export async function readWorkbuddyHistory(root = workbuddyRoot()): Promise<HistoryEntry[]> {
  const rows = await readRows(root);
  const paths = transcriptMap(root);
  return rows.filter(row => /^[A-Za-z0-9_-]+$/.test(row.id)).map(row => ({
    agent: "workbuddy", sessionId: row.id, host: "app", cwd: row.cwd || "",
    title: row.custom_title?.trim() || row.title?.trim() || "WorkBuddy 会话",
    summary: "", startedAt: Number(row.created_at),
    updatedAt: Number(row.last_activity_at || row.updated_at || row.created_at),
    transcriptPath: paths.get(row.id) || "", locator: {},
  }));
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
  const record = object(value);
  return string(record.text);
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

/** Observed WorkBuddy 5.9.2 JSONL records, independent of the model it is running. */
export function parseWorkbuddyTranscript(
  entry: Record<string, unknown>, session: Pick<Session, "agent" | "sessionId">, context: SourceContext,
): AgentEvent[] {
  if (string(entry.sessionId) && entry.sessionId !== session.sessionId) return [];
  const at = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(string(entry.timestamp));
  if (!Number.isFinite(at) || at <= 0) return [];
  const base = {
    agent: "workbuddy", sessionId: session.sessionId, host: "app" as const,
    at, source: "workbuddy-transcript", eventId: string(entry.id) || undefined,
    cwd: string(entry.cwd), turnId: context.turnId,
  };
  const type = string(entry.type);
  if (type === "message" && entry.role === "user") {
    context.turnId = string(entry.id) || `user:${at}`;
    return [{ ...base, type: "progress", turnId: context.turnId, title: text(entry.content).slice(0, 160) }];
  }
  if (type === "function_call") {
    const name = string(entry.name), call = string(entry.callId);
    if (questionTool(name) && call) {
      const args = object(parsed(entry.arguments));
      const questions = Array.isArray(args.questions) ? args.questions : [];
      const summary = questions.map(question => string(object(question).question)).filter(Boolean).join(" / ");
      return [{ ...base, type: "needs_input", attention: "question", requestIds: [call], summary: lastSentence(summary) }];
    }
    return [{ ...base, type: "tool" }];
  }
  if (type === "function_call_result") {
    const call = string(entry.callId);
    if (questionTool(string(entry.name)) && call && entry.status === "completed") {
      const output = parsed(entry.output);
      // Async acknowledgements are transport receipts, not a user's answer.
      if (isAsyncAcknowledgement(output) || isAsyncAcknowledgement(text(output))) return [];
      if (!text(output).trim() && !object(output).answers && !object(output).cancelled) return [];
      return [{ ...base, type: "resolved", requestIds: [call] }];
    }
    // An unrelated tool result must not dismiss an outstanding question.
    return [{ ...base, type: "tool" }];
  }
  if (type === "message" && entry.role === "assistant" && entry.status === "completed") {
    const summary = lastSentence(text(entry.content));
    const events: AgentEvent[] = [{ ...base, type: "stopped", summary }];
    if (asksForInput(summary)) events.push({ ...base, type: "needs_input", attention: "input", inferred: true, summary });
    return events;
  }
  return [];
}

/** Newer terminal database status reconciles a transcript that ended during cancellation or fork. */
export async function pollWorkbuddyStatus(sessions: Session[], root = workbuddyRoot()): Promise<AgentEvent[]> {
  const relevant = sessions.filter(session => session.agent === "workbuddy" && /^[A-Za-z0-9_-]+$/.test(session.sessionId));
  if (!relevant.length) return [];
  const rows = await readRows(root, `AND id IN (${relevant.map(session => q(session.sessionId)).join(",")})`, 2000);
  const byId = new Map(relevant.map(session => [session.sessionId, session]));
  const events: AgentEvent[] = [];
  for (const row of rows) {
    const at = Number(row.updated_at || row.last_activity_at || row.created_at);
    if (!Number.isFinite(at) || at <= 0) continue;
    const current = byId.get(row.id);
    // A newer prompt/tool event wins over an older persisted terminal status.
    if (at < (current?.state?.at ?? 0)) continue;
    const base = {agent:"workbuddy",sessionId:row.id,host:"app" as const,cwd:row.cwd,at,source:"workbuddy-database",eventId:`workbuddy-db:${row.id}:${row.status}:${at}`};
    if (row.status.toLowerCase() === "error") {
      events.push({...base,type:"failed",attention:"failed",summary:"WorkBuddy 将此会话标记为异常；请返回客户端查看详情。"});
    } else if (row.status.toLowerCase() === "completed") {
      events.push({...base,type:"stopped",summary:"WorkBuddy 会话回合已停止。"});
    }
    // A persisted running flag can survive process exit and is not proof of a live agent.
  }
  return events;
}

export function workbuddySessionUrl(sessionId: string): string | undefined {
  return /^[A-Za-z0-9_-]+$/.test(sessionId) ? `workbuddy://chat/${encodeURIComponent(sessionId)}` : undefined;
}

export const workbuddyAdapter: Adapter = {
  id: "workbuddy", name: "WorkBuddy", icon: "agent-icons/workbuddy.png",
  detect: () => ({present:existsSync(join(workbuddyRoot(),"workbuddy.db")),hooked:false,hosts:["app"]}),
  planInstall: () => ({changes:[],notes:["自动只读采集 WorkBuddy 本地数据库与会话 JSONL，不需要修改 WorkBuddy 设置。","可识别本地提问、回答及异常；未持久化的权限弹窗无法可靠监测。"]}),
  planUninstall: () => ({changes:[],notes:["此来源未写入 WorkBuddy 配置；取消相关订阅即可停止提醒。"]}),
  source: {
    discover: () => readWorkbuddyHistory(),
    poll: sessions => pollWorkbuddyStatus(sessions),
    transcript: {parse:parseWorkbuddyTranscript},
    locateTranscript: async session => findTranscript(join(workbuddyRoot(),"projects"),session.sessionId),
    titles: async sessions => {
      const wanted = new Set(sessions.filter(session=>session.agent==="workbuddy").map(session=>session.sessionId));
      if(!wanted.size)return [];
      return (await readWorkbuddyHistory()).filter(session=>wanted.has(session.sessionId)).map(session=>({agent:"workbuddy",sessionId:session.sessionId,title:session.title,observedAt:Date.now(),source:"workbuddy-database"}));
    },
  },
  async jump(session) {
    const url = workbuddySessionUrl(session.sessionId);
    const registered = process.platform === "win32" && (await run("reg.exe",["query","HKCR\\workbuddy","/v","URL Protocol"])).ok;
    if (url && registered && await openUrl(url)) return {ok:true,method:"url",message:"已向 WorkBuddy 发送打开此会话的请求。"};
    const copied = await copyToClipboard(session.sessionId);
    return {ok:copied,method:copied?"copied":"none",message:"未找到可用的 WorkBuddy 会话入口，已复制会话 ID，可在 WorkBuddy 中查找。"};
  },
};
