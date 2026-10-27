export const TEAM_EDITOR_HTML = String.raw`
<dialog id="team-editor" aria-labelledby="team-editor-title"><form id="team-editor-form" class="migration-body">
  <h2 id="team-editor-title"></h2><p id="team-editor-target" class="maintenance-note"></p>
  <div id="team-editor-fields"></div><p id="team-editor-error" role="alert" class="team-error"></p>
  <details id="team-editor-latest" hidden><summary>服务器最新版本（你的草稿仍保留）</summary><div id="team-editor-latest-body"></div></details>
  <div class="remote-sync-actions"><button id="team-editor-compare" type="button" class="secondary-button" hidden>读取最新版本</button><button id="team-editor-rebase" type="button" class="secondary-button" hidden>已核对，以最新版本提交草稿</button></div>
  <div class="dialog-actions"><button id="team-editor-cancel" type="button" class="secondary-button">关闭</button><button id="team-editor-save" class="primary-button" type="submit">保存到团队</button></div>
</form></dialog>
<dialog id="team-history" aria-labelledby="team-history-title"><div class="migration-body"><h2 id="team-history-title">共享历史</h2><p id="team-history-target" class="maintenance-note"></p><p id="team-history-status" role="status"></p><div id="team-history-items"></div><div class="remote-sync-actions"><button id="team-history-prev" class="secondary-button" type="button">上一页</button><button id="team-history-next" class="secondary-button" type="button">下一页</button><button id="team-history-close" class="secondary-button" type="button">关闭</button></div></div></dialog>`;

export const TEAM_WORKSPACE_CSS = String.raw`
#team-view { max-width:1280px; margin:auto; padding:24px; min-width:0; height:100%; overflow-y:auto; }
.app-header .view-tabs { min-width:0; max-width:100%; overflow-x:auto; justify-content:flex-start; }
.app-header .view-tabs .tab { flex:0 0 auto; white-space:nowrap; }
#team-view .team-toolbar { display:flex; align-items:end; gap:12px; flex-wrap:wrap; margin:12px 0; }
#team-view .team-toolbar .field { flex:1 1 180px; margin:0; }
#team-view .team-list { display:grid; gap:10px; margin:12px 0; }
#team-view .team-list p { white-space:pre-wrap; }
#team-view .team-list .remote-sync-actions { margin-top:12px; }
#team-view .team-page { display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
#team-view .team-section { margin-top:24px; padding-top:12px; border-top:1px solid var(--line); }
#team-editor, #team-history { width:min(760px,calc(100vw - 32px)); max-height:calc(100dvh - 32px); overflow:auto; }
#team-editor .migration-body, #team-history .migration-body { min-width:0; padding:24px; }
#team-editor .field { margin:12px 0; min-width:0; }
#team-editor textarea, #team-editor input, #team-editor select { display:block; width:100%; max-width:100%; min-width:0; }
#team-editor textarea { min-height:90px; resize:vertical; }
#team-editor p, #team-editor h2, #team-history p, #team-history h2 { overflow-wrap:anywhere; }
#team-editor-latest-body p, #team-history-items p { white-space:pre-wrap; }
#team-editor pre, #team-history pre { white-space:pre-wrap; overflow-wrap:anywhere; max-width:100%; font-size:12px; }
.team-error { color:#a32c24; white-space:pre-wrap; overflow-wrap:anywhere; }
#team-history-items { display:grid; gap:12px; margin:16px 0; }
#team-view [hidden], #team-editor [hidden], #team-history [hidden] { display:none !important; }
@media(max-width:700px) { #team-view { padding:16px; } #team-editor .migration-body, #team-history .migration-body { padding:16px; } }
`;

export const TEAM_WORKSPACE_JS = String.raw`
  var teamEditor = null, teamHistoryState = null, teamCollectionSequence = 0;
  var teamOffsets = {tasks:0,rules:0}, teamCollections = {tasks:[],rules:[]};
  function teamSelectedShare() { return teamShares.find(function(s) { return s.shareId === remoteElement("team-review-share").value; }); }
  function teamTarget() { var s=teamSelectedShare(); return s ? s.name + " · " + remoteElement("team-data-source").textContent : "未选择共享项目"; }
  function teamCapture() { return {shareId:remoteElement("team-review-share").value,connectionId:teamConnectionId}; }
  function teamCurrent(target) { return !teamConnectionSaving && target.connectionId===teamConnectionId && target.shareId===remoteElement("team-review-share").value; }
  function teamRequest(target, action, args, write) {
    if (!teamCurrent(target)) return Promise.reject(new Error("连接或共享项目已经变化，请关闭后重新打开。"));
    var path=teamUrl("/api/team/"+encodeURIComponent(target.shareId)+"/"+action,target.connectionId);
    if (!write) Object.keys(args || {}).forEach(function(key) { path += "&"+encodeURIComponent(key)+"="+encodeURIComponent(args[key]); });
    return fetchJson(path,write ? {method:"POST",body:args} : undefined);
  }
  function teamButton(label, action) { var b=element("button","secondary-button",label); b.type="button"; b.addEventListener("click",action); return b; }
  function teamSnapshot(container, record) {
    container.replaceChildren();
    container.append(element("p","",record.title||record.goal||""));
    container.append(element("p","",record.content||(record.checkpoint&&record.checkpoint.summary)||"尚无说明"));
    var cp=record.checkpoint;
    if(cp)["completed","next","blockers","risks","changedFiles"].forEach(function(key,i){if(cp[key]&&cp[key].length)container.append(element("p","",["已完成","下一步","阻塞","风险","修改文件"][i]+"：\n"+cp[key].join("\n")));});
    if(cp&&cp.verification&&cp.verification.length)container.append(element("p","","验证记录：\n"+cp.verification.map(function(v){return v.command+" · "+v.status+(v.summary?" · "+v.summary:"");}).join("\n")));
    container.append(element("p","maintenance-note","更新时间："+formatDate(record.updatedAt)));
  }
  function bindTeamWorkspace() {
    document.body.append(remoteElement("remote-confirm-dialog"));
    remoteElement("open-team-workspace").onclick=function(){switchView("team");};
    remoteElement("team-new-memory").onclick=function(){openTeamEditor("propose");};
    remoteElement("team-new-task").onclick=function(){openTeamEditor("task-start");};
    remoteElement("team-new-rule").onclick=function(){openTeamEditor("rule-put");};
    ["tasks","rules"].forEach(function(kind){
      remoteElement("team-"+kind+"-status").onchange=function(){teamOffsets[kind]=0;loadTeamCollections();};
      remoteElement("team-"+kind+"-prev").onclick=function(){teamOffsets[kind]=Math.max(0,teamOffsets[kind]-20);loadTeamCollections();};
      remoteElement("team-"+kind+"-next").onclick=function(){teamOffsets[kind]+=20;loadTeamCollections();};
    });
    remoteElement("team-memory-search").onsubmit=function(event){event.preventDefault();loadTeamMemories();};
    remoteElement("team-editor-form").onsubmit=saveTeamEditor;
    remoteElement("team-editor-cancel").onclick=function(){remoteElement("team-editor").close();};
    remoteElement("team-editor").onclose=function(){teamEditor=null;};
    remoteElement("team-editor").oncancel=function(event){if(teamEditor&&teamEditor.busy)event.preventDefault();};
    remoteElement("team-editor-compare").onclick=compareTeamEditor;
    remoteElement("team-editor-rebase").onclick=function(){
      if (!teamEditor || !teamEditor.latest) return;
      teamEditor.record=teamEditor.latest; teamEditor.latest=null; teamEditor.requestId=null;teamEditor.payload=null;
      remoteElement("team-editor-error").textContent="已采用最新版本号，草稿内容保留。请检查完整内容后再次保存。";
      remoteElement("team-editor-rebase").hidden=true; remoteElement("team-editor-save").disabled=false;
    };
    remoteElement("team-history-close").onclick=function(){remoteElement("team-history").close();};
    remoteElement("team-history").onclose=function(){teamHistoryState=null;};
    remoteElement("team-history-prev").onclick=function(){if(teamHistoryState){teamHistoryState.offset=Math.max(0,teamHistoryState.offset-20);loadTeamHistory();}};
    remoteElement("team-history-next").onclick=function(){if(teamHistoryState){teamHistoryState.offset+=20;loadTeamHistory();}};
  }
  function teamPermissions() {
    var s=teamSelectedShare(),write=s&&s.role!=="viewer",review=s&&(s.role==="owner"||s.role==="reviewer");
    remoteElement("team-new-memory").hidden=!write; remoteElement("team-new-task").hidden=!write; remoteElement("team-new-rule").hidden=!review;
  }
  function clearTeamCollections() {
    teamCollectionSequence++; teamCollections={tasks:[],rules:[]}; teamOffsets={tasks:0,rules:0};
    ["tasks","rules"].forEach(function(kind){remoteElement("team-"+kind+"-items").replaceChildren();remoteElement("team-"+kind+"-page").textContent="";["prev","next"].forEach(function(dir){remoteElement("team-"+kind+"-"+dir).disabled=true;});});
    ["team-new-memory","team-new-task","team-new-rule"].forEach(function(id){remoteElement(id).hidden=true;});
  }
  async function loadTeamMemories() {
    var target=teamCapture(), sequence=++teamMemorySequence, query=remoteElement("team-memory-query").value.trim();
    try { var data=await teamRequest(target,"memories",{query:query,limit:100}); if(teamCurrent(target)&&sequence===teamMemorySequence) renderTeamMemories(data,100); return true; }
    catch(error){if(teamCurrent(target)&&sequence===teamMemorySequence){remoteElement("team-knowledge-items").replaceChildren(element("p","team-error",error.message));}}
  }
  function renderTeamMemories(records,limit) {
    var c=remoteElement("team-knowledge-items");c.replaceChildren();
    c.append(element("p","maintenance-note","共享记忆 · "+records.length+" 条（最多 "+limit+" 条，可搜索缩小范围）"));
    if(!records.length)c.append(element("p","maintenance-note","暂无匹配的共享记忆。"));
    records.forEach(function(record){var d=element("details","remote-backup-record");d.append(element("summary","",record.title),element("p","",record.content),element("p","maintenance-note","类型："+record.type+" · "+record.id));c.append(d);});
  }
  async function loadTeamCollections() {
    var target=teamCapture(),sequence=++teamCollectionSequence;if(!target.shareId)return;
    teamPermissions();
    ["tasks","rules"].forEach(function(kind){remoteElement("team-"+kind+"-items").replaceChildren(element("p","maintenance-note","正在读取…"));["prev","next"].forEach(function(dir){remoteElement("team-"+kind+"-"+dir).disabled=true;});});
    var results=await Promise.allSettled(["tasks","rules"].map(function(kind){return teamRequest(target,kind,{status:remoteElement("team-"+kind+"-status").value,limit:20,offset:teamOffsets[kind]});}));
    if(!teamCurrent(target)||sequence!==teamCollectionSequence)return;
    results.forEach(function(result,i){var kind=["tasks","rules"][i],container=remoteElement("team-"+kind+"-items");container.replaceChildren();
      if(result.status==="rejected"){remoteElement("team-"+kind+"-page").textContent="读取失败";container.append(element("p","team-error",result.reason.message));return;}
      var data=result.value;teamCollections[kind]=data.items;
      remoteElement("team-"+kind+"-page").textContent="显示 "+(data.items.length?data.offset+1:0)+"–"+(data.offset+data.items.length)+" / "+data.total;
      remoteElement("team-"+kind+"-prev").disabled=data.offset===0;remoteElement("team-"+kind+"-next").disabled=data.offset+data.items.length>=data.total;
      if(!data.items.length)container.append(element("p","maintenance-note","当前筛选下暂无内容。"));
      data.items.forEach(function(record){renderTeamRecord(container,kind,record,target);});
    });
    return results.every(function(result){return result.status==="fulfilled";});
  }
  function renderTeamRecord(container,kind,record,target) {
    var item=element("details","remote-backup-record"),actions=element("div","remote-sync-actions"),s=teamSelectedShare();
    item.append(element("summary","",record.title||record.goal));
    item.append(element("p","",record.content||(record.checkpoint&&record.checkpoint.summary)||"尚无进度说明"));
    if(record.checkpoint)["completed","next","blockers","risks","changedFiles"].forEach(function(key,i){if(record.checkpoint[key]&&record.checkpoint[key].length)item.append(element("p","",["已完成","下一步","阻塞","风险","修改文件"][i]+"：\n"+record.checkpoint[key].join("\n")));});
    item.append(element("p","maintenance-note","版本 "+record.version+" · "+({in_progress:"进行中",completed:"已完成",cancelled:"已取消",active:"生效中",deleted:"已停用"}[record.status]||record.status)+" · "+record.id));
    if(kind==="tasks"&&s.role!=="viewer"&&record.status==="in_progress"){
      actions.append(teamButton("更新进度",function(){if(teamCurrent(target))openTeamEditor("task-checkpoint",record);}));
      ["completed","cancelled"].forEach(function(status){actions.append(teamButton(status==="completed"?"完成计划":"取消计划",function(){teamTransition(target,"task-finish",{taskId:record.id,expectedVersion:record.version,status:status},record.goal);}));});
    }
    if(kind==="rules"&&(s.role==="owner"||s.role==="reviewer")){
      actions.append(teamButton(record.status==="deleted"?"编辑并恢复":"编辑规则",function(){if(teamCurrent(target))openTeamEditor("rule-put",record);}));
      if(record.status==="active")actions.append(teamButton("停用规则",function(){teamTransition(target,"rule-disable",{ruleId:record.id,expectedVersion:record.version},record.title);}));
    }
    actions.append(teamButton("查看历史",function(){if(teamCurrent(target))openTeamHistory(kind,record,target);}));item.append(actions);container.append(item);
  }
  async function teamTransition(target,action,args,title) {
    if(!teamCurrent(target)||!await confirmRemoteOperation("目标："+teamTarget()+"\n"+title+"\n确认"+(action==="rule-disable"?"停用规则":args.status==="completed"?"完成计划":"取消计划")+"？历史记录将保留。"))return;
    try {await teamRequest(target,action,args,true);if(teamCurrent(target))await loadTeamCollections();}
    catch(error){if(teamCurrent(target)){remoteElement("team-review-status").textContent=error.code==="TEAM_VERSION_CONFLICT"?"内容已被其他成员修改，请刷新后核对最新版本再操作。":error.message;}}
  }
  function teamField(name,label,value,max,large) {
    var box=element("div","field"),l=element("label","",label),input=document.createElement(large?"textarea":"input");input.id="team-field-"+name;input.name=name;input.value=value||"";input.maxLength=max;l.htmlFor=input.id;box.append(l,input);remoteElement("team-editor-fields").append(box);return input;
  }
  function openTeamEditor(action,record) {
    var target=teamCapture();if(!target.shareId)return;
    teamEditor={action:action,target:target,record:record||null,requestId:null,payload:null,busy:false};
    remoteElement("team-editor-title").textContent={propose:"提议共享记忆","task-start":"创建共享计划","task-checkpoint":"更新共享进度","rule-put":record?"编辑共享规则":"创建共享规则"}[action];
    remoteElement("team-editor-target").textContent="写入目标："+teamTarget();remoteElement("team-editor-fields").replaceChildren();remoteElement("team-editor-error").textContent="";
    ["team-editor-compare","team-editor-rebase","team-editor-latest"].forEach(function(id){remoteElement(id).hidden=true;});remoteElement("team-editor-save").disabled=false;
    if(action==="task-start")teamField("goal","计划目标", "",8000,true).required=true;
    else if(action==="task-checkpoint"){
      var cp=record.checkpoint||{};teamField("summary","进度说明",cp.summary,8000,true);
      ["completed","next","blockers","risks"].forEach(function(key,i){teamField(key,["已完成（每行一项）","下一步（每行一项）","阻塞（每行一项）","风险（每行一项）"][i],(cp[key]||[]).join("\n"),60000,true);});
      remoteElement("team-editor-fields").append(element("p","maintenance-note","修改文件和验证记录保留原值；未改动的列表保留原始条目。"));
    }else{
      teamField("title","标题",record&&record.title,500,false).required=true;teamField("content","正文",record&&record.content,action==="propose"?32000:16000,true).required=true;
      if(action==="propose"){
        var box=element("div","field"),label=element("label","","记忆类型"),select=document.createElement("select");select.id="team-field-type";label.htmlFor=select.id;
        types.forEach(function(t){addOption(select,t[0],t[1]);});select.value="decision";box.append(label,select);remoteElement("team-editor-fields").append(box,element("p","maintenance-note","默认团队共享决策和约束；其他类型须管理员开启。提交后进入审核队列。"));
      }
    }
    remoteElement("team-editor").showModal();remoteElement("team-editor-fields").querySelector("input,textarea").focus();
  }
  async function saveTeamEditor(event) {
    event.preventDefault();var editor=teamEditor;if(!editor||editor.busy)return;var args={},value=function(key){return remoteElement("team-field-"+key).value;};
    if(editor.action==="task-start")args.goal=value("goal");
    else if(editor.action==="task-checkpoint"){
      var cp=Object.assign({},editor.record.checkpoint,{summary:value("summary")});
      ["completed","next","blockers","risks"].forEach(function(key){var raw=value(key),old=editor.record.checkpoint[key]||[];cp[key]=raw===old.join("\n")?old:raw.split("\n").map(function(v){return v.trim();}).filter(Boolean);});
      var payload=JSON.stringify(cp);if(payload!==editor.payload){editor.payload=payload;editor.requestId=crypto.randomUUID();}
      args={taskId:editor.record.id,expectedVersion:editor.record.version,requestId:editor.requestId,checkpoint:cp};
    }else{args={title:value("title"),content:value("content")};if(editor.action==="propose")args.type=value("type");else if(editor.record){args.ruleId=editor.record.id;args.expectedVersion=editor.record.version;}}
    editor.busy=true;remoteElement("team-editor-save").disabled=true;remoteElement("team-editor-cancel").disabled=true;remoteElement("team-editor-error").textContent="正在保存…";
    try {await teamRequest(editor.target,editor.action,args,true);if(teamEditor!==editor)return;if(teamCurrent(editor.target))await loadTeamReview();if(teamEditor===editor)remoteElement("team-editor").close();toast("已保存到团队项目");}
    catch(error){if(teamEditor!==editor)return;remoteElement("team-editor-error").textContent=error.code==="TEAM_VERSION_CONFLICT"?"其他成员已经更新内容。草稿已保留，请读取最新版本并核对。":error.message+(error.httpStatus?"":"。连接中断时结果可能已保存；新建内容请先刷新列表核对，避免重复创建。");
      remoteElement("team-editor-compare").hidden=error.code!=="TEAM_VERSION_CONFLICT";
      remoteElement("team-editor-save").disabled=error.code==="TEAM_VERSION_CONFLICT";
    }finally{editor.busy=false;remoteElement("team-editor-cancel").disabled=false;}
  }
  async function compareTeamEditor() {
    var editor=teamEditor;if(!editor||!editor.record)return;
    try {var result=await teamRequest(editor.target,editor.action==="task-checkpoint"?"task":"rule-history",editor.action==="task-checkpoint"?{taskId:editor.record.id}:{ruleId:editor.record.id,limit:1,offset:0});if(teamEditor!==editor)return;
      editor.latest=editor.action==="task-checkpoint"?result:result.items[0];remoteElement("team-editor-latest").hidden=false;remoteElement("team-editor-latest").open=true;teamSnapshot(remoteElement("team-editor-latest-body"),editor.latest);
      remoteElement("team-editor-rebase").hidden=editor.action==="task-checkpoint"&&editor.latest.status!=="in_progress";
    }catch(error){if(teamEditor===editor)remoteElement("team-editor-error").textContent=error.message;}
  }
  function openTeamHistory(kind,record,target){teamHistoryState={kind:kind,record:record,target:target,offset:0,sequence:0};remoteElement("team-history-target").textContent=teamTarget()+" · "+(record.title||record.goal);remoteElement("team-history").showModal();loadTeamHistory();}
  async function loadTeamHistory(){
    var s=teamHistoryState;if(!s)return;var sequence=++s.sequence;remoteElement("team-history-items").replaceChildren();remoteElement("team-history-status").textContent="正在读取历史…";["prev","next"].forEach(function(d){remoteElement("team-history-"+d).disabled=true;});
    try{var args={limit:20,offset:s.offset};args[s.kind==="tasks"?"taskId":"ruleId"]=s.record.id;var data=await teamRequest(s.target,s.kind==="tasks"?"task-history":"rule-history",args);if(teamHistoryState!==s||sequence!==s.sequence)return;
      remoteElement("team-history-status").textContent="本页 "+data.items.length+" / 共 "+data.total;data.items.forEach(function(record){var d=element("details","remote-backup-record"),body=element("div","");teamSnapshot(body,record.snapshot||record);d.append(element("summary","","版本 "+(record.version||record.sequence)+" · "+({created:"创建",checkpoint:"进度更新",completed:"完成",cancelled:"取消",active:"生效",deleted:"停用"}[record.kind||record.status]||"历史记录")),body);remoteElement("team-history-items").append(d);});
      remoteElement("team-history-prev").disabled=s.offset===0;remoteElement("team-history-next").disabled=s.offset+data.items.length>=data.total;
    }catch(error){if(teamHistoryState===s)remoteElement("team-history-status").textContent=error.message;}
  }
`;
