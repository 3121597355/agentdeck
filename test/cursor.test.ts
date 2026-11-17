import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURSOR_EVENTS, CURSOR_LIMITATIONS, cursorAdapter, parseCursorHook, parseCursorHookFile, installCursorHooks, removeCursorHooks, discoverCursorHistory, pollCursorSessions, cursorTranscriptEvents } from "../src/core/adapters/cursor";
import { exec, q } from "../src/core/sqlite";
import { applyEvent } from "../src/core/status";
import { fromHistory } from "../src/core/merge";

const ctx = {node:"C:/node.exe",cli:"C:/inbox/bin/agent-inbox.mjs",launcher:"C:/inbox/bin/agent-inbox.mjs-hook.ps1"};
test("Cursor Hook installation preserves unrelated hooks and settings, and removes only its own entries",()=>{
  const original = {version:1,custom:"kept",hooks:{stop:[{command:"user-audit.ps1",loop_limit:3},{command:"powershell.exe -File agent-inbox.mjs-hook.ps1 hook claude"}],preToolUse:[{command:"user-permission-gate.ps1"}]}};
  const installed = installCursorHooks(original,ctx);
  assert.deepEqual(removeCursorHooks(installed),original);
  assert.deepEqual(installCursorHooks(installed,ctx),installed);
  assert.deepEqual(installed.hooks?.preToolUse,original.hooks.preToolUse);
  assert.ok(CURSOR_EVENTS.every(name=>installed.hooks?.[name]?.some(v=>String(v.command).endsWith("hook cursor"))));
  assert.ok(!CURSOR_EVENTS.some(name=>/^(preToolUse|beforeShellExecution|beforeMCPExecution)$/.test(name)));
  assert.throws(()=>parseCursorHookFile('{"hooks":{"stop":{}}}',"hooks.json"),/有效/);
});
test("Cursor Hooks use stable conversation/generation identities and never equate turn stop with task completion",()=>{
  const base = {conversation_id:"conversation-1",generation_id:"generation-1",workspace_roots:["C:\\项目"]};
  const progress=parseCursorHook({...base,hook_event_name:"beforeSubmitPrompt",prompt:"修改中文界面"},{},100)!;
  assert.equal(progress.agent,"cursor");assert.equal(progress.cwd,"C:\\项目");assert.equal(progress.type,"progress");
  const wait=parseCursorHook({...base,hook_event_name:"afterAgentResponse",text:"请选择要使用的颜色？"},{},200)!;
  let session=applyEvent(undefined,progress)!.next;
  session=applyEvent(session,wait)!.next;
  const stop=parseCursorHook({...base,hook_event_name:"stop",status:"completed"},{},300)!;
  assert.equal(stop.type,"stopped");assert.equal(applyEvent(session,stop)!.next.status,"needs_input");
  const resumed=parseCursorHook({...base,generation_id:"generation-2",hook_event_name:"beforeSubmitPrompt",prompt:"蓝色"},{},400)!;
  assert.equal(applyEvent(session,resumed)!.next.status,"running");
  assert.equal(parseCursorHook({...base,hook_event_name:"beforeShellExecution"},{},400),null);
  assert.equal(parseCursorHook({...base,hook_event_name:"stop",status:"error"},{},500)!.type,"failed");
  assert.equal(parseCursorHook({...base,hook_event_name:"stop",status:"aborted"},{},500)!.type,"interrupted");
  assert.equal(parseCursorHook({...base,hook_event_name:"postToolUseFailure",failure_type:"permission_denied"},{},500)!.type,"tool");
});
test("Cursor answered question resolves matching request; async acceptance is not an answer",()=>{
  const base={conversation_id:"c1",generation_id:"g1",hook_event_name:"postToolUse",tool_name:"request_user_input",tool_use_id:"request-1"};
  assert.equal(parseCursorHook({...base,tool_output:'{"answers":{"color":"blue"}}'},{},10)!.type,"resolved");
  assert.equal(parseCursorHook({...base,tool_output:'{"accepted":true}'},{},10)!.type,"tool");
  const pending=applyEvent(undefined,{agent:"cursor",sessionId:"c1",type:"needs_input",requestIds:["request-1"],at:1})!.next;
  const acknowledgement=parseCursorHook({...base,tool_output:'{"accepted":true}'},{},10)!;
  assert.equal(applyEvent(pending,acknowledgement)!.next.status,"needs_input");
});
test("Cursor actual JSONL shape recovers a question and clears it only on a later user message",()=>{
  const events=cursorTranscriptEvents({sessionId:"c1",cwd:"C:\\project"},[
    {offset:0,entry:{role:"user",message:{content:[{type:"text",text:"请修改页面"}]}}},
    {offset:80,entry:{role:"assistant",message:{content:[{type:"text",text:"需要我先修改哪个页面？"}]}}},
    {offset:160,entry:{type:"turn_ended",status:"success"}},
  ],100);
  let state=events.reduce((current,event)=>applyEvent(current,event)?.next || current,undefined as ReturnType<typeof fromHistory>|undefined)!;
  assert.equal(state.status,"needs_input");
  assert.ok(events.every(e=>e.at===100 && e.eventId?.startsWith("cursor-transcript:")));
  state=applyEvent(state,{agent:"cursor",sessionId:"c1",type:"progress",at:200})!.next;
  assert.equal(state.status,"running");
});
test("Cursor real database schema and JSONL exports produce history; blocking flag resolves its own pending request",async()=>{
  const root=mkdtempSync(join(tmpdir(),"agent-inbox-cursor-"));
  const paths={root:join(root,"config"),userData:join(root,"User")};
  const storage=join(paths.userData,"globalStorage");mkdirSync(storage,{recursive:true});
  const db=join(storage,"state.vscdb");
  await exec(db,"CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isSubagent INTEGER,value TEXT);CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);");
  const header={name:"真实格式的中文会话",isDraft:false,hasBlockingPendingActions:true};
  const data={composerId:"c1",status:"completed",latestChatGenerationUUID:"g1"};
  await exec(db,`INSERT INTO composerHeaders VALUES('c1','fixture',100,200,0,${q(JSON.stringify(header))});INSERT INTO cursorDiskKV VALUES('composerData:c1',${q(JSON.stringify(data))});INSERT INTO composerHeaders VALUES('draft','fixture',100,200,0,'{"isDraft":true}');`);
  const dir=join(paths.root,"projects","fixture","agent-transcripts","c1");mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"c1.jsonl"),JSON.stringify({role:"user",message:{content:[{type:"text",text:"请处理这个任务"}]}})+"\n"+JSON.stringify({type:"turn_ended",status:"success"})+"\n");
  const history=await discoverCursorHistory(paths);assert.equal(history.length,1);assert.equal(history[0].title,header.name);assert.equal(history[0].sessionId,"c1");
  let session=fromHistory(history[0]);session.subscribed=true;
  const first=await pollCursorSessions([session],paths);const wait=first.find(e=>e.type==="needs_input" && e.requestIds?.[0]?.startsWith("cursor-blocking:g1:"))!;
  assert.ok(wait);session=applyEvent(session,wait)!.next;
  await exec(db,"UPDATE composerHeaders SET value=json_set(value,'$.hasBlockingPendingActions',0),lastUpdatedAt=300 WHERE composerId='c1';");
  const second=await pollCursorSessions([session],paths);const resolved=second.find(e=>e.type==="resolved")!;
  assert.deepEqual(resolved.requestIds,wait.requestIds);assert.equal(applyEvent(session,resolved)!.next.state?.pending.length,0);
  session=applyEvent(session,resolved)!.next;
  await exec(db,"UPDATE composerHeaders SET value=json_set(value,'$.hasBlockingPendingActions',1),lastUpdatedAt=400 WHERE composerId='c1';");
  const later=new Date(Date.now()+1000);utimesSync(db,later,later);
  const reopened=(await pollCursorSessions([session],paths)).find(e=>e.type==="needs_input")!;
  assert.notDeepEqual(reopened.requestIds,wait.requestIds,"a later blocking decision within the same generation needs its own identity");
  assert.equal(applyEvent(session,reopened)!.next.status,"needs_input");
});
test("Cursor old blocking metadata cannot outrank a newer Hook through unrelated database writes",async()=>{
  const root=mkdtempSync(join(tmpdir(),"agent-inbox-cursor-clock-"));
  const paths={root:join(root,"config"),userData:join(root,"User")};
  const storage=join(paths.userData,"globalStorage");mkdirSync(storage,{recursive:true});
  const db=join(storage,"state.vscdb");
  await exec(db,"CREATE TABLE composerHeaders(composerId TEXT PRIMARY KEY,workspaceId TEXT,createdAt INTEGER,lastUpdatedAt INTEGER,isSubagent INTEGER,value TEXT);CREATE TABLE cursorDiskKV(key TEXT PRIMARY KEY,value BLOB);");
  await exec(db,`INSERT INTO composerHeaders VALUES('c1','fixture',100,200,0,'{"hasBlockingPendingActions":true}');INSERT INTO cursorDiskKV VALUES('composerData:c1','{"latestChatGenerationUUID":"g1"}');`);
  // The DB revision is later because another conversation changed; c1's own header is still old.
  utimesSync(db,new Date(1000),new Date(1000));
  const progress=parseCursorHook({conversation_id:"c1",generation_id:"g2",hook_event_name:"beforeSubmitPrompt",prompt:"继续执行"},{},500)!;
  const session=applyEvent(undefined,progress)!.next;session.subscribed=true;
  const old=await pollCursorSessions([session],paths);
  assert.ok(!old.some(e=>e.type==="needs_input"),"row at200 must not overrule Hook progress at500 even when the DB revision is1000");
  await exec(db,`UPDATE composerHeaders SET lastUpdatedAt=600 WHERE composerId='c1';UPDATE cursorDiskKV SET value='{"latestChatGenerationUUID":"g2"}' WHERE key='composerData:c1';`);
  utimesSync(db,new Date(1000),new Date(1000));
  const fresh=await pollCursorSessions([session],paths);
  const wait=fresh.find(e=>e.type==="needs_input")!;
  assert.ok(wait,"genuine header at600 may establish a new blocking request");
  assert.equal(wait.at,600,"unrelated DB revision must never become the event timestamp");
  assert.equal(applyEvent(session,wait)!.next.status,"needs_input");
});
test("Cursor connection notes disclose polling and local navigation limitations",()=>{
  const original=process.env.AGENT_INBOX_CURSOR_ROOT;
  process.env.AGENT_INBOX_CURSOR_ROOT=mkdtempSync(join(tmpdir(),"agent-inbox-cursor-notes-"));
  try {assert.ok(cursorAdapter.planInstall(ctx).notes.includes(CURSOR_LIMITATIONS));}
  finally {if(original===undefined)delete process.env.AGENT_INBOX_CURSOR_ROOT;else process.env.AGENT_INBOX_CURSOR_ROOT=original;}
});
