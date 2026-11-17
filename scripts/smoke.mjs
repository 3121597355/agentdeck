import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const work=resolve('../../work');
const root=join(work,'windows-ui-verification');
rmSync(root,{recursive:true,force:true});
mkdirSync(root,{recursive:true});
const env={...process.env,AGENT_INBOX_HOME:root,AGENT_INBOX_TEST_HOME:root,AGENT_INBOX_SQLITE:resolve('resources/sqlite3.exe'),CODEX_HOME:join(root,'codex'),CLAUDE_CONFIG_DIR:join(root,'claude'),AGENT_INBOX_CLAUDE_DESKTOP_ROOT:join(root,'claude-desktop'),AGENT_INBOX_SMOKE_RESULT:join(work,'windows-smoke-result.json'),AGENT_INBOX_SCREENSHOT:resolve('../Windows版界面.png'),AGENT_INBOX_TEST_NOTIFICATION:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const entries=[
  ['codex','11111111-1111-4111-8111-111111111111','修复登录页面的表单验证','needs_input','permission'],
  ['claude','22222222-2222-4222-8222-222222222222','排查后端接口超时','running',''],
  ['codex','33333333-3333-4333-8333-333333333333','整理项目文档与运行说明','ready',''],
  ['claude','44444444-4444-4444-8444-444444444444','调整首页布局和移动端样式','needs_input','question'],
];
for(const [agent,id,title,status,attention] of entries){
  execFileSync(process.execPath,['build/agent-inbox.mjs','event','--agent',agent,'--session',id,'--type','started','--title',title,'--cwd',`C:\\Projects\\${agent==='codex'?'studio-web':'service-api'}`],{env,windowsHide:true});
  execFileSync(process.execPath,['build/agent-inbox.mjs','event','--agent',agent,'--session',id,'--type',status==='needs_input'?'needs_input':status==='running'?'progress':'stopped',...(attention?['--attention',attention,'--request','ui-check']:[]),'--cwd',`C:\\Projects\\${agent==='codex'?'studio-web':'service-api'}`,'--summary',status==='needs_input'?'接下来的操作需要你的确认。请返回原会话查看并处理。':'本轮状态已更新。'],{env,windowsHide:true});
}
execFileSync(resolve('resources/sqlite3.exe'),[join(root,'db.sqlite'),'UPDATE sessions SET subscribed=1, handled_at=NULL;'],{windowsHide:true});
const customUsagePath=join(root,'custom-agent.jsonl');
const now=Date.now();
writeFileSync(customUsagePath,[
  {meta:{session:'smoke-session-1',name:'自定义会话一',cwd:'C:\\Projects\\custom-one'},event:{type:'started',created_at:new Date(now-12*60_000).toISOString()}},
  {meta:{session:'smoke-session-1'},payload:{summary:'自定义会话已经接入，等待确认。'},event:{type:'needs_input',created_at:new Date(now-8*60_000).toISOString(),request:'custom-q1'}},
  {meta:{session:'smoke-session-2',name:'自定义会话二',cwd:'C:\\Projects\\custom-two'},event:{type:'started',created_at:new Date(now-6*60_000).toISOString()}},
  {meta:{session:'smoke-session-2'},event:{type:'running',created_at:new Date(now-3*60_000).toISOString()}},
].map(value=>JSON.stringify(value)).join('\n')+'\n');
writeFileSync(join(root,'config.json'),JSON.stringify({notifications:false,notificationChannels:['windows'],contentSearchEnabled:false,customUsageAgents:[
  {
    id:'custom-smoke-agent',name:'Smoke Agent',path:customUsagePath,filePattern:'*.jsonl',
    timestampField:'event.created_at',timestampUnit:'iso',enabled:true,scanSessions:true,
    sessionIdField:'meta.session',eventTypeField:'event.type',titleField:'meta.name',
    cwdField:'meta.cwd',summaryField:'payload.summary',requestIdField:'event.request',jumpUrl:'',
  },
]}));
const executable=process.env.AGENT_INBOX_PACKAGED_EXE || resolve('node_modules/electron/dist/electron.exe');
const child=spawn(executable,process.env.AGENT_INBOX_PACKAGED_EXE?[]:['.'],{env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>{
  if(existsSync(env.AGENT_INBOX_SMOKE_RESULT)) console.log(readFileSync(env.AGENT_INBOX_SMOKE_RESULT,'utf8'));
  process.exitCode=code ?? 1;
});
