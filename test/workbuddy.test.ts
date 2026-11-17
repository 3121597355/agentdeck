import { strict as assert } from "node:assert";
import { test } from "node:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { exec } from "../src/core/sqlite";
import { Store } from "../src/core/db";
import { EventEngine } from "../src/core/engine";
import { DEFAULT_CONFIG } from "../src/core/config";
import { TranscriptCollector } from "../src/core/sources/collector";
import { deliverNotifications } from "../src/core/notifications";
import { applyEvent } from "../src/core/status";
import { parseWorkbuddyTranscript, pollWorkbuddyStatus, readWorkbuddyHistory, workbuddyAdapter, workbuddyRoot, workbuddySessionUrl } from "../src/core/adapters/workbuddy";
import type { Session } from "../src/core/types";
import { tempDir } from "./helpers";

const session = (id = "session-1", transcriptPath = ""): Session => ({
  agent:"workbuddy",sessionId:id,host:"app",title:"WorkBuddy",cwd:"",summary:"",status:"idle",attention:null,
  subscribed:true,handledAt:null,startedAt:1,updatedAt:1,locator:{},transcriptPath,
});
const row = (timestamp: number, type: string, values: object = {}) => ({timestamp,type,sessionId:"session-1",...values});

test("WorkBuddy discovers custom titles and exact transcripts read-only, excludes deleted sessions", async t => {
  const directory = tempDir(t), db = join(directory,"workbuddy.db");
  await exec(db, `CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,custom_title TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,last_activity_at INTEGER,deleted_at INTEGER);
    INSERT INTO sessions VALUES('session-1','C:/Projects/真实项目','原始标题','用户标题','completed',1000,3000,2000,NULL);
    INSERT INTO sessions VALUES('deleted','C:/Projects','','','error',1000,3000,NULL,4000);`);
  const projects = join(directory,"projects","encoded-project");mkdirSync(projects,{recursive:true});
  const transcript = join(projects,"session-1.jsonl");writeFileSync(transcript,"{}\n");
  const before = createHash("sha256").update(readFileSync(db)).digest("hex");
  const history = await readWorkbuddyHistory(directory);
  assert.equal(history.length,1);assert.equal(history[0].title,"用户标题");assert.equal(history[0].transcriptPath,transcript);
  assert.equal(history[0].cwd,"C:/Projects/真实项目");assert.equal(history[0].updatedAt,2000);
  assert.equal(createHash("sha256").update(readFileSync(db)).digest("hex"),before);
});

test("WorkBuddy external database schema errors are reported instead of an empty success", async t => {
  const directory=tempDir(t);await exec(join(directory,"workbuddy.db"),"CREATE TABLE unrelated(id TEXT);");
  await assert.rejects(readWorkbuddyHistory(directory),/数据库读取失败/);
});

test("WorkBuddy database flags do not invent live running; newer terminal status supplements transcripts", async t => {
  const directory=tempDir(t);await exec(join(directory,"workbuddy.db"),`CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,custom_title TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,last_activity_at INTEGER,deleted_at INTEGER);
    INSERT INTO sessions VALUES('session-1','','','','running',1,3,NULL,NULL);
    INSERT INTO sessions VALUES('error','','','','error',1,4,NULL,NULL);
    INSERT INTO sessions VALUES('history-only','','','','completed',1,5,NULL,NULL);`);
  const events=await pollWorkbuddyStatus([session(),session("error"),session("history-only")],directory);
  assert.deepEqual(events.map(event=>[event.sessionId,event.type,event.at]),[["history-only","stopped",5],["error","failed",4]]);
  assert.ok(events.every(event=>event.type!=="completed"));
  assert.equal((await pollWorkbuddyStatus([session("history-only","exact-transcript.jsonl")],directory))[0].type,"stopped");
});

test("WorkBuddy newer DB completed reconciles interrupted transcript while preserving pending; older DB cannot stop a new turn", async t => {
  const directory=tempDir(t);await exec(join(directory,"workbuddy.db"),`CREATE TABLE sessions(id TEXT,cwd TEXT,title TEXT,custom_title TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,last_activity_at INTEGER,deleted_at INTEGER);
    INSERT INTO sessions VALUES('session-1','','','','completed',1,50,45,NULL);`);
  let current=applyEvent(session(),{agent:"workbuddy",sessionId:"session-1",type:"progress",at:10,turnId:"turn"})!.next;
  current=applyEvent(current,{agent:"workbuddy",sessionId:"session-1",type:"needs_input",attention:"question",requestIds:["q"],at:20,turnId:"turn"})!.next;
  current.transcriptPath="exact-transcript.jsonl";
  const events=await pollWorkbuddyStatus([current],directory);
  assert.equal(events.length,1);assert.equal(events[0].type,"stopped");assert.equal(events[0].at,50);
  current=applyEvent(current,events[0])!.next;
  assert.equal(current.status,"needs_input");assert.equal(current.state!.phase,"ready");assert.equal(current.state!.pending[0].id,"q");
  const running=applyEvent(session(),{agent:"workbuddy",sessionId:"session-1",type:"progress",at:60,turnId:"new-turn"})!.next;
  running.transcriptPath="exact-transcript.jsonl";
  assert.deepEqual(await pollWorkbuddyStatus([running],directory),[]);
  assert.equal(running.status,"running");
});

test("WorkBuddy isolation never selects actual user data; navigation rejects invalid IDs", t => {
  const oldTest=process.env.AGENT_INBOX_TEST_HOME,oldRoot=process.env.AGENT_INBOX_WORKBUDDY_ROOT;
  t.after(()=>{if(oldTest===undefined)delete process.env.AGENT_INBOX_TEST_HOME;else process.env.AGENT_INBOX_TEST_HOME=oldTest;if(oldRoot===undefined)delete process.env.AGENT_INBOX_WORKBUDDY_ROOT;else process.env.AGENT_INBOX_WORKBUDDY_ROOT=oldRoot;});
  delete process.env.AGENT_INBOX_WORKBUDDY_ROOT;process.env.AGENT_INBOX_TEST_HOME="isolated";
  assert.equal(workbuddyRoot(),join("isolated","sources","workbuddy"));
  assert.equal(workbuddySessionUrl("session-1"),"workbuddy://chat/session-1");
  assert.equal(workbuddySessionUrl("../bad?prompt=send"),undefined);
  assert.deepEqual(workbuddyAdapter.planInstall({node:"node",cli:"cli"}).changes,[]);
});

test("WorkBuddy parser ignores wrong session and missing time, async acknowledgement cannot answer questions", () => {
  assert.deepEqual(parseWorkbuddyTranscript({type:"message",role:"user"},session(),{}),[]);
  assert.deepEqual(parseWorkbuddyTranscript(row(10,"message",{sessionId:"other",role:"user"}),session(),{}),[]);
  assert.deepEqual(parseWorkbuddyTranscript(row(20,"function_call_result",{name:"AskUserQuestion",callId:"q",status:"completed",output:{accepted:true}}),session(),{}),[]);
});

test("WorkBuddy actual JSONL lifecycle restores historical questions silently and resolves only matching result", async t => {
  const directory=tempDir(t),path=join(directory,"session-1.jsonl"),store=new Store(join(directory,"inbox.sqlite"));
  const write=(records:object[])=>records.map(record=>JSON.stringify(record)).join("\n")+"\n";
  writeFileSync(path,write([
    row(100,"message",{id:"user",role:"user",content:[{type:"text",text:"继续"}]}),
    row(200,"function_call",{id:"ask",name:"AskUserQuestion",callId:"historical",arguments:'{"questions":[{"question":"选择方案？"}]}'}),
    row(300,"message",{id:"assistant",role:"assistant",status:"completed",content:[{type:"text",text:"等待选择。"}]}),
  ]));
  await store.subscribeEntry(session("session-1",path));
  const config={...DEFAULT_CONFIG,notificationChannels:["windows"]};
  const collector=new TranscriptCollector(new EventEngine(store,()=>config),()=>[workbuddyAdapter],error=>assert.fail(error));
  const delivered:string[]=[];const drain=()=>deliverNotifications(store,config,[{id:"windows",async send(message){delivered.push(message.id);}}]);
  await collector.poll();await drain();
  assert.equal((await store.get("workbuddy","session-1"))!.status,"needs_input");assert.equal(delivered.length,0);
  appendFileSync(path,write([row(400,"function_call_result",{id:"unrelated",name:"Read",callId:"other",status:"completed",output:{type:"text",text:"tool result"}})]));
  await collector.poll();assert.equal((await store.get("workbuddy","session-1"))!.state!.pending[0].id,"historical");
  appendFileSync(path,write([
    row(500,"function_call_result",{id:"answer",name:"AskUserQuestion",callId:"historical",status:"completed",output:{type:"text",text:"The user chose option A"}}),
    row(600,"message",{id:"new-user",role:"user",content:"下一步"}),
    row(700,"function_call",{id:"new-ask",name:"AskUserQuestion",callId:"live",arguments:'{"questions":[{"question":"继续？"}]}'}),
  ]));
  await collector.poll();await drain();await collector.poll();await drain();
  assert.deepEqual((await store.get("workbuddy","session-1"))!.state!.pending.map(request=>request.id),["live"]);
  assert.equal(delivered.length,1);
  appendFileSync(path,write([
    row(800,"function_call_result",{id:"live-answer",name:"AskUserQuestion",callId:"live",status:"completed",output:{type:"text",text:"The user chose yes"}}),
    row(900,"message",{id:"last-assistant",role:"assistant",status:"completed",content:"本轮处理结束。"}),
  ]));
  await collector.poll();assert.equal((await store.get("workbuddy","session-1"))!.status,"ready");
});
