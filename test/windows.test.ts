import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { writeWindowsLauncher } from "../desktop/launcher";
import { projectName, tildify, HOME } from "../src/core/paths";
import { codexAdapter, findNotify, originalNotify } from "../src/core/adapters/codex";
import { claudeAdapter } from "../src/core/adapters/claude";
import { hasOurHooks, parseJsonFile } from "../src/core/adapters/json";
import { tempDir } from "./helpers";

test("Windows project paths handle backslashes, mixed separators and Chinese",()=>{
  assert.equal(projectName("C:\\项目\\Agent Inbox\\"),"Agent Inbox");
  assert.equal(projectName("C:/项目/Agent Inbox/"),"Agent Inbox");
  assert.equal(tildify(HOME+"\\项目"),"~\\项目");
});

test("Windows PowerShell launcher forwards actual UTF-8 hook input through the bundled Electron runtime",t=>{
  const root=join(tempDir(t),"中文 路径 ' 测试");
  const bin=join(root,"bin");mkdirSync(bin,{recursive:true});
  const launcher=join(bin,"agent-inbox.mjs-hook.ps1"),cli=join(bin,"agent-inbox.mjs");
  writeWindowsLauncher({path:launcher,exe:resolve("node_modules/electron/dist/electron.exe"),cli,source:resolve("build/agent-inbox.mjs"),root,sqlite:resolve("resources/sqlite3.exe")});
  const env={...process.env,ELECTRON_RUN_AS_NODE:"1",AGENT_INBOX_HOME:root,AGENT_INBOX_SQLITE:resolve("resources/sqlite3.exe")};
  execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",launcher,"hook","claude"],{windowsHide:true,input:JSON.stringify({hook_event_name:"UserPromptSubmit",session_id:"windows-hook",prompt:"中文标题，包含引号 \" 与换行\n测试",cwd:"C:\\项目\\测试"}),env,encoding:"utf8",timeout:12000});
  const rows=JSON.parse(execFileSync(process.execPath,[cli,"list","--json"],{env,encoding:"utf8"}));
  assert.equal(rows.length,1);
  assert.match(rows[0].title,/中文标题/);
  assert.equal(rows[0].cwd,"C:\\项目\\测试");
  assert.ok(!existsSync(join(root,"log.txt")),"hook must not silently fail or log errors");
});

test("Windows Hook install plans keep other commands, use the launcher and preserve prior notify",()=>{
  const ctx={node:"C:\\Apps\\Agent Inbox.exe",cli:"C:\\数据\\agent-inbox.mjs",launcher:"C:\\数据 空格\\agent-inbox.mjs-hook.ps1"};
  const c=claudeAdapter.planInstall(ctx);
  for(const change of c.changes){const hooks=parseJsonFile(change.after,change.path);assert.ok(hasOurHooks(hooks));const cmd=hooks.hooks!.SessionStart.at(-1)!.hooks[0].command;assert.match(cmd,/powershell.exe/);assert.ok(cmd.includes('数据 空格/agent-inbox.mjs-hook.ps1'));}
  const plan=codexAdapter.planInstall(ctx);
  const toml=plan.changes[0].after;
  const notify=findNotify(toml)!.items;
  assert.equal(notify[0],"powershell.exe");assert.ok(notify.includes(ctx.launcher));
  // Reconnecting an already-installed wrapper must preserve the original notifier too.
  assert.deepEqual(originalNotify(notify),originalNotify(findNotify(plan.changes[0].before)?.items||[]));
  assert.ok(hasOurHooks(parseJsonFile(plan.changes[1].after,"test")));
});

test("Windows launcher preserves Codex notify JSON arguments with quotes and Chinese",async t=>{
  const root=tempDir(t),bin=join(root,"bin");mkdirSync(bin,{recursive:true});
  const launcher=join(bin,"agent-inbox.mjs-hook.ps1"),cli=join(bin,"agent-inbox.mjs");
  writeWindowsLauncher({path:launcher,exe:resolve("node_modules/electron/dist/electron.exe"),cli,source:resolve("build/agent-inbox.mjs"),root,sqlite:resolve("resources/sqlite3.exe")});
  const payload={type:"agent-turn-complete","thread-id":"windows-notify",cwd:"C:\\项目 空格","input-messages":["中文通知测试"],"last-assistant-message":"已完成这一轮。包含引号 \" 与换行\n正文。"};
  const recorder=join(root,"recorder.mjs"),captured=join(root,"captured.json");
  writeFileSync(recorder,"import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))); ");
  const literal='中文 参数 "literal"';
  execFileSync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",launcher,"hook","codex-notify","--then",process.execPath,recorder,captured,literal,JSON.stringify(payload)],{windowsHide:true,encoding:"utf8",timeout:12000});
  const env={...process.env,AGENT_INBOX_HOME:root,AGENT_INBOX_SQLITE:resolve("resources/sqlite3.exe")};
  const rows=JSON.parse(execFileSync(process.execPath,[cli,"list","--json"],{env,encoding:"utf8"}));
  assert.equal(rows.length,1);assert.equal(rows[0].status,"ready");assert.equal(rows[0].title,"中文通知测试");assert.equal(rows[0].summary,payload["last-assistant-message"].replace(/\s+/g," "));
  for(let i=0;i<40&&!existsSync(captured);i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.deepEqual(JSON.parse(readFileSync(captured,"utf8")),[literal,JSON.stringify(payload)]);
});
