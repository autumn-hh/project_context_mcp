export const MEMORY_KNOWLEDGE_HTML = String.raw`
<details id="memory-knowledge-panel" class="memory-knowledge-panel">
  <summary>实体与关系 <span>整理、审核和复核</span></summary>
  <div class="memory-knowledge-content">
    <p class="memory-knowledge-help">选择一条记忆后，可整理其中的项目、服务、模块和规则。提交后进入待审核列表，确认且仍有效的记录才会进入实体关系图。</p>
    <div class="memory-knowledge-toolbar"><label for="memory-knowledge-status">记录状态</label><select id="memory-knowledge-status"><option value="all">全部状态</option><option value="pending">待审核</option><option value="accepted">已确认</option><option value="stale">待复核</option><option value="rejected">已拒绝</option><option value="superseded">已替代</option></select><button id="memory-knowledge-refresh" class="secondary-button" type="button">刷新列表</button></div>
    <p id="memory-knowledge-message" class="memory-knowledge-help" role="status"></p>
    <div id="memory-knowledge-items" class="memory-knowledge-items"></div>
    <div class="memory-knowledge-page"><span id="memory-knowledge-page-label">尚未读取</span><div><button id="memory-knowledge-prev" class="secondary-button" type="button" disabled>上一页</button><button id="memory-knowledge-next" class="secondary-button" type="button" disabled>下一页</button></div></div>
  </div>
</details>
<dialog id="memory-knowledge-editor" aria-labelledby="memory-knowledge-editor-title">
  <form id="memory-knowledge-form" class="memory-knowledge-form">
    <header><div><h2 id="memory-knowledge-editor-title">整理实体与关系</h2><p id="memory-knowledge-editor-target" class="memory-knowledge-help"></p></div><button id="memory-knowledge-close" class="secondary-button" type="button">关闭</button></header>
    <p class="memory-knowledge-help">名称和关系必须有下面原文的支持。证据填写原文中的连续片段；实体证据需含名称或别名，关系证据需同时提及两端实体。提交只会生成候选，仍需单独审核。</p>
    <details class="memory-knowledge-original" open><summary>记忆原文（只读，可复制）</summary><pre id="memory-knowledge-original-text" tabindex="0"></pre><p id="memory-knowledge-original-note" class="memory-knowledge-help"></p></details>
    <p id="memory-knowledge-editor-message" class="memory-knowledge-error" role="alert"></p>
    <button id="memory-knowledge-reload" class="secondary-button" type="button" hidden>重载原文，保留草稿</button>
    <fieldset id="memory-knowledge-editor-fields">
      <section class="memory-knowledge-section"><header><h3>实体</h3><button id="memory-knowledge-add-entity" class="secondary-button" type="button">添加实体</button></header><div id="memory-knowledge-entities"></div></section>
      <section class="memory-knowledge-section"><header><h3>关系</h3><button id="memory-knowledge-add-relation" class="secondary-button" type="button">添加关系</button></header><p class="memory-knowledge-help">先填写实体，再选择关系两端。仅在原文明确支持时添加关系。</p><div id="memory-knowledge-relations"></div></section>
    </fieldset>
    <footer><p id="memory-knowledge-submit-status" class="memory-knowledge-help" role="status"></p><button id="memory-knowledge-submit" class="primary-button" type="submit">提交为待审核候选</button></footer>
  </form>
</dialog>
`;

export const MEMORY_KNOWLEDGE_CSS = String.raw`
.memory-knowledge-panel { min-width:0; margin:0 24px 24px; border:1px solid var(--line); border-radius:9px; background:#fff; }
.memory-knowledge-panel > summary { padding:15px 16px; font-size:14px; font-weight:700; cursor:pointer; overflow-wrap:anywhere; }
.memory-knowledge-panel > summary span { margin-left:10px; color:var(--muted); font-size:11px; font-weight:400; }
.memory-knowledge-content { padding:0 16px 16px; min-width:0; }
.memory-knowledge-help { font-size:12px; line-height:1.7; color:var(--muted); overflow-wrap:anywhere; }
.memory-knowledge-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:10px; margin:14px 0; }
.memory-knowledge-toolbar label { font-size:12px; }
.memory-knowledge-toolbar select { width:150px; max-width:100%; }
.memory-knowledge-items { display:grid; gap:12px; }
.memory-knowledge-card { min-width:0; border:1px solid var(--line); border-radius:8px; padding:14px; }
.memory-knowledge-card header { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:8px; }
.memory-knowledge-card h3 { margin:0; font-size:13px; line-height:1.7; overflow-wrap:anywhere; flex:1 1 200px; }
.memory-knowledge-card p,.memory-knowledge-card pre,.memory-knowledge-card summary { font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; max-width:100%; }
.memory-knowledge-card details { margin:10px 0; min-width:0; }
.memory-knowledge-card summary { cursor:pointer; font-weight:600; }
.memory-knowledge-badge { border:1px solid var(--line); border-radius:20px; padding:4px 9px; font-size:11px; line-height:1.5; white-space:normal; overflow-wrap:anywhere; flex:0 0 auto; max-width:100%; }
.memory-knowledge-badge.pending { background:#fff8e9; color:#7f5a15; }
.memory-knowledge-badge.accepted { background:#e9f5ed; color:#216540; }
.memory-knowledge-badge.stale { background:#fff0e8; color:#8e4820; }
.memory-knowledge-evidence { margin:10px 0; padding:10px 12px; border-left:3px solid #9fb5aa; background:#f7faf8; min-width:0; }
.memory-knowledge-evidence h4 { margin:0 0 6px; font-size:12px; overflow-wrap:anywhere; }
.memory-knowledge-evidence blockquote { margin:7px 0 0; font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
.memory-knowledge-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.memory-knowledge-actions button { max-width:100%; white-space:normal; }
.memory-knowledge-page { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-top:16px; font-size:12px; color:var(--muted); }
.memory-knowledge-page > div { display:flex; gap:8px; }
#memory-knowledge-editor { width:min(920px,calc(100vw - 28px)); max-width:calc(100vw - 28px); max-height:calc(100dvh - 28px); padding:0; overflow:auto; }
#memory-knowledge-editor [hidden] { display:none!important; }
.memory-knowledge-form { min-width:0; padding:24px; }
.memory-knowledge-form > header,.memory-knowledge-section > header { display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px; }
.memory-knowledge-form > header > div { flex:1 1 240px; min-width:0; }
.memory-knowledge-form h2 { margin:0; font-size:18px; overflow-wrap:anywhere; }
.memory-knowledge-form h3 { margin:0; font-size:14px; }
.memory-knowledge-form fieldset { border:0; padding:0; margin:0; min-width:0; }
.memory-knowledge-original { margin:16px 0; padding:12px; border:1px solid var(--line); border-radius:8px; }
.memory-knowledge-original summary { font-size:12px; font-weight:600; cursor:pointer; }
.memory-knowledge-original pre { max-height:260px; overflow:auto; padding:10px 0; margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.8; }
.memory-knowledge-section { margin-top:22px; }
.memory-knowledge-section > header { margin-bottom:12px; align-items:center; }
.memory-knowledge-row { margin:10px 0; padding:14px; border:1px solid var(--line); border-radius:8px; min-width:0; }
.memory-knowledge-row > header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
.memory-knowledge-row > header strong { font-size:12px; overflow-wrap:anywhere; }
.memory-knowledge-fields { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; min-width:0; }
.memory-knowledge-fields .field { margin:0; min-width:0; }
.memory-knowledge-fields .field.wide { grid-column:1/-1; }
.memory-knowledge-fields input,.memory-knowledge-fields textarea,.memory-knowledge-fields select { min-width:0; width:100%; max-width:100%; }
.memory-knowledge-fields label { display:block; margin-bottom:5px; font-size:12px; }
.memory-knowledge-fields textarea { min-height:76px; resize:vertical; }
.memory-knowledge-error { font-size:12px; line-height:1.7; color:#9f3527; overflow-wrap:anywhere; white-space:pre-wrap; }
.memory-knowledge-form footer { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; border-top:1px solid var(--line); padding-top:16px; margin-top:20px; }
.memory-knowledge-form footer button { max-width:100%; white-space:normal; }
#memory-knowledge-editor button:focus-visible,#memory-knowledge-editor input:focus-visible,#memory-knowledge-editor textarea:focus-visible,#memory-knowledge-editor select:focus-visible,#memory-knowledge-editor summary:focus-visible { outline:3px solid #286fa5; outline-offset:2px; }
@media(max-width:720px) {
 .memory-knowledge-panel { margin:0 12px 16px; }
 .memory-knowledge-content { padding:0 12px 12px; }
 .memory-knowledge-form { padding:16px 12px; }
 .memory-knowledge-fields { grid-template-columns:1fr; }
 .memory-knowledge-fields .field.wide { grid-column:auto; }
 .memory-knowledge-row { padding:12px; }
 .memory-knowledge-form > header > div { flex-basis:180px; }
 .memory-knowledge-form footer button { width:100%; }
}
`;

export const MEMORY_KNOWLEDGE_JS = String.raw`
  var mkState={projectId:null,sequence:0,controller:null,offset:0,total:0,items:[],loading:false,mutating:false};
  var mkEditor=null,mkEditorSequence=0,mkDraftKey=0;
  var mkEntityTypes=[["project","项目"],["service","服务"],["module","模块"],["storage","存储"],["rule","规则"],["technology","技术"],["concept","概念"]];
  var mkRelationTypes=[["uses","使用"],["provides","提供"],["stored_in","存储于"],["depends_on","依赖"],["governed_by","遵循规则"]];
  function mkEl(id){return document.getElementById("memory-knowledge-"+id);}
  function mkPath(projectId){return "/api/projects/"+encodeURIComponent(projectId)+"/memory-knowledge";}
  function mkCurrent(projectId,sequence){return els["portrait-project"].value===projectId&&mkState.projectId===projectId&&mkState.sequence===sequence&&mkEl("panel").open;}
  function mkStatus(record){return record.effectiveStatus||record.status;}
  function mkStatusLabel(value){return {pending:"待审核",accepted:"已确认",stale:"待复核",rejected:"已拒绝",superseded:"已替代"}[value]||value;}
  function mkTypeLabel(value){var row=mkEntityTypes.find(function(item){return item[0]===value;});return row?row[1]:value;}
  function mkRelationLabel(value){var row=mkRelationTypes.find(function(item){return item[0]===value;});return row?row[1]:value;}
  function mkButton(label,action,kind){var b=element("button",kind||"secondary-button",label);b.type="button";b.addEventListener("click",action);return b;}
  function bindMemoryKnowledgeEvents(){
    window.addEventListener("resize",fitMemoryKnowledgeEditor);
    new MutationObserver(fitMemoryKnowledgeEditor).observe(document.body,{attributes:true,attributeFilter:["style"]});
    mkEl("panel").addEventListener("toggle",function(){
      if(mkEl("panel").open)loadMemoryKnowledge();
      else {mkState.sequence++;if(mkState.controller)mkState.controller.abort();mkState.loading=false;mkState.mutating=false;}
    });
    mkEl("status").addEventListener("change",function(){mkState.offset=0;loadMemoryKnowledge();});
    mkEl("refresh").addEventListener("click",function(){loadMemoryKnowledge();});
    mkEl("prev").addEventListener("click",function(){if(!mkState.loading&&!mkState.mutating){mkState.offset=Math.max(0,mkState.offset-20);loadMemoryKnowledge();}});
    mkEl("next").addEventListener("click",function(){if(!mkState.loading&&!mkState.mutating){mkState.offset+=20;loadMemoryKnowledge();}});
    mkEl("close").addEventListener("click",function(){if(!mkEditor||!mkEditor.submitting)mkEl("editor").close();});
    mkEl("editor").addEventListener("cancel",function(event){if(mkEditor&&mkEditor.submitting)event.preventDefault();});
    mkEl("editor").addEventListener("close",function(){if(mkEl("editor").open)return;mkEditorSequence++;if(mkEditor&&mkEditor.controller)mkEditor.controller.abort();mkEditor=null;});
    mkEl("form").addEventListener("submit",submitMemoryKnowledge);
    mkEl("add-entity").addEventListener("click",function(){if(!mkEditor||mkEditor.busy)return;if(mkEditor.document.entities.length>=12){mkEditorMessage("最多整理12个实体，请拆分到更具体的记忆。");return;}mkEditor.document.entities.push({key:mkNewKey(mkEditor.document),name:"",type:"concept",aliases:[],evidence:""});renderMkEditorRows();});
    mkEl("add-relation").addEventListener("click",function(){if(!mkEditor||mkEditor.busy)return;var entities=mkEditor.document.entities;if(entities.length<2){mkEditorMessage("请先添加至少两个实体。");return;}if(mkEditor.document.relations.length>=24){mkEditorMessage("最多整理24条关系。");return;}mkEditor.document.relations.push({from:entities[0].key,to:entities[1].key,type:"uses",evidence:""});renderMkEditorRows();});
    mkEl("reload").addEventListener("click",reloadMkOriginal);
  }
  function mkNewKey(document){var key;do{key="entity_"+(++mkDraftKey);}while(document.entities.some(function(item){return item.key===key;}));return key;}
  function resetMemoryKnowledge(){
    mkState.sequence++;if(mkState.controller)mkState.controller.abort();
    mkState.projectId=null;mkState.items=[];mkState.offset=0;mkState.total=0;mkState.loading=false;mkState.mutating=false;
    mkEditorSequence++;if(mkEditor&&mkEditor.controller)mkEditor.controller.abort();mkEditor=null;
    if(!mkEl("panel"))return;
    if(mkEl("editor").open)mkEl("editor").close();
    mkEl("items").replaceChildren();mkEl("message").textContent="选择项目后展开此面板。";mkEl("page-label").textContent="尚未读取";mkEl("prev").disabled=true;mkEl("next").disabled=true;
    mkEl("status").disabled=false;mkEl("refresh").disabled=false;
  }
  function showMemoryKnowledge(){if(mkEl("panel").open)loadMemoryKnowledge();}
  async function loadMemoryKnowledge(){
    if(!mkEl("panel").open||mkState.mutating)return;
    var projectId=els["portrait-project"].value;if(!projectId)return;
    if(mkState.projectId!==projectId){mkState.projectId=projectId;mkState.offset=0;}
    var sequence=++mkState.sequence;if(mkState.controller)mkState.controller.abort();
    var controller=new AbortController();mkState.controller=controller;mkState.loading=true;
    var loaded=false;
    mkState.items=[];mkEl("items").replaceChildren();mkEl("message").textContent="正在读取实体与关系记录…";mkEl("page-label").textContent="正在读取";
    mkEl("prev").disabled=true;mkEl("next").disabled=true;mkEl("refresh").disabled=true;
    try{
      var result=await fetchJson(mkPath(projectId)+"?status="+encodeURIComponent(mkEl("status").value)+"&limit=20&offset="+mkState.offset,{signal:controller.signal});
      if(!mkCurrent(projectId,sequence))return;
      mkState.items=result.items||[];mkState.total=result.total||0;mkState.offset=result.offset||0;
      loaded=true;
      if(!mkState.items.length&&mkState.offset>0&&mkState.total<=mkState.offset){mkState.offset=Math.max(0,Math.floor(Math.max(0,mkState.total-1)/20)*20);mkState.loading=false;return loadMemoryKnowledge();}
      mkEl("message").textContent=mkState.items.length?"":"没有符合状态筛选的记录。选择一条记忆，点击“整理实体与关系”开始。";
      renderMemoryKnowledge();
    }catch(error){if(mkCurrent(projectId,sequence)&&error.name!=="AbortError"){mkEl("message").textContent="读取失败："+(error.message||String(error))+"。可点击“刷新列表”重试。";mkEl("page-label").textContent="读取失败";}}
    finally{if(mkCurrent(projectId,sequence)){mkState.loading=false;mkEl("status").disabled=false;mkEl("refresh").disabled=false;mkEl("prev").disabled=!loaded||mkState.offset===0;mkEl("next").disabled=!loaded||mkState.offset+20>=mkState.total;}}
  }
  function renderMemoryKnowledge(){
    var projectId=mkState.projectId,sequence=mkState.sequence;
    mkEl("items").replaceChildren();
    mkState.items.forEach(function(record){
      var card=element("article","memory-knowledge-card"),header=element("header"),status=mkStatus(record);
      var names=(record.document.entities||[]).map(function(item){return item.name;}).filter(Boolean);
      header.append(element("h3","",names.length?names.join(" · "):"实体关系记录"),element("span","memory-knowledge-badge "+status,mkStatusLabel(status)));
      card.append(header,element("p","memory-knowledge-help","记忆 "+record.memoryId+" · 版本 "+record.version+" · "+formatDate(record.updatedAt)));
      if(status==="stale")card.append(element("p","memory-knowledge-error","原记忆已变化、当前不可用或存在多份已确认版本，本记录已停止用于实体图。请核对原文和版本后复核。"));
      var details=element("details");details.append(element("summary","","查看全部实体、关系与原文证据"));
      renderMkDocument(details,record.document);card.append(details);
      var feedback=element("p","memory-knowledge-error");feedback.setAttribute("role","status");
      var actions=element("div","memory-knowledge-actions");
      actions.append(mkButton("查看原记忆",function(){if(mkCurrent(projectId,sequence))mkShowMemory(record.memoryId,projectId);}));
      if(status!=="superseded")actions.append(mkButton(status==="stale"?"重新整理":"复制并重新整理",function(){if(mkCurrent(projectId,sequence))openMemoryKnowledgeEditor(null,record,projectId);}));
      if(status==="pending")actions.append(mkButton("确认并加入图谱",function(){reviewMemoryKnowledge(record,"accept",projectId,sequence,feedback);},"primary-button"));
      if(status==="stale"&&record.status==="accepted")actions.append(mkButton("复核并选用此版本",function(){reviewMemoryKnowledge(record,"accept",projectId,sequence,feedback);}));
      if(status==="pending"||status==="accepted"||status==="stale")actions.append(mkButton(status==="accepted"?"撤销确认":status==="stale"?"拒绝此记录":"拒绝",function(){reviewMemoryKnowledge(record,"reject",projectId,sequence,feedback);}));
      card.append(actions,feedback);mkEl("items").append(card);
    });
    var start=mkState.total?mkState.offset+1:0,end=Math.min(mkState.offset+mkState.items.length,mkState.total);
    mkEl("page-label").textContent="第 "+start+"–"+end+" 条，共 "+mkState.total+" 条 · 每页20条";
  }
  function renderMkDocument(container,document){
    var entities=document.entities||[],relations=document.relations||[];
    entities.forEach(function(entity,index){
      var box=element("section","memory-knowledge-evidence");
      box.append(element("h4","","实体 "+(index+1)+" · "+entity.name+"（"+mkTypeLabel(entity.type)+"）"));
      if(entity.aliases&&entity.aliases.length)box.append(element("p","memory-knowledge-help","别名："+entity.aliases.join("，")));
      box.append(element("blockquote","",entity.evidence));container.append(box);
    });
    relations.forEach(function(relation,index){
      var from=entities.find(function(item){return item.key===relation.from;}),to=entities.find(function(item){return item.key===relation.to;});
      var box=element("section","memory-knowledge-evidence");box.append(element("h4","","关系 "+(index+1)+" · "+(from?from.name:relation.from)+" → "+mkRelationLabel(relation.type)+" → "+(to?to.name:relation.to)),element("blockquote","",relation.evidence));container.append(box);
    });
    if(!relations.length)container.append(element("p","memory-knowledge-help","未整理实体之间的关系。"));
  }
  async function mkShowMemory(memoryId,projectId){
    if(els["portrait-project"].value!==projectId)return;
    mgEl("history").checked=true;
    setMemoryGraphView("evidence","memory:"+memoryId);
    document.getElementById("memory-graph-heading").scrollIntoView({block:"nearest"});
  }
  async function reviewMemoryKnowledge(record,action,projectId,sequence,feedback){
    if(!mkCurrent(projectId,sequence)||mkState.mutating)return;
    mkState.mutating=true;mkEl("items").querySelectorAll("button").forEach(function(button){button.disabled=true;});
    mkEl("status").disabled=true;mkEl("refresh").disabled=true;mkEl("prev").disabled=true;mkEl("next").disabled=true;
    feedback.textContent=action==="accept"?"正在确认…":"正在更新记录…";
    try{
      await fetchJson(mkPath(projectId)+"/"+encodeURIComponent(record.id)+"/review",{method:"POST",body:{action:action,expectedVersion:record.version}});
      if(!mkCurrent(projectId,sequence))return;
      feedback.textContent=action==="accept"?"已确认。":"记录已拒绝。";
      mkState.mutating=false;mkEl("status").disabled=false;
      if(els["portrait-project"].value===projectId&&memoryGraphState.projectId===projectId)loadMemoryGraph(memoryGraphState.root,memoryGraphState.depth);
      await loadMemoryKnowledge();
    }catch(error){if(mkCurrent(projectId,sequence)){feedback.textContent=error.httpStatus===409?"记录版本已变化。请刷新列表核对最新状态后再审核。":(error.message||String(error));}}
    finally{
      if(mkState.projectId===projectId&&mkState.sequence===sequence){mkState.mutating=false;mkEl("status").disabled=false;mkEl("refresh").disabled=false;
        if(mkCurrent(projectId,sequence)){mkEl("items").querySelectorAll("button").forEach(function(button){button.disabled=false;});mkEl("prev").disabled=mkState.offset===0;mkEl("next").disabled=mkState.offset+20>=mkState.total;}
      }
    }
  }
  function mkEditorCurrent(editor){return mkEditor===editor&&mkEl("editor").open&&els["portrait-project"].value===editor.projectId;}
  function fitMemoryKnowledgeEditor(){
    var dialog=mkEl("editor");if(!dialog||!dialog.open)return;
    var zoom=(parseFloat(getComputedStyle(document.body).zoom)||1)*(parseFloat(getComputedStyle(document.documentElement).zoom)||1);
    var width=Math.max(160,(window.innerWidth-28)/zoom),height=Math.max(120,(window.innerHeight-28)/zoom);
    dialog.style.width=Math.min(920,width)+"px";dialog.style.maxWidth=width+"px";dialog.style.maxHeight=height+"px";
  }
  function mkEditorMessage(message){mkEl("editor-message").textContent=message||"";}
  function mkEditorBusy(editor,busy){
    editor.busy=busy;mkEl("editor-fields").disabled=busy||!editor.editable;mkEl("submit").disabled=busy||!editor.editable;
    mkEl("close").disabled=Boolean(editor.submitting);mkEl("reload").disabled=busy;
  }
  async function openMemoryKnowledgeEditor(detail,record,projectId){
    projectId=projectId||els["portrait-project"].value;if(!projectId||els["portrait-project"].value!==projectId)return;
    if(mkEditor&&mkEditor.busy)return;
    if(mkEditor&&mkEditor.controller)mkEditor.controller.abort();
    var memoryId=record?record.memoryId:detail&&detail.memory&&detail.memory.id;if(!memoryId)return;
    var project=projectById(projectId),document=record?JSON.parse(JSON.stringify(record.document)):{entities:[],relations:[]};
    document.entities.forEach(function(item){mkDraftKey++;});
    var editor={projectId:projectId,memoryId:memoryId,document:document,memory:null,memoryHash:null,editable:false,busy:false,submitting:false,conflict:false,controller:new AbortController(),sequence:++mkEditorSequence};
    mkEditor=editor;
    mkEl("editor-target").textContent=(project?project.name:projectId)+" · "+memoryId;
    mkEl("original-text").textContent="正在读取记忆原文…";mkEl("original-note").textContent="";
    mkEditorMessage("");mkEl("submit-status").textContent="";mkEl("reload").hidden=true;
    if(!mkEl("editor").open)mkEl("editor").showModal();fitMemoryKnowledgeEditor();mkEditorBusy(editor,true);renderMkEditorRows();
    try{
      var current=await fetchJson(memoryGraphBase(projectId)+"/nodes/"+encodeURIComponent("memory:"+memoryId)+"?includeInactive=true&includeSummaries=true",{signal:editor.controller.signal});
      if(!mkEditorCurrent(editor))return;
      mkSetOriginal(editor,current,record);
      if(!editor.document.entities.length)editor.document.entities.push({key:mkNewKey(editor.document),name:"",type:"concept",aliases:[],evidence:""});
      renderMkEditorRows();
    }catch(error){if(mkEditorCurrent(editor)&&error.name!=="AbortError"){mkEditorMessage("无法读取原文："+(error.message||String(error)));mkEl("reload").hidden=false;}}
    finally{if(mkEditorCurrent(editor))mkEditorBusy(editor,false);}
  }
  function mkSetOriginal(editor,detail,record){
    if(!detail.memory)throw new Error("该节点不是可整理的记忆。");
    editor.memory=detail.memory;editor.memoryHash=detail.memoryHash||(record&&record.memoryHash)||null;
    editor.editable=!detail.truncated&&detail.memory.status==="active"&&detail.memory.type!=="task-summary"&&Boolean(detail.memoryHash);
    mkEl("original-text").textContent=detail.memory.title+"\n"+detail.memory.content;
    mkEl("original-note").textContent=detail.truncated?"原文超过网页详情上限，当前不能在网页提交整理。可通过 MCP 读取完整记忆后提交候选。":detail.memory.status!=="active"||detail.memory.type==="task-summary"?"仅活跃的长期记忆可提交实体关系候选。":!detail.memoryHash?"服务未返回原文版本，暂不能提交。请更新服务后重试。":"";
    mkEl("editor-target").textContent=(projectById(editor.projectId)?projectById(editor.projectId).name:editor.projectId)+" · "+detail.memory.title;
  }
  async function reloadMkOriginal(){
    var editor=mkEditor;if(!editor||editor.busy)return;
    mkEditorBusy(editor,true);mkEditorMessage("正在重载原文；实体与关系草稿保持不变。");
    try{
      var detail=await fetchJson(memoryGraphBase(editor.projectId)+"/nodes/"+encodeURIComponent("memory:"+editor.memoryId)+"?includeInactive=true&includeSummaries=true",{signal:editor.controller.signal});
      if(!mkEditorCurrent(editor))return;
      mkSetOriginal(editor,detail,null);editor.conflict=false;mkEl("reload").hidden=true;
      mkEditorMessage("已重载原文。请核对名称、关系和证据片段，再提交草稿。");
    }catch(error){if(mkEditorCurrent(editor)&&error.name!=="AbortError")mkEditorMessage("重载失败："+(error.message||String(error)));}
    finally{if(mkEditorCurrent(editor))mkEditorBusy(editor,false);}
  }
  function mkField(label,type,value,onChange,options){
    var field=element("div","field"+(type==="textarea"?" wide":"")),id="mk-field-"+(++mkDraftKey),control=element(type==="textarea"?"textarea":type==="select"?"select":"input");
    control.id=id;
    if(type==="select"){(options||[]).forEach(function(option){addOption(control,option[0],option[1]);});}
    else if(type!=="textarea")control.type="text";
    control.value=value||"";control.required=true;
    if(type==="textarea")control.maxLength=1000;else if(type!=="select")control.maxLength=120;
    control.addEventListener(type==="select"?"change":"input",function(){onChange(control.value);});
    var title=element("label","",label);title.htmlFor=id;field.append(title,control);return field;
  }
  function renderMkEditorRows(){
    var editor=mkEditor;if(!editor)return;
    mkEl("entities").replaceChildren();mkEl("relations").replaceChildren();
    editor.document.entities.forEach(function(entity,index){
      var row=element("section","memory-knowledge-row"),header=element("header");header.append(element("strong","","实体 "+(index+1)),mkButton("删除实体",function(){
        if(editor.busy||!mkEditorCurrent(editor))return;
        editor.document.entities.splice(index,1);editor.document.relations=editor.document.relations.filter(function(relation){return relation.from!==entity.key&&relation.to!==entity.key;});renderMkEditorRows();
      }));
      var fields=element("div","memory-knowledge-fields");
      fields.append(mkField("名称","text",entity.name,function(value){entity.name=value;mkUpdateEndpoints();}),mkField("实体类型","select",entity.type,function(value){entity.type=value;},mkEntityTypes));
      var aliases=mkField("别名（可选，逗号分隔）","text",(entity.aliases||[]).join("，"),function(value){entity.aliases=value.split(/[,，]/).map(function(alias){return alias.trim();}).filter(Boolean);});
      aliases.querySelector("input").required=false;
      aliases.querySelector("input").maxLength=1000;
      fields.append(aliases,mkField("原文证据片段","textarea",entity.evidence,function(value){entity.evidence=value;}));row.append(header,fields);mkEl("entities").append(row);
    });
    editor.document.relations.forEach(function(relation,index){
      var row=element("section","memory-knowledge-row"),header=element("header");header.append(element("strong","","关系 "+(index+1)),mkButton("删除关系",function(){if(editor.busy||!mkEditorCurrent(editor))return;editor.document.relations.splice(index,1);renderMkEditorRows();}));
      var choices=editor.document.entities.map(function(entity,i){return[entity.key,entity.name||"实体 "+(i+1)];}),fields=element("div","memory-knowledge-fields");
      var from=mkField("从实体","select",relation.from,function(value){relation.from=value;},choices),to=mkField("到实体","select",relation.to,function(value){relation.to=value;},choices);
      from.querySelector("select").dataset.endpoint="from";from.querySelector("select").dataset.relationIndex=String(index);
      to.querySelector("select").dataset.endpoint="to";to.querySelector("select").dataset.relationIndex=String(index);
      fields.append(from,to,mkField("关系类型","select",relation.type,function(value){relation.type=value;},mkRelationTypes),mkField("原文证据片段","textarea",relation.evidence,function(value){relation.evidence=value;}));
      row.append(header,fields);mkEl("relations").append(row);
    });
    if(!editor.document.relations.length)mkEl("relations").append(element("p","memory-knowledge-help","尚未添加关系；可以仅提交有明确证据的实体。"));
  }
  function mkUpdateEndpoints(){
    if(!mkEditor)return;
    mkEl("relations").querySelectorAll("select[data-endpoint]").forEach(function(select){
      var relation=mkEditor.document.relations[Number(select.dataset.relationIndex)],value=relation[select.dataset.endpoint];select.replaceChildren();
      mkEditor.document.entities.forEach(function(entity,index){addOption(select,entity.key,entity.name||"实体 "+(index+1));});select.value=value;
    });
  }
  async function submitMemoryKnowledge(event){
    event.preventDefault();var editor=mkEditor;if(!editor||editor.busy||!mkEditorCurrent(editor)||!editor.editable)return;
    if(editor.conflict){mkEditorMessage("请先重载原文并核对草稿，再重新提交。");return;}
    if(!editor.document.entities.length){mkEditorMessage("请至少添加一个有原文证据的实体。");return;}
    if(editor.document.entities.some(function(entity){return entity.aliases.length>8||entity.aliases.some(function(alias){return alias.length>120;});})){mkEditorMessage("每个实体最多8个别名，每个别名不超过120字。");return;}
    if(editor.document.relations.some(function(relation){return relation.from===relation.to;})){mkEditorMessage("关系的两端必须是不同实体。");return;}
    if(!mkEl("form").reportValidity())return;
    var body={memoryId:editor.memoryId,document:JSON.parse(JSON.stringify(editor.document))};
    if(editor.memoryHash)body.expectedMemoryHash=editor.memoryHash;
    editor.submitting=true;mkEditorBusy(editor,true);mkEditorMessage("");mkEl("submit-status").textContent="正在提交候选…";
    try{
      if(els["portrait-project"].value!==editor.projectId)throw new Error("项目已经变化，请重新打开整理窗口。");
      var result=await fetchJson(mkPath(editor.projectId),{method:"POST",body:body});
      if(!mkEditorCurrent(editor))return;
      var projectId=editor.projectId;mkEl("editor").close();mkEditor=null;
      if(els["portrait-project"].value===projectId){
        var status=mkStatus(result);mkState.offset=0;mkEl("status").value=status==="pending"?"pending":"all";
        if(!mkEl("panel").open)mkEl("panel").open=true;else loadMemoryKnowledge();
        toast(status==="pending"?"已提交待审核候选，尚未加入实体图。":"相同整理记录已存在，当前状态："+mkStatusLabel(status)+"。");
      }
    }catch(error){
      if(!mkEditorCurrent(editor))return;
      if(error.httpStatus===409){editor.conflict=true;mkEl("reload").hidden=false;mkEditorMessage("原记忆或版本已变化，草稿已保留。请重载原文并核对证据后再提交。");}
      else mkEditorMessage(error.message||String(error));
      mkEl("submit-status").textContent="未提交，草稿已保留。";
    }finally{if(mkEditorCurrent(editor)){editor.submitting=false;mkEditorBusy(editor,false);}}
  }
`;
