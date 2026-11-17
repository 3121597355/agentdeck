import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { run, shQuote } from "../exec";
import { sqliteBinary, q } from "../sqlite";
import { openUrl, copyToClipboard } from "../jump";
import { asksForInput } from "../status";
import { Adapter, HookContext, InstallPlan, HOOK_MARKER } from "./types";
import { AgentEvent, HistoryEntry, Session, SessionTitle } from "../types";
import { string as s, object, eventTime, requestIds, questionTool, isAsyncAcknowledgement } from "./events";

/** Only observational hooks. Permission hooks require an allow/deny reply and are deliberately absent. */
export const CURSOR_EVENTS = ["sessionStart", "sessionEnd", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop"] as const;
export const CURSOR_LIMITATIONS = "本地会话与 Hook 状态已接入；本地阻塞标志可识别等待介入，但不保证区分每一种审批。跳转打开 Cursor 并复制会话 ID，未验证本地聊天的精确深链。";

export interface CursorPaths { root: string; userData: string; }
export function cursorPaths(): CursorPaths {
  const isolation = process.env.AGENT_INBOX_TEST_HOME;
  return {
    root: process.env.AGENT_INBOX_CURSOR_ROOT || (isolation ? join(isolation, "cursor") : join(homedir(), ".cursor")),
    userData: process.env.AGENT_INBOX_CURSOR_USER_DATA || (isolation ? join(isolation, "cursor-user") : join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Cursor", "User")),
  };
}
type CursorHookFile = { version?: number; hooks?: Record<string, Record<string, unknown>[]>; [key: string]: unknown };
export function parseCursorHookFile(text: string, path: string): CursorHookFile {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
        (parsed.version === undefined || (Number.isInteger(parsed.version) && parsed.version > 0)) &&
        (parsed.hooks === undefined || (parsed.hooks && typeof parsed.hooks === "object" && !Array.isArray(parsed.hooks))) &&
        Object.values(parsed.hooks || {}).every(v => Array.isArray(v))) return parsed;
  } catch {}
  throw new Error(`${path} 不是有效的 Cursor Hook JSON；请修复后再接入。`);
}
const isOurHook = (v: Record<string, unknown>) => typeof v?.command === "string" && v.command.includes(HOOK_MARKER) && /hook\s+cursor(?:\s|$)/.test(v.command);
export function removeCursorHooks(file: CursorHookFile): CursorHookFile {
  const hooks: Record<string, Record<string, unknown>[]> = {};
  for (const [name, entries] of Object.entries(file.hooks || {})) {
    const kept = entries.filter(v => !isOurHook(v));
    if (kept.length) hooks[name] = kept;
  }
  const next = { ...file };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  return next;
}
export function installCursorHooks(file: CursorHookFile, ctx: HookContext): CursorHookFile {
  const base = removeCursorHooks(file);
  // On Windows Cursor launches the command through PowerShell. The bundled launcher forwards UTF-8 stdin.
  const command = ctx.launcher
    ? `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ctx.launcher.replace(/\\/g, "/")}" hook cursor`
    : `${shQuote(ctx.node)} ${shQuote(ctx.cli)} hook cursor`;
  const hooks = { ...base.hooks };
  for (const name of CURSOR_EVENTS) hooks[name] = [...(hooks[name] || []), { command, timeout: 10, failClosed: false }];
  return { ...base, version: typeof base.version === "number" ? base.version : 1, hooks };
}
function hookPlan(ctx?: HookContext): InstallPlan {
  const path = join(cursorPaths().root, "hooks.json");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const file = parseCursorHookFile(before, path);
  const next = ctx ? installCursorHooks(file, ctx) : removeCursorHooks(file);
  const after = JSON.stringify(next, null, 2) + "\n";
  return { changes: [{ path, before, after, summary: ctx ? "接入 Cursor 观察 Hook，保留已有 Hook" : "移除本应用的 Cursor Hook", preview: after, previewLang: "json" }],
    notes: [CURSOR_LIMITATIONS, "仅接入用户级本地 Hook；Cursor 云端不会读取本机 hooks.json。", "本应用不安装权限拦截 Hook，不批准授权，也不发送自动续聊。", "请启动新会话或重新加载 Cursor，以使配置生效。"] };
}
const excerpt = (text: string, max = 180) => text.replace(/<\/?user_query>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
export function parseCursorHook(payload: Record<string, unknown>, _env: NodeJS.ProcessEnv, now = Date.now()): AgentEvent | null {
  const sessionId = s(payload.conversation_id) || s(payload.session_id);
  const name = s(payload.hook_event_name);
  if (!sessionId || !name) return null;
  const generation = s(payload.generation_id);
  const base = { agent: "cursor", sessionId, host: "app" as const, source: "cursor-hook", at: eventTime(payload.timestamp, now),
    turnId: generation || undefined, cwd: s(payload.cwd) || (Array.isArray(payload.workspace_roots) ? s(payload.workspace_roots[0]) : ""),
    transcriptPath: s(payload.transcript_path),
    eventId: s(payload.event_id) || `cursor-hook:${hash([sessionId, generation, name, payload.tool_use_id, payload.text, payload.prompt, payload.status, payload.loop_count, payload.timestamp])}` };
  switch (name) {
    case "sessionStart": return { ...base, type: "started" };
    case "sessionEnd": return { ...base, type: "ended" };
    case "beforeSubmitPrompt": return { ...base, type: "progress", title: excerpt(s(payload.prompt), 100) };
    case "postToolUse": {
      const request = requestIds(payload);
      if (questionTool(s(payload.tool_name)) && isAsyncAcknowledgement(payload.tool_output)) return { ...base, type: "tool" };
      if (questionTool(s(payload.tool_name)) && request.length && !isAsyncAcknowledgement(payload.tool_output))
        return { ...base, type: "resolved", requestIds: request };
      return { ...base, type: "tool", requestIds: request };
    }
    case "postToolUseFailure": return payload.is_interrupt === true ? { ...base, type: "interrupted" } : { ...base, type: "tool" };
    case "afterAgentResponse": {
      const summary = excerpt(s(payload.text));
      return { ...base, type: asksForInput(s(payload.text)) ? "needs_input" : "stopped", attention: asksForInput(s(payload.text)) ? "question" : undefined, summary };
    }
    case "stop": return { ...base, type: payload.status === "error" ? "failed" : payload.status === "aborted" ? "interrupted" : "stopped" };
    default: return null;
  }
}

async function readDatabase<T>(db: string, query: string): Promise<T[]> {
  if (!existsSync(db)) return [];
  const result = await run(sqliteBinary(), ["-readonly", "-json", "-bail", "-cmd", ".timeout 2000", db, query], undefined, 7000);
  if (!result.ok) throw new Error(`Cursor 本地数据库读取失败：${result.stderr.trim().slice(0, 220)}`);
  if (!result.stdout.trim()) return [];
  return JSON.parse(result.stdout) as T[];
}
interface CursorHeader { id: string; name: string | null; createdAt: number; updatedAt: number | null; workspaceId: string | null; }
async function readHeaders(paths: CursorPaths): Promise<CursorHeader[]> {
  const db = join(paths.userData, "globalStorage", "state.vscdb");
  if (!existsSync(db)) return [];
  const tables = await readDatabase<{name:string}>(db, "SELECT name FROM sqlite_master WHERE type='table';");
  if (tables.some(t => t.name === "composerHeaders")) return readDatabase<CursorHeader>(db,
    "SELECT composerId AS id,json_extract(value,'$.name') AS name,createdAt,coalesce(lastUpdatedAt,createdAt) AS updatedAt,workspaceId FROM composerHeaders WHERE isSubagent=0 AND coalesce(json_extract(value,'$.isDraft'),0)=0 ORDER BY coalesce(lastUpdatedAt,createdAt) DESC LIMIT 1000;");
  if (tables.some(t => t.name === "cursorDiskKV")) return readDatabase<CursorHeader>(db,
    "SELECT json_extract(value,'$.composerId') AS id,json_extract(value,'$.name') AS name,json_extract(value,'$.createdAt') AS createdAt,coalesce(json_extract(value,'$.lastUpdatedAt'),json_extract(value,'$.createdAt')) AS updatedAt,json_extract(value,'$.workspaceIdentifier.id') AS workspaceId FROM cursorDiskKV WHERE key LIKE 'composerData:%' AND coalesce(json_extract(value,'$.isDraft'),0)=0 AND json_extract(value,'$.composerId') IS NOT NULL LIMIT 1000;");
  return [];
}
interface TranscriptRecord { entry: Record<string,unknown>; offset: number; }
/** JSONL exports do not contain per-entry timestamps. Use the actual file revision time, never fabricated historical times. */
function transcriptRecords(path: string): {records:TranscriptRecord[]; at:number} {
  const stat = statSync(path);
  const limit = 8 * 1024 * 1024;
  const start = Math.max(0, stat.size - limit);
  const buffer = Buffer.alloc(Math.min(stat.size, limit));
  const fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
  const records: TranscriptRecord[] = [];
  let offset = start ? buffer.indexOf(10) + 1 : 0;
  if (start && offset === 0) return {records, at:stat.mtimeMs};
  while (offset < buffer.length) {
    const end = buffer.indexOf(10, offset);
    const finish = end < 0 ? buffer.length : end;
    try { records.push({entry:JSON.parse(buffer.subarray(offset, finish).toString("utf8")),offset:start+offset}); } catch {}
    offset = finish + 1;
  }
  return {records:records.slice(-1000),at:stat.mtimeMs};
}
function contentText(entry: Record<string, unknown>): string {
  const content = object(entry.message).content;
  if (!Array.isArray(content)) return "";
  return content.filter(v => object(v).type === "text").map(v => s(object(v).text)).join("\n");
}
function findTranscripts(paths: CursorPaths): Map<string,string> {
  const found = new Map<string,string>();
  const projectRoot = join(paths.root, "projects");
  if (!existsSync(projectRoot)) return found;
  for (const project of readdirSync(projectRoot, {withFileTypes:true}).filter(v => v.isDirectory()).slice(0,300)) {
    const dir = join(projectRoot, project.name, "agent-transcripts");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, {withFileTypes:true}).slice(0,1000)) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) found.set(basename(entry.name,".jsonl"),join(dir,entry.name));
      if (entry.isDirectory()) {
        const path = join(dir,entry.name,`${entry.name}.jsonl`);
        if (existsSync(path)) found.set(entry.name,path);
      }
    }
  }
  return found;
}
function workspacePath(paths: CursorPaths, workspaceId: string | null): string {
  if (!workspaceId) return "";
  const path = join(paths.userData,"workspaceStorage",workspaceId,"workspace.json");
  try {
    const data = JSON.parse(readFileSync(path,"utf8"));
    const uri = s(data.folder);
    if (uri.startsWith("file:///")) return decodeURIComponent(uri.slice(8)).replace(/\//g,"\\");
  } catch {}
  return "";
}
export async function discoverCursorHistory(paths = cursorPaths()): Promise<HistoryEntry[]> {
  const headers = await readHeaders(paths);
  const transcripts = findTranscripts(paths);
  const byId = new Map<string,HistoryEntry>();
  for (const header of headers) {
    if (!header.id || header.id === "empty-state-draft") continue;
    byId.set(header.id,{agent:"cursor",sessionId:header.id,host:"app",title:header.name || "Cursor 会话",cwd:workspacePath(paths,header.workspaceId),summary:"",startedAt:header.createdAt || 0,updatedAt:header.updatedAt || header.createdAt || 0,transcriptPath:transcripts.get(header.id) || ""});
  }
  for (const [id,path] of transcripts) {
    const {records,at} = transcriptRecords(path);
    const firstUser = records.find(r => r.entry.role === "user");
    const lastAssistant = [...records].reverse().find(r => r.entry.role === "assistant");
    const prior = byId.get(id);
    byId.set(id,{agent:"cursor",sessionId:id,host:"app",title:prior?.title && prior.title !== "Cursor 会话" ? prior.title : excerpt(firstUser ? contentText(firstUser.entry) : "",100) || "Cursor 会话",cwd:prior?.cwd || "",summary:excerpt(lastAssistant ? contentText(lastAssistant.entry) : ""),startedAt:prior?.startedAt || statSync(path).birthtimeMs,updatedAt:Math.max(prior?.updatedAt || 0,at),transcriptPath:path});
  }
  return [...byId.values()].sort((a,b) => b.updatedAt-a.updatedAt).slice(0,1000);
}
export function cursorTranscriptEvents(session: Pick<Session,"sessionId"|"cwd">, records:TranscriptRecord[], at:number): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const {entry,offset} of records) {
    const base = {agent:"cursor",sessionId:session.sessionId,host:"app" as const,cwd:session.cwd,at,source:"cursor-transcript",eventId:`cursor-transcript:${session.sessionId}:${offset}:${hash(entry)}`};
    if (entry.role === "user") events.push({...base,type:"progress"});
    else if (entry.role === "assistant") {
      const text = contentText(entry);
      if (text) events.push({...base,type:asksForInput(text)?"needs_input":"stopped",attention:asksForInput(text)?"question":undefined,summary:excerpt(text)});
    } else if (entry.type === "turn_ended") events.push({...base,type:entry.status === "error"?"failed":entry.status === "aborted"?"interrupted":"stopped"});
  }
  return events;
}
export async function pollCursorSessions(sessions:Session[],paths = cursorPaths()):Promise<AgentEvent[]> {
  const own = sessions.filter(s => s.agent === "cursor");
  if (!own.length) return [];
  const events: AgentEvent[] = [];
  const transcripts = findTranscripts(paths);
  for (const session of own) {
    const path = session.transcriptPath && existsSync(session.transcriptPath) ? session.transcriptPath : transcripts.get(session.sessionId);
    if (path) {const read=transcriptRecords(path);events.push(...cursorTranscriptEvents(session,read.records,read.at));}
  }
  const db = join(paths.userData,"globalStorage","state.vscdb");
  if (existsSync(db)) {
    const tables = await readDatabase<{name:string}>(db,"SELECT name FROM sqlite_master WHERE type='table';");
    if (tables.some(t => t.name === "composerHeaders") && tables.some(t => t.name === "cursorDiskKV")) {
      const rows = await readDatabase<{id:string;pending:number;status:string;generation:string|null;at:number|null}>(db,
        `SELECT h.composerId AS id,coalesce(json_extract(h.value,'$.hasBlockingPendingActions'),0) AS pending,json_extract(d.value,'$.status') AS status,json_extract(d.value,'$.latestChatGenerationUUID') AS generation,coalesce(h.lastUpdatedAt,h.createdAt) AS at FROM composerHeaders h LEFT JOIN cursorDiskKV d ON d.key='composerData:'||h.composerId WHERE h.composerId IN (${own.map(v=>q(v.sessionId)).join(",")});`);
      for (const row of rows) {
        const session = own.find(v=>v.sessionId===row.id)!;
        // A global DB/WAL revision can belong to another conversation. Only this header's
        // timestamp may establish that its blocking flag is newer than an identified turn/Hook.
        const at = Number(row.at) || 0;
        const hookAt = session.state?.source === "cursor-hook" ? session.state.at : 0;
        const turnAt = session.state?.turnId ? session.state.turnStartedAt || 0 : 0;
        if (at < Math.max(hookAt, turnAt)) continue;
        // File revision is solely an identity discriminator for a later blocking cycle, never its event clock.
        const revision = Math.max(statSync(db).mtimeMs,existsSync(db+"-wal")?statSync(db+"-wal").mtimeMs:0);
        const current = session.state?.pending.find(v=>v.id.startsWith("cursor-blocking:"));
        if (row.pending) {
          const request = current?.id || `cursor-blocking:${row.generation || row.id}:${Math.trunc(at)}:${Math.trunc(revision)}`;
          events.push({agent:"cursor",sessionId:row.id,host:"app",type:"needs_input",attention:"input",requestIds:[request],at,source:"cursor-local-snapshot",eventId:`cursor-blocking:${row.id}:${request}:open:${row.at || 0}`,summary:"Cursor 本地记录显示此会话正在等待用户决定。"});
        } else if (current) events.push({agent:"cursor",sessionId:row.id,host:"app",type:"resolved",requestIds:[current.id],at,source:"cursor-local-snapshot",eventId:`cursor-blocking:${row.id}:${current.id}:closed:${at}`});
      }
    }
  }
  return events;
}

export const cursorAdapter:Adapter = {
  id:"cursor",name:"Cursor",icon:"agent-icons/cursor.png",
  detect(){const paths=cursorPaths();let hooked=false;try{const file=parseCursorHookFile(readFileSync(join(paths.root,"hooks.json"),"utf8"),"hooks.json");hooked=CURSOR_EVENTS.every(name=>file.hooks?.[name]?.some(isOurHook));}catch{}return{present:existsSync(paths.root)||existsSync(paths.userData),hooked,hosts:["app","cli"]};},
  planInstall:ctx=>hookPlan(ctx),planUninstall:()=>hookPlan(),parseHook:(_kind,payload,env)=>parseCursorHook(payload,env),
  source:{discover:()=>discoverCursorHistory(),poll:sessions=>pollCursorSessions(sessions),titles:async sessions=>{const history=await discoverCursorHistory();return history.filter(h=>sessions.some(s=>s.agent==="cursor"&&s.sessionId===h.sessionId)).map(h=>({agent:"cursor",sessionId:h.sessionId,title:h.title,source:"cursor-local",observedAt:Date.now()} as SessionTitle));}},
  async jump(session){
    await copyToClipboard(session.sessionId);
    const registered=process.platform!=="win32"||(await run("reg.exe",["query","HKCR\\cursor","/v","URL Protocol"])).ok;
    // Verified in the installed cursor-deeplink extension. /agent routes only cloud agents, so don't use it for local UUIDs.
    if(registered&&await openUrl("cursor://anysphere.cursor-deeplink/glass"))return{ok:true,method:"activate",message:"已请求打开 Cursor，并复制会话 ID。当前客户端未验证本地聊天的精确深链，请在 Cursor 历史记录中定位。"};
    return{ok:true,method:"copied",message:"未找到可用的 Cursor 桌面入口，已复制会话 ID。"};
  },
};
