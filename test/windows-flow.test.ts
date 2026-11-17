import { strict as assert } from "node:assert";
import { test } from "node:test";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tempDir } from "./helpers";

test("desktop backend refreshes renamed Hook and history titles without subscribing or inventing activity", async t => {
  const root = tempDir(t), probe = join(root,"rename-flow.mjs");
  await build({stdin:{resolveDir:process.cwd(),contents:`
    import {mkdirSync} from 'node:fs';
    import {join} from 'node:path';
    import {strict as assert} from 'node:assert';
    import {InboxBackend} from './desktop/backend';
    import {exec} from './src/core/sqlite';
    const catalog=join(process.env.CODEX_HOME,'state_5.sqlite');
    mkdirSync(process.env.CODEX_HOME,{recursive:true});
    await exec(catalog,"CREATE TABLE threads(id TEXT,name TEXT,title TEXT); INSERT INTO threads VALUES ('unsubscribed','Client name','First prompt'),('history','History name','Other prompt');");
    const received=[];
    const backend=new InboxBackend({id:'windows',async send(value){received.push(value);}},()=>{},{node:process.execPath,cli:'unused'});
    await backend.store.put({agent:'codex',sessionId:'unsubscribed',host:'app',title:'First prompt',cwd:'',summary:'',transcriptPath:'',locator:{},subscribed:false,handledAt:50,status:'running',attention:null,startedAt:10,updatedAt:20});
    try {
      await backend.start();
      assert.equal(backend.lastError,'');
      assert.equal(backend.snapshot().sessions.find(s=>s.sessionId==='unsubscribed').title,'Client name');
      assert.equal(backend.snapshot().sessions.find(s=>s.sessionId==='history').title,'History name');
      await exec(catalog,"UPDATE threads SET name=CASE id WHEN 'unsubscribed' THEN 'Renamed later' ELSE 'History renamed later' END;");
      // No history rescan or execution event: the normal metadata poll must update both names.
      await backend.refresh();
      assert.equal(backend.snapshot().sessions.find(s=>s.sessionId==='unsubscribed').title,'Renamed later');
      assert.equal(backend.snapshot().sessions.find(s=>s.sessionId==='history').title,'History renamed later');
      const saved=await backend.session('codex','unsubscribed');
      assert.equal(saved.title,'Renamed later');
      assert.equal(saved.subscribed,false);assert.equal(saved.status,'running');
      assert.equal(saved.handledAt,50);assert.equal(saved.updatedAt,20);
      assert.equal((await backend.store.all()).length,1,'history names do not import rows or subscribe them');
      assert.equal(received.length,0);assert.deepEqual(await backend.store.claimNotifications(),[]);
      console.log(JSON.stringify({unsubscribedRenamed:true,historyRenamed:true,metadataOnly:true,notifications:0}));
    } finally {backend.stop();}
  `},bundle:true,platform:"node",format:"esm",outfile:probe});
  const env={...process.env,AGENT_INBOX_TEST_HOME:root,AGENT_INBOX_HOME:join(root,"data"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),AGENT_INBOX_CLAUDE_DESKTOP_ROOT:join(root,"desktop"),AGENT_INBOX_DSH_ROOT:join(root,"dsh"),AGENT_INBOX_WORKBUDDY_ROOT:join(root,"workbuddy"),AGENT_INBOX_CURSOR_ROOT:join(root,"cursor"),AGENT_INBOX_CURSOR_USER_DATA:join(root,"cursor-user")};
  const result=JSON.parse(execFileSync(process.execPath,[probe],{env,windowsHide:true,encoding:"utf8",timeout:20000}));
  assert.deepEqual(result,{unsubscribedRenamed:true,historyRenamed:true,metadataOnly:true,notifications:0});
});

test("Windows desktop backend connects and removes hooks, then tracks a real hook question and answer end to end",async t=>{
  const root=tempDir(t),probe=join(root,"flow.mjs");
  await build({stdin:{resolveDir:process.cwd(),contents:`
    import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
    import {join} from 'node:path';
    import {execFileSync} from 'node:child_process';
    import {strict as assert} from 'node:assert';
    import {InboxBackend} from './desktop/backend';
    import {writeWindowsLauncher} from './desktop/launcher';
    import {findNotify} from './src/core/adapters/codex';
    const root=process.env.AGENT_INBOX_HOME,claude=process.env.CLAUDE_CONFIG_DIR,codex=process.env.CODEX_HOME;
    mkdirSync(claude,{recursive:true});mkdirSync(codex,{recursive:true});
    const original={model:'preserve-user-setting',hooks:{Stop:[{hooks:[{type:'command',command:'echo keep-user-hook'}]}]}};
    writeFileSync(join(claude,'settings.json'),JSON.stringify(original));
    writeFileSync(join(codex,'config.toml'),'model = "preserve-user-setting"\\nnotify = ["existing-notifier", "space arg"]\\n');
    const launcher=join(root,'bin','agent-inbox.mjs-hook.ps1'),cli=join(root,'bin','agent-inbox.mjs');
    writeWindowsLauncher({path:launcher,exe:process.env.TEST_ELECTRON,cli,source:process.env.TEST_CLI,root,sqlite:process.env.AGENT_INBOX_SQLITE});
    const received=[];
    const backend=new InboxBackend({id:'windows',async send(value){received.push(value);}},()=>{},{node:process.env.TEST_ELECTRON,cli,launcher});
    await backend.start();
    await backend.applyConnection('claude','install');
    assert.equal(JSON.parse(readFileSync(join(claude,'settings.json'),'utf8')).model,original.model);
    await backend.applyConnection('claude','remove');
    assert.deepEqual(JSON.parse(readFileSync(join(claude,'settings.json'),'utf8')),original);
    await backend.applyConnection('codex','install');
    assert.equal(findNotify(readFileSync(join(codex,'config.toml'),'utf8')).items[0],'powershell.exe');
    await backend.applyConnection('codex','remove');
    assert.deepEqual(findNotify(readFileSync(join(codex,'config.toml'),'utf8')).items,['existing-notifier','space arg']);
    const hook=payload=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',launcher,'hook','claude'],{input:JSON.stringify({session_id:'flow-session',cwd:root,...payload}),windowsHide:true});
    hook({hook_event_name:'UserPromptSubmit',prompt:'验证中文 Hook 与桌面采集通路'});
    await backend.refresh(true);
    await backend.action('subscribe','claude','flow-session');
    const question={tool_name:'AskUserQuestion',tool_use_id:'q-1',tool_input:{questions:[{question:'要继续吗？',options:[]}]}};
    hook({hook_event_name:'PreToolUse',...question});
    await backend.refresh();
    assert.equal((await backend.session('claude','flow-session')).status,'needs_input');
    assert.equal(received.length,1);
    hook({hook_event_name:'Stop',last_assistant_message:'已停止这一轮。'});
    await backend.refresh();
    assert.equal((await backend.session('claude','flow-session')).status,'needs_input');
    hook({hook_event_name:'PostToolUse',...question,tool_response:{answers:{'要继续吗？':'继续'}}});
    await backend.refresh();
    assert.notEqual((await backend.session('claude','flow-session')).status,'needs_input');
    assert.equal((await backend.session('claude','flow-session')).state.pending.length,0);
    assert.equal(received.length,1);
    assert.equal(backend.lastError,'');
    backend.stop();
    console.log(JSON.stringify({connectionPreserved:true,requestTracked:true,answerResolved:true,notifications:received.length}));
  `},bundle:true,platform:"node",format:"esm",outfile:probe});
  const env={...process.env,AGENT_INBOX_TEST_HOME:root,AGENT_INBOX_HOME:join(root,"data"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),AGENT_INBOX_CLAUDE_DESKTOP_ROOT:join(root,"desktop"),TEST_ELECTRON:resolve("node_modules/electron/dist/electron.exe"),TEST_CLI:resolve("build/agent-inbox.mjs")};
  const result=JSON.parse(execFileSync(process.execPath,[probe],{env,windowsHide:true,encoding:"utf8",timeout:25000}));
  assert.deepEqual(result,{connectionPreserved:true,requestTracked:true,answerResolved:true,notifications:1});
});
