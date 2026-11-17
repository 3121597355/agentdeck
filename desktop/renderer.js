const $=selector=>document.querySelector(selector);
const esc=value=>String(value ?? '').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const paths={inbox:'M4 4h16v12l-3 4H7l-3-4V4Zm0 9h4l2 3h4l2-3h4',bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',layers:'m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',check:'m5 12 4 4L19 6',chart:'M4 19V9m5 10V5m5 14v-7m5 7V3',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',refresh:'M20 7V3l-4 4M4 17v4l4-4M20 7a9 9 0 0 0-15-2M4 17a9 9 0 0 0 15 2',arrow:'M5 12h14m-5-5 5 5-5 5',folder:'M3 6h7l2 2h9v12H3V6',copy:'M8 8h12v12H8V8ZM4 16H3V3h13v1',terminal:'m5 7 4 4-4 4m7 0h7'};
paths.sun='M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5';
paths.moon='M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z';
const icon=name=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.inbox}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
const statusNames={needs_input:'待输入',running:'运行中',ready:'本轮结束',done:'已完成',idle:'历史记录',unknown:'状态未确认'};
const attentionNames={question:'等待你的回答',permission:'等待你的授权',failed:'失败需要处理',quota:'额度需要处理',interrupted:'执行中断',input:'等待输入'};
let state={sessions:[],settings:{},connections:[],updatedAt:0,error:'',index:{}},view='inbox',selected='',query='',contentMatches={},searchSequence=0,first=true;
let usageState={days:7,report:null,loading:false,error:'',sequence:0};
let toastTimer,searchTimer,connection,usageAgentMode='usage';
const systemTheme=window.matchMedia('(prefers-color-scheme: dark)');
let themePreference='system',themeSaving=false;
function applyTheme(preference){
  themePreference=['light','dark','system'].includes(preference)?preference:'system';
  const dark=themePreference==='dark'||(themePreference==='system'&&systemTheme.matches);
  document.documentElement.dataset.theme=dark?'dark':'light';
  document.documentElement.dataset.themePreference=themePreference;
  const target=dark?'日间':'夜间';
  $('#theme-label').textContent=target;
  $('#theme-icon').innerHTML=icon(dark?'sun':'moon');
  $('#theme-toggle').setAttribute('aria-label','切换到'+target+'模式');
  $('#theme-toggle').title=(themePreference==='system'?'正在跟随系统 · ':'')+'切换到'+target+'模式';
  if($('#theme-setting'))$('#theme-setting').value=themePreference;
  if($('#theme-description'))$('#theme-description').textContent=themePreference==='system'?'自动跟随 Windows 外观。':'已保存'+(dark?'夜间':'日间')+'模式。';
}
function themeBusy(value){
  themeSaving=value;
  $('#theme-toggle').disabled=value;
  if($('#theme-setting'))$('#theme-setting').disabled=value;
}
async function saveTheme(preference){
  if(themeSaving)return;
  const previous=state.settings.theme||'system';
  themeBusy(true);applyTheme(preference);
  const result=await perform(()=>window.inbox.settings({theme:preference}));
  themeBusy(false);
  if(result)receive(result);else applyTheme(previous);
}
systemTheme.addEventListener('change',()=>{if(themePreference==='system')applyTheme('system');});
$('#theme-toggle').onclick=()=>saveTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
applyTheme('system');
const key=s=>`${s.agent}:${s.sessionId}`;
const agentNames={claude:'Claude Code',codex:'Codex',cursor:'Cursor',dsh:'DeepSeek Harness',workbuddy:'WorkBuddy'};
const name=s=>s.name||agentNames[s.agent]||state.connections.find(c=>c.agent===s.agent)?.name||s.agent;
const agentIcons={claude:'claude.svg',codex:'codex.svg',cursor:'cursor.png',dsh:'dsh.png',workbuddy:'workbuddy.png'};
const symbol=s=>{
  const custom=!!s.custom||String(s.agent||'').startsWith('custom-');
  const fallback=custom?[...String(name(s)||'A')][0]:String(s.agent||'?').slice(0,1).toUpperCase();
  return `<span class="agent-symbol ${custom?'custom':esc(s.agent)}" title="${esc(name(s))}">${agentIcons[s.agent]?`<img src="agent-icons/${agentIcons[s.agent]}" alt="${esc(name(s))}" width="22" height="22" draggable="false">`:esc(fallback)}</span>`;
};
const active=()=>state.sessions.filter(s=>s.subscribed&&s.handledAt===null);
const project=s=>s.cwd?.replace(/[\\/]+$/,'').split(/[\\/]/).pop()||'未指定项目';
const relative=time=>{if(!time)return'时间未确认';const d=Math.max(0,Date.now()-time);return d<60000?'刚刚':d<3600000?`${Math.floor(d/60000)} 分钟前`:d<86400000?`${Math.floor(d/3600000)} 小时前`:d<604800000?`${Math.floor(d/86400000)} 天前`:new Date(time).toLocaleDateString('zh-CN',{month:'short',day:'numeric'});};
function toast(text){$('#toast').textContent=text;$('#toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),5500);}
async function perform(fn){try{return await fn();}catch(e){toast(String(e.message||e).replace(/^Error invoking remote method '[^']+': Error: /,''));return null;}}

function setView(next){
  view=next;
  document.querySelectorAll('[data-view]').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  const sessionView=!['settings','usage'].includes(view);
  $('#workspace').classList.toggle('hidden',!sessionView);
  $('#settings-page').classList.toggle('hidden',view!=='settings');
  $('#usage-page').classList.toggle('hidden',view!=='usage');
  $('#page-title').textContent={inbox:'收件箱',waiting:'待我处理',all:'全部会话',handled:'已处理',usage:'使用统计',settings:'设置'}[view];
  const refreshLabel=view==='usage'?'刷新使用统计':'刷新会话';
  $('#refresh').setAttribute('aria-label',refreshLabel);
  $('#refresh').title=refreshLabel;
  if(view==='settings')renderSettings();
  else if(view==='usage'){renderUsage();void loadUsage();}
  else renderList();
}

function receive(value){
  state=value;
  if(!themeSaving)applyTheme(state.settings.theme);
  renderAgentFilter();
  if(first&&state.updatedAt){first=false;if(!active().length)setView('all');}
  renderCounts();
  const warning=[state.testData?'测试会话 · 仅用于界面验证':'',state.error?'采集暂时失败：'+state.error:'',state.connections.filter(c=>c.error).map(c=>name({agent:c.agent})+' 暂不可用，请查看设置。').join(' '),!state.testData?state.notice:''].filter(Boolean).join(' ');
  $('#notice').textContent=warning;
  $('#notice').classList.toggle('hidden',!warning);
  $('#notice').classList.toggle('test-data',!!state.testData&&!state.error&&!state.connections.some(c=>c.error));
  const offline=!!state.error||state.connections.some(c=>c.error);
  $('#refresh-status').innerHTML='<i class="online-dot"></i>'+(offline?'连接异常':state.updatedAt?'本地已连接':'正在连接');
  $('#refresh-status').classList.toggle('offline',offline);
  $('#refresh-status').title=(state.updatedAt?'最近更新：'+new Date(state.updatedAt).toLocaleTimeString('zh-CN'):'正在读取本地数据')+' · Ctrl + Alt + I 唤起';
  $('#search').placeholder=state.settings.contentSearchEnabled?'搜索会话或正文':'搜索会话';
  $('#search').title=state.settings.contentSearchEnabled?'搜索标题、项目、ID 或正文':'搜索标题、项目或 ID';
  if(view==='settings')updateSettingsStatus();
  else if(view==='usage')renderUsage();
  else renderList();
}

function renderCounts(){
  const rows=active();
  $('#count-inbox').textContent=rows.length;
  $('#count-waiting').textContent=rows.filter(s=>s.status==='needs_input').length||'';
  $('#count-all').textContent=state.sessions.length;
  $('#count-handled').textContent=state.sessions.filter(s=>s.subscribed&&s.handledAt!==null).length||'';
}

function filtered(){let rows=view==='all'?state.sessions:view==='handled'?state.sessions.filter(s=>s.subscribed&&s.handledAt!==null):view==='waiting'?active().filter(s=>s.status==='needs_input'):active();const agent=$('#agent-filter').value,status=$('#status-filter').value;const terms=query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);return rows.filter(s=>(!agent||s.agent===agent)&&(!status||s.status===status)&&terms.every(term=>[s.title,s.cwd,s.sessionId].join(' ').normalize('NFKC').toLowerCase().includes(term)||contentMatches[key(s)]?.terms.includes(term))).sort((a,b)=>view==='inbox'?(Number(b.status==='needs_input')-Number(a.status==='needs_input')||b.updatedAt-a.updatedAt):b.updatedAt-a.updatedAt);}

function renderList(){const rows=filtered();$('#list-meta').textContent=`${rows.length} 个会话${query?' · 搜索结果':''}${state.settings.contentSearchEnabled&&state.index.busy?' · 正文索引中':''}`;if(!rows.length){const hasQuery=query||$('#agent-filter').value||$('#status-filter').value;const titles=hasQuery?['没有匹配的会话','试试其他关键词，或调整 Agent 和状态筛选。']:view==='all'?['还没有发现本地会话','使用已接入 Agent 创建对话，或在“设置与接入”中添加自定义 JSONL 来源。']:view==='waiting'?['当前没有待处理请求','你订阅的会话需要回答或授权时，会出现在这里。']:view==='handled'?['还没有标记为已处理的会话','在会话详情中标记已处理，可以暂时将它收起。']:['从一条会话开始','在全部会话中选择并订阅。新的待处理请求会集中出现在这里。'];$('#session-list').innerHTML=`<div class="empty-state"><div class="empty-symbol">${icon(view==='waiting'?'check':'inbox')}</div><h3>${titles[0]}</h3><p>${titles[1]}</p>${!hasQuery&&view==='inbox'?'<button class="button subtle" id="browse-all">浏览全部会话</button>':''}</div>`;$('#browse-all')?.addEventListener('click',()=>setView('all'));}else{$('#session-list').innerHTML=rows.map(s=>`<article class="session-row ${selected===key(s)?'selected':''}" data-key="${esc(key(s))}" tabindex="0" aria-label="${esc(s.title||'未命名会话')}">${symbol(s)}<div class="row-content"><div class="row-top"><span class="session-title" title="${esc(s.title)}">${esc(s.title||'未命名会话')}</span></div><div class="row-meta"><span class="status-pill ${esc(s.status)}">${statusNames[s.status]||'未确认'}</span><span class="project" title="${esc(s.cwd)}">${esc(s.cwd?project(s):name(s))}</span><span class="row-time">${relative(s.updatedAt)}</span></div></div><div class="row-actions"><button class="button ${s.subscribed?'secondary':'subtle'}" data-action="${s.subscribed?'unsubscribe':'subscribe'}">${s.subscribed?'已订阅':'订阅'}</button><button class="jump-button" data-action="jump" title="返回会话" aria-label="返回会话">${icon('arrow')}</button></div></article>`).join('');$('#session-list').querySelectorAll('.session-row').forEach(el=>{el.addEventListener('click',()=>{selected=el.dataset.key;renderList();});el.addEventListener('keydown',e=>{if(e.key==='Enter'){selected=el.dataset.key;renderList();}});el.querySelectorAll('[data-action]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const s=state.sessions.find(s=>key(s)===el.dataset.key);if(s)void sessionAction(b.dataset.action,s);}));});}renderDetail();}

function renderDetail(){
  const s=state.sessions.find(s=>key(s)===selected),panel=$('#detail');
  panel.classList.toggle('hidden',!s);
  $('#content-grid').classList.toggle('with-detail',!!s);
  if(!s)return;
  const same=panel.dataset.sessionKey===key(s),expanded=same&&panel.querySelector('.session-info')?.open,scroll=same?panel.scrollTop:0;
  panel.dataset.sessionKey=key(s);
  const message=contentMatches[key(s)]?.snippet||s.summary;
  panel.innerHTML=    '<div class="detail-top"><div class="detail-agent">'+symbol(s)+'<span>'+esc(name(s))+'</span></div><button id="detail-close" class="icon-button" aria-label="关闭详情">×</button></div>'+
    '<h2>'+esc(s.title||'未命名会话')+'</h2><span class="status-pill '+esc(s.status)+'">'+(s.status==='needs_input'?esc(attentionNames[s.attention]||'等待输入'):statusNames[s.status]||'未确认')+'</span>'+
    (message?'<div class="detail-message">'+esc(message.slice(0,1800))+'</div>':'')+
    '<div class="detail-actions"><button class="button primary" data-detail="jump">'+icon('arrow')+'返回会话</button><button class="button secondary" data-detail="'+(s.subscribed?'unsubscribe':'subscribe')+'">'+(s.subscribed?'取消订阅':'订阅会话')+'</button>'+
    (s.subscribed?'<button class="button secondary" data-detail="'+(s.handledAt===null?'handled':'restore')+'">'+(s.handledAt===null?'标记已处理':'恢复到收件箱')+'</button>':'')+'</div>'+
    '<details class="session-info" '+(expanded?'open':'')+'><summary>会话信息</summary><dl class="detail-fields"><dt>项目目录</dt><dd>'+esc(s.cwd||'未指定')+'</dd><dt>会话 ID</dt><dd>'+esc(s.sessionId)+'</dd><dt>最近活动</dt><dd>'+(s.updatedAt?new Date(s.updatedAt).toLocaleString('zh-CN'):'未确认')+'</dd>'+
    (s.state?.pending?.length?'<dt>待处理请求</dt><dd>'+s.state.pending.length+' 项</dd>':'')+'</dl><div class="extra-actions">'+
    (['claude','codex'].includes(s.agent)?'<button class="button secondary" data-detail="resume">在终端恢复</button>':'')+
    '<button class="button secondary" data-detail="project">打开项目</button><button class="button secondary" data-detail="copy">复制 ID</button></div><p class="detail-hint">'+
    (['claude','codex'].includes(s.agent)?'终端恢复会打开新终端。':'返回方式与接入说明见设置。')+'</p></details>';
  panel.scrollTop=scroll;
  $('#detail-close').onclick=()=>{selected='';renderList();};
  panel.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>sessionAction(b.dataset.detail,s));
}

async function sessionAction(action,s){const result=await perform(()=>window.inbox.action(action,s.agent,s.sessionId));if(result?.sessions){receive(result);if(action==='subscribe')toast('已订阅');if(action==='handled')toast('已标记为已处理');}else if(result?.message)toast(result.message);}

function renderAgentFilter(){const select=$('#agent-filter'),selected=select.value;const agents=new Map(state.connections.map(c=>[c.agent,name({agent:c.agent})]));for(const s of state.sessions)if(!agents.has(s.agent))agents.set(s.agent,name(s));select.innerHTML='<option value="">全部 Agent</option>'+[...agents].map(([id,label])=>`<option value="${esc(id)}">${esc(label)}</option>`).join('');select.value=agents.has(selected)?selected:'';}
function connectionStatus(c){if(!c.enabled&&c.custom)return '已停用 · 保留配置与自定义 Agent';if(c.error)return '采集暂不可用 · '+c.error;if(!c.present)return c.custom?'记录路径当前不可访问':'尚未发现本地数据';const mode=c.custom?'本地会话已接入':c.hooked?'Hook 已接入':c.monitoring?'本地记录已接入':'已发现本地数据';return mode+' · '+(c.count||0)+' 个会话';}
function renderSettings(){
  const rows=state.connections.map(c=>'<div class="setting-row"><div class="connection-name">'+symbol({agent:c.agent,name:c.name,custom:c.custom})+'<div><h4>'+esc(c.name||name({agent:c.agent}))+'</h4><p id="connection-'+esc(c.agent)+'">'+esc(connectionStatus(c))+'</p>'+
    (c.notes?.length?'<details class="connection-notes"><summary>接入说明</summary><p>'+c.notes.map(esc).join('<br>')+'</p></details>':'')+'</div></div>'+
    (c.custom?'<div class="connection-buttons"><button class="button secondary" data-custom-edit="'+esc(c.agent)+'">编辑</button><button class="button secondary" data-custom-toggle="'+esc(c.agent)+'" data-enabled="'+(c.enabled?'0':'1')+'">'+(c.enabled?'停用':'启用')+'</button><button class="button secondary" data-custom-delete="'+esc(c.agent)+'">删除</button></div>':c.hookable?'<div class="connection-buttons">'+(c.hooked?'<button class="button secondary" data-connect="'+esc(c.agent)+'" data-operation="remove">移除 Hook</button>':'')+'<button class="button subtle" data-connect="'+esc(c.agent)+'" data-operation="install">'+(c.hooked?'重新接入':'接入 Hook')+'</button></div>':'')+'</div>').join('');
  $('#settings-page').innerHTML=    '<section class="settings-section"><h3>外观</h3><div class="setting-row"><div><h4>主题</h4><p id="theme-description"></p></div><select id="theme-setting" aria-label="外观模式"><option value="system">跟随系统</option><option value="light">日间 · 浅色</option><option value="dark">夜间 · 深色</option></select></div></section>'+
    '<section class="settings-section"><div class="settings-section-head"><h3>Agent 接入</h3><button class="button subtle" id="add-custom-session">＋ 添加 Agent</button></div>'+rows+'</section>'+
    '<section class="settings-section"><h3>通知与启动</h3><div class="setting-row"><div><h4>系统通知</h4><p>提醒已订阅会话的待处理请求。</p></div><input class="switch" id="notification-setting" type="checkbox" '+(state.settings.notifications?'checked':'')+' aria-label="Windows 系统通知"></div>'+
    '<div class="setting-row"><div><h4>开机启动</h4><p>登录 Windows 后在托盘运行。</p></div><input class="switch" id="startup-setting" type="checkbox" '+(state.settings.startAtLogin?'checked':'')+' aria-label="开机启动"></div>'+
    '<div class="setting-row"><div><h4>测试通知</h4></div><button class="button secondary" id="test-notification">发送测试</button></div></section>'+
    '<section class="settings-section"><h3>搜索与数据</h3><div class="setting-row"><div><h4>正文搜索</h4><p>在本机索引 Codex 与 Claude 的对话。</p><div id="index-progress" class="index-status"></div></div><input class="switch" id="search-setting" type="checkbox" '+(state.settings.contentSearchEnabled?'checked':'')+' aria-label="对话正文搜索"></div>'+
    '<div class="setting-row"><div><h4>本地数据</h4><details><summary>查看数据路径</summary><span class="data-path">'+esc(state.dataDir)+'</span></details></div><button class="button secondary" id="open-data">打开目录</button></div></section>';
  applyTheme(themePreference);
  $('#theme-setting').disabled=themeSaving;
  $('#theme-setting').onchange=e=>saveTheme(e.target.value);
  for(const [id,setting] of [['notification-setting','notifications'],['startup-setting','startAtLogin'],['search-setting','contentSearchEnabled']])$('#'+id).onchange=async e=>{
    const result=await perform(()=>window.inbox.settings({[setting]:e.target.checked}));
    if(result){receive(result);renderSettings();}else e.target.checked=!e.target.checked;
  };
  $('#test-notification').onclick=async()=>{const r=await perform(()=>window.inbox.system('notification-test'));if(r?.message)toast(r.message);};
  $('#open-data').onclick=()=>perform(()=>window.inbox.system('data'));
  $('#settings-page').querySelectorAll('[data-connect]').forEach(b=>b.onclick=()=>previewConnection(b.dataset.connect,b.dataset.operation));
  $('#add-custom-session').onclick=()=>openUsageAgentEditor(null,'session');
  $('#settings-page').querySelectorAll('[data-custom-edit]').forEach(b=>b.onclick=()=>{
    const source=state.connections.find(connection=>connection.agent===b.dataset.customEdit);
    if(source)openUsageAgentEditor(source,'session');
  });
  $('#settings-page').querySelectorAll('[data-custom-toggle]').forEach(b=>b.onclick=()=>void toggleUsageAgent(b.dataset.customToggle,b.dataset.enabled==='1'));
  $('#settings-page').querySelectorAll('[data-custom-delete]').forEach(b=>b.onclick=()=>void deleteUsageAgent(b.dataset.customDelete));
  updateSettingsStatus();
}

function usageDuration(ms){
  if(!Number.isFinite(ms)||ms<60000)return ms>0?'不足 1 分钟':'0 分钟';
  const totalMinutes=Math.round(ms/60000),hours=Math.floor(totalMinutes/60),minutes=totalMinutes%60;
  if(!hours)return `${minutes} 分钟`;
  return `${hours} 小时${minutes?` ${minutes} 分钟`:''}`;
}

function usageDurationShort(ms){
  if(!ms)return'—';
  if(ms<3600000)return `${Math.round(ms/60000)} 分`;
  const hours=ms/3600000;
  return `${hours>=10?hours.toFixed(1):hours.toFixed(2).replace(/0$/,'')} 小时`;
}

function usageDateLabel(date,full=false){
  const [year,month,day]=String(date).split('-').map(Number);
  return full?`${year}年${month}月${day}日`:`${month}/${day}`;
}

function usageChart(report){
  const width=720,height=232,left=42,right=704,top=20,bottom=198,plotHeight=bottom-top;
  const step=(right-left)/Math.max(1,report.daily.length),barWidth=Math.max(5,Math.min(50,step*.56));
  const max=Math.max(10*60000,...report.daily.map(day=>day.totalMs));
  const labelEvery=Math.max(1,Math.ceil(report.daily.length/7));
  const grid=[0,.5,1].map(ratio=>{
    const y=bottom-ratio*plotHeight;
    return `<line class="usage-chart-gridline" x1="${left}" y1="${y}" x2="${right}" y2="${y}"></line><text class="usage-chart-axis" x="${left-9}" y="${y+4}" text-anchor="end">${ratio?usageDurationShort(max*ratio):'0'}</text>`;
  }).join('');
  const bars=report.daily.map((day,index)=>{
    const x=left+step*index+(step-barWidth)/2,y=bottom-(day.totalMs/max)*plotHeight;
    return `<rect class="usage-chart-bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.max(0,bottom-y).toFixed(2)}" rx="${Math.min(4,barWidth/3).toFixed(2)}"><title>${esc(usageDateLabel(day.date,true))} · ${esc(usageDuration(day.totalMs))}</title></rect>`;
  }).join('');
  const points=report.daily.map((day,index)=>`${(left+step*(index+.5)).toFixed(2)},${(bottom-(day.totalMs/max)*plotHeight).toFixed(2)}`).join(' ');
  const labels=report.daily.map((day,index)=>{
    if(index%labelEvery!==0&&index!==report.daily.length-1)return'';
    return `<text class="usage-chart-label" x="${(left+step*(index+.5)).toFixed(2)}" y="222" text-anchor="middle">${usageDateLabel(day.date)}</text>`;
  }).join('');
  return `<svg class="usage-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="每日合并活动时长趋势，${esc(usageDateLabel(report.startDate))}至${esc(usageDateLabel(report.endDate))}">
    ${grid}${bars}<polyline class="usage-chart-line" points="${points}"></polyline>${labels}
  </svg>`;
}

function renderUsage(){
  const page=$('#usage-page'),report=usageState.report;
  if(!report){
    page.innerHTML=`<div class="usage-loading" aria-busy="true"><div class="usage-loading-mark">${icon('chart')}</div><h2>${usageState.error?'暂时无法读取统计':'正在汇总本地 Agent 活动'}</h2><p>${usageState.error?esc(usageState.error):'读取内置及自定义 Agent 的本地时间戳，并合并并行活动。'}</p>${usageState.error?'<button class="button secondary" id="usage-retry">重新读取</button>':''}</div>`;
    $('#usage-retry')?.addEventListener('click',()=>void loadUsage(usageState.days));
    return;
  }
  const sourceRows=report.providers.map(provider=>{
    const stateLabel=!provider.enabled?'已停用':provider.error?provider.error:!provider.measurable?'未计入':provider.available?`${provider.files} 个近期会话`:'未发现本地记录';
    const sourceActions=provider.editable?`<div class="usage-source-actions">
      <button class="button secondary usage-source-button" data-usage-agent-edit="${esc(provider.id)}">编辑</button>
      <button class="button secondary usage-source-button" data-usage-agent-toggle="${esc(provider.id)}" data-enabled="${provider.enabled?'0':'1'}">${provider.enabled?'停用':'启用'}</button>
      <button class="button secondary usage-source-button" data-usage-agent-delete="${esc(provider.id)}">删除</button>
    </div>`:'';
    return `<article class="usage-source ${provider.measurable?'':'excluded'}" data-source-id="${esc(provider.id)}">
      <div class="usage-source-head">${symbol({agent:provider.id,name:provider.name,custom:provider.custom})}<div><h3>${esc(provider.name)}</h3><p>${esc(stateLabel)}</p></div><strong>${provider.measurable?esc(usageDuration(provider.durationMs)):'—'}</strong></div>
      ${provider.measurable?`<progress class="usage-source-progress" max="100" value="${Math.min(100,Math.round(provider.ratio*100))}" aria-label="${esc(provider.name)}独立时长占合并时长 ${Math.round(provider.ratio*100)}%"></progress>`:''}
      <p class="usage-source-note">${esc(provider.note)}</p>
      ${provider.error?`<p class="usage-source-error">${esc(provider.error)}</p>`:''}
      ${provider.custom?`<p class="usage-source-path">${esc(provider.path)} · ${esc(provider.timestampField)} · ${esc(provider.timestampUnit)}</p>`:''}
      ${sourceActions}
    </article>`;
  }).join('');
  const tableProviders=report.providers.filter(provider=>provider.measurable&&provider.enabled);
  const tableHead=tableProviders.map(provider=>`<th scope="col">${esc(provider.name)}</th>`).join('');
  const tableRows=[...report.daily].reverse().map(day=>`<tr><th scope="row">${esc(usageDateLabel(day.date,true))}</th>${tableProviders.map(provider=>`<td>${esc(usageDurationShort(day.providers[provider.id]||0))}</td>`).join('')}<td><strong>${esc(usageDurationShort(day.totalMs))}</strong></td></tr>`).join('');
  const updated=report.generatedAt?new Date(report.generatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'刚刚';
  const errors=report.errors.length?`<div class="usage-errors"><strong>部分记录未能读取</strong><p>${report.errors.map(esc).join('<br>')}</p></div>`:'';
  page.innerHTML=`<div class="usage-page-head">
      <div><p class="usage-kicker">AGENT ACTIVITY</p><h2>每天的专注轨迹</h2><p class="usage-intro">用本地会话时间估算 Agent 活动。并行任务会合并计时，不会把多开窗口重复算成双倍时间。</p></div>
      <div class="usage-period" role="group" aria-label="统计周期">${[7,14,30].map(days=>`<button data-usage-days="${days}" class="${usageState.days===days?'active':''}" aria-pressed="${usageState.days===days}">${days} 天</button>`).join('')}</div>
    </div>
    <div class="usage-meta"><span>${esc(usageDateLabel(report.startDate,true))} — ${esc(usageDateLabel(report.endDate,true))}</span><span>${usageState.loading?'正在更新':`更新于 ${updated}`}</span></div>
    <section class="usage-metrics" aria-label="使用统计概览">
      <article><span>合并活动时长</span><strong>${esc(usageDuration(report.totalMs))}</strong><p>多 Agent 并行时间已去重</p></article>
      <article><span>有活动天数</span><strong>${report.activeDays} <small>/ ${report.days} 天</small></strong><p>只计算至少出现一次记录的日子</p></article>
      <article><span>活跃日均</span><strong>${esc(usageDuration(report.averageActiveDayMs))}</strong><p>总时长 ÷ 有活动天数</p></article>
      <article><span>单日最长</span><strong>${report.longestDay?esc(usageDuration(report.longestDay.totalMs)):'0 分钟'}</strong><p>${report.longestDay?esc(usageDateLabel(report.longestDay.date,true)):'暂无记录'}</p></article>
    </section>
    <section class="usage-panel usage-trend-panel"><div class="usage-panel-title"><div><h3>每日趋势</h3><p>柱形与折线均表示去重后的合并活动时长</p></div><span>${report.eventCount} 个活动时间点</span></div>${usageChart(report)}</section>
    <section class="usage-panel"><div class="usage-panel-title"><div><h3>来源分布</h3><p>各来源独立时长可以重叠，占比仅用于观察活跃来源</p></div><div class="usage-panel-actions"><span>${report.providers.filter(provider=>provider.custom).length} 个自定义</span><button class="button subtle usage-source-button" id="usage-agent-add">＋ 添加 Agent</button></div></div><div class="usage-sources">${sourceRows}</div></section>
    <section class="usage-panel"><div class="usage-panel-title"><div><h3>每日明细</h3><p>切换统计周期时会复用最近记录，只读本地文件</p></div></div><div class="usage-table-wrap"><table class="usage-table"><thead><tr><th scope="col">日期</th>${tableHead}<th scope="col">去重总时长</th></tr></thead><tbody>${tableRows}</tbody></table></div></section>
    ${errors}
    <p class="usage-footnote">${esc(report.explanation)} 这不是前台挂机时间，也不包含 ${esc(report.timeZone)} 之外的历史口径转换。</p>`;
  page.querySelectorAll('[data-usage-days]').forEach(button=>button.addEventListener('click',()=>{
    const days=Number(button.dataset.usageDays);
    if(days!==usageState.days)void loadUsage(days);
  }));
  $('#usage-agent-add')?.addEventListener('click',()=>openUsageAgentEditor(null,'usage'));
  page.querySelectorAll('[data-usage-agent-edit]').forEach(button=>button.addEventListener('click',()=>{
    const provider=usageState.report?.providers.find(item=>item.id===button.dataset.usageAgentEdit);
    if(provider)openUsageAgentEditor(provider,'usage');
  }));
  page.querySelectorAll('[data-usage-agent-toggle]').forEach(button=>button.addEventListener('click',()=>void toggleUsageAgent(button.dataset.usageAgentToggle,button.dataset.enabled==='1')));
  page.querySelectorAll('[data-usage-agent-delete]').forEach(button=>button.addEventListener('click',()=>void deleteUsageAgent(button.dataset.usageAgentDelete)));
}

function openUsageAgentEditor(provider,mode='usage'){
  usageAgentMode=mode==='session'?'session':'usage';
  $('#usage-agent-form').reset();
  $('#usage-agent-id').value=provider?.id||'';
  $('#usage-agent-name').value=provider?.name||'';
  $('#usage-agent-path').value=provider?.path||'';
  $('#usage-agent-pattern').value=provider?.filePattern||'*.jsonl';
  $('#usage-agent-field').value=provider?.timestampField||'timestamp';
  $('#usage-agent-unit').value=provider?.timestampUnit||'auto';
  $('#usage-agent-enabled').checked=provider?provider.enabled:true;
  $('#usage-agent-session-id-field').value=provider?.sessionIdField||'session_id';
  $('#usage-agent-event-field').value=provider?.eventTypeField||'type';
  $('#usage-agent-title-field').value=provider?.titleField||'title';
  $('#usage-agent-cwd-field').value=provider?.cwdField||'cwd';
  $('#usage-agent-summary-field').value=provider?.summaryField||'summary';
  $('#usage-agent-request-field').value=provider?.requestIdField||'request_id';
  $('#usage-agent-jump-url').value=provider?.jumpUrl||'';
  const sessionMode=usageAgentMode==='session';
  $('#usage-agent-session-fields').hidden=!sessionMode;
  if(sessionMode)$('#usage-agent-session-fields').open=true;
  $('.usage-agent-intro').textContent=sessionMode
    ?'添加本地 JSONL Agent 会话来源，并同时计入使用统计。会话 ID、状态和时间字段都可以映射。'
    :'只读统计本地记录中的时间戳。首版支持 JSONL 或逐行 JSON 文件，保存后立即刷新统计。';
  $('#usage-agent-title').textContent=sessionMode?(provider?'编辑 Agent 会话':'添加 Agent'):(provider?'编辑 Agent':'添加 Agent 统计');
  $('#usage-agent-save').textContent=sessionMode?(provider?'保存修改':'添加并扫描'):(provider?'保存修改':'保存并统计');
  if(!$('#usage-agent-dialog').open)$('#usage-agent-dialog').showModal();
  setTimeout(()=>$('#usage-agent-name').focus(),20);
}

function closeUsageAgentEditor(){$('#usage-agent-dialog').close();}

async function pickUsageAgentPath(kind){
  const result=await perform(()=>window.inbox.usageSource({action:'select-path',kind,path:$('#usage-agent-path').value.trim()}));
  if(!result?.path)return;
  $('#usage-agent-path').value=result.path;
  if(kind==='file'){
    const filename=result.path.split(/[\\/]/).pop()||'';
    const dot=filename.lastIndexOf('.');
    if(dot>0&&!filename.slice(dot).includes('?'))$('#usage-agent-pattern').value=`*${filename.slice(dot)}`;
  }
}

async function saveUsageAgent(event){
  event.preventDefault();
  const button=$('#usage-agent-save');
  button.disabled=true;
  const agent={
    id:$('#usage-agent-id').value,
    name:$('#usage-agent-name').value.trim(),
    path:$('#usage-agent-path').value.trim(),
    filePattern:$('#usage-agent-pattern').value.trim(),
    timestampField:$('#usage-agent-field').value.trim(),
    timestampUnit:$('#usage-agent-unit').value,
    enabled:$('#usage-agent-enabled').checked,
    ...(usageAgentMode==='session'?{
      scanSessions:true,
      sessionIdField:$('#usage-agent-session-id-field').value.trim(),
      eventTypeField:$('#usage-agent-event-field').value.trim(),
      titleField:$('#usage-agent-title-field').value.trim(),
      cwdField:$('#usage-agent-cwd-field').value.trim(),
      summaryField:$('#usage-agent-summary-field').value.trim(),
      requestIdField:$('#usage-agent-request-field').value.trim(),
      jumpUrl:$('#usage-agent-jump-url').value.trim(),
    }:{}),
  };
  const action=usageAgentMode==='session'?'save-session':'save';
  const result=await perform(()=>window.inbox.usageSource({action,agent}));
  button.disabled=false;
  if(!result)return;
  closeUsageAgentEditor();
  receive(result);
  if(usageAgentMode==='session'){
    renderSettings();
    toast(agent.id?'已更新 Agent 会话':'已添加 Agent，正在扫描本地会话');
    return;
  }
  usageState.report=null;
  await loadUsage();
  toast(agent.id?'已更新自定义 Agent':'已添加自定义 Agent，正在重新统计');
}

async function toggleUsageAgent(id,enabled){
  const result=await perform(()=>window.inbox.usageSource({action:'toggle',id,enabled}));
  if(!result)return;
  receive(result);
  if(view==='settings')renderSettings();
  usageState.report=null;
  if(view==='usage')await loadUsage();
  toast(enabled?(view==='settings'?'已启用 Agent 会话扫描':'已启用并重新统计'):'已停用此来源');
}

async function deleteUsageAgent(id){
  const provider=usageState.report?.providers.find(item=>item.id===id)||state.connections.find(item=>item.agent===id);
  if(!provider||!window.confirm(`删除“${provider.name}”？这会移除会话扫描与使用统计配置，但不会删除本地记录。`))return;
  const result=await perform(()=>window.inbox.usageSource({action:'delete',id}));
  if(!result)return;
  receive(result);
  if(view==='settings')renderSettings();
  usageState.report=null;
  if(view==='usage')await loadUsage();
  toast('已删除自定义 Agent');
}

async function loadUsage(days=usageState.days){
  const normalized=[7,14,30].includes(Number(days))?Number(days):7;
  const sequence=++usageState.sequence;
  usageState={...usageState,days:normalized,loading:true,error:''};
  renderUsage();
  const report=await perform(()=>window.inbox.usage(normalized));
  if(sequence!==usageState.sequence)return;
  usageState.loading=false;
  if(report)usageState.report=report;
  else usageState.error='统计读取失败，请稍后重试。';
  renderUsage();
}

function updateSettingsStatus(){if(!$('#index-progress'))return;$('#index-progress').textContent=state.settings.contentSearchEnabled?(state.index.busy?`正在索引 ${state.index.completed||0} / ${state.index.total||0} 个记录`:`正文搜索已开启${state.index.failed?` · ${state.index.failed} 个记录暂未索引`:''}`):'';for(const c of state.connections){const el=$('#connection-'+c.agent);if(el)el.textContent=connectionStatus(c);}}

async function previewConnection(agent,operation){const result=await perform(()=>window.inbox.connection(agent,operation==='remove'?'preview-remove':'preview'));if(!result)return;connection={agent,operation};$('#dialog-title').textContent=`${operation==='remove'?'移除':'接入'} ${name({agent})} Hook`;$('#dialog-description').textContent=operation==='remove'?'仅移除此应用写入的 Hook 和 notify 包装，保留其他设置。变更前会创建备份。':'将写入下列客户端配置，并备份已有内容。Hook 只上报状态，授权和回答仍在原客户端中处理。';$('#connection-preview').innerHTML=result.files.length?result.files.map(f=>`<div class="preview-file"><strong>${esc(f.path)}</strong>${operation==='remove'?'':`<pre>${esc(f.preview)}</pre>`}</div>`).join(''):'<p>当前配置无需修改。</p>';$('#dialog-confirm').textContent=operation==='remove'?'移除并备份':'接入并备份配置';$('#connection-dialog').showModal();}
$('#dialog-close').onclick=$('#dialog-cancel').onclick=()=>$('#connection-dialog').close();
$('#dialog-confirm').onclick=async()=>{const button=$('#dialog-confirm');button.disabled=true;const result=await perform(()=>window.inbox.connection(connection.agent,connection.operation));button.disabled=false;if(result){receive(result.snapshot);renderSettings();$('#connection-dialog').close();toast(result.message);}};
$('#usage-agent-close').onclick=$('#usage-agent-cancel').onclick=closeUsageAgentEditor;
$('#usage-pick-file').onclick=()=>void pickUsageAgentPath('file');
$('#usage-pick-directory').onclick=()=>void pickUsageAgentPath('directory');
$('#usage-agent-form').addEventListener('submit',saveUsageAgent);
document.querySelectorAll('[data-view]').forEach(el=>el.onclick=()=>setView(el.dataset.view));
$('#minimize').onclick=()=>window.inbox.system('minimize');$('#hide').onclick=()=>window.inbox.system('hide');
$('#refresh').onclick=async()=>{const b=$('#refresh');b.disabled=true;if(view==='usage'){await loadUsage();b.disabled=false;return;}const result=await perform(()=>window.inbox.system('refresh'));b.disabled=false;if(result)receive(result);};
$('#search').oninput=e=>{query=e.target.value;contentMatches={};renderList();clearTimeout(searchTimer);const sequence=++searchSequence;searchTimer=setTimeout(async()=>{if(!state.settings.contentSearchEnabled)return;const matches=await perform(()=>window.inbox.search(query));if(sequence===searchSequence&&matches){contentMatches=matches;renderList();}},220);};
$('#agent-filter').onchange=$('#status-filter').onchange=renderList;
document.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='k'&&['inbox','waiting','all','handled'].includes(view)){e.preventDefault();$('#search').focus();}if(e.key==='Escape'&&!$('#connection-dialog').open&&!$('#usage-agent-dialog').open&&['inbox','waiting','all','handled'].includes(view)){selected='';renderList();}});
window.inbox.onUpdate(receive);window.inbox.snapshot().then(receive).catch(e=>toast(e.message));
