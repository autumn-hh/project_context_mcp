export const MEMORY_GRAPH_HTML = String.raw`
<section id="portrait-memory-graph" class="memory-graph-panel" hidden aria-labelledby="memory-graph-heading">
  <header class="memory-graph-heading"><div><h2 id="memory-graph-heading">记忆关系</h2><p id="memory-graph-description">查看记忆之间的主题线索，需要核对出处时再进入来源追溯。</p></div><span class="memory-graph-local">本机项目</span></header>
  <div class="memory-graph-toolbar">
    <div class="memory-graph-mode"><label for="memory-graph-view">查看方式</label><select id="memory-graph-view"><option value="knowledge" selected>知识关联</option><option value="evidence">来源追溯</option></select></div>
    <form id="memory-graph-search-form" class="memory-graph-search" role="search">
      <label class="sr-only" for="memory-graph-query">搜索记忆关键词</label>
      <input id="memory-graph-query" type="search" maxlength="200" placeholder="搜索记忆关键词" autocomplete="off">
      <button type="submit" class="primary-button">搜索</button>
    </form>
    <div class="memory-graph-tools"><button id="memory-graph-overview" type="button" class="secondary-button">回到概览</button><button id="memory-graph-refresh" type="button" class="secondary-button">刷新</button><button id="memory-graph-fit" type="button" class="secondary-button" disabled>适应画布</button></div>
  </div>
  <div class="memory-graph-filters">
    <fieldset id="memory-graph-relations"><legend>显示关系</legend>
      <label data-memory-view="knowledge"><input type="checkbox" value="CONTENT_RELATED" checked>可能相关</label>
      <label data-memory-view="evidence" hidden><input type="checkbox" value="SOURCED_FROM" checked>来源</label>
      <label><input type="checkbox" value="SUPERSEDES" checked>替代</label>
      <label data-memory-view="evidence" hidden><input type="checkbox" value="PRODUCED_BY" checked>任务</label>
      <label data-memory-view="evidence" hidden><input type="checkbox" value="APPLIES_TO" checked>适用范围</label>
    </fieldset>
    <label class="memory-graph-history"><input id="memory-graph-history" type="checkbox">显示过期、冲突及已替代记忆</label>
    <label id="memory-graph-summaries-label" hidden><input id="memory-graph-summaries" type="checkbox">包含任务摘要</label>
  </div>
  <p id="memory-graph-notice" class="memory-graph-notice" role="status" hidden></p>
  <div class="memory-graph-workspace">
    <div class="memory-graph-main">
      <div id="memory-graph-legend" class="memory-graph-legend" aria-label="图谱说明"><span class="memory-legend-memory">记忆</span><span>虚线表示可能相关 · 箭头表示替代</span></div>
      <p class="memory-graph-canvas-hint">拖动画布查看邻居，滚轮缩放；节点列表可查看完整名称并定位节点。</p>
      <div class="memory-graph-canvas-wrap">
        <div id="memory-graph-canvas" role="img" aria-label="本项目记忆关系图；可使用下方节点列表查看相同内容"></div>
        <div id="memory-graph-message" class="memory-graph-message" role="status"><span>选择项目后读取记忆关系</span></div>
      </div>
      <details class="memory-graph-node-browser" open><summary>节点列表 <span id="memory-graph-node-count">0</span></summary><p>可用键盘选择节点，查看完整名称与关系依据。</p><div id="memory-graph-nodes" class="memory-graph-node-list" aria-label="当前图谱节点"></div></details>
    </div>
    <aside class="memory-graph-detail" aria-labelledby="memory-graph-detail-title">
      <header><h3 id="memory-graph-detail-title">选择一个节点</h3></header>
      <div id="memory-graph-detail-body"><p class="memory-graph-muted">点击图中节点或下方列表，查看记忆内容与出处。点击连线查看关系依据。</p></div>
      <div class="memory-graph-expand"><button id="memory-graph-expand-one" type="button" class="secondary-button" disabled>展开一层</button><button id="memory-graph-expand-two" type="button" class="secondary-button" disabled>展开两层</button></div>
      <button id="memory-graph-trace" type="button" class="secondary-button memory-graph-trace" hidden disabled>追溯此记忆</button>
    </aside>
  </div>
  <footer class="memory-graph-footer"><span id="memory-graph-status">尚未读取</span><span id="memory-graph-scope">记忆概览</span></footer>
</section>
`;

export const MEMORY_GRAPH_CSS = String.raw`
.portrait-mode-tabs { overflow-x:auto; }
.portrait-mode-tabs .portrait-mode { flex:0 0 auto; white-space:nowrap; }
#portrait-memory-graph { min-width:0; background:var(--surface,#fff); }
#portrait-memory-graph [hidden] { display:none !important; }
.memory-graph-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 24px 8px; }
.memory-graph-heading h2 { margin:0; font-size:18px; }
.memory-graph-heading p { margin:6px 0; color:var(--muted); font-size:12px; }
.memory-graph-local { flex:0 0 auto; border:1px solid var(--line); border-radius:20px; padding:5px 10px; color:var(--muted); font-size:11px; }
.memory-graph-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:10px; padding:8px 24px 12px; }
.memory-graph-mode { display:flex; align-items:center; gap:8px; min-width:0; }
.memory-graph-mode label { color:var(--muted); font-size:12px; white-space:nowrap; }
.memory-graph-mode select { width:140px; min-width:0; }
.memory-graph-search { display:grid; grid-template-columns:minmax(0,1fr) auto; flex:1 1 300px; max-width:620px; gap:8px; min-width:0; }
.memory-graph-search input { min-width:0; }
.memory-graph-tools { display:flex; flex-wrap:wrap; gap:8px; }
.memory-graph-filters { display:flex; flex-wrap:wrap; align-items:center; gap:12px 22px; padding:0 24px 14px; border-bottom:1px solid var(--line); }
.memory-graph-filters fieldset { display:flex; flex-wrap:wrap; gap:10px 16px; margin:0; padding:0; border:0; min-width:0; }
.memory-graph-filters legend { float:left; margin-right:12px; font-size:12px; color:var(--muted); }
.memory-graph-filters label { display:inline-flex; align-items:center; gap:6px; margin:0; font-size:12px; line-height:1.5; }
.memory-graph-filters input[type=checkbox] { width:15px; height:15px; padding:0; flex:0 0 auto; }
.memory-graph-notice { margin:12px 24px 0; padding:10px 12px; border:1px solid #dfc594; border-radius:8px; background:#fff9ed; color:#795519; font-size:12px; overflow-wrap:anywhere; }
.memory-graph-workspace { display:grid; grid-template-columns:minmax(0,1fr) minmax(270px,340px); min-width:0; }
.memory-graph-main { min-width:0; }
.memory-graph-canvas-hint { margin:0; padding:0 18px 10px; font-size:11px; line-height:1.6; color:var(--muted); overflow-wrap:anywhere; }
.memory-graph-legend { display:flex; flex-wrap:wrap; gap:8px 18px; padding:12px 18px; color:var(--muted); font-size:11px; }
.memory-graph-legend [class^=memory-legend-]::before { content:""; display:inline-block; width:9px; height:9px; margin-right:5px; border-radius:2px; background:#226a52; }
.memory-graph-legend .memory-legend-task::before { background:#3d70a1 !important; }
.memory-graph-legend .memory-legend-source::before { background:#b07825 !important; }
.memory-graph-legend .memory-legend-scope::before { background:#7b6a98 !important; }
.memory-graph-canvas-wrap { position:relative; min-width:0; height:440px; background:#f6f9f7; border-block:1px solid var(--line); }
#memory-graph-canvas { position:absolute; inset:0; }
.memory-graph-message { position:absolute; inset:0; z-index:1; display:flex; align-items:center; justify-content:center; padding:24px; text-align:center; color:var(--muted); background:#f6f9f7; }
.memory-graph-message span { max-width:100%; white-space:pre-wrap; overflow-wrap:anywhere; }
.memory-graph-node-browser { border-bottom:1px solid var(--line); }
.memory-graph-node-browser > summary { padding:12px 16px; cursor:pointer; font-size:12px; font-weight:700; }
.memory-graph-node-browser > summary span { margin-left:6px; color:var(--muted); font-variant-numeric:tabular-nums; }
.memory-graph-node-browser > p { margin:0; padding:0 16px 10px; font-size:11px; color:var(--muted); }
.memory-graph-node-list { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-content:start; max-height:230px; overflow:auto; border-top:1px solid var(--line); }
.memory-graph-node { display:flex; flex-direction:column; align-items:flex-start; gap:5px; min-width:0; width:100%; padding:10px 14px; border:0; border-radius:0; border-right:1px solid var(--line); border-bottom:1px solid var(--line); background:#fff; text-align:left; color:var(--text); }
.memory-graph-node strong { font-size:12px; line-height:1.55; font-weight:600; }
.memory-graph-node small { font-size:10px; color:var(--muted); }
.memory-graph-node strong,.memory-graph-node small { display:block; width:100%; overflow-wrap:anywhere; white-space:normal; }
.memory-graph-node:hover { background:#f1f6f3; }
.memory-graph-node[aria-pressed=true] { background:#e1eee7; box-shadow:inset 3px 0 #176b4d; }
#portrait-memory-graph button:focus-visible,#portrait-memory-graph input:focus-visible,#portrait-memory-graph select:focus-visible,#portrait-memory-graph summary:focus-visible { outline:3px solid #286fa5; outline-offset:-3px; }
.memory-graph-detail { min-width:0; padding:18px; border-left:1px solid var(--line); background:#fff; scroll-margin-top:100px; }
.memory-graph-detail h3 { scroll-margin-top:100px; }
.memory-graph-detail header { padding-bottom:12px; border-bottom:1px solid var(--line); }
.memory-graph-detail h3 { margin:0; font-size:15px; line-height:1.6; overflow-wrap:anywhere; }
.memory-graph-detail h4 { margin:18px 0 8px; font-size:12px; }
.memory-graph-detail p { font-size:12px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
.memory-graph-muted { color:var(--muted); }
.memory-graph-facts { display:grid; grid-template-columns:minmax(60px,auto) minmax(0,1fr); gap:0 12px; margin:12px 0; }
.memory-graph-facts dt,.memory-graph-facts dd { margin:0; padding:7px 0; border-bottom:1px solid var(--line); font-size:11px; line-height:1.6; overflow-wrap:anywhere; }
.memory-graph-facts dt { color:var(--muted); }
.memory-graph-detail details > summary { cursor:pointer; font-size:12px; margin:12px 0; }
.memory-graph-detail details pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:11px; max-width:100%; }
.memory-graph-evidence { display:block; width:100%; min-width:0; border:1px solid var(--line); border-radius:7px; background:#f8faf9; margin:6px 0; padding:9px 10px; text-align:left; font-size:11px; line-height:1.6; overflow-wrap:anywhere; white-space:normal; }
.memory-graph-evidence:hover { background:#edf4ef; }
.memory-graph-expand { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:16px; }
.memory-graph-expand button { min-width:0; white-space:normal; }
.memory-graph-trace { width:100%; min-width:0; white-space:normal; margin-top:8px; }
.memory-graph-terms { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
.memory-graph-term { max-width:100%; padding:4px 7px; border:1px solid var(--line); border-radius:6px; font-size:11px; line-height:1.6; background:var(--surface-muted); overflow-wrap:anywhere; }
.memory-graph-related-note { border-left:3px solid #7b6a98; padding:8px 10px; background:#f6f3f9; }
.memory-graph-footer { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px 16px; padding:12px 18px; border-top:1px solid var(--line); color:var(--muted); font-size:11px; }
.memory-graph-footer span { min-width:0; overflow-wrap:anywhere; }
@media(max-width:1000px) { .memory-graph-workspace { grid-template-columns:minmax(0,1fr) minmax(250px,300px); } .memory-graph-node-list { grid-template-columns:1fr; } }
@media(max-width:720px) {
  .memory-graph-heading { padding:16px 12px 6px; align-items:flex-start; }
  .memory-graph-heading h2 { font-size:16px; }
  .memory-graph-toolbar { padding:8px 12px 12px; }
  .memory-graph-mode { flex-basis:100%; }
  .memory-graph-mode select { flex:1; }
  .memory-graph-search { flex-basis:100%; max-width:none; }
  .memory-graph-tools { width:100%; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); }
  .memory-graph-tools button { min-width:0; padding-inline:6px; white-space:normal; }
  .memory-graph-filters { padding:0 12px 12px; gap:12px; }
  .memory-graph-notice { margin:12px 12px 0; }
  .memory-graph-workspace { display:flex; flex-direction:column; }
  .memory-graph-canvas-wrap { height:340px; }
  .memory-graph-node-list { max-height:210px; }
  .memory-graph-detail { border-left:0; border-top:1px solid var(--line); padding:16px 12px; scroll-margin-top:160px; }
  .memory-graph-detail h3 { scroll-margin-top:160px; }
  .memory-graph-legend { padding:10px 12px; }
  .memory-graph-canvas-hint { padding-inline:12px; }
}
`;

export const MEMORY_GRAPH_JS = String.raw`
  var memoryGraphState = { projectId:null, sequence:0, detailSequence:0, controller:null, detailController:null, cy:null, data:null, root:null, depth:1, selectedId:null, loading:false, view:"knowledge" };
  var memoryRelationLabels = { CONTENT_RELATED:"可能相关", SOURCED_FROM:"来源于", SUPERSEDES:"替代", PRODUCED_BY:"由任务产生", APPLIES_TO:"适用于" };
  function mgEl(id) { return document.getElementById("memory-graph-" + id); }
  function memoryGraphBase(projectId) { return "/api/projects/" + encodeURIComponent(projectId) + "/memory-graph"; }
  function memoryGraphIsCurrent(projectId, sequence) { return memoryGraphState.projectId === projectId && els["portrait-project"].value === projectId && memoryGraphState.sequence === sequence; }
  function bindMemoryGraphEvents() {
    mgEl("view").addEventListener("change", function() { setMemoryGraphView(mgEl("view").value,null); });
    mgEl("search-form").addEventListener("submit", function(event) { event.preventDefault(); loadMemoryGraph(null); });
    mgEl("overview").addEventListener("click", function() { mgEl("query").value=""; loadMemoryGraph(null); });
    mgEl("refresh").addEventListener("click", function() { loadMemoryGraph(memoryGraphState.root, memoryGraphState.depth); });
    mgEl("fit").addEventListener("click", function() { fitMemoryGraphReadable(memoryGraphState.cy); });
    mgEl("history").addEventListener("change", function() { loadMemoryGraph(null); });
    mgEl("summaries").addEventListener("change", function() { loadMemoryGraph(null); });
    mgEl("relations").addEventListener("change", function() {
      loadMemoryGraph(memoryGraphState.root,memoryGraphState.depth);
    });
    mgEl("expand-one").addEventListener("click", function() { if(memoryGraphState.selectedId) loadMemoryGraph(memoryGraphState.selectedId,1); });
    mgEl("expand-two").addEventListener("click", function() { if(memoryGraphState.selectedId) loadMemoryGraph(memoryGraphState.selectedId,2); });
    mgEl("trace").addEventListener("click", function() {
      if(memoryGraphState.selectedId && memoryGraphState.selectedId.indexOf("memory:")===0) setMemoryGraphView("evidence",memoryGraphState.selectedId);
    });
    window.addEventListener("resize", function() { if(memoryGraphState.cy) memoryGraphState.cy.resize(); });
  }
  function memoryGraphRelations() {
    return Array.from(mgEl("relations").querySelectorAll("input:checked")).filter(function(input){return !input.parentElement.hidden;}).map(function(input){return input.value;});
  }
  function updateMemoryGraphView() {
    var evidence=memoryGraphState.view==="evidence";
    mgEl("view").value=memoryGraphState.view;
    mgEl("relations").querySelectorAll("[data-memory-view]").forEach(function(label){label.hidden=label.dataset.memoryView!==memoryGraphState.view;});
    mgEl("summaries-label").hidden=!evidence;mgEl("summaries").disabled=!evidence;
    if(!evidence)mgEl("summaries").checked=false;
    mgEl("description").textContent=evidence?"按需核对记忆的来源、任务和演变依据。":"查看记忆之间的主题线索，需要核对出处时再进入来源追溯。";
    var legend=mgEl("legend");legend.replaceChildren(element("span","memory-legend-memory","记忆"));
    if(evidence){legend.append(element("span","memory-legend-task","任务"),element("span","memory-legend-source","来源"),element("span","memory-legend-scope","范围"));}
    legend.append(element("span","",evidence?"箭头表示记录中的关系方向":"虚线表示可能相关 · 箭头表示替代"));
  }
  function setMemoryGraphView(view, root) {
    memoryGraphState.view=view==="evidence"?"evidence":"knowledge";updateMemoryGraphView();
    if(memoryGraphState.view==="knowledge" && root && root.indexOf("memory:")!==0)root=null;
    loadMemoryGraph(root||null,1);
  }
  function memoryGraphClearDetail(message) {
    memoryGraphState.selectedId=null;
    mgEl("detail-title").textContent="选择一个节点";
    mgEl("detail-body").replaceChildren(element("p","memory-graph-muted",message||"点击图中节点或下方列表，查看记忆内容与出处。点击连线查看关系依据。"));
    mgEl("expand-one").disabled=true; mgEl("expand-two").disabled=true;
    mgEl("trace").hidden=true;mgEl("trace").disabled=true;
  }
  function resetMemoryGraph() {
    memoryGraphState.sequence++; memoryGraphState.detailSequence++;
    if(memoryGraphState.controller) memoryGraphState.controller.abort();
    if(memoryGraphState.detailController) memoryGraphState.detailController.abort();
    if(memoryGraphState.cy) memoryGraphState.cy.destroy();
    memoryGraphState.cy=null; memoryGraphState.data=null; memoryGraphState.projectId=null;
    memoryGraphState.root=null; memoryGraphState.depth=1; memoryGraphState.loading=false;
    if(!mgEl("nodes")) return;
    memoryGraphState.view="knowledge";updateMemoryGraphView();
    mgEl("query").value=""; mgEl("nodes").replaceChildren(); mgEl("node-count").textContent="0";
    mgEl("notice").hidden=true; mgEl("status").textContent="尚未读取"; mgEl("scope").textContent="记忆概览";
    mgEl("fit").disabled=true; memoryGraphClearDetail();
    memoryGraphMessage("选择项目后读取记忆关系");
  }
  function memoryGraphMessage(message) {
    mgEl("message").hidden=!message;
    mgEl("message").replaceChildren(element("span","",message||""));
  }
  function showMemoryGraph(force) {
    var projectId=els["portrait-project"].value;
    if(projectId!==memoryGraphState.projectId) { resetMemoryGraph(); loadMemoryGraph(null); return; }
    if(force || !memoryGraphState.data) { loadMemoryGraph(memoryGraphState.root,memoryGraphState.depth); return; }
    setTimeout(function(){if(memoryGraphState.cy){memoryGraphState.cy.resize();fitMemoryGraphReadable(memoryGraphState.cy);}},0);
  }
  async function loadMemoryGraph(root, depth) {
    var projectId=els["portrait-project"].value;
    if(!projectId) { resetMemoryGraph(); return; }
    if(memoryGraphState.projectId && memoryGraphState.projectId!==projectId) resetMemoryGraph();
    if(memoryGraphState.view==="knowledge" && root && root.indexOf("memory:")!==0)root=null;
    memoryGraphState.projectId=projectId;
    memoryGraphState.root=root||null; memoryGraphState.depth=depth||1;
    var sequence=++memoryGraphState.sequence;
    memoryGraphState.detailSequence++;
    if(memoryGraphState.controller) memoryGraphState.controller.abort();
    if(memoryGraphState.detailController) memoryGraphState.detailController.abort();
    var controller=new AbortController(); memoryGraphState.controller=controller;
    memoryGraphState.loading=true; memoryGraphState.data=null;
    if(memoryGraphState.cy) memoryGraphState.cy.destroy();
    memoryGraphState.cy=null; mgEl("nodes").replaceChildren(); mgEl("node-count").textContent="0";
    mgEl("notice").hidden=true; mgEl("fit").disabled=true;
    memoryGraphClearDetail("正在读取关系，请稍候。"); memoryGraphMessage("正在读取记忆关系…");
    mgEl("status").textContent="正在读取"; mgEl("scope").textContent=root?"邻居展开":"记忆概览";
    var params=new URLSearchParams({limit:"24",view:memoryGraphState.view,includeSummaries:String(memoryGraphState.view==="evidence"&&mgEl("summaries").checked),includeInactive:String(mgEl("history").checked)});
    if(root){params.set("node",root);params.set("depth",String(depth||1));}
    else if(mgEl("query").value.trim())params.set("query",mgEl("query").value.trim());
    var relations=memoryGraphRelations();
    if(!relations.length)params.set("relation","none");
    else relations.forEach(function(relation){params.append("relation",relation);});
    try {
      var data=await fetchJson(memoryGraphBase(projectId)+"?"+params.toString(),{signal:controller.signal});
      if(!memoryGraphIsCurrent(projectId,sequence))return;
      memoryGraphState.data=data; memoryGraphState.loading=false;
      renderMemoryGraph(data);
      if(root && data.nodes.some(function(node){return node.id===root;}))selectMemoryGraphNode(root);
    } catch(error) {
      if(!memoryGraphIsCurrent(projectId,sequence)||error.name==="AbortError")return;
      memoryGraphState.loading=false;
      memoryGraphMessage("无法读取记忆关系。\n"+(error.message||String(error))+"\n可点击“刷新”重试，或回到概览。");
      mgEl("status").textContent="读取失败"; memoryGraphClearDetail("尚未取得图谱数据。");
    }
  }
  function memoryNodeLabel(node) {
    if(node.nodeType==="memory")return typeLabel(node.memoryType||"fact");
    return {task:"任务",source:"来源",scope:"适用范围"}[node.nodeType]||node.nodeType;
  }
  function renderMemoryGraph(data) {
    memoryGraphClearDetail();
    renderMemoryGraphNodes();
    mgEl("node-count").textContent=String(data.nodes.length);
    var total=data.totals&&Number.isFinite(data.totals.memories)?data.totals.memories:null;
    mgEl("status").textContent="当前展示 "+data.nodes.length+" 个节点 · "+data.edges.length+" 条关系"+(total===null?"":"；本项目可浏览 "+total+" 条记忆"+(memoryGraphState.view==="evidence"&&mgEl("summaries").checked?"（含摘要）":"（不含摘要）"));
    mgEl("scope").textContent=(memoryGraphState.view==="evidence"?"来源追溯":"知识关联")+" · "+(data.root?"展开 "+memoryGraphState.depth+" 层邻居":mgEl("query").value.trim()?"关键词结果":"概览");
    mgEl("notice").hidden=!data.truncated;
    mgEl("notice").textContent="当前为局部视图，最多展示 24 个节点。可搜索具体主题，或选中一条记忆展开邻居。";
    if(!data.nodes.length){memoryGraphMessage("没有符合条件的记忆关系。\n可修改关键词，或开启“显示过期、冲突及已替代记忆”。");return;}
    if(typeof window.cytoscape!=="function"){memoryGraphMessage("图形引擎未能加载。仍可使用下方节点列表查看内容与关系。");return;}
    memoryGraphMessage("");
    var canvas=mgEl("canvas"),canvasWidth=canvas.clientWidth||900,canvasHeight=canvas.clientHeight||440;
    // Prefer readable, deterministic cells. Labels are part of node dimensions;
    // a wide canvas can hold more columns, while narrow screens keep fewer columns.
    var ratio=Math.max(.6,Math.min(1.5,canvasWidth/canvasHeight));
    var columns=Math.max(1,Math.min(Math.floor(canvasWidth/170)||1,Math.ceil(Math.sqrt(data.nodes.length*ratio))));
    var rows=Math.max(1,Math.ceil(data.nodes.length/columns));
    if(data.nodes.length<=9&&canvasWidth>=650){columns=Math.min(3,data.nodes.length);rows=Math.ceil(data.nodes.length/columns);}
    var gridWidth=Math.max(canvasWidth-70,columns*190),gridHeight=Math.max(canvasHeight-70,rows*135);
    var cy=window.cytoscape({
      container:mgEl("canvas"),minZoom:.12,maxZoom:3,boxSelectionEnabled:false,
      elements:data.nodes.map(function(node){return{group:"nodes",data:Object.assign({},node,{displayLabel:Array.from(node.label||"").slice(0,24).join("")+(Array.from(node.label||"").length>24?"…":"")})};})
        .concat(data.edges.map(function(edge){return{group:"edges",data:Object.assign({},edge,{displayRelation:memoryRelationLabels[edge.relationType]||edge.relationType})};})),
      style:memoryGraphStyles(),
      layout:{name:"grid",animate:false,fit:false,padding:35,rows:rows,cols:columns,avoidOverlap:true,avoidOverlapPadding:20,nodeDimensionsIncludeLabels:true,condense:false,boundingBox:{x1:35,y1:35,w:gridWidth,h:gridHeight}}
    });
    memoryGraphState.cy=cy;
    mgEl("fit").disabled=false;
    cy.on("tap","node",function(event){selectMemoryGraphNode(event.target.id());});
    cy.on("tap","edge",function(event){selectMemoryGraphEdge(event.target.id());});
    cy.on("mouseover","node,edge",function(event){event.target.addClass("hovered");});
    cy.on("mouseout","node,edge",function(event){event.target.removeClass("hovered");});
    setTimeout(function(){if(memoryGraphState.cy===cy){cy.resize();fitMemoryGraphReadable(cy);}},0);
  }
  function fitMemoryGraphReadable(cy) {
    if(!cy||!cy.nodes().length)return;
    cy.fit(undefined,35);
    // Keep labels legible instead of shrinking a dense graph into an overview.
    // The viewport may show a subset; pan, zoom, or use the complete node list.
    if(cy.zoom()<.85){cy.zoom(.85);cy.center();}
  }
  function memoryGraphStyles() {
    return [
      {selector:"node",style:{"width":34,"height":34,"background-color":"#226a52","border-width":1,"border-color":"#164d3b","label":"data(displayLabel)","font-size":13.5,"font-family":"Segoe UI, Microsoft YaHei, sans-serif","text-valign":"bottom","text-margin-y":8,"text-wrap":"wrap","text-overflow-wrap":"anywhere","text-max-width":148,"color":"#26312c"}},
      {selector:"node[nodeType='task']",style:{"shape":"round-rectangle","background-color":"#3d70a1","border-color":"#2d5072"}},
      {selector:"node[nodeType='source']",style:{"shape":"diamond","background-color":"#b07825","border-color":"#80571d"}},
      {selector:"node[nodeType='scope']",style:{"shape":"hexagon","background-color":"#7b6a98","border-color":"#56466e"}},
      {selector:"node[status='stale'],node[status='conflicted'],node[status='superseded']",style:{"border-style":"dashed","border-width":3,"background-opacity":.45}},
      {selector:"edge",style:{"curve-style":"bezier","line-color":"#99aca2","target-arrow-color":"#99aca2","target-arrow-shape":"triangle","arrow-scale":.8,"width":1.5,"label":"","font-size":9,"text-background-color":"#f6f9f7","text-background-opacity":.95,"text-background-padding":3,"color":"#68776f"}},
      {selector:"edge[relationType='SUPERSEDES']",style:{"line-color":"#9a6a28","target-arrow-color":"#9a6a28","line-style":"dashed"}},
      {selector:"edge[relationType='CONTENT_RELATED']",style:{"line-color":"#85739e","target-arrow-shape":"none","source-arrow-shape":"none","line-style":"dashed"}},
      {selector:".hovered",style:{"overlay-color":"#73968a","overlay-opacity":.12,"overlay-padding":6}},
      {selector:"edge.hovered,edge:selected",style:{"label":"data(displayRelation)"}},
      {selector:"node:selected",style:{"border-color":"#152a20","border-width":4,"overlay-color":"#176b4d","overlay-opacity":.12,"overlay-padding":5}},
      {selector:"edge:selected",style:{"line-color":"#176b4d","target-arrow-color":"#176b4d","width":3}}
    ];
  }
  function renderMemoryGraphNodes() {
    mgEl("nodes").replaceChildren();
    if(!memoryGraphState.data)return;
    memoryGraphState.data.nodes.forEach(function(node) {
      var button=element("button","memory-graph-node");button.type="button";
      button.dataset.nodeId=node.id;button.setAttribute("aria-pressed",String(node.id===memoryGraphState.selectedId));
      button.append(element("strong","",node.label),element("small","",memoryNodeLabel(node)+(node.status?" · "+statusLabel(node.status):"")));
      button.addEventListener("click",function(){selectMemoryGraphNode(node.id);});
      mgEl("nodes").append(button);
    });
  }
  function memoryGraphMarkSelection(id) {
    mgEl("nodes").querySelectorAll("button").forEach(function(button){button.setAttribute("aria-pressed",String(button.dataset.nodeId===id));});
    if(memoryGraphState.cy){memoryGraphState.cy.elements().unselect();var selected=memoryGraphState.cy.getElementById(id);selected.select();if(selected.length&&selected.isNode())memoryGraphState.cy.center(selected);}
  }
  async function selectMemoryGraphNode(id) {
    if(memoryGraphState.loading||!memoryGraphState.data)return;
    var node=memoryGraphState.data.nodes.find(function(item){return item.id===id;});if(!node)return;
    var projectId=memoryGraphState.projectId,sequence=memoryGraphState.sequence,detailSequence=++memoryGraphState.detailSequence;
    if(memoryGraphState.detailController)memoryGraphState.detailController.abort();
    var controller=new AbortController();memoryGraphState.detailController=controller;
    memoryGraphState.selectedId=id;memoryGraphMarkSelection(id);
    mgEl("detail-title").textContent=node.label;mgEl("detail-body").replaceChildren(element("p","memory-graph-muted","正在读取详情…"));
    mgEl("expand-one").disabled=true;mgEl("expand-two").disabled=true;
    mgEl("trace").hidden=true;mgEl("trace").disabled=true;
    try {
      var detail=await fetchJson(memoryGraphBase(projectId)+"/nodes/"+encodeURIComponent(id)+"?includeInactive="+mgEl("history").checked+"&includeSummaries="+String(memoryGraphState.view==="evidence"&&mgEl("summaries").checked),{signal:controller.signal});
      if(!memoryGraphIsCurrent(projectId,sequence)||detailSequence!==memoryGraphState.detailSequence)return;
      renderMemoryGraphDetail(detail);
      mgEl("expand-one").disabled=false;mgEl("expand-two").disabled=false;
      mgEl("trace").hidden=detail.nodeType!=="memory"||memoryGraphState.view==="evidence";
      mgEl("trace").disabled=mgEl("trace").hidden;
      memoryGraphRevealDetail();
    }catch(error){
      if(!memoryGraphIsCurrent(projectId,sequence)||detailSequence!==memoryGraphState.detailSequence||error.name==="AbortError")return;
      mgEl("detail-body").replaceChildren(element("p","memory-graph-muted","详情读取失败："+(error.message||String(error))));
    }
  }
  function memoryGraphFacts(values) {
    var facts=element("dl","memory-graph-facts");
    values.forEach(function(pair){if(pair[1]!==undefined&&pair[1]!==null&&pair[1]!=="")facts.append(element("dt","",pair[0]),element("dd","",Array.isArray(pair[1])?pair[1].join("\n"):pair[1]));});
    return facts;
  }
  function memoryGraphRevealDetail() {
    if(window.innerWidth<=720&&!document.getElementById("portrait-memory-graph").hidden&&!document.getElementById("portrait-view").hidden) {
      mgEl("detail-title").scrollIntoView({block:"nearest"});
    }
  }
  function memorySourceKindLabel(kind) { return {file:"文件",user:"人工记录",tool:"工具记录",inference:"推断",import:"导入",git:"Git 提交",hg:"Mercurial 提交",svn:"Subversion 提交"}[kind]||kind; }
  function memoryGraphSection(title,content) {
    var body=mgEl("detail-body");body.append(element("h4","",title),element("p","",content||"暂无记录"));
  }
  function renderMemoryGraphDetail(detail) {
    var body=mgEl("detail-body");body.replaceChildren();
    var memory=detail.memory,task=detail.task,source=detail.source;
    mgEl("detail-title").textContent=(memory&&memory.title)||(task&&task.goal)||(source&&(source.sourceRef||source.ref||source.path))||(detail.nodeType==="scope"&&detail.scope)||detail.label;
    body.append(memoryGraphFacts([["节点类型",memoryNodeLabel(detail)],["状态",detail.status?statusLabel(detail.status):null]]));
    if(memory){
      if(memory.status!=="active")body.append(element("p","memory-graph-muted","此记忆不是当前活跃结论，请核对历史及来源后使用。"));
      memoryGraphSection("记忆内容",memory.content);
      if(memory.reason)memoryGraphSection("记录理由",memory.reason);
      body.append(memoryGraphFacts([["适用范围",memory.scope],["来源类型",memorySourceKindLabel(memory.sourceKind)],["来源引用",memory.sourceRef],["置信度",memory.confidence],["更新时间",formatDate(memory.updatedAt)]]));
    }
    if(task){
      memoryGraphSection("任务目标",task.goal);
      var checkpoint=task.checkpoint||{};
      if(checkpoint.summary)memoryGraphSection("进度摘要",checkpoint.summary);
      [["completed","已完成"],["next","下一步"],["blockers","阻塞"],["risks","风险"],["changedFiles","修改文件"]].forEach(function(pair){if(checkpoint[pair[0]]&&checkpoint[pair[0]].length)memoryGraphSection(pair[1],checkpoint[pair[0]].join("\n"));});
      body.append(memoryGraphFacts([["任务状态",statusLabel(task.status)],["更新时间",formatDate(task.updatedAt)]]));
    }
    if(source)renderMemoryGraphSource(source);
    if(detail.nodeType==="scope"){
      memoryGraphSection("适用范围",detail.scope||detail.label);
      body.append(element("p","memory-graph-muted","范围连线表示记忆记录声明的适用位置，不表示两条记忆之间存在事实关联。"));
    }
    memoryGraphRelationsFor(detail.id);
    var identifiers=element("details");identifiers.append(element("summary","","记录标识"),element("pre","",detail.id));body.append(identifiers);
    if(detail.truncated)body.append(element("p","memory-graph-muted","详情内容已按返回上限截取；可在原始记忆、任务或来源中查看完整记录。"));
  }
  function renderMemoryGraphSource(source) {
    var body=mgEl("detail-body");
    body.append(memoryGraphFacts([["来源类型",memorySourceKindLabel(source.sourceKind||source.kind)],["来源引用",source.sourceRef||source.ref||source.path]]));
    if(source.available===false||source.missing===true)body.append(element("p","memory-graph-muted","当前来源不可用，以下为保留的历史证据。"));
    var bindings=Array.isArray(source.bindings)?source.bindings:[source];
    bindings.forEach(function(binding,index){
      var excerpt=binding.sourceExcerpt||binding.source_excerpt||binding.excerpt;
      var start=binding.startLine||binding.start_line,end=binding.endLine||binding.end_line;
      if(bindings.length>1)body.append(element("h4","","来源证据 "+(index+1)));
      body.append(memoryGraphFacts([["行号",start?start+(end&&end!==start?"–"+end:""):null],["版本",binding.gitCommit||binding.git_commit],["关联记忆",binding.memoryId||binding.memory_id]]));
      if(excerpt)memoryGraphSection("保留的来源摘录",excerpt);
      var hash=binding.sourceHash||binding.source_hash;
      if(hash){var fingerprint=element("details");fingerprint.append(element("summary","","来源指纹"),element("pre","",hash));body.append(fingerprint);}
    });
  }
  function memoryGraphRelationsFor(id) {
    var data=memoryGraphState.data;if(!data)return;
    var edges=data.edges.filter(function(edge){return edge.source===id||edge.target===id;});
    mgEl("detail-body").append(element("h4","","当前图中的关系 · "+edges.length));
    if(!edges.length)mgEl("detail-body").append(element("p","memory-graph-muted","当前视图未包含相邻关系，可展开邻居查看。"));
    edges.forEach(function(edge){
      var other=data.nodes.find(function(node){return node.id===(edge.source===id?edge.target:edge.source);});
      var direction=edge.relationType==="CONTENT_RELATED"?" · ":edge.source===id?" → ":" ← ";
      var button=element("button","memory-graph-evidence",(memoryRelationLabels[edge.relationType]||edge.relationType)+direction+(other?other.label:"关联节点"));
      button.type="button";button.addEventListener("click",function(){selectMemoryGraphEdge(edge.id);});mgEl("detail-body").append(button);
    });
  }
  function selectMemoryGraphEdge(id) {
    var data=memoryGraphState.data;if(!data||memoryGraphState.loading)return;
    var edge=data.edges.find(function(item){return item.id===id;});if(!edge)return;
    memoryGraphState.detailSequence++;if(memoryGraphState.detailController)memoryGraphState.detailController.abort();
    memoryGraphClearDetail();memoryGraphMarkSelection(id);
    mgEl("detail-title").textContent=(memoryRelationLabels[edge.relationType]||edge.relationType)+" · 关系依据";
    var body=mgEl("detail-body");body.replaceChildren();
    var related=edge.relationType==="CONTENT_RELATED";
    if(related)body.append(element("p","memory-graph-related-note","这两条记忆具有共同的词面线索，仅表示可能相关。它不证明依赖、支持或因果关系，请对照两端原文判断。"));
    [["source",related?"记忆一":"起点"],["target",related?"记忆二":"终点"]].forEach(function(pair){
      var node=data.nodes.find(function(item){return item.id===edge[pair[0]];});
      if(node){var button=element("button","memory-graph-evidence",pair[1]+"："+node.label);button.type="button";button.addEventListener("click",function(){selectMemoryGraphNode(node.id);});body.append(button);}
    });
    if(related){
      if(Array.isArray(edge.sharedTerms)&&edge.sharedTerms.length){
        body.append(element("h4","","共同词项"));
        var terms=element("div","memory-graph-terms");
        edge.sharedTerms.forEach(function(term){terms.append(element("span","memory-graph-term",term));});body.append(terms);
      }
      if(edge.excerpts){memoryGraphSection("记忆一 · 原文线索",edge.excerpts.source);memoryGraphSection("记忆二 · 原文线索",edge.excerpts.target);}
    }
    if(!related)memoryGraphSection("记录依据",edge.evidence);
    memoryGraphRevealDetail();
  }
`;
