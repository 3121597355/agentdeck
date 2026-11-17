import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, Notification, ipcMain, shell, clipboard, globalShortcut, dialog } from "electron";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import type { InboxBackend } from "./backend";
import type { Session } from "../src/core/types";
import { writeWindowsLauncher } from "./launcher";

app.setName("AgentDeck");
const appId = process.env.AGENT_INBOX_TEST_HOME ? "io.agentdeck.desktop.verification" : "io.agentdeck.desktop";
app.setAppUserModelId(appId);
const isolation = process.env.AGENT_INBOX_TEST_HOME;
const root = isolation || join(app.getPath("appData"), "AgentInboxWindows");
const assetDir = app.isPackaged ? join(process.resourcesPath, "app-assets") : join(__dirname, "..", "resources");
const bundledCli = app.isPackaged ? join(process.resourcesPath, "agent-inbox.mjs") : join(__dirname, "agent-inbox.mjs");
const sqlite = join(assetDir, "sqlite3.exe");
process.env.AGENT_INBOX_HOME = root;
process.env.AGENT_INBOX_SQLITE = sqlite;
if (isolation) app.setPath("userData", join(isolation, "electron-profile"));
else app.setPath("userData", join(root, "electron-profile"));

let win: BrowserWindow;
let tray: Tray;
let backend: InboxBackend;
let quitting = false;
let notice = "";
let startup = false;
let notificationsShown = 0;
let testShortcut = "";
const notifications = new Map<string, Notification>();
const icon = nativeImage.createFromPath(join(assetDir, "icon.png"));
const launcher = join(root, "bin", "agent-inbox.mjs-hook.ps1");
const cli = join(root, "bin", "agent-inbox.mjs");
const psQuote = (text: string) => "'" + text.replace(/'/g, "''") + "'";

function prepareLauncher() {
  writeWindowsLauncher({path:launcher,exe:process.execPath,source:bundledCli,cli,root,sqlite});
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}

function snapshot() {
  return {...backend.snapshot(), settings:{...backend.snapshot().settings,startAtLogin:startup},
    platform:"Windows", version:app.getVersion(), notificationSupported:Notification.isSupported(),
    shortcut:"Ctrl + Alt + I", notice, testData:!!isolation};
}

function setupWindowsShortcut() {
  const programs=join(app.getPath("appData"),"Microsoft","Windows","Start Menu","Programs");
  mkdirSync(programs,{recursive:true});
  const path=join(programs,isolation?"AgentDeck - Verification.lnk":"AgentDeck.lnk");
  const legacy=join(programs,"Agent Inbox Windows.lnk");
  if(!isolation&&existsSync(legacy))unlinkSync(legacy);
  const ok=shell.writeShortcutLink(path,"create",{target:process.execPath,cwd:app.isPackaged?dirname(process.execPath):app.getAppPath(),
    args:app.isPackaged?"":`"${app.getAppPath()}"`,description:"多 Agent 会话、待处理提醒与本地使用统计工作台",icon:join(assetDir,"icon.ico"),iconIndex:0,appUserModelId:appId});
  if(isolation&&ok)testShortcut=path;
  if(!ok)notice="开始菜单快捷方式未创建，系统通知可能无法显示。";
}

let menuSignature = "";
function publish() {
  if (!backend) return;
  const value = snapshot();
  if (win && !win.isDestroyed()) win.webContents.send("inbox:update", value);
  if (!tray) return;
  const active = value.sessions.filter(s => s.subscribed && s.handledAt === null);
  const waiting = active.filter(s => s.status === "needs_input");
  tray.setToolTip(`AgentDeck · ${waiting.length} 个待处理 · ${active.length} 个订阅`);
  const signature = `${waiting.length}:${active.length}:${active.slice(0,8).map(s=>`${s.agent}:${s.sessionId}:${s.title}:${s.status}`).join("|")}:${startup}`;
  if (signature !== menuSignature) {
    menuSignature = signature;
    tray.setContextMenu(Menu.buildFromTemplate([
      {label:`打开收件箱${waiting.length ? `（${waiting.length} 个待处理）` : ""}`,click:showWindow},
      {type:"separator"},
      ...active.slice(0,8).map(s=>({label:`${s.status === "needs_input" ? "● " : ""}${s.title.slice(0,32) || "未命名会话"}`,click:()=>{showWindow(); win.webContents.send("inbox:unused",s.sessionId); void jump(s).catch(showError);}})),
      {type:"separator"},
      {label:"开机启动",type:"checkbox",checked:startup,click:item=>{setStartup(item.checked); publish();}},
      {label:"退出 AgentDeck",click:()=>app.quit()},
    ]));
  }
}

function showError(error: unknown) {notice = error instanceof Error ? error.message : String(error); backend?.log(notice); publish();}

function showNotification(id: string, title: string, body: string, onClick: () => void): Promise<void> {
  if (!Notification.isSupported()) return Promise.reject(new Error("此系统当前无法显示通知"));
  const notification = new Notification({title,body:body.slice(0,220),icon,silent:false,timeoutType:"default"});
  notifications.set(id,notification);
  notification.on("click",onClick);
  notification.on("close",()=>notifications.delete(id));
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error("Windows 没有确认通知显示，稍后重试。")),8000);
    notification.once("show",()=>{clearTimeout(timeout);notificationsShown++;resolve();});
    notification.once("failed",(_event,error)=>{clearTimeout(timeout);notice=`通知未送达：${error}`; backend?.log(notice); publish();reject(new Error(notice));});
    notification.show();
  });
}

function run(file: string, args: string[], timeout=5000): Promise<{ok:boolean; stdout:string}> {
  return new Promise(resolve=>execFile(file,args,{windowsHide:true,encoding:"utf8",timeout},(error,stdout)=>resolve({ok:!error,stdout:String(stdout ?? "")})));
}

async function protocolAvailable(name: string) {
  return (await run("reg.exe",["query",`HKCR\\${name}`,"/v","URL Protocol"])).ok;
}

async function jump(session: Session) {
  if (!["claude", "codex"].includes(session.agent)) {
    const {getAdapter} = await import("../src/core/adapters");
    const {readConfig} = await import("../src/core/config");
    const adapter = getAdapter(session.agent);
    if (!adapter) throw new Error("此客户端尚未接入。");
    const result = await adapter.jump(session, readConfig());
    if (!result.ok) {
      if (adapter.custom) {
        clipboard.writeText(session.sessionId);
        return {method:"copied",message:`已复制会话 ID，请在 ${adapter.name} 中查找。`};
      }
      throw new Error("此客户端当前没有可用的会话入口。可复制会话 ID，在原客户端中查找。");
    }
    return {method: result.method, message: result.message || (result.method === "url" ? `已向 ${adapter.name} 发送打开此会话的请求。` : result.method === "copied" ? "已复制会话定位信息，请在原客户端中查找。" : `已打开 ${adapter.name}；请在客户端中选择对应会话。`)};
  }
  if (session.agent === "codex" && /^[a-f0-9-]{36}$/i.test(session.sessionId) && await protocolAvailable("codex")) {
    const host = session.locator.hostId ? `?hostId=${encodeURIComponent(session.locator.hostId)}` : "";
    await shell.openExternal(`codex://threads/${session.sessionId}${host}`);
    return {method:"url",message:"已向 Codex 发送打开此会话的请求。"};
  }
  if (session.agent === "claude" && session.locator.claudeDesktopId && /^local_[A-Za-z0-9-]+$/.test(session.locator.claudeDesktopId) && await protocolAvailable("claude")) {
    await shell.openExternal(`claude://code/continue?session=${encodeURIComponent(session.locator.claudeDesktopId)}`);
    return {method:"url",message:"已向 Claude 发送打开此会话的请求。"};
  }
  clipboard.writeText(resumeCommand(session));
  return {method:"copied",message:"当前没有可用的桌面会话入口。已复制恢复命令，可在终端粘贴执行；也可选择“在终端恢复”。"};
}

function resumeCommand(s: Session) {
  if (!["claude","codex"].includes(s.agent) || !/^[A-Za-z0-9_-]+$/.test(s.sessionId)) throw new Error("此会话没有有效的 CLI 恢复 ID。");
  return s.agent === "claude" ? `claude --resume ${s.sessionId}` : `codex resume ${s.sessionId}`;
}

async function resume(session: Session) {
  const executable = session.agent === "claude" ? "claude" : "codex";
  const command = resumeCommand(session);
  const check = await run("where.exe",[executable]);
  if (!check.ok) {clipboard.writeText(command); return {message:`未找到 ${executable} CLI，已复制恢复命令。请安装该客户端后在终端执行。`};}
  // Keep the command in a script instead of interpolating it into cmd or wt.
  const resumeDir = join(root,"resume"); mkdirSync(resumeDir,{recursive:true});
  const script = join(resumeDir,`${session.agent}-${session.sessionId}.ps1`);
  const location = session.cwd && existsSync(session.cwd) ? `Set-Location -LiteralPath ${psQuote(session.cwd)}\n` : "";
  writeFileSync(script,"\uFEFF"+location+command+"\n","utf8");
  const args = ["-NoLogo","-NoExit","-ExecutionPolicy","Bypass","-File",script];
  const terminal = await run("where.exe",["wt.exe"]);
  const child = terminal.ok
    ? spawn("wt.exe",["-w","0","new-tab","--title",`AgentDeck · ${session.agent}`,"powershell.exe",...args],{detached:true,stdio:"ignore",windowsHide:true})
    : spawn("powershell.exe",args,{detached:true,stdio:"ignore",windowsHide:false});
  child.on("error",showError); child.unref();
  return {message:"已在终端请求恢复此会话。运行中的原终端标签不会被自动定位。"};
}

function setStartup(value: boolean) {
  if (!app.isPackaged && value) throw new Error("开机启动请在打包后的应用中设置。");
  app.setLoginItemSettings({openAtLogin:value,path:process.execPath,args:["--hidden"]});
  startup=value;
  writeFileSync(join(root,"desktop-settings.json"),JSON.stringify({startAtLogin:value},null,2));
}

function trustedIpc(event: Electron.IpcMainInvokeEvent) {
  if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("不受支持的页面请求");
}

function registerIpc() {
  const handle=(name:string,fn:(...args:any[])=>unknown)=>ipcMain.handle(name,async(event,...args)=>{trustedIpc(event); return fn(...args);});
  handle("inbox:snapshot",()=>snapshot());
  handle("inbox:search",(query:string)=>backend.search(String(query)));
  handle("inbox:usage",(days:number)=>{
    const value=Number(days);
    if(![7,14,30].includes(value))throw new Error("统计周期只支持 7、14 或 30 天");
    return backend.usage(value);
  });
  handle("inbox:usage-source",async(request:Record<string,unknown>)=>{
    const action=String(request.action ?? "");
    if(action === "select-path"){
      const kind=request.kind === "directory" ? "directory" : "file";
      const defaultPath=typeof request.path === "string" && request.path && existsSync(request.path) ? request.path : undefined;
      const result=await dialog.showOpenDialog(win,{
        title:kind === "directory" ? "选择 Agent 记录目录" : "选择 Agent 记录文件",
        defaultPath,
        properties:kind === "directory" ? ["openDirectory"] : ["openFile"],
        filters:kind === "file" ? [{name:"会话记录",extensions:["jsonl","log","json"]}] : undefined,
      });
      return {path:result.canceled ? "" : result.filePaths[0] ?? ""};
    }
    if(action === "save"){
      if(!request.agent || typeof request.agent !== "object" || Array.isArray(request.agent))throw new Error("自定义 Agent 配置无效。");
      return await backend.saveUsageAgent(request.agent as Record<string,unknown>);
    }
    if(action === "save-session"){
      if(!request.agent || typeof request.agent !== "object" || Array.isArray(request.agent))throw new Error("自定义 Agent 配置无效。");
      return await backend.saveCustomSessionAgent(request.agent as Record<string,unknown>);
    }
    if(action === "toggle"){
      return await backend.toggleUsageAgent(String(request.id ?? ""),Boolean(request.enabled));
    }
    if(action === "delete"){
      return await backend.deleteUsageAgent(String(request.id ?? ""));
    }
    throw new Error("不支持的自定义 Agent 操作。");
  });
  handle("inbox:action",async(action:string,agent:string,id:string)=>{
    if (["jump","resume","copy","project"].includes(action)) {
      const s=await backend.session(agent,id); if (!s) throw new Error("会话不存在");
      if (action === "jump") return jump(s);
      if (action === "resume") return resume(s);
      if (action === "copy") {clipboard.writeText(s.sessionId);return {message:"已复制会话 ID。"};}
      if (!s.cwd || !existsSync(s.cwd)) throw new Error("项目目录当前不可访问。");
      const error=await shell.openPath(s.cwd);if(error)throw new Error(error);return {message:"已打开项目目录。"};
    }
    await backend.action(action,agent,id);return snapshot();
  });
  handle("inbox:settings",async(patch:Record<string,unknown>)=>{
    if(typeof patch.startAtLogin === "boolean")setStartup(patch.startAtLogin);
    await backend.settings(patch);
    if (patch.theme === "light" || patch.theme === "dark" || patch.theme === "system") nativeTheme.themeSource = patch.theme;
    return snapshot();
  });
  handle("inbox:connection",async(agent:string,operation:string)=>{
    if (operation === "preview" || operation === "preview-remove") {
      const plan=backend.connectionPlan(agent,operation === "preview-remove" ? "remove" : "install");
      return {files:plan.changes.filter(c=>c.before !== c.after).map(c=>({path:c.path,preview:c.preview})),notes:plan.notes,agent,operation};
    }
    if (!["install","remove"].includes(operation))throw new Error("不支持的接入操作");
    const written=await backend.applyConnection(agent,operation);
    const clientName=backend.snapshot().connections.find(connection=>connection.agent===agent)?.name||agent;
    return {snapshot:snapshot(),message:operation === "remove" ? "已移除此应用的 Hook，保留其他配置。" : `已接入 ${clientName}。${agent === "codex" ? "请在支持 /hooks 的客户端执行 /hooks 确认；其他版本以本地记录采集为准。" : "请启动新会话或重新加载客户端配置。"}`,written};
  });
  handle("inbox:system",async(action:string)=>{
    if(action === "minimize")win.minimize();
    else if(action === "hide")win.hide();
    else if(action === "quit")app.quit();
    else if(action === "data")await shell.openPath(root);
    else if(action === "refresh") {await backend.refresh(true);return snapshot();}
    else if(action === "notification-test") {await showNotification("test","AgentDeck · 测试通知","通知已发出。点击可返回收件箱。",showWindow);return {message:"Windows 已确认测试通知显示。点击通知可返回收件箱。"};}
    else if(action === "clear-notice") {notice="";publish();}
    else throw new Error("不支持的系统操作");
  });
}

async function smokeTest() {
  const result:any={snapshot:{},interactions:{}};
  try {
    if (process.env.AGENT_INBOX_VERIFY_THEME_RESTART === "1") {
      result.themeRestart=await win.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<50;i++){
          const saved=(await window.inbox.snapshot()).settings.theme;
          if(saved==='dark'&&document.documentElement.dataset.theme==='dark')return {saved,resolved:'dark',button:document.querySelector('#theme-toggle').getAttribute('aria-label')};
          await new Promise(r=>setTimeout(r,50));
        }
        throw new Error('Saved dark theme did not survive a fresh process');
      })()`);
      writeFileSync(process.env.AGENT_INBOX_SMOKE_RESULT!,JSON.stringify(result,null,2));
      app.quit();return;
    }
    result.snapshot=await win.webContents.executeJavaScript("window.inbox.snapshot().then(v=>({total:v.sessions.length,waiting:v.sessions.filter(s=>s.subscribed&&s.status==='needs_input').length,connections:v.connections,error:v.error}))");
    result.interactions=await win.webContents.executeJavaScript(`(async()=>{
      const wait=async predicate=>{for(let i=0;i<50;i++){const s=await window.inbox.snapshot();if(predicate(s))return s;await new Promise(r=>setTimeout(r,50));}throw new Error('UI action did not settle');};
      const click=selector=>{const element=document.querySelector(selector);if(!element)throw new Error('Missing UI control: '+selector);element.click();};
      const buttons=[...document.querySelectorAll('[data-view]')];
      buttons.find(b=>b.dataset.view==='all').click();
      await new Promise(r=>setTimeout(r,250));
      const rows=document.querySelectorAll('.session-row').length;
      document.querySelector('.session-row')?.click();
      const detail=!!document.querySelector('.detail-panel h2');
      let tested={};
      if(${!!isolation}){
        const target=(await window.inbox.snapshot()).sessions[0];
        const row=()=>[...document.querySelectorAll('.session-row')].find(r=>r.dataset.key===target.agent+':'+target.sessionId);
        const find=s=>s.sessions.find(v=>v.agent===target.agent&&v.sessionId===target.sessionId);
        row().querySelector('[data-action="unsubscribe"]').click();await wait(s=>!find(s).subscribed&&row()?.querySelector('[data-action="subscribe"]'));
        row().querySelector('[data-action="subscribe"]').click();await wait(s=>find(s).subscribed&&row()?.querySelector('[data-action="unsubscribe"]'));
        row().click();click('[data-detail="handled"]');await wait(s=>find(s).handledAt!==null&&document.querySelector('[data-detail="restore"]'));
        document.querySelector('[data-view="handled"]').click();const handled=document.querySelectorAll('.session-row').length===1;
        click('[data-detail="restore"]');await wait(s=>find(s).handledAt===null&&document.querySelector('[data-detail="handled"]'));
        document.querySelector('[data-view="all"]').click();
        const input=document.querySelector('#search');input.value='接口';input.dispatchEvent(new Event('input',{bubbles:true}));const search=document.querySelectorAll('.session-row').length===1;
        input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));
        const agent=document.querySelector('#agent-filter');agent.value='codex';agent.dispatchEvent(new Event('change'));const filter=document.querySelectorAll('.session-row').length===2;
        agent.value='';agent.dispatchEvent(new Event('change'));
        tested={subscription:true,handled,restored:true,search,filter};
      }
      document.querySelector('[data-view="settings"]').click();
      const settings={
        base:!!document.querySelector('#notification-setting'),
        addCustom:!!document.querySelector('#add-custom-session'),
        seededCustomActions:!!document.querySelector('[data-custom-edit="custom-smoke-agent"]')&&!!document.querySelector('[data-custom-toggle="custom-smoke-agent"]')&&!!document.querySelector('[data-custom-delete="custom-smoke-agent"]')
      };
      if(${!!isolation}){
        document.querySelector('[data-view="all"]').click();
        const customAgent=document.querySelector('#agent-filter');
        const customOption=[...customAgent.options].find(option=>option.value==='custom-smoke-agent');
        customAgent.value='custom-smoke-agent';
        customAgent.dispatchEvent(new Event('change'));
        const seededSessions=document.querySelectorAll('.session-row').length;
        customAgent.value='';
        customAgent.dispatchEvent(new Event('change'));
        if(!customOption||customOption.textContent!=='Smoke Agent'||seededSessions!==2)throw new Error('Seeded custom sessions did not reach All Sessions or the Agent filter');
        settings.seededDiscovered={option:true,sessions:seededSessions};

        document.querySelector('[data-view="settings"]').click();
        click('#add-custom-session');
        const mapping=document.querySelector('#usage-agent-session-fields');
        settings.sessionDialog=!!document.querySelector('#usage-agent-dialog')?.open&&!!mapping?.open;
        document.querySelector('#usage-agent-name').value='UI Smoke Agent';
        document.querySelector('#usage-agent-path').value=${JSON.stringify(join(isolation ?? "", "custom-agent.jsonl"))};
        document.querySelector('#usage-agent-pattern').value='*.jsonl';
        document.querySelector('#usage-agent-field').value='event.created_at';
        document.querySelector('#usage-agent-unit').value='iso';
        document.querySelector('#usage-agent-session-id-field').value='meta.session';
        document.querySelector('#usage-agent-event-field').value='event.type';
        document.querySelector('#usage-agent-title-field').value='meta.name';
        document.querySelector('#usage-agent-cwd-field').value='meta.cwd';
        document.querySelector('#usage-agent-summary-field').value='payload.summary';
        document.querySelector('#usage-agent-request-field').value='event.request';
        document.querySelector('#usage-agent-form').requestSubmit(document.querySelector('#usage-agent-save'));
        let saved=await wait(s=>{
          const config=s.settings.customUsageAgents?.find(agent=>agent.name==='UI Smoke Agent');
          return !!config&&s.sessions.some(session=>session.agent===config.id);
        });
        const uiAgent=saved.settings.customUsageAgents.find(agent=>agent.name==='UI Smoke Agent');
        settings.saved={id:uiAgent.id,sessionScans:saved.sessions.filter(session=>session.agent===uiAgent.id).length,connection:saved.connections.some(connection=>connection.agent===uiAgent.id&&connection.custom)};
        if(settings.saved.sessionScans!==2||!settings.saved.connection)throw new Error('Saved custom Agent did not discover both sessions');

        document.querySelector('[data-view="all"]').click();
        await new Promise(r=>setTimeout(r,250));
        const uiFilter=document.querySelector('#agent-filter');
        uiFilter.value=uiAgent.id;
        uiFilter.dispatchEvent(new Event('change'));
        const customRows=()=>[...document.querySelectorAll('.session-row')];
        for(let i=0;i<50&&customRows().length!==2;i++)await new Promise(r=>setTimeout(r,50));
        settings.filteredSessions=customRows().length;
        const firstCustomRow=customRows()[0];
        if(!firstCustomRow||settings.filteredSessions!==2)throw new Error('Custom Agent was not filterable in All Sessions: '+JSON.stringify({rows:settings.filteredSessions,value:uiFilter.value,options:[...uiFilter.options].map(option=>option.value)}));
        const subscribedSessionId=firstCustomRow.dataset.key.slice(uiAgent.id.length+1);
        firstCustomRow.querySelector('[data-action="subscribe"]').click();
        await wait(s=>s.sessions.find(session=>session.agent===uiAgent.id&&session.sessionId===subscribedSessionId)?.subscribed&&customRows().find(row=>row.dataset.key===uiAgent.id+':'+subscribedSessionId)?.querySelector('[data-action="unsubscribe"]'));
        settings.subscribed=!!customRows().find(row=>row.dataset.key===uiAgent.id+':'+subscribedSessionId)?.querySelector('[data-action="unsubscribe"]');
        if(!settings.subscribed)throw new Error('Custom session could not be subscribed');

        document.querySelector('[data-view="settings"]').click();
        click('[data-custom-edit="'+uiAgent.id+'"]');
        settings.editReopensMapping=!!document.querySelector('#usage-agent-session-fields')?.open&&document.querySelector('#usage-agent-session-id-field').value==='meta.session';
        document.querySelector('#usage-agent-close').click();
        click('[data-custom-toggle="'+uiAgent.id+'"]');
        await wait(s=>{
          const configured=s.settings.customUsageAgents?.find(agent=>agent.id===uiAgent.id);
          const own=s.sessions.filter(session=>session.agent===uiAgent.id);
          return configured?.enabled===false&&own.length===1&&own[0].subscribed;
        });
        settings.disabled={
          retained:!!(await window.inbox.snapshot()).settings.customUsageAgents.find(agent=>agent.id===uiAgent.id),
          discoveredSessionHidden:(await window.inbox.snapshot()).sessions.filter(session=>session.agent===uiAgent.id).length===1,
          subscribedSessionRetained:(await window.inbox.snapshot()).sessions.some(session=>session.agent===uiAgent.id&&session.sessionId===subscribedSessionId&&session.subscribed),
          card:document.querySelector('[data-custom-toggle="'+uiAgent.id+'"]')?.closest('.setting-row')?.textContent.includes('已停用')
        };
        if(!settings.disabled.retained||!settings.disabled.discoveredSessionHidden||!settings.disabled.subscribedSessionRetained||!settings.disabled.card)throw new Error('Disabling a custom Agent did not retain configuration, subscriptions and source state consistently');

        click('[data-custom-toggle="'+uiAgent.id+'"]');
        await wait(s=>s.settings.customUsageAgents?.find(agent=>agent.id===uiAgent.id)?.enabled===true&&s.sessions.filter(session=>session.agent===uiAgent.id).length===2);
        document.querySelector('[data-view="all"]').click();
        const restoredFilter=document.querySelector('#agent-filter');
        restoredFilter.value='';
        restoredFilter.dispatchEvent(new Event('change'));
        await new Promise(r=>setTimeout(r,150));
        const restoredOption=!![...restoredFilter.options].find(option=>option.value===uiAgent.id);
        const restoredRows=document.querySelectorAll('.session-row').length;
        settings.reenabled=restoredOption&&restoredRows===rows+2;
        if(!settings.reenabled)throw new Error('Re-enabling a custom Agent did not restore sessions and filter: '+JSON.stringify({restoredOption,restoredRows,expectedRows:rows+2,agent:uiAgent.id}));

        document.querySelector('[data-view="settings"]').click();
        window.confirm=()=>true;
        click('[data-custom-delete="'+uiAgent.id+'"]');
        await wait(s=>!s.settings.customUsageAgents?.some(agent=>agent.id===uiAgent.id)&&!s.sessions.some(session=>session.agent===uiAgent.id)&&!s.connections.some(connection=>connection.agent===uiAgent.id));
        settings.deleted={
          configRemoved:!(await window.inbox.snapshot()).settings.customUsageAgents.some(agent=>agent.id===uiAgent.id),
          sessionsRemoved:!(await window.inbox.snapshot()).sessions.some(session=>session.agent===uiAgent.id),
          connectionRemoved:!(await window.inbox.snapshot()).connections.some(connection=>connection.agent===uiAgent.id)
        };
        if(!Object.values(settings.deleted).every(Boolean))throw new Error('Deleting a custom Agent did not synchronize every view');
      }
      document.querySelector('[data-view="usage"]').click();
      for(let i=0;i<80&&!document.querySelector('.usage-metrics');i++)await new Promise(r=>setTimeout(r,50));
      if(!document.querySelector('.usage-metrics'))throw new Error('Usage statistics did not render');
      const usage={periodButtons:document.querySelectorAll('[data-usage-days]').length,chart:!!document.querySelector('.usage-chart-svg'),sources:document.querySelectorAll('.usage-source').length,customSources:document.querySelectorAll('.usage-source [data-usage-agent-edit]').length,addAgent:!!document.querySelector('#usage-agent-add'),customTable:!![...document.querySelectorAll('.usage-table thead th')].find(th=>th.textContent==='Smoke Agent')};
      click('#usage-agent-add');
      usage.dialog=!!document.querySelector('#usage-agent-dialog')?.open;
      const form=document.querySelector('#usage-agent-form');
      document.querySelector('#usage-agent-name').value='UI Usage Agent';
      document.querySelector('#usage-agent-path').value=${JSON.stringify(join(isolation ?? "", "custom-agent.jsonl"))};
      document.querySelector('#usage-agent-pattern').value='*.jsonl';
      document.querySelector('#usage-agent-field').value='event.created_at';
      document.querySelector('#usage-agent-unit').value='iso';
      form.requestSubmit(document.querySelector('#usage-agent-save'));
      for(let i=0;i<100&&!([...document.querySelectorAll('.usage-source h3')].some(el=>el.textContent==='UI Usage Agent'));i++)await new Promise(r=>setTimeout(r,50));
      usage.added=!![...document.querySelectorAll('.usage-source h3')].some(el=>el.textContent==='UI Usage Agent');
      usage.savedCount=(await window.inbox.snapshot()).settings.customUsageAgents?.length||0;
      if(!usage.addAgent||usage.customSources<1||!usage.customTable||!usage.dialog||!usage.added||usage.savedCount<2)throw new Error('Custom Agent UI flow failed: '+JSON.stringify(usage));
      document.querySelector('[data-usage-days="14"]').click();
      for(let i=0;i<80&&document.querySelector('[data-usage-days="14"]')?.getAttribute('aria-pressed')!=='true';i++)await new Promise(r=>setTimeout(r,50));
      usage.fourteenDays=document.querySelector('[data-usage-days="14"]').getAttribute('aria-pressed')==='true';
      document.querySelector('[data-view="inbox"]').click();
      return {rows,detail,settings,usage,...tested,title:document.title};
    })()`);
    if(process.env.AGENT_INBOX_TEST_NOTIFICATION === "1")await showNotification("smoke","AgentDeck · 验证通知","Windows 版通知通道测试。",showWindow);
    await new Promise(resolve=>setTimeout(resolve,400));
    result.agentIcons=await win.webContents.executeJavaScript("[...document.querySelectorAll('.agent-symbol img')].map(img=>({agent:img.alt,loaded:img.complete&&img.naturalWidth>0,src:img.getAttribute('src')}))");
    result.appearance=await win.webContents.executeJavaScript(`(async()=>{
      const wait=async preference=>{for(let i=0;i<50;i++){const s=await window.inbox.snapshot();if(s.settings.theme===preference&&!document.querySelector('#theme-toggle').disabled)return s;await new Promise(r=>setTimeout(r,50));}throw new Error('Theme change did not settle');};
      const before=(await window.inbox.snapshot()).settings;
      document.querySelector('[data-view="settings"]').click();
      const select=document.querySelector('#theme-setting');
      select.value='light';select.dispatchEvent(new Event('change'));
      await wait('light');
      if(document.documentElement.dataset.theme!=='light')throw new Error('Light theme was not applied');
      document.querySelector('#theme-toggle').click();
      const after=await wait('dark');
      if(select.value!=='dark'||document.documentElement.dataset.theme!=='dark')throw new Error('Settings and header theme controls are out of sync');
      const settingsBackground=getComputedStyle(document.querySelector('.settings-section')).backgroundColor;
      document.querySelector('#connection-dialog').showModal();
      const dialogBackground=getComputedStyle(document.querySelector('#connection-dialog')).backgroundColor;
      document.querySelector('#connection-dialog').close();
      document.querySelector('[data-view="inbox"]').click();
      document.querySelector('.session-row').click();
      const bodyBackground=getComputedStyle(document.body).backgroundColor;
      const detailBackground=getComputedStyle(document.querySelector('#detail')).backgroundColor;
      const unchanged=['notifications','contentSearchEnabled','startAtLogin'].every(key=>before[key]===after.settings[key]);
      if(!unchanged)throw new Error('Appearance changed unrelated settings');
      return {headerToggle:true,settingsSelect:true,saved:after.settings.theme,bodyBackground,detailBackground,settingsBackground,dialogBackground,otherSettingsPreserved:unchanged};
    })()`);
    result.layout=await win.webContents.executeJavaScript(`(async()=>{
      const info=document.querySelector('.session-info');
      const collapsed=!info.open;
      info.querySelector('summary').click();
      const extras=[...info.querySelectorAll('[data-detail]')].every(button=>button.getBoundingClientRect().height>0);
      await window.inbox.system('refresh');
      await new Promise(r=>setTimeout(r,150));
      const preserved=document.querySelector('.session-info').open;
      document.querySelector('.session-info summary').click();
      if(!collapsed||!extras||!preserved)throw new Error('Expandable session details failed');
      return {detailsCollapsed:collapsed,extraActionsVisible:extras,expandedStatePreserved:preserved,decorativeLabelsRemoved:!document.querySelector('.eyebrow,.stats-grid,.sidebar-tip'),titleFont:getComputedStyle(document.querySelector('.session-title')).fontSize};
    })()`);
    win.setSize(970,650);
    await new Promise(resolve=>setTimeout(resolve,300));
    result.layout.customDialogCompact=await win.webContents.executeJavaScript(`(async()=>{
      const click=selector=>{const element=document.querySelector(selector);if(!element)throw new Error('Missing UI control: '+selector);element.click();};
      document.querySelector('[data-view="settings"]').click();
      click('[data-custom-edit="custom-smoke-agent"]');
      const dialog=document.querySelector('#usage-agent-dialog'),rect=dialog.getBoundingClientRect();
      const fits=rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight&&dialog.scrollWidth<=dialog.clientWidth;
      const scrollable=dialog.scrollHeight>dialog.clientHeight&&getComputedStyle(dialog).overflowY==='auto';
      const mapping=document.querySelector('#usage-agent-session-fields')?.open;
      document.querySelector('#usage-agent-close').click();
      document.querySelector('[data-view="all"]').click();
      await new Promise(r=>setTimeout(r,150));
      if(!fits||!scrollable||!mapping)throw new Error('Compact custom Agent dialog is clipped or not scrollable');
      return {fits,scrollable,mapping,width:Math.round(rect.width),height:Math.round(rect.height)};
    })()`);
    result.layout.compact=await win.webContents.executeJavaScript(`(()=>{
      const list=document.querySelector('#session-list').getBoundingClientRect(),detail=document.querySelector('#detail').getBoundingClientRect();
      const fits=document.body.scrollWidth<=innerWidth&&detail.right<=innerWidth&&list.bottom<=innerHeight;
      const actions=[...document.querySelector('.session-row').querySelectorAll('.row-actions button')].every(button=>{const r=button.getBoundingClientRect();return r.left>=list.left&&r.right<=list.right;});
      if(!fits||!actions)throw new Error('Compact window overflows');
      return {fits,actions,width:innerWidth,height:innerHeight};
    })()`);
    result.layout.usageCompact=await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('[data-view="usage"]').click();
      for(let i=0;i<80&&(!document.querySelector('.usage-metrics')||document.querySelector('.usage-loading'));i++)await new Promise(r=>setTimeout(r,50));
      const page=document.querySelector('#usage-page'),period=document.querySelector('.usage-period').getBoundingClientRect(),chart=document.querySelector('.usage-chart-svg').getBoundingClientRect();
      const usageFits=page.scrollWidth<=page.clientWidth&&period.right<=innerWidth&&chart.right<=innerWidth&&document.body.scrollWidth<=innerWidth;
      if(!usageFits)throw new Error('Compact usage statistics overflow');
      document.querySelector('[data-view="inbox"]').click();
      return {fits:usageFits,periodVisible:period.width>0,chartVisible:chart.width>0};
    })()`);
    if(process.env.AGENT_INBOX_COMPACT_SCREENSHOT)writeFileSync(process.env.AGENT_INBOX_COMPACT_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    win.setSize(1220,820);
    await new Promise(resolve=>setTimeout(resolve,500));
    await win.webContents.executeJavaScript("document.querySelector('#toast').style.visibility='hidden'");
    if(process.env.AGENT_INBOX_SCREENSHOT_DARK)writeFileSync(process.env.AGENT_INBOX_SCREENSHOT_DARK,(await win.webContents.capturePage()).toPNG());
    if(process.env.AGENT_INBOX_USAGE_SCREENSHOT_DARK){
      await win.webContents.executeJavaScript(`(async()=>{
        document.querySelector('[data-view="usage"]').click();
        for(let i=0;i<80&&!document.querySelector('.usage-metrics');i++)await new Promise(r=>setTimeout(r,50));
        if(!document.querySelector('.usage-metrics'))throw new Error('Usage statistics did not render for dark screenshot');
        if(document.querySelector('#usage-page').classList.contains('hidden')||!document.querySelector('[data-view="usage"]').classList.contains('active'))throw new Error('Usage page was not active for dark screenshot');
        document.querySelector('#usage-page').scrollTop=0;
      })()`);
      writeFileSync(process.env.AGENT_INBOX_USAGE_SCREENSHOT_DARK,(await win.webContents.capturePage()).toPNG());
    }
    await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('#theme-toggle').click();
      for(let i=0;i<50;i++){if((await window.inbox.snapshot()).settings.theme==='light'&&!document.querySelector('#theme-toggle').disabled)return;await new Promise(r=>setTimeout(r,50));}
      throw new Error('Header toggle did not switch back to light');
    })()`);
    await new Promise(resolve=>setTimeout(resolve,300));
    if(process.env.AGENT_INBOX_SCREENSHOT_LIGHT)writeFileSync(process.env.AGENT_INBOX_SCREENSHOT_LIGHT,(await win.webContents.capturePage()).toPNG());
    if(process.env.AGENT_INBOX_USAGE_SCREENSHOT_LIGHT){
      await win.webContents.executeJavaScript(`(async()=>{
        document.querySelector('[data-view="usage"]').click();
        for(let i=0;i<80&&!document.querySelector('.usage-metrics');i++)await new Promise(r=>setTimeout(r,50));
        if(!document.querySelector('.usage-metrics'))throw new Error('Usage statistics did not render for light screenshot');
        if(document.querySelector('#usage-page').classList.contains('hidden')||!document.querySelector('[data-view="usage"]').classList.contains('active'))throw new Error('Usage page was not active for light screenshot');
        document.querySelector('#usage-page').scrollTop=0;
      })()`);
      writeFileSync(process.env.AGENT_INBOX_USAGE_SCREENSHOT_LIGHT,(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript("document.querySelector('[data-view=\"inbox\"]').click()");
    }
    if(process.env.AGENT_INBOX_SCREENSHOT)writeFileSync(process.env.AGENT_INBOX_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.querySelector('#toast').style.visibility=''");
    await win.webContents.executeJavaScript(`(async()=>{
      document.querySelector('[data-view="settings"]').click();
      const select=document.querySelector('#theme-setting');select.value='system';select.dispatchEvent(new Event('change'));
      for(let i=0;i<50;i++){if((await window.inbox.snapshot()).settings.theme==='system'&&!document.querySelector('#theme-toggle').disabled)return;await new Promise(r=>setTimeout(r,50));}
      throw new Error('Follow-system setting did not save');
    })()`);
    result.appearance.systemChanges=[];
    for(const theme of ["light","dark"] as const){
      nativeTheme.themeSource=theme;
      result.appearance.systemChanges.push(await win.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<50;i++){if(document.documentElement.dataset.theme==='${theme}')return {resolved:'${theme}',saved:(await window.inbox.snapshot()).settings.theme};await new Promise(r=>setTimeout(r,50));}
        throw new Error('Follow-system mode ignored native ${theme} change');
      })()`));
    }
    nativeTheme.themeSource="system";
    await win.webContents.executeJavaScript(`(async()=>{
      const select=document.querySelector('#theme-setting');select.value='dark';select.dispatchEvent(new Event('change'));
      for(let i=0;i<50;i++){if((await window.inbox.snapshot()).settings.theme==='dark'&&!document.querySelector('#theme-toggle').disabled)return;await new Promise(r=>setTimeout(r,50));}
      throw new Error('Dark theme did not save before reload');
    })()`);
    if(process.env.AGENT_INBOX_THEME_SETTINGS_SCREENSHOT)writeFileSync(process.env.AGENT_INBOX_THEME_SETTINGS_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    await new Promise<void>(resolve=>{win.webContents.once('did-finish-load',()=>resolve());win.webContents.reload();});
    result.appearance.reload=await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<50;i++){if(document.documentElement.dataset.theme==='dark'&&(await window.inbox.snapshot()).settings.theme==='dark')return true;await new Promise(r=>setTimeout(r,50));}
      throw new Error('Saved theme did not survive reload');
    })()`);
    result.notificationsShown=notificationsShown; result.tray=!tray.isDestroyed();
    writeFileSync(process.env.AGENT_INBOX_SMOKE_RESULT!,JSON.stringify(result,null,2));
  } catch(error) {writeFileSync(process.env.AGENT_INBOX_SMOKE_RESULT!,JSON.stringify({error:error instanceof Error?error.stack:String(error),result},null,2));}
  app.quit();
}

const locked = isolation ? true : app.requestSingleInstanceLock();
if(!locked)app.quit();
else {
  app.on("second-instance",showWindow);
  app.on("before-quit",()=>{quitting=true;backend?.stop();globalShortcut.unregisterAll();for(const n of notifications.values())n.close();if(testShortcut&&existsSync(testShortcut))unlinkSync(testShortcut);});
  app.on("window-all-closed",()=>{if(quitting)app.quit();});
  app.whenReady().then(async()=>{
    if(!existsSync(sqlite))throw new Error("应用缺少 SQLite 资源，请使用完整的解压目录。");
    mkdirSync(root,{recursive:true});prepareLauncher();setupWindowsShortcut();
    try{startup=JSON.parse(readFileSync(join(root,"desktop-settings.json"),"utf8")).startAtLogin === true;}catch{}
    if (startup && app.isPackaged && !isolation) setStartup(true);
    const {readConfig} = await import("../src/core/config");
    const theme = readConfig().theme;
    nativeTheme.themeSource = theme === "light" || theme === "dark" ? theme : "system";
    win=new BrowserWindow({width:1220,height:820,minWidth:970,minHeight:650,frame:false,backgroundColor:nativeTheme.shouldUseDarkColors?"#181d1b":"#f6f7f4",icon,
      show:false,webPreferences:{preload:join(__dirname,"preload.cjs"),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.on("close",event=>{if(!quitting){event.preventDefault();win.hide();}});
    win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    win.webContents.on("will-navigate",event=>event.preventDefault());
    tray=new Tray(icon);tray.on("double-click",showWindow);tray.on("click",showWindow);
    const {InboxBackend}=await import("./backend");
    const attention:Record<string,string>={question:"等待回答",permission:"等待授权",failed:"需要处理失败",quota:"额度需要处理",interrupted:"执行已中断",input:"等待输入"};
    backend=new InboxBackend({id:"windows",async send(message){
      await showNotification(message.id,`${message.title || "未命名会话"} · ${attention[message.attention ?? "input"] || "待处理"}`,message.summary || "这个会话需要你介入。点击返回收件箱。",()=>{showWindow();void backend.session(message.agent,message.sessionId).then(s=>{if(s)void jump(s).catch(showError);});});
    }},publish,{node:process.execPath,cli,launcher});
    registerIpc();
    const shortcut=globalShortcut.register("CommandOrControl+Alt+I",()=>win.isVisible()&&win.isFocused()?win.hide():showWindow());
    if(!shortcut)notice="Ctrl + Alt + I 已被其他程序占用，可从系统托盘打开。";
    await win.loadFile(join(__dirname,"..","desktop","index.html"));
    if(!process.argv.includes("--hidden"))showWindow();
    await backend.start();
    void backend.usage(7).catch(error=>backend.log(`使用统计预热失败：${String(error)}`));
    if(process.env.AGENT_INBOX_LIVE_RESULT){
      await new Promise(resolve=>setTimeout(resolve,500));
      const s=backend.snapshot();
      const agentIcons=await win.webContents.executeJavaScript("[...document.querySelectorAll('.agent-symbol img')].map(img=>({agent:img.alt,loaded:img.complete&&img.naturalWidth>0}))");
      const appearance=await win.webContents.executeJavaScript("({saved:document.documentElement.dataset.themePreference,resolved:document.documentElement.dataset.theme,button:document.querySelector('#theme-toggle').getAttribute('aria-label')})");
      let titleCheck;
      if(process.env.AGENT_INBOX_VERIFY_TITLE_ID){
        const sessionId=process.env.AGENT_INBOX_VERIFY_TITLE_ID;
        const target=s.sessions.find(session=>session.agent==='codex'&&session.sessionId===sessionId);
        const displayed=await win.webContents.executeJavaScript(`(()=>{
          document.querySelector('[data-view="all"]').click();
          const row=[...document.querySelectorAll('.session-row')].find(row=>row.dataset.key===${JSON.stringify('codex:'+sessionId)});
          if(!row)return {found:false};
          row.click();
          return {found:true,listTitle:row.querySelector('.session-title').textContent,detailTitle:document.querySelector('#detail h2').textContent};
        })()`);
        titleCheck={sessionId,title:target?.title,subscribed:target?.subscribed,...displayed};
      }
      writeFileSync(process.env.AGENT_INBOX_LIVE_RESULT,JSON.stringify({total:s.sessions.length,agents:s.sessions.reduce((out:Record<string,number>,v)=>{out[v.agent]=(out[v.agent]||0)+1;return out;},{}),connections:s.connections,error:s.error,updatedAt:s.updatedAt,agentIcons,appearance,titleCheck,protocolCodex:await protocolAvailable("codex"),tray:!tray.isDestroyed()},null,2));
      if(process.env.AGENT_INBOX_SCREENSHOT){await new Promise(resolve=>setTimeout(resolve,300));writeFileSync(process.env.AGENT_INBOX_SCREENSHOT,(await win.webContents.capturePage()).toPNG());}
      if(process.env.AGENT_INBOX_LIVE_USAGE_SCREENSHOT){
        await win.webContents.executeJavaScript(`(async()=>{
          document.querySelector('[data-view="usage"]').click();
          for(let i=0;i<600&&(!document.querySelector('.usage-metrics')||document.querySelector('.usage-loading'));i++)await new Promise(r=>setTimeout(r,100));
          if(!document.querySelector('.usage-metrics')||document.querySelector('#usage-page').classList.contains('hidden'))throw new Error('Live usage statistics did not render');
          await new Promise(r=>setTimeout(r,350));
          document.querySelector('#usage-page').scrollTop=0;
        })()`);
        writeFileSync(process.env.AGENT_INBOX_LIVE_USAGE_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
      }
      if(process.env.AGENT_INBOX_LIVE_EXIT==="1")app.quit();
    }
    if(process.env.AGENT_INBOX_SMOKE_RESULT)await smokeTest();
  }).catch(error=>{showError(error);dialog.showErrorBox("AgentDeck 无法启动",String(error));app.quit();});
}
