export const UI_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Project Context 本地工作台</title>
  <link rel="stylesheet" href="/styles.css">
  <script src="/vendor/cytoscape.js" defer></script>
  <script src="/app.js" defer></script>
</head>
<body>
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark">PC</span>
      <div><strong>Project Context</strong><span>项目与工作记忆</span></div>
    </div>
    <nav class="view-tabs" aria-label="主要视图">
      <button class="tab active" data-view="task" aria-pressed="true"><svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M7 5h10M7 10h10M7 15h10M2 5h1M2 10h1M2 15h1"/></svg>任务流水线</button>
      <button class="tab" data-view="portrait" aria-pressed="false"><svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M3 8h14M8 8v9"/></svg>项目画像</button>
      <button class="tab" data-view="rules" aria-pressed="false"><svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h4m4 0h6M3 14h8m4 0h2"/><circle cx="9" cy="6" r="2"/><circle cx="13" cy="14" r="2"/></svg>规则</button>
      <button class="tab" data-view="context" aria-pressed="false"><svg class="nav-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="m10 2 8 4-8 4-8-4 8-4ZM2 10l8 4 8-4M2 14l8 4 8-4"/></svg>上下文</button>
    </nav>
    <div class="local-state"><span class="status-dot"></span><div><strong>本地运行</strong><span>连接正常</span></div></div>
  </header>

  <main>
    <section id="portrait-view" class="portrait-view" hidden>
      <header class="portrait-toolbar">
        <div><h1>项目画像</h1></div>
        <div class="portrait-actions">
          <div class="field"><label for="portrait-project">项目</label><select id="portrait-project"></select></div>
          <button id="edit-project" class="secondary-button" type="button">编辑项目</button>
          <button id="refresh-portrait" class="secondary-button" type="button">刷新画像</button>
        </div>
      </header>
      <div id="portrait-loading" class="empty-state"><strong>正在读取项目画像</strong></div>
      <div id="portrait-empty" class="empty-state portrait-empty" hidden><strong>没有可展示的项目</strong><span>登记并索引项目后，画像会显示在这里。</span></div>
      <div id="portrait-content" hidden>
        <section class="portrait-identity">
          <div class="portrait-heading">
            <div><div class="portrait-title-row"><h2 id="portrait-name"></h2><span id="portrait-state" class="status-badge active"></span></div><p id="portrait-path"></p></div>
            <div id="portrait-index-state" class="index-state"></div>
          </div>
          <div id="portrait-metrics" class="portrait-metrics"></div>
        </section>
        <nav class="portrait-mode-tabs" aria-label="项目画像模式">
          <button class="portrait-mode active" data-portrait-mode="overview" aria-pressed="true" type="button">项目概览</button>
          <button class="portrait-mode" data-portrait-mode="graph" aria-pressed="false" type="button">代码关系</button>
          <button class="portrait-mode" data-portrait-mode="maintenance" aria-pressed="false" type="button">索引与存储</button>
        </nav>
        <div id="portrait-overview" class="portrait-grid">
          <div class="portrait-column">
          <section class="portrait-section"><header><div><span class="panel-label">ACTIVE WORK</span><h2>进行中的任务</h2></div><button id="portrait-all-tasks" class="secondary-button" type="button">查看全部任务</button></header><div id="portrait-tasks" class="portrait-list"></div></section>
          <section class="portrait-section portrait-span-2"><header><div><span class="panel-label">CODEBASE</span><h2>代码构成</h2></div></header><div id="portrait-file-types" class="file-types"></div></section>
          <section class="portrait-section"><header><div><span class="panel-label">KNOWLEDGE</span><h2>知识状态</h2></div></header><div id="portrait-knowledge" class="status-groups"></div></section>
          <section class="portrait-section"><header><div><span class="panel-label">INDEXED SOURCES</span><h2>主要来源</h2></div></header><div id="portrait-sources" class="portrait-list source-list"></div></section>
          </div>
          <div class="portrait-column">
          <section class="portrait-section"><header><div><span class="panel-label">RECENT MEMORY</span><h2>近期记忆</h2></div></header><div id="portrait-memories" class="portrait-list"></div></section>
          <section class="portrait-section"><header><div><span class="panel-label">VERSION CONTROL</span><h2>版本控制状态</h2></div></header><dl id="portrait-git" class="portrait-facts"></dl></section>
          <section class="portrait-section"><header><div><span class="panel-label">STALE MEMORY</span><h2>待处理记忆</h2></div></header><div id="portrait-stale-memories" class="portrait-list"></div></section>
          <section class="portrait-section"><header><div><span class="panel-label">REVIEW QUEUE</span><h2>待审核候选</h2></div></header><div id="portrait-candidates" class="portrait-list"></div></section>
          </div>
        </div>
        <div id="portrait-maintenance" class="portrait-grid" hidden>
          <div class="portrait-maintenance-actions"><div><h2>索引与存储</h2><p>管理搜索范围、索引升级和数据库空间</p></div><div class="maintenance-toolbar-actions">          <button id="index-project" class="secondary-button" type="button">立即索引</button>
          <button id="optimize-index" class="primary-button" type="button">升级索引并回收空间</button>
          <button id="toggle-watch" class="secondary-button" type="button">启动监听</button>
</div></div>
          <section class="portrait-section portrait-span-2 maintenance-section">
            <header><div><span class="panel-label">DATABASE</span><h2>数据库维护</h2></div><button id="refresh-storage" class="secondary-button" type="button">刷新占用</button></header>
            <div id="storage-usage" class="storage-metrics"></div>
            <details class="storage-inspect"><summary>数据库位置与数据量</summary><p id="storage-path" class="maintenance-note"></p><dl id="storage-counts" class="storage-counts"></dl></details>
            <p class="maintenance-note maintenance-scope">清理对象是数据库内的索引运行日志，不会删除项目文件。记忆、任务、候选及有效索引均保留；日志始终保留最新 10 条。可回收空间为当前空闲页估算。</p>
            <div class="maintenance-columns">
              <section class="maintenance-card" aria-labelledby="manual-cleanup-title"><header><span class="panel-label">ON DEMAND</span><h3 id="manual-cleanup-title">手动清理</h3><p class="maintenance-note">先核对日志明细，再确认本次清理。</p></header>
                <div class="maintenance-controls"><div class="field"><label for="cleanup-retention">本次保留天数</label><input id="cleanup-retention" type="number" min="1" max="3650" step="1" value="30"></div><button id="preview-cleanup" class="primary-button" type="button" disabled>预览清理</button></div>
                <p id="cleanup-result" class="ignore-impact" role="status">请先预览，再确认执行。空间回收期间数据库写入可能短暂等待。</p>
                <div class="maintenance-card-actions"><button id="execute-cleanup" class="danger-button" type="button" disabled>确认执行清理并回收空间</button></div>
              </section>
              <section class="maintenance-card" aria-labelledby="auto-maintenance-title"><header><span class="panel-label">SCHEDULE</span><h3 id="auto-maintenance-title">自动维护</h3><p class="maintenance-note">由你开启，在索引完成后按间隔检查。</p></header>
                <label class="maintenance-toggle"><input id="maintenance-auto" type="checkbox">启用自动维护（默认关闭）</label>
                <div class="maintenance-controls"><div class="field"><label for="maintenance-retention">自动保留天数</label><input id="maintenance-retention" type="number" min="1" max="3650" step="1" value="30"></div><div class="field"><label for="maintenance-interval">执行间隔（小时）</label><input id="maintenance-interval" type="number" min="1" max="8760" step="1" value="24"></div></div>
                <p id="maintenance-result" class="maintenance-note" role="status"></p>
                <p class="maintenance-note">空闲空间至少 16 MiB 且占数据库 20% 时才自动压缩。应用关闭期间不会运行。</p>
                <div class="maintenance-card-actions"><button id="save-maintenance" class="secondary-button" type="button" disabled>保存自动维护设置</button></div>
              </section>
            </div>
            <section class="maintenance-card ranking-settings-card" aria-labelledby="ranking-settings-title"><header><div><span class="panel-label">SEARCH RANKING</span><h3 id="ranking-settings-title">搜索排序权重</h3><p class="maintenance-note">只影响搜索结果顺序，不改变索引内容；范围为 0–2。</p></div><span id="ranking-settings-status" class="subtle-status"></span></header><form id="ranking-settings-form" class="ranking-settings-form"><div class="ranking-fields"><label><span>业务代码片段</span><input id="ranking-business-chunk" type="number" min="0" max="2" step="0.01"></label><label><span>业务代码符号</span><input id="ranking-business-symbol" type="number" min="0" max="2" step="0.01"></label><label><span>记忆结果</span><input id="ranking-memory" type="number" min="0" max="2" step="0.01"></label><label><span>低相关代码片段</span><input id="ranking-low-chunk" type="number" min="0" max="2" step="0.01"></label><label><span>低相关代码符号</span><input id="ranking-low-symbol" type="number" min="0" max="2" step="0.01"></label></div><div class="maintenance-card-actions"><button id="reset-ranking" class="secondary-button" type="button">恢复默认</button><button id="save-ranking" class="primary-button" type="submit">保存权重</button></div></form><p id="ranking-settings-result" class="maintenance-note" role="status"></p></section>
            <section id="cleanup-details" class="cleanup-details" aria-labelledby="cleanup-details-title" hidden><h3 id="cleanup-details-title">清理明细</h3><p id="cleanup-details-note" class="maintenance-note"></p><div id="cleanup-details-table"></div></section>
            <details class="storage-inspect"><summary>最近索引日志 <span id="recent-index-count"></span></summary><p class="maintenance-note">直接展开记录即可查看已有内容，无需重新索引。索引完成后保留当前阅读位置，可按需刷新列表。</p><div class="maintenance-controls log-pagination"><div class="field"><label for="index-log-limit">每页条数</label><select id="index-log-limit"><option value="10">10 条</option><option value="20" selected>20 条</option><option value="50">50 条</option><option value="100">100 条</option></select></div><div class="field"><label for="index-log-status">运行状态</label><select id="index-log-status"><option value="all">全部状态</option><option value="completed">已完成</option><option value="failed">失败</option><option value="running">运行中</option></select></div><button id="index-log-prev" class="secondary-button" type="button" disabled>上一页</button><button id="index-log-next" class="secondary-button" type="button" disabled>下一页</button><button id="refresh-index-logs" class="secondary-button" type="button">刷新日志</button></div><p id="index-log-page" class="maintenance-note" role="status"></p><div id="recent-index-list"></div></details>
            <details class="storage-inspect cleanup-history"><summary>最近清理记录 <span id="cleanup-history-count"></span></summary><p class="maintenance-note">保留最近 20 次手动或自动清理记录。旧版本未记录的清理明细无法恢复。</p><div class="maintenance-controls"><div class="field"><label for="cleanup-history-limit">显示记录数</label><select id="cleanup-history-limit"><option value="5" selected>最近 5 次</option><option value="10">最近 10 次</option><option value="20">最近 20 次</option></select></div></div><div id="cleanup-history-list"></div></details>
          </section>
          <section class="portrait-section portrait-span-2 ignore-section">
            <header><div><span class="panel-label">INDEX FILTER</span><h2>索引过滤</h2></div><span id="ignore-status" class="subtle-status"></span></header>
            <form id="ignore-form" class="ignore-form">
              <div class="ignore-builder">
                <div class="ignore-presets" aria-label="常用忽略规则">
                  <span>快速添加</span>
                  <button class="ignore-preset" data-ignore-preset="generated" type="button">生成代码</button>
                  <button class="ignore-preset" data-ignore-preset="temporary" type="button">日志与临时文件</button>
                  <button class="ignore-preset" data-ignore-preset="snapshots" type="button">测试快照</button>
                </div>
                <div class="ignore-path-row">
                  <label class="sr-only" for="ignore-path">要排除的项目相对路径或扩展名</label>
                  <input id="ignore-path" type="text" maxlength="500" spellcheck="false" placeholder="输入目录、文件或 *.ext">
                  <button id="add-ignore-path" class="secondary-button" type="button">添加规则</button>
                </div>
              </div>
              <label class="sr-only" for="ignore-content">项目忽略规则</label>
              <textarea id="ignore-content" rows="8" maxlength="60000" spellcheck="false" placeholder="build/&#10;*.o&#10;*.a&#10;generated/**"></textarea>
              <div id="ignore-path-warning" class="ignore-warning" hidden><span>检测到 Windows 路径分隔符</span><button id="normalize-ignore" type="button">转换为 /</button></div>
              <div class="ignore-impact" aria-live="polite">
                <strong id="ignore-impact-summary">输入规则后显示影响范围</strong>
                <div id="ignore-impact-paths" class="ignore-impact-paths"></div>
              </div>
              <div class="ignore-actions"><button id="reload-ignore" class="secondary-button" type="button">重新载入</button><button id="save-ignore" class="primary-button" type="submit">保存并索引</button></div>
            </form>
          </section>
        </div>
        <section id="portrait-graph" class="graph-panel" hidden>
          <header class="graph-toolbar">
            <div class="graph-search-wrap">
              <form id="graph-search-form" class="graph-search" role="search">
                <label class="sr-only" for="graph-search">搜索文件、类或函数</label>
                <input id="graph-search" type="search" maxlength="120" autocomplete="off" placeholder="搜索文件、类或函数">
                <button class="secondary-button" type="submit">定位</button>
              </form>
              <div id="graph-search-results" class="graph-search-results" hidden></div>
            </div>
            <fieldset id="graph-relations" class="relation-filters">
              <legend class="sr-only">关系类型</legend>
              <label><input type="checkbox" value="IMPORTS" checked><span class="relation-swatch imports"></span>导入</label>
              <label><input type="checkbox" value="CALLS" checked><span class="relation-swatch calls"></span>调用</label>
              <label><input type="checkbox" value="EXTENDS" checked><span class="relation-swatch extends"></span>继承</label>
              <label><input type="checkbox" value="IMPLEMENTS" checked><span class="relation-swatch implements"></span>实现</label>
            </fieldset>
            <div class="graph-tools">
              <label class="sr-only" for="graph-layout">图布局</label>
              <select id="graph-layout" title="图布局">
                <option value="cose">力导向</option>
                <option value="breadthfirst">分层</option>
                <option value="circle">环形</option>
              </select>
              <button id="graph-fit" class="secondary-button" type="button" title="适应画布">适应</button>
              <button id="graph-relayout" class="secondary-button" type="button" title="重新计算布局">重排</button>
            </div>
          </header>
          <div class="graph-workspace">
            <div class="graph-canvas-wrap">
              <div id="code-graph" class="code-graph" role="application" aria-label="项目代码关系图"></div>
              <div id="graph-loading" class="graph-loading" hidden><strong>正在构建关系图</strong></div>
              <div id="graph-empty" class="graph-loading" hidden><strong>没有可展示的代码关系</strong></div>
            </div>
            <aside id="graph-details" class="graph-details" aria-labelledby="graph-detail-title">
              <header><div><span class="panel-label">NODE DETAIL</span><h2 id="graph-detail-title">选择节点</h2></div><button id="graph-detail-close" class="icon-button" type="button" aria-label="关闭节点详情" title="关闭节点详情">×</button></header>
              <div id="graph-detail-body" class="graph-detail-body"><p class="portrait-list-empty">选择文件或符号后显示详细信息。</p></div>
              <div class="graph-detail-actions">
                <button id="graph-expand-one" class="secondary-button" type="button" disabled>展开一层</button>
                <button id="graph-expand-two" class="secondary-button" type="button" disabled>展开两层</button>
              </div>
            </aside>
          </div>
          <footer class="graph-footer"><span id="graph-status">0 个节点 · 0 条关系</span><span id="graph-scope">文件级概览</span></footer>
        </section>
      </div>
    </section>

    <section id="task-view" class="task-view">
      <header class="task-toolbar">
        <div><h1>任务流水线</h1></div>
        <div class="task-toolbar-actions">
          <div class="task-project-picker">
            <label for="task-project-search">切换项目</label>
            <input id="task-project-search" type="search" role="combobox" autocomplete="off" aria-autocomplete="list" aria-controls="task-project-results" aria-expanded="false" placeholder="搜索项目名称或路径">
            <div id="task-project-results" class="task-project-results" role="listbox" hidden></div>
            <select id="task-project" hidden></select>
          </div>
          <div class="task-live-state" aria-label="自动刷新已开启"><span></span>实时更新</div>
          <button id="refresh-tasks" class="secondary-button" type="button">刷新</button>
        </div>
      </header>
      <div id="task-warnings" class="task-warnings" role="status" hidden></div>
      <div id="task-loading" class="empty-state"><strong>正在读取任务动态</strong></div>
      <div id="task-empty" class="empty-state" hidden><strong>没有可展示的项目</strong><span>登记项目后，任务动态会显示在这里。</span></div>
      <div id="task-workspace" class="task-workspace" hidden>
        <aside class="task-queue" aria-labelledby="task-queue-title">
          <header><div><span class="panel-label">TASK QUEUE</span><h2 id="task-queue-title">任务队列</h2></div><span id="task-count" class="task-count"></span></header>
      <div class="task-filters" aria-label="任务筛选">
        <label class="task-query-field">搜索任务<input id="task-query" type="search" maxlength="200" placeholder="任务目标或当前摘要"></label>
        <details class="task-filter-options"><summary>筛选与排序</summary><div class="task-filter-fields"><label>状态<select id="task-status"><option value="all">全部状态</option><option value="in_progress">进行中</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select></label>
        <label>排序<select id="task-sort"><option value="updated">最近更新</option><option value="created">最近创建</option><option value="completed">最近完成</option></select></label>
        <label class="task-archive-filter"><input id="task-archived" type="checkbox">包含归档项目</label>
        </div></details>
      </div>
          <div id="task-list" class="task-list"></div>
          <nav class="task-list-pagination" aria-label="任务列表分页">
            <div class="task-page-summary"><span id="task-page" aria-live="polite"></span><label for="task-limit">每页<select id="task-limit"><option value="10">10 条</option><option value="20" selected>20 条</option><option value="50">50 条</option></select></label></div>
            <div class="task-page-controls"><button id="task-prev" class="secondary-button" type="button" disabled>上一页</button><span id="task-page-number" aria-live="polite"></span><button id="task-next" class="secondary-button" type="button" disabled>下一页</button></div>
          </nav>
        </aside>
        <div id="task-detail" class="task-detail" aria-live="polite"></div>
      </div>
    </section>

    <section id="rules-view" class="rules-layout" hidden>
      <aside class="scope-panel">
        <div class="panel-label">作用范围</div>
        <nav id="scope-nav" class="scope-nav"></nav>
        <div class="field compact-field">
          <label for="project-filter">项目筛选</label>
          <select id="project-filter"><option value="">全部项目</option></select>
        </div>
        <label class="check-row"><input id="show-inactive" type="checkbox">显示历史和已删除规则</label>
      </aside>

      <section class="rule-list-panel" aria-labelledby="rule-list-title">
        <header class="panel-header">
          <div><h1 id="rule-list-title">全部规则</h1><p id="rule-count">0 条规则</p></div>
          <button id="new-rule" class="primary-button" type="button">新建规则</button>
        </header>
        <div class="search-row">
          <label class="sr-only" for="rule-search">搜索规则</label>
          <input id="rule-search" type="search" placeholder="搜索标题或内容">
        </div>
        <div id="rule-list" class="rule-list" role="list"></div>
        <div id="empty-rules" class="empty-state" hidden><strong>没有匹配的规则</strong><span>调整筛选条件或新建一条规则。</span></div>
      </section>

      <section id="editor-panel" class="editor-panel" aria-labelledby="editor-title">
        <header class="editor-header">
          <div><span class="panel-label">规则编辑器</span><h2 id="editor-title">新建规则</h2></div>
          <div class="editor-tools"><span id="editor-status" class="status-badge active">ACTIVE</span><button id="editor-close" class="icon-button" type="button" aria-label="关闭编辑器" title="关闭编辑器">×</button></div>
        </header>
        <form id="rule-form">
          <div class="field"><label for="rule-title">标题</label><input id="rule-title" name="title" maxlength="160" required></div>
          <div class="two-columns">
            <div class="field"><label for="rule-type">类型</label><select id="rule-type" name="type"></select></div>
            <div class="field"><label for="scope-level">作用域</label><select id="scope-level" name="scopeLevel"></select></div>
          </div>
          <div id="project-field" class="field" hidden><label for="rule-project">所属项目</label><select id="rule-project" name="projectId"></select></div>
          <div id="scope-ref-field" class="field" hidden><label id="scope-ref-label" for="scope-ref">范围定位</label><input id="scope-ref" name="scopeRef" maxlength="500"><small id="scope-ref-help"></small></div>
          <div class="field"><label for="rule-content">规则内容</label><textarea id="rule-content" name="content" rows="8" maxlength="8000" required></textarea></div>
          <div class="field"><label for="rule-reason">原因或背景 <span>可选</span></label><textarea id="rule-reason" name="reason" rows="3" maxlength="3000"></textarea></div>
          <div id="version-note" class="version-note" hidden>保存修改会创建新版本，当前版本将保留为 superseded 历史记录。</div>
          <div class="form-actions">
            <button id="delete-rule" class="danger-button" type="button" hidden>停用规则</button>
            <button id="reactivate-rule" class="secondary-button" type="button" hidden>重新启用</button>
            <button id="save-rule" class="primary-button" type="submit">保存规则</button>
          </div>
        </form>
      </section>
    </section>

    <section id="context-view" class="context-view" hidden>
      <header class="context-header"><div><span class="panel-label">实际组装结果</span><h1>上下文预览</h1></div></header>
      <div class="context-controls">
        <div class="field"><label for="context-project">项目</label><select id="context-project"></select></div>
        <div class="field task-field"><label for="context-task">模拟当前任务</label><textarea id="context-task" rows="3" placeholder="例如：修改认证模块的刷新令牌逻辑"></textarea></div>
        <div class="field budget-field"><label for="context-budget">Token 预算</label><input id="context-budget" type="number" min="500" max="100000" step="500" value="4000"></div>
        <button id="preview-context" class="primary-button" type="button">生成预览</button>
      </div>
      <div id="context-summary" class="context-summary" hidden></div>
      <div id="context-results" class="context-results"></div>
      <div id="empty-context" class="empty-state context-empty"><strong>选择项目并输入任务</strong><span>预览本次会进入模型上下文的个人规则、项目记忆、任务进度和代码证据。</span></div>
    </section>
  </main>

  <dialog id="migration-dialog" aria-labelledby="migration-title">
    <div class="migration-body"><h2 id="migration-title">升级索引：先选择搜索范围</h2>
      <p id="migration-project"></p>
      <p>可勾选不需要搜索的目录，保存为项目忽略规则。默认全部保留，源文件不会删除。随后备份、更新索引并回收空间；全部成功且完整性检查通过后，自动删除本次备份。失败时保留用于恢复。</p>
      <p id="migration-note" role="status"></p>
      <details class="storage-inspect"><summary>升级前磁盘空间检查</summary><pre id="migration-space" role="status">正在检查…</pre><button id="migration-space-refresh" class="secondary-button" type="button">重新检查空间</button></details>
      <div class="migration-filters"><div class="field"><label for="migration-search">搜索文件夹路径</label><input id="migration-search" type="search" placeholder="输入文件夹名称或路径" maxlength="2000"></div><div class="field"><label for="migration-page-size">每页文件夹数</label><select id="migration-page-size"><option value="10">10 个</option><option value="20">20 个</option><option value="50">50 个</option><option value="100">100 个</option></select></div></div>
      <div class="dialog-actions"><button id="migration-recommend" class="secondary-button" type="button" disabled>勾选推荐目录</button></div>
      <p id="migration-recommendation" role="status">推荐会结合项目语言、构建文件和目录证据；学习、示例和业务目录由你判断。</p>
      <div id="migration-directories"></div>
      <div class="migration-pagination"><span id="migration-page-status"></span><button id="migration-page-prev" class="secondary-button" type="button" disabled>上一页</button><button id="migration-page-next" class="secondary-button" type="button" disabled>下一页</button></div>
      <pre id="migration-result" role="status" hidden></pre>
      <div class="migration-action-bar"><p id="migration-action-hint" role="status">检查空间和选中目录后开始升级。</p><div class="dialog-actions"><button id="migration-close" class="secondary-button" type="button">关闭</button><button id="migration-check-job" class="primary-button" type="button" hidden>查询原任务</button><button id="migration-compact" class="secondary-button" type="button" hidden>仅重试空间回收</button><button id="migration-run" class="primary-button" type="button" disabled>暂停访问并升级</button></div></div>
    </div>
  </dialog>
  <dialog id="migration-confirm-dialog" aria-labelledby="migration-confirm-title"><div class="migration-body"><h2 id="migration-confirm-title">确认升级索引？</h2><p id="migration-confirm-message"></p><div class="dialog-actions"><button id="migration-confirm-cancel" class="secondary-button" type="button">返回修改</button><button id="migration-confirm-ok" class="primary-button" type="button">确认并开始</button></div></div></dialog>
  <dialog id="confirm-dialog">
    <form method="dialog"><h2>停用这条规则？</h2><p>规则会转为 deleted 状态并保留审计记录，不会物理删除。</p><div class="dialog-actions"><button value="cancel" class="secondary-button">取消</button><button value="confirm" class="danger-button">停用</button></div></form>
  </dialog>
  <dialog id="unregister-dialog" aria-labelledby="unregister-title"><form method="dialog"><h2 id="unregister-title">移除失效项目登记？</h2><p id="unregister-description"></p><p>仅从项目列表移除登记，不删除源码、备份或个人规则。服务器会再次检查数据库是否确实缺失；数据库仍存在时拒绝移除。</p><div class="dialog-actions"><button class="secondary-button" value="cancel">保留登记</button><button class="danger-button" value="confirm">移除登记</button></div></form></dialog>
  <dialog id="project-dialog">
    <form id="project-form">
      <h2>编辑项目</h2>
      <div class="project-dialog-fields">
        <div class="field"><label for="project-name">项目名称</label><input id="project-name" maxlength="160" required></div>
        <div class="field"><label for="project-root">根目录</label><input id="project-root" maxlength="2000" required spellcheck="false"></div>
      </div>
      <div class="dialog-actions"><button id="cancel-project" class="secondary-button" type="button">取消</button><button id="save-project" class="primary-button" type="submit">保存</button></div>
    </form>
  </dialog>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
</body>
</html>`;

export const UI_CSS = String.raw`:root {
  color-scheme: light;
  --bg: #f4f6f5;
  --surface: #ffffff;
  --surface-muted: #f8faf9;
  --text: #1c2421;
  --muted: #66716c;
  --line: #d9dfdc;
  --line-strong: #bdc7c2;
  --accent: #176b4d;
  --accent-strong: #0d553b;
  --accent-soft: #e6f2ec;
  --amber: #9a5b08;
  --amber-soft: #fff3db;
  --danger: #a73535;
  --danger-soft: #fbeaea;
  --shadow: 0 8px 24px rgba(19, 36, 29, 0.08);
  font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--bg); color: var(--text); font-size: 14px; letter-spacing: 0; }
button, input, select, textarea { font: inherit; letter-spacing: 0; }
button { cursor: pointer; }
.app-header { height: 72px; display: grid; grid-template-columns: minmax(230px, 1fr) auto minmax(230px, 1fr); align-items: center; padding: 0 24px; background: #16221d; color: #fff; border-bottom: 1px solid #2d3b35; box-shadow: 0 5px 18px rgba(13,25,19,.16); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand-mark { width: 36px; height: 36px; display: grid; place-items: center; border: 1px solid rgba(255,255,255,.45); background: #e9f3ee; color: #184b38; border-radius: 6px; font-weight: 900; font-size: 12px; box-shadow: 0 5px 14px rgba(0,0,0,.14); }
.brand div { display: flex; flex-direction: column; min-width: 0; }
.brand strong { font-size: 14px; line-height: 1.2; }
.brand div span { color: #9daea6; font-size: 10px; margin-top: 3px; }
.view-tabs { display: flex; align-items: center; gap: 3px; padding: 4px; border: 1px solid #35443d; border-radius: 6px; background: #101a16; }
.tab { min-width: 0; height: 38px; padding: 0 15px; border: 0; border-radius: 4px; background: transparent; color: #aebdb6; font-size: 12px; font-weight: 700; white-space: nowrap; }
.tab:hover { color: #fff; background: #26342e; }
.tab.active { color: #123d2d; background: #e8f4ee; box-shadow: 0 2px 8px rgba(0,0,0,.16); }
.local-state { justify-self: end; display: flex; align-items: center; gap: 9px; color: #bdc8c3; }
.local-state div { display: grid; gap: 2px; }
.local-state strong { color: #e5ede9; font-size: 11px; }
.local-state div span { color: #8fa199; font-size: 9px; }
.status-dot { width: 7px; height: 7px; border-radius: 50%; background: #58b98d; box-shadow: 0 0 0 3px rgba(88,185,141,.15); }
main { height: calc(100vh - 72px); overflow: hidden; }
.rules-layout { height: 100%; display: grid; grid-template-columns: 210px minmax(300px, 420px) minmax(440px, 1fr); }
.scope-panel, .rule-list-panel, .editor-panel { min-height: 0; background: var(--surface); }
.scope-panel { padding: 22px 14px; border-right: 1px solid var(--line); background: var(--surface-muted); overflow-y: auto; }
.panel-label { display: block; color: var(--muted); font-size: 11px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; }
.scope-nav { display: grid; gap: 3px; margin-bottom: 24px; }
.scope-button { display: flex; justify-content: space-between; width: 100%; padding: 9px 10px; border: 0; border-radius: 5px; background: transparent; color: #39433e; text-align: left; }
.scope-button span { color: var(--muted); font-size: 12px; }
.scope-button.active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 700; }
.field { display: grid; gap: 6px; }
.field label { font-size: 12px; font-weight: 700; color: #3e4944; }
.field label span, .field small { color: var(--muted); font-weight: 400; }
.compact-field { margin-bottom: 16px; }
input, select, textarea { width: 100%; border: 1px solid var(--line-strong); border-radius: 5px; background: #fff; color: var(--text); padding: 9px 10px; outline: none; }
textarea { resize: vertical; line-height: 1.55; }
input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(23,107,77,.1); }
.check-row { display: flex; gap: 8px; align-items: flex-start; color: var(--muted); font-size: 12px; line-height: 1.4; }
.check-row input { width: 15px; margin: 1px 0 0; }
.rule-list-panel { display: flex; flex-direction: column; border-right: 1px solid var(--line); }
.panel-header, .editor-header, .context-header, .portrait-toolbar { min-height: 78px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
h1, h2, p { margin: 0; }
.panel-header h1, .context-header h1, .portrait-toolbar h1 { font-size: 18px; line-height: 1.3; }
.panel-header p { margin-top: 3px; color: var(--muted); font-size: 12px; }
.search-row { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--surface-muted); }
.rule-list { flex: 1; overflow-y: auto; }
.rule-item { width: 100%; display: grid; gap: 7px; padding: 14px 16px; border: 0; border-bottom: 1px solid var(--line); background: #fff; color: inherit; text-align: left; }
.rule-item:hover { background: #f7faf8; }
.rule-item.selected { background: var(--accent-soft); box-shadow: inset 3px 0 var(--accent); }
.rule-item-title { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
.rule-item-title strong { font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
.rule-item p { color: #56615c; font-size: 12px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.rule-meta { display: flex; gap: 6px; flex-wrap: wrap; color: var(--muted); font-size: 11px; }
.meta-pill { padding: 2px 6px; border: 1px solid var(--line); border-radius: 4px; background: #fff; }
.editor-panel { overflow-y: auto; }
.editor-header { position: sticky; top: 0; z-index: 2; background: rgba(255,255,255,.97); }
.editor-header h2 { font-size: 17px; }
.editor-tools { display: flex; align-items: center; gap: 8px; }
.icon-button { width: 32px; height: 32px; display: none; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 5px; background: #fff; color: #44504a; font-size: 21px; line-height: 1; }
.status-badge { border-radius: 4px; padding: 4px 7px; font-size: 10px; font-weight: 800; }
.status-badge.active { color: var(--accent-strong); background: var(--accent-soft); }
.status-badge.inactive { color: var(--amber); background: var(--amber-soft); }
#rule-form { display: grid; gap: 18px; max-width: 760px; padding: 24px; }
.two-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.version-note { padding: 10px 12px; border-left: 3px solid var(--amber); background: var(--amber-soft); color: #704405; font-size: 12px; line-height: 1.5; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
.primary-button, .secondary-button, .danger-button { min-height: 36px; border-radius: 5px; padding: 8px 13px; font-weight: 700; border: 1px solid transparent; }
.primary-button { background: var(--accent); color: #fff; }
.primary-button:hover { background: var(--accent-strong); }
.secondary-button { background: #fff; border-color: var(--line-strong); color: #35413b; }
.danger-button { background: #fff; border-color: #d9a9a9; color: var(--danger); }
.danger-button:hover { background: var(--danger-soft); }
.empty-state { margin: auto; padding: 40px 24px; text-align: center; color: var(--muted); }
.empty-state strong, .empty-state span { display: block; }
.empty-state strong { color: #3d4943; margin-bottom: 6px; }
.context-view { height: 100%; overflow-y: auto; background: var(--surface); }
.context-header { min-height: 84px; }
.context-controls { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(320px, 2fr) 140px auto; align-items: end; gap: 14px; padding: 18px 24px; border-bottom: 1px solid var(--line); background: var(--surface-muted); }
.context-controls .primary-button { margin-bottom: 1px; }
.context-summary { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 24px; border-bottom: 1px solid var(--line); }
.summary-stat { border: 1px solid var(--line); border-radius: 5px; padding: 6px 9px; background: #fff; color: var(--muted); font-size: 12px; }
.summary-stat strong { color: var(--text); margin-right: 4px; }
.context-results { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 0; max-width: 1200px; margin: 0 auto; border-left: 1px solid var(--line); }
.context-section { min-height: 180px; padding: 20px 22px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.context-section h2 { font-size: 14px; margin-bottom: 12px; }
.context-entry { padding: 10px 0; border-top: 1px solid var(--line); }
.context-entry:first-of-type { border-top: 0; }
.context-entry strong { display: block; font-size: 12px; margin-bottom: 4px; overflow-wrap: anywhere; }
.context-entry p { color: #56615c; font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.context-entry small { display: block; margin-top: 5px; color: var(--muted); }
.context-empty { margin-top: 80px; }

.task-filters { flex: 0 0 auto; display: flex; flex-wrap: wrap; align-items: end; gap: 10px; padding: 12px 24px; border-bottom: 1px solid var(--line); }
.task-filters label { display: grid; gap: 5px; color: var(--muted); font-size: 11px; min-width: 0; }
.task-filters .task-query-field { flex: 1 1 300px; max-width: 640px; }
.task-filters input, .task-filters select { min-width: 0; width: 100%; }
.task-filters .task-archive-filter { display: flex; align-items: center; min-height: 38px; }
.task-archive-filter input { width: auto; }
.task-pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; padding: 12px 0; flex: 0 0 auto; }
.task-pagination > span { font-size: 11px; overflow-wrap: anywhere; }
.task-pagination button:disabled, .task-list-pagination button:disabled { opacity: .45; cursor: default; }
.task-list-pagination { flex: 0 0 auto; padding: 10px 12px; border-top: 1px solid var(--line); background: var(--surface); }
.task-page-summary, .task-page-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.task-page-summary { flex-wrap: wrap; margin-bottom: 8px; color: var(--muted); font-size: 11px; }
.task-page-summary > span { min-width: 0; overflow-wrap: anywhere; flex: 1 1 100px; }
.task-page-summary label { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.task-page-summary select { width: auto; min-width: 66px; height: 30px; padding: 3px 6px; font-size: 11px; }
.task-page-controls { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; }
.task-page-controls > span { text-align: center; font-size: 11px; overflow-wrap: anywhere; }
.task-page-controls button { min-width: 0; padding: 7px 9px; font-size: 11px; }
.task-warnings { padding: 10px 24px; max-height: 120px; overflow: auto; background: #fff4df; color: #795518; font-size: 11px; overflow-wrap: anywhere; flex: 0 0 auto; }
.task-detail-tabs { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.task-detail-tabs button[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); }
.task-focus-title, .task-focus-meta > span { min-width: 0; overflow-wrap: anywhere; }
.task-history { padding: 16px; overflow-wrap: anywhere; }
.task-history > p { margin: 10px 0; color: var(--muted); font-size: 12px; }
.task-history-record { border: 1px solid var(--line); border-radius: 5px; margin-top: 12px; min-width: 0; }
.task-history-record > summary { cursor: pointer; padding: 14px; line-height: 1.6; font-size: 12px; }
.task-history-record > p { padding: 0 14px 12px; font-size: 12px; }
.task-history-note, .task-cancelled-note { color: #795518; background: #fff4df; padding: 12px; margin-top: 12px; line-height: 1.6; }
.task-live-state.paused span { animation: none; background: #9da7a2; }
.task-list-item.cancelled .task-list-indicator { background: #b6781f; }
@media (max-width: 760px) {
  .task-filters { padding: 12px 16px; gap: 8px; }
  .task-filters .task-query-field { flex-basis: 100%; max-width: none; }
  .task-filters > label:not(.task-query-field):not(.task-archive-filter) { flex: 1 1 80px; }
  .task-workspace .task-queue { max-height: none; }
  .task-history { padding: 12px; }
}

.task-view { height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--surface); }
.task-toolbar { position: relative; z-index: 10; flex: 0 0 auto; min-height: 76px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 24px; border-bottom: 1px solid var(--line); background: #f9fbfa; box-shadow: 0 2px 10px rgba(19,36,29,.04); }
.task-toolbar .panel-label { margin-bottom: 4px; color: #47715e; font-size: 9px; }
.task-toolbar h1 { font-size: 20px; line-height: 1.25; }
.task-toolbar-actions { display: flex; align-items: end; gap: 10px; }
.task-project-picker { position: relative; width: min(420px, 42vw); display: grid; gap: 5px; }
.task-project-picker > label { color: #3e4944; font-size: 10px; font-weight: 800; }
.task-project-picker input { height: 38px; padding: 8px 11px; background: #fff; font-weight: 650; }
.task-project-results { position: absolute; z-index: 30; top: calc(100% + 6px); left: 0; right: 0; max-height: min(262px, 42vh); overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--line-strong); border-radius: 6px; background: #fff; box-shadow: 0 14px 30px rgba(15,31,23,.18); }
.task-project-option { width: 100%; min-width: 0; display: grid; align-content: center; gap: 3px; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--line); background: #fff; color: var(--text); text-align: left; }
.task-project-option:last-child { border-bottom: 0; }
.task-project-option:hover, .task-project-option.focused { background: #edf7f2; }
.task-project-option.selected { box-shadow: inset 3px 0 #2d8e69; }
.task-project-option strong, .task-project-option small { display: block; overflow-wrap: anywhere; }
.task-project-option strong { font-size: 11px; }
.task-project-option small { color: var(--muted); font-size: 9px; line-height: 1.4; }
.task-project-no-results { padding: 14px 12px; color: var(--muted); font-size: 11px; }
.task-live-state { min-height: 38px; display: flex; align-items: center; gap: 8px; padding: 0 10px; color: var(--muted); font-size: 11px; font-weight: 700; white-space: nowrap; }
.task-live-state span { width: 7px; height: 7px; border-radius: 50%; background: #36a474; box-shadow: 0 0 0 0 rgba(54,164,116,.28); animation: live-pulse 2.2s ease-out infinite; }
.task-workspace { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr); }
.task-queue { min-height: 0; display: flex; flex-direction: column; overflow: hidden; border-right: 1px solid var(--line); background: var(--surface-muted); }
.task-queue > header { flex: 0 0 auto; min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: rgba(248,250,249,.96); }
.task-queue h2 { font-size: 15px; }
.task-count { color: var(--muted); font-size: 11px; }
.task-list { padding: 8px; min-height: 0; flex: 1 1 auto; overflow-y: auto; }
.task-list-group { margin: 12px 8px 6px; color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; }
.task-list-item { width: 100%; display: grid; grid-template-columns: 9px minmax(0, 1fr); gap: 10px; padding: 12px 10px; border: 1px solid transparent; border-radius: 5px; background: transparent; color: var(--text); text-align: left; }
.task-list-item:hover { background: #fff; border-color: var(--line); }
.task-list-item.active { background: #fff; border-color: var(--line-strong); box-shadow: 0 3px 12px rgba(19,36,29,.06); }
.task-list-indicator { width: 8px; height: 8px; margin-top: 4px; border-radius: 50%; background: #9da7a2; }
.task-list-item.in-progress .task-list-indicator { background: #2d9d6c; box-shadow: 0 0 0 4px rgba(45,157,108,.12); }
.task-list-copy { min-width: 0; }
.task-list-copy strong, .task-list-copy span, .task-list-copy small { display: block; overflow-wrap: anywhere; }
.task-list-copy strong { font-size: 12px; line-height: 1.4; }
.task-list-copy span { margin-top: 4px; color: #56615c; font-size: 10px; line-height: 1.45; }
.task-list-copy small { margin-top: 6px; color: var(--muted); font-size: 9px; }
.task-detail { min-width: 0; min-height: 0; overflow-y: auto; background: #fff; }
.task-focus { padding: 26px 28px 22px; border-bottom: 1px solid var(--line); background: linear-gradient(90deg, #f4faf7 0, #fff 58%); }
.task-focus-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; max-width: 1120px; margin: 0 auto; }
.task-focus-title { max-width: 760px; }
.task-focus-title h2 { font-size: 22px; line-height: 1.35; overflow-wrap: anywhere; }
.task-focus-title p { margin-top: 9px; color: #4f5e57; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.factory-scene { --station-position: 37.5%; max-width: 1120px; display: grid; grid-template-rows: 116px auto auto; margin: 22px auto 0; border: 1px solid #cbd8d2; border-radius: 6px; overflow: hidden; background: #fff; box-shadow: 0 7px 18px rgba(19,36,29,.06); }
.factory-floor { position: relative; min-width: 620px; overflow: hidden; background: #edf5f1; }
.factory-floor::before { content: ""; position: absolute; inset: auto 0 0; height: 36px; background: #dce7e1; border-top: 1px solid #c8d6cf; }
.factory-stations { position: absolute; inset: 8px 20px 31px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.factory-station { position: relative; display: grid; justify-items: center; align-content: start; color: #728079; font-size: 9px; font-weight: 800; }
.factory-station-label { position: relative; z-index: 9; order: -1; min-height: 14px; margin-bottom: 4px; line-height: 14px; }
.factory-machine { position: relative; width: 46px; height: 52px; border: 2px solid #64736c; border-radius: 4px 4px 2px 2px; background: #f8fbf9; }
.factory-machine::before { content: ""; position: absolute; top: 9px; left: 8px; width: 26px; height: 15px; border: 2px solid #78867f; border-radius: 2px; background: #dce7e2; }
.factory-machine::after { content: ""; position: absolute; left: 9px; right: 9px; bottom: 8px; height: 4px; border-radius: 2px; background: #aab7b1; box-shadow: 0 -7px #aab7b1; }
.factory-station.done .factory-machine { border-color: #438b6a; background: #e2f1e9; }
.factory-station.done .factory-machine::before { border-color: #4b9a74; background: #bfe3d1; }
.factory-station.current { color: #176342; }
.factory-station.current .factory-machine { border-color: #176b4d; background: #fff; box-shadow: 0 0 0 5px rgba(39,145,99,.12); }
.factory-station.current .factory-machine::before { border-color: #2f9568; background: #bfe9d4; animation: factory-screen 1.15s ease-in-out infinite alternate; }
.factory-conveyor { position: absolute; z-index: 4; left: 28px; right: 28px; bottom: 20px; height: 18px; border: 2px solid #34423b; border-radius: 3px; overflow: hidden; background: repeating-linear-gradient(90deg, #7f9088 0 12px, #acbbb4 12px 24px); }
.factory-conveyor::before, .factory-conveyor::after { content: ""; position: absolute; bottom: -10px; width: 7px; height: 10px; background: #4a5952; }
.factory-conveyor::before { left: 14%; }
.factory-conveyor::after { right: 14%; }
.factory-unit { position: absolute; z-index: 7; bottom: 37px; left: calc(var(--station-position) - 22px); width: 44px; height: 31px; display: grid; place-items: center; border: 2px solid #314039; border-radius: 3px; background: #f0b85b; color: #553508; font-size: 8px; font-weight: 900; transition: left .55s ease; }
.factory-unit::before { content: ""; position: absolute; top: -5px; left: 5px; right: 5px; height: 5px; border: 2px solid #314039; border-bottom: 0; background: #ffd17f; }
.factory-worker { position: absolute; z-index: 8; bottom: 39px; left: calc(var(--station-position) + 24px); width: 34px; height: 53px; transition: left .55s ease; }
.factory-worker-head { position: absolute; top: 0; left: 8px; width: 19px; height: 20px; border: 2px solid #29352f; border-radius: 50%; background: #f1ccb0; }
.factory-worker-head::before { content: ""; position: absolute; top: -4px; left: -3px; right: -3px; height: 9px; border: 2px solid #29352f; border-radius: 9px 9px 2px 2px; background: #e4a82e; }
.factory-worker-body { position: absolute; top: 18px; left: 5px; width: 25px; height: 30px; border: 2px solid #29352f; border-radius: 7px 7px 2px 2px; background: #2d8e69; }
.factory-worker-arm { position: absolute; z-index: 2; top: 24px; left: 3px; width: 8px; height: 25px; border: 2px solid #29352f; border-radius: 7px; background: #f1ccb0; transform-origin: 50% 3px; transform: rotate(48deg); }
.factory-worker-arm.right { left: auto; right: 1px; transform: rotate(-48deg); }
.factory-work-orders { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid #d6e1dc; background: #f8fbf9; }
.factory-order { min-width: 0; padding: 10px 12px 11px; border-right: 1px solid #dce5e1; }
.factory-order:last-child { border-right: 0; }
.factory-order strong, .factory-order span { display: block; overflow-wrap: anywhere; }
.factory-order strong { color: #52615a; font-size: 9px; }
.factory-order span { margin-top: 5px; color: #26352e; font-size: 10px; line-height: 1.5; }
.factory-order.current { background: #eef8f3; box-shadow: inset 0 3px #2f9568; }
.factory-order.current strong { color: #176342; }
.factory-status { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; color: #176342; font-size: 10px; font-weight: 800; }
.factory-status-copy { display: flex; align-items: center; gap: 7px; }
.factory-status-dot { width: 7px; height: 7px; border-radius: 50%; background: #2c9c6c; }
.factory-stage-name { color: var(--muted); font-weight: 700; }
.factory-scene.working .factory-conveyor { animation: factory-belt .65s linear infinite; }
.factory-scene.working .factory-unit { animation: factory-unit 1s ease-in-out infinite alternate; }
.factory-scene.working .factory-worker-head { animation: worker-nod 2.2s ease-in-out infinite; }
.factory-scene.working .factory-worker-arm { animation: factory-work-left .46s ease-in-out infinite alternate; }
.factory-scene.working .factory-worker-arm.right { animation: factory-work-right .46s .23s ease-in-out infinite alternate; }
.factory-scene.working .factory-status-dot { animation: live-pulse 2.2s ease-out infinite; }
.factory-scene.blocked { border-color: #dfbf84; }
.factory-scene.blocked .factory-floor { background: #fff6e5; }
.factory-scene.blocked .factory-station.current .factory-machine { border-color: #ae7014; box-shadow: 0 0 0 5px rgba(174,112,20,.12); }
.factory-scene.blocked .factory-unit { background: #ffd27e; animation: factory-blocked .7s ease-in-out infinite alternate; }
.factory-scene.blocked .factory-order.current { background: #fff6e5; box-shadow: inset 0 3px #bc7b19; }
.factory-scene.blocked .factory-status { color: #82500a; }
.factory-scene.blocked .factory-status-dot { background: #bc7b19; }
.factory-scene.complete { --station-position: 87.5%; }
.factory-scene.complete .factory-unit { background: #7bc39f; color: #123f2d; }
.factory-scene.complete .factory-worker { left: calc(var(--station-position) - 58px); }
.factory-scene.complete .factory-worker-arm { transform: rotate(150deg); }
.factory-scene.complete .factory-worker-arm.right { transform: rotate(-150deg); }
.factory-scene.complete .factory-status { color: #3d6e58; }
.factory-scene.complete .factory-status-dot { background: #438b6a; }
.task-focus-meta { display: flex; flex-wrap: wrap; gap: 12px 20px; max-width: 1120px; margin: 18px auto 0; color: var(--muted); font-size: 10px; }
.task-focus-meta strong { color: #3d4943; }
.task-progress { max-width: 1120px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 24px auto 0; }
.task-progress-step { position: relative; min-width: 0; padding: 20px 10px 0 0; color: var(--muted); font-size: 10px; }
.task-progress-step::before { content: ""; position: absolute; top: 5px; left: 0; right: 0; height: 2px; background: #dfe5e2; }
.task-progress-step::after { content: ""; position: absolute; z-index: 1; top: 0; left: 0; width: 12px; height: 12px; border: 2px solid #c8d0cc; border-radius: 50%; background: #fff; }
.task-progress-step.done::before, .task-progress-step.current::before { background: #67b18f; }
.task-progress-step.done::after { border-color: #2f9568; background: #2f9568; }
.task-progress-step.current { color: var(--accent-strong); font-weight: 800; }
.task-progress-step.current::after { border-color: #258f60; box-shadow: 0 0 0 5px rgba(37,143,96,.13); animation: task-breathe 1.8s ease-in-out infinite; }
.task-progress-step:last-child::before { right: calc(100% - 12px); }
.task-metrics { max-width: 1120px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 0 auto; border-bottom: 1px solid var(--line); }
.task-metric { min-height: 86px; display: grid; align-content: center; padding: 14px 18px; border-right: 1px solid var(--line); }
.task-metric:last-child { border-right: 0; }
.task-metric strong { font-size: 21px; }
.task-metric span { margin-top: 4px; color: var(--muted); font-size: 10px; }
.task-detail-grid { max-width: 1120px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); margin: 0 auto; }
.task-detail-section { min-height: 190px; padding: 22px 24px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.task-detail-section:nth-child(2n) { border-right: 0; }
.task-detail-section h3 { font-size: 13px; }
.task-activity-list { display: grid; margin-top: 12px; }
.task-activity { position: relative; min-height: 34px; padding: 8px 0 8px 22px; border-top: 1px solid var(--line); color: #4c5953; font-size: 11px; line-height: 1.5; overflow-wrap: anywhere; }
.task-activity::before { content: ""; position: absolute; top: 13px; left: 3px; width: 7px; height: 7px; border: 2px solid #85a696; border-radius: 50%; background: #fff; }
.task-activity:first-child { border-top: 0; }
.task-activity.success::before { border-color: #2f9568; background: #2f9568; }
.task-activity.warning::before { border-color: #b6781f; background: #fff4df; }
.task-activity.danger::before { border-color: var(--danger); background: var(--danger-soft); }
.task-activity small { display: block; margin-top: 3px; color: var(--muted); font-size: 9px; }
.task-detail-empty { height: 100%; display: grid; place-items: center; padding: 40px; text-align: center; }
.task-detail-empty strong { display: block; font-size: 16px; }
.task-detail-empty span { display: block; max-width: 460px; margin-top: 7px; color: var(--muted); line-height: 1.55; }
.task-detail-actions { max-width: 1120px; display: flex; justify-content: flex-end; gap: 8px; padding: 16px 24px 28px; margin: 0 auto; }
.task-detail.task-updated { animation: task-update 650ms ease-out; }
@keyframes live-pulse { 0% { box-shadow: 0 0 0 0 rgba(54,164,116,.28); } 70%, 100% { box-shadow: 0 0 0 7px rgba(54,164,116,0); } }
@keyframes task-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(.78); } }
@keyframes task-update { 0% { background: #e9f6ef; } 100% { background: #fff; } }
@keyframes worker-nod { 0%, 68%, 100% { transform: rotate(0); } 74%, 88% { transform: rotate(7deg) translateY(1px); } }
@keyframes factory-screen { from { background: #bfe9d4; box-shadow: inset 0 0 0 0 rgba(255,255,255,.6); } to { background: #72c89f; box-shadow: inset 0 0 0 3px rgba(255,255,255,.55); } }
@keyframes factory-belt { from { background-position-x: 0; } to { background-position-x: 24px; } }
@keyframes factory-unit { from { transform: translateY(0); } to { transform: translateY(-3px); } }
@keyframes factory-work-left { from { transform: rotate(38deg); } to { transform: rotate(62deg) translateY(2px); } }
@keyframes factory-work-right { from { transform: rotate(-38deg); } to { transform: rotate(-62deg) translateY(2px); } }
@keyframes factory-blocked { from { transform: translateX(-2px) rotate(-1deg); } to { transform: translateX(2px) rotate(1deg); } }
.portrait-view { height: 100%; overflow-y: auto; background: var(--surface); }
.portrait-toolbar { position: sticky; top: 0; z-index: 3; min-height: 84px; background: #fff; }
.portrait-actions { display: flex; flex-wrap: wrap; align-items: end; justify-content: flex-end; gap: 10px; }
.portrait-actions .field { min-width: min(320px, 38vw); }
.portrait-identity { padding: 24px; border-bottom: 1px solid var(--line); background: var(--surface-muted); }
.portrait-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; max-width: 1280px; margin: 0 auto 20px; }
.portrait-title-row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.portrait-title-row h2 { font-size: 24px; line-height: 1.25; }
.portrait-heading p { margin-top: 7px; color: var(--muted); font-family: Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
.index-state { flex: 0 0 auto; max-width: 360px; padding-left: 18px; border-left: 3px solid var(--accent); text-align: right; }
.index-state strong, .index-state span { display: block; }
.index-state strong { font-size: 13px; }
.index-state span { margin-top: 4px; color: var(--muted); font-size: 11px; }
.portrait-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); max-width: 1280px; margin: 0 auto; border: 1px solid var(--line); background: #fff; }
.portrait-metric { min-height: 88px; padding: 16px 18px; border-right: 1px solid var(--line); }
.portrait-metric:last-child { border-right: 0; }
.portrait-metric strong, .portrait-metric span { display: block; }
.portrait-metric strong { font-size: 24px; line-height: 1.15; }
.portrait-metric span { margin-top: 7px; color: var(--muted); font-size: 11px; }
.portrait-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); max-width: 1280px; margin: 0 auto; border-left: 1px solid var(--line); }
.portrait-section { min-height: 240px; padding: 22px 24px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.portrait-section.portrait-span-2 { grid-column: 1 / -1; }
.portrait-section > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.portrait-section h2 { font-size: 15px; }
.ignore-section { min-height: 0; }
.maintenance-section { min-height: 0; min-width: 0; }
.storage-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.storage-metric { min-width: 0; padding: 16px; border: 1px solid var(--line); background: var(--surface-muted); }
.storage-metric:first-child { border-color: #b7d6c7; background: var(--accent-soft); }
.storage-metric span { display: block; color: var(--muted); font-size: 12px; }
.storage-metric strong { display: block; margin-top: 8px; font-size: clamp(16px, 2vw, 25px); font-variant-numeric: tabular-nums; white-space: nowrap; }
.storage-inspect { min-width: 0; margin-top: 16px; border-top: 1px solid var(--line); }
.storage-inspect > summary { padding: 13px 0; cursor: pointer; color: #35413b; font-size: 12px; font-weight: 700; }
.storage-inspect > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.storage-counts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px 22px; margin: 0 0 14px; }
.storage-count { display: flex; justify-content: space-between; gap: 12px; min-width: 0; font-size: 12px; }
.storage-count dt { color: var(--muted); }
.storage-count dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.maintenance-scope { padding: 12px 14px; background: var(--surface-muted); border-left: 3px solid var(--accent); }
.maintenance-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }
.maintenance-card { min-width: 0; display: flex; flex-direction: column; padding: 20px; border: 1px solid var(--line); border-radius: 6px; }
.maintenance-card h3, .cleanup-details h3 { margin: 5px 0 0; font-size: 15px; }
.maintenance-card .ignore-impact { margin: 0 0 12px; line-height: 1.7; overflow-wrap: anywhere; }
.maintenance-card-actions { margin-top: auto; padding-top: 10px; }
.cleanup-details { margin-top: 22px; }
.cleanup-table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--line); border-radius: 4px; }
.cleanup-table { width: 100%; min-width: 640px; border-collapse: collapse; table-layout: fixed; font-size: 11px; text-align: left; }
.cleanup-table th { background: var(--surface-muted); color: var(--muted); font-weight: 700; }
.cleanup-table th, .cleanup-table td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.cleanup-table tr:last-child td { border-bottom: 0; }
.cleanup-table th:first-child { width: 25%; }
.cleanup-table th:nth-child(2), .cleanup-table th:nth-child(3) { width: 18%; }
.cleanup-table th:nth-child(4) { width: 10%; }
.cleanup-table caption { text-align: left; padding: 10px; color: var(--muted); }
.cleanup-log > summary { cursor: pointer; color: var(--accent-strong); font-weight: 700; }
.cleanup-log-content { width: 100%; max-width: calc(100vw - 120px); margin: 10px 0 0; padding: 12px; background: var(--surface-muted); }
.cleanup-log-content p { margin: 0 0 8px; line-height: 1.7; overflow-wrap: anywhere; }
.cleanup-log-error { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }
.cleanup-log-error code, .cleanup-log-error pre { display: block; margin: 4px 0 0; font-family: Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.process-log { margin: 10px 0; padding: 0; list-style: none; }
.process-log li { padding: 8px 0; border-top: 1px solid var(--line); white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
.process-log-meta { display: block; color: var(--muted); font-size: 10px; }
.process-log-path { display: block; font-family: Consolas, monospace; }
.cleanup-history-item { margin-bottom: 10px; padding: 0 14px 12px; border: 1px solid var(--line); border-radius: 4px; }
.cleanup-history-item > summary { display: list-item; padding: 12px 0; cursor: pointer; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.cleanup-history-item > summary span { display: inline-block; margin-right: 14px; }
.cleanup-history-item > summary strong { color: var(--accent-strong); }
.maintenance-note { margin: 10px 0; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.maintenance-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; margin: 14px 0; }
.maintenance-controls .field { flex: 1 1 110px; min-width: 0; max-width: 190px; }
.maintenance-controls input { width: 100%; min-width: 0; }
.maintenance-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.maintenance-toggle input { width: auto; }
.ranking-settings-card { margin-top: 18px; }
.ranking-settings-form { display: grid; gap: 14px; }
.ranking-fields { display: grid; grid-template-columns: repeat(5, minmax(110px, 1fr)); gap: 10px; }
.ranking-fields label { display: grid; gap: 6px; min-width: 0; color: var(--muted); font-size: 11px; }
.ranking-fields input { width: 100%; min-width: 0; font-variant-numeric: tabular-nums; }
.ranking-settings-card .maintenance-card-actions { display: flex; gap: 8px; flex-wrap: wrap; }
@media (max-width: 900px) { .maintenance-columns { grid-template-columns: minmax(0, 1fr); } .storage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ranking-fields { grid-template-columns: repeat(3, minmax(110px, 1fr)); } }
@media (max-width: 560px) { .storage-metrics { gap: 8px; } .storage-metric { padding: 12px; } .storage-counts { grid-template-columns: minmax(0, 1fr); } .maintenance-card { padding: 15px; } .maintenance-card-actions button { max-width: 100%; white-space: normal; } .ranking-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.ignore-form { display: grid; gap: 10px; }
.ignore-builder { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .8fr); gap: 12px; align-items: center; }
.ignore-presets { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.ignore-presets > span { margin-right: 3px; color: var(--muted); font-size: 12px; font-weight: 700; }
.ignore-preset { min-height: 30px; padding: 5px 9px; border: 1px solid var(--line-strong); border-radius: 5px; background: #fff; color: #35413b; font-size: 12px; font-weight: 700; }
.ignore-preset:hover { border-color: var(--accent); color: var(--accent-strong); }
.ignore-path-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
.ignore-path-row input { min-width: 0; }
.ignore-form textarea { width: 100%; min-height: 152px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; line-height: 1.55; }
.ignore-warning { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; border-left: 3px solid var(--amber); background: var(--amber-soft); color: #704405; font-size: 12px; }
.ignore-warning button { border: 0; padding: 0; background: transparent; color: #704405; font-weight: 800; text-decoration: underline; }
.ignore-impact { min-height: 48px; padding: 9px 11px; border: 1px solid var(--line); background: var(--surface-muted); color: var(--muted); font-size: 12px; }
.ignore-impact strong { color: #35413b; }
.ignore-impact-paths { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 5px; }
.ignore-impact-paths code { overflow-wrap: anywhere; }
.ignore-actions { display: flex; justify-content: flex-end; gap: 8px; }
.subtle-status { color: var(--muted); font-size: 12px; }
.file-types { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 34px; }
.file-type { display: grid; grid-template-columns: minmax(70px, .6fr) minmax(120px, 1fr) auto; align-items: center; gap: 10px; min-height: 36px; border-top: 1px solid var(--line); font-size: 12px; }
.file-type:nth-child(-n+2) { border-top: 0; }
.file-type strong { overflow-wrap: anywhere; }
.file-type-track { height: 6px; background: #e8ecea; overflow: hidden; }
.file-type-track span { display: block; height: 100%; background: var(--accent); }
.file-type small { color: var(--muted); white-space: nowrap; }
.portrait-facts { display: grid; grid-template-columns: minmax(100px, .7fr) minmax(0, 1.3fr); margin: 0; }
.portrait-facts dt, .portrait-facts dd { min-height: 38px; margin: 0; padding: 10px 0; border-top: 1px solid var(--line); font-size: 12px; overflow-wrap: anywhere; }
.portrait-facts dt:first-of-type, .portrait-facts dt:first-of-type + dd { border-top: 0; }
.portrait-facts dt { color: var(--muted); }
.status-groups { display: grid; gap: 16px; }
.status-group h3 { margin: 0 0 7px; font-size: 12px; }
.status-values { display: flex; flex-wrap: wrap; gap: 7px; }
.status-value { padding: 5px 8px; border: 1px solid var(--line); background: var(--surface-muted); color: var(--muted); font-size: 11px; }
.status-value strong { color: var(--text); margin-right: 5px; }
.portrait-list { display: grid; }
.portrait-item { padding: 11px 0; border-top: 1px solid var(--line); }
.portrait-item:first-child { border-top: 0; padding-top: 0; }
.portrait-item strong, .portrait-item span, .portrait-item small { display: block; overflow-wrap: anywhere; }
.portrait-item strong { font-size: 12px; line-height: 1.45; }
.portrait-item span { margin-top: 4px; color: #56615c; font-size: 11px; line-height: 1.5; }
.portrait-item small { margin-top: 5px; color: var(--muted); font-size: 10px; }
.portrait-item-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 9px; }
.portrait-item-actions button { min-height: 30px; padding: 5px 9px; font-size: 10px; }
.portrait-list-empty { color: var(--muted); font-size: 12px; }
.source-list .portrait-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 14px; }
.source-list .portrait-item small { grid-column: 1 / -1; margin-top: 0; }
.portrait-empty { margin-top: 80px; }
.portrait-mode-tabs { position: sticky; top: 84px; z-index: 2; display: flex; justify-content: center; min-height: 46px; border-bottom: 1px solid var(--line); background: #fff; }
.portrait-mode { position: relative; min-width: 108px; border: 0; background: transparent; color: var(--muted); font-weight: 700; }
.portrait-mode.active { color: var(--accent-strong); }
.portrait-mode.active::after { content: ""; position: absolute; left: 16px; right: 16px; bottom: -1px; height: 3px; background: var(--accent); }
.graph-panel { scroll-margin-top: 130px; background: #fff; }
.graph-toolbar { position: relative; z-index: 2; min-height: 64px; display: grid; grid-template-columns: minmax(260px, 1fr) auto auto; align-items: center; gap: 16px; padding: 12px 18px; border-bottom: 1px solid var(--line); background: var(--surface-muted); }
.graph-search-wrap { position: relative; max-width: 520px; }
.graph-search { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.graph-search-results { position: absolute; z-index: 8; top: calc(100% + 5px); left: 0; right: 0; max-height: 320px; overflow-y: auto; border: 1px solid var(--line-strong); background: #fff; box-shadow: var(--shadow); }
.graph-search-result { width: 100%; display: grid; gap: 3px; padding: 10px 12px; border: 0; border-bottom: 1px solid var(--line); background: #fff; text-align: left; }
.graph-search-result:last-child { border-bottom: 0; }
.graph-search-result:hover, .graph-search-result:focus { background: var(--accent-soft); }
.graph-search-result strong { font-size: 12px; overflow-wrap: anywhere; }
.graph-search-result small { color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.relation-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin: 0; padding: 0; border: 0; }
.relation-filters label { min-height: 34px; display: flex; align-items: center; gap: 5px; padding: 6px 8px; border: 1px solid var(--line); background: #fff; color: #46514c; font-size: 11px; cursor: pointer; }
.relation-filters label:has(input:not(:checked)) { color: #8b9490; background: #f1f3f2; }
.relation-filters input { width: 14px; margin: 0; }
.relation-swatch { width: 8px; height: 8px; border-radius: 50%; }
.relation-swatch.imports { background: #177b57; }
.relation-swatch.calls { background: #3377b6; }
.relation-swatch.extends { background: #a05d08; }
.relation-swatch.implements { background: #a43d52; }
.graph-tools { display: flex; align-items: center; gap: 7px; }
.graph-tools select { width: 100px; }
.graph-workspace { height: min(720px, calc(100vh - 258px)); min-height: 540px; display: grid; grid-template-columns: minmax(0, 1fr) 320px; border-bottom: 1px solid var(--line); }
.graph-canvas-wrap { position: relative; min-width: 0; overflow: hidden; background: #f7f9f8; }
.code-graph { position: absolute; inset: 0; }
.graph-loading { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; background: rgba(247,249,248,.88); color: var(--muted); }
.graph-loading strong { padding: 9px 12px; border: 1px solid var(--line); background: #fff; color: #3d4943; font-size: 12px; }
.graph-details { min-width: 0; display: flex; flex-direction: column; border-left: 1px solid var(--line); background: #fff; }
.graph-details > header { min-height: 74px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.graph-details h2 { font-size: 15px; overflow-wrap: anywhere; }
.graph-detail-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
.graph-detail-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--surface-muted); }
.graph-facts { display: grid; grid-template-columns: 88px minmax(0, 1fr); margin: 0 0 18px; }
.graph-facts dt, .graph-facts dd { min-height: 34px; margin: 0; padding: 8px 0; border-top: 1px solid var(--line); font-size: 11px; overflow-wrap: anywhere; }
.graph-facts dt:first-of-type, .graph-facts dt:first-of-type + dd { border-top: 0; }
.graph-facts dt { color: var(--muted); }
.graph-detail-section { margin-top: 18px; }
.graph-detail-section h3 { margin: 0 0 8px; font-size: 12px; }
.graph-detail-entry { padding: 8px 0; border-top: 1px solid var(--line); }
.graph-detail-entry strong, .graph-detail-entry span, .graph-detail-entry small { display: block; overflow-wrap: anywhere; }
.graph-detail-entry strong { font-size: 11px; }
.graph-detail-entry span { margin-top: 3px; color: #56615c; font-size: 10px; }
.graph-detail-entry small { margin-top: 4px; color: var(--muted); font-size: 9px; }
.graph-footer { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 18px; color: var(--muted); font-size: 11px; background: #fff; }
.graph-footer span:last-child { color: var(--text); font-weight: 700; }
dialog { width: min(420px, calc(100vw - 32px)); border: 1px solid var(--line); border-radius: 6px; padding: 0; box-shadow: var(--shadow); }
dialog::backdrop { background: rgba(20, 27, 24, .45); }
dialog form { padding: 22px; }
dialog h2 { font-size: 17px; margin-bottom: 8px; }
dialog p { color: var(--muted); line-height: 1.5; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 22px; }
.project-dialog-fields { display: grid; gap: 14px; margin-top: 18px; }
#project-dialog { width: min(560px, calc(100vw - 32px)); }
#migration-dialog { width: min(800px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: auto; }
.migration-body { padding: 20px; min-width: 0; }
.migration-body p, #migration-result { overflow-wrap: anywhere; }
#migration-directories { max-height: 40dvh; overflow: auto; display: grid; gap: 8px; }
.migration-pagination { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
.migration-pagination span { margin-right: auto; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.migration-filters { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.migration-filters .field:first-child { flex: 1 1 200px; min-width: 0; }
.migration-filters input { min-width: 0; width: 100%; }
#migration-space { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 12px; line-height: 1.6; }
.migration-directory { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 8px; padding: 10px; border: 1px solid var(--line); }
.migration-directory input { width: 16px; height: 16px; margin-top: 3px; }
.migration-directory:hover { border-color: var(--accent); }
.migration-directory:has(input:checked) { background: var(--accent-soft); border-color: var(--accent); }
.migration-directory input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.migration-directory strong, .migration-directory small { display: block; overflow-wrap: anywhere; }
.migration-directory small { color: var(--muted); margin-top: 4px; line-height: 1.5; }
#migration-result { white-space: pre-wrap; padding: 12px; background: var(--surface-muted); font: inherit; line-height: 1.65; }
#migration-dialog .dialog-actions { flex-wrap: wrap; }
.migration-action-bar { position: sticky; bottom: -20px; background: var(--surface, #fff); padding: 12px 0 0; border-top: 1px solid var(--line); margin-top: 12px; }
.migration-action-bar .dialog-actions { margin-top: 8px; padding-bottom: 12px; }
#migration-action-hint { margin: 0; font-size: 12px; overflow-wrap: anywhere; }
#migration-dialog button:disabled { cursor: not-allowed; opacity: .55; }
@media (max-width: 520px) { .migration-action-bar .dialog-actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); } .migration-action-bar button { min-width: 0; white-space: normal; overflow-wrap: anywhere; } }
#project-root { font-family: Consolas, monospace; }
.toast { position: fixed; right: 22px; bottom: 22px; max-width: min(420px, calc(100vw - 44px)); padding: 11px 14px; border-radius: 5px; background: #202824; color: #fff; box-shadow: var(--shadow); opacity: 0; transform: translateY(8px); pointer-events: none; transition: .18s ease; }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.error { background: var(--danger); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
[hidden] { display: none !important; }
@media (max-width: 980px) {
  .app-header { grid-template-columns: 1fr auto; }
  .view-tabs { order: 3; grid-column: 1 / -1; height: 44px; justify-content: center; padding: 3px; border-width: 1px 0 0; border-radius: 0; background: #101a16; }
  .local-state { display: none; }
  .app-header { height: 116px; }
  main { height: calc(100vh - 116px); }
  .rules-layout { grid-template-columns: 190px minmax(280px, 1fr); }
  .editor-panel { display: none; position: fixed; z-index: 5; top: 116px; right: 0; bottom: 0; width: min(560px, calc(100vw - 40px)); box-shadow: -8px 0 28px rgba(20,32,27,.15); }
  .editor-panel.open { display: block; }
  .icon-button { display: grid; }
  .context-controls { grid-template-columns: 1fr 1fr; }
  .task-field { grid-column: 1 / -1; }
  .task-workspace { grid-template-columns: 260px minmax(0, 1fr); }
  .portrait-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .portrait-metric:nth-child(2) { border-right: 0; }
  .portrait-metric:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .graph-toolbar { grid-template-columns: 1fr auto; }
  .graph-search-wrap { max-width: none; }
  .relation-filters { grid-column: 1 / -1; grid-row: 2; }
  .graph-tools { grid-column: 2; grid-row: 1; }
  .graph-workspace { grid-template-columns: minmax(0, 1fr) 280px; }
}
@media (max-width: 640px) {
  .app-header { padding: 0 14px; }
  .rules-layout { display: block; overflow-y: auto; }
  .scope-panel { border-right: 0; border-bottom: 1px solid var(--line); padding: 12px; }
  .scope-nav { display: flex; overflow-x: auto; margin-bottom: 12px; }
  .scope-button { width: auto; flex: 0 0 auto; gap: 8px; }
  .compact-field, .check-row { display: none; }
  .rule-list-panel { min-height: calc(100vh - 210px); border-right: 0; }
  .editor-panel { top: 116px; left: 0; width: 100vw; }
  .two-columns { grid-template-columns: 1fr; }
  #rule-form { padding: 18px 16px 90px; }
  .form-actions { position: fixed; z-index: 6; left: 0; right: 0; bottom: 0; padding: 12px 16px; background: #fff; border-top: 1px solid var(--line); }
  .context-controls { grid-template-columns: 1fr; padding: 16px; }
  .task-field { grid-column: auto; }
  .context-results { grid-template-columns: 1fr; border-left: 0; }
  .context-section { border-right: 0; }
  .tab { min-width: 0; height: 36px; flex: 1 1 0; padding-inline: 5px; font-size: 10px; }
  .task-view { overflow-y: auto; }
  .task-toolbar { align-items: stretch; flex-direction: column; padding: 12px 16px; }
  .task-toolbar-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; }
  .task-project-picker { width: auto; min-width: 0; }
  .task-project-results { max-height: min(238px, 38vh); }
  .task-workspace { height: auto; min-height: calc(100% - 138px); display: block; }
  .task-queue { border-right: 0; border-bottom: 1px solid var(--line); }
  .task-queue > header { min-height: 54px; padding-block: 9px; }
  .task-list { display: flex; flex: 0 0 auto; max-height: 200px; gap: 7px; overflow: auto; padding: 8px 12px 12px; }
  .task-list-group { display: none; }
  .task-list-item { flex: 0 0 min(78vw, 290px); background: #fff; border-color: var(--line); }
  .task-detail { overflow: visible; }
  .task-focus { padding: 22px 16px 18px; }
  .task-focus-heading { display: grid; }
  .task-focus-title h2 { font-size: 18px; }
  .factory-scene { overflow: hidden; }
  .factory-floor { min-width: 0; }
  .factory-work-orders { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .factory-order:nth-child(2n) { border-right: 0; }
  .factory-order:nth-child(-n+2) { border-bottom: 1px solid #dce5e1; }
  .factory-status { background: #fff; }
  .factory-scene.blocked .factory-status { background: #fffaf0; }
  .task-progress { overflow-x: auto; grid-template-columns: repeat(4, minmax(92px, 1fr)); padding-bottom: 4px; }
  .task-metrics { grid-template-columns: 1fr 1fr; }
  .task-metric:nth-child(2) { border-right: 0; }
  .task-metric:nth-child(-n+2) { border-bottom: 1px solid var(--line); }
  .task-detail-grid { grid-template-columns: 1fr; }
  .task-detail-section, .task-detail-section:nth-child(2n) { min-height: 0; padding: 20px 16px; border-right: 0; }
  .task-detail-actions { padding-inline: 16px; }
  .portrait-toolbar { align-items: stretch; flex-direction: column; padding: 14px 16px; }
  .portrait-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .portrait-actions .field { grid-column: 1 / -1; min-width: 0; }
  .portrait-actions > button { width: 100%; padding-inline: 6px; }
  .portrait-identity { padding: 20px 16px; }
  .portrait-heading { display: grid; gap: 16px; }
  .portrait-title-row h2 { font-size: 21px; }
  .index-state { max-width: none; text-align: left; }
  .portrait-metrics { grid-template-columns: 1fr 1fr; }
  .portrait-metric { min-height: 78px; padding: 14px; }
  .portrait-metric strong { font-size: 20px; }
  .portrait-grid { grid-template-columns: 1fr; border-left: 0; }
  .portrait-section, .portrait-section.portrait-span-2 { grid-column: auto; border-right: 0; padding: 20px 16px; }
  .ignore-builder { grid-template-columns: 1fr; }
  .ignore-presets { align-items: flex-start; }
  .ignore-path-row { grid-template-columns: minmax(0, 1fr) auto; }
  .ignore-actions { display: grid; grid-template-columns: 1fr 1fr; }
  .file-types { grid-template-columns: 1fr; }
  .file-type:nth-child(2) { border-top: 1px solid var(--line); }
  .portrait-mode-tabs { top: 142px; }
  .graph-panel { scroll-margin-top: 188px; }
  .graph-toolbar { display: grid; grid-template-columns: 1fr; gap: 10px; padding: 12px; }
  .graph-search-wrap, .relation-filters, .graph-tools { grid-column: auto; grid-row: auto; }
  .relation-filters { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  .relation-filters label { flex: 0 0 auto; }
  .graph-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; }
  .graph-tools select { width: 100%; }
  .graph-workspace { position: relative; height: calc(100vh - 318px); min-height: 500px; display: block; }
  .graph-canvas-wrap { position: absolute; inset: 0; }
  .graph-details { position: absolute; z-index: 5; left: 0; right: 0; bottom: 0; height: min(46%, 380px); border-left: 0; border-top: 1px solid var(--line-strong); box-shadow: 0 -8px 24px rgba(19,36,29,.1); transform: translateY(100%); transition: transform .18s ease; }
  .graph-details.open { transform: translateY(0); }
  .graph-details .icon-button { display: grid; }
  .graph-footer { align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .task-live-state span, .task-progress-step.current::after, .task-detail.task-updated,
  .factory-conveyor, .factory-unit, .factory-worker-head, .factory-worker-arm,
  .factory-machine::before, .factory-status-dot { animation: none !important; }
  .factory-unit, .factory-worker { transition: none; }
  .toast, .graph-details { transition: none; }
}
`;

export const UI_JS = String.raw`(function () {
  "use strict";
  var state = {
    projects: [], memories: [], scope: "all", selectedId: null, portraitProjectId: null, portrait: null,
    graphCy: null, graphProjectId: null, graphRoot: null, graphScope: "files",
    graphSelectedId: null, graphSearchResults: [], graphSearchSequence: 0, graphSearchTimer: null,
    portraitLoading: false, ignoreProjectId: null, taskProjectId: null, taskPortrait: null,
    taskMutating: false, taskOffset: 0, taskSequence: 0, taskHistorySequence: 0, taskHistoryOffset: 0, taskDetailMode: "current", taskSearchTimer: null, taskQueryKey: null,
    taskLoading: false, selectedTaskId: null, taskSignature: null, taskProjectActiveIndex: -1
  };
  var scopes = [
    ["all", "全部规则"], ["user", "全局"], ["workspace", "工作区"],
    ["project", "项目"], ["module", "模块"], ["task", "任务"]
  ];
  var types = [["constraint", "约束"], ["preference", "偏好"], ["decision", "决策"], ["fact", "事实"], ["lesson", "经验"], ["issue", "问题"], ["assumption", "假设"], ["task-summary", "任务总结"]];
  var els = {};
  var TASK_PROJECT_STORAGE_KEY = "project-context-mcp:task-project-id";
  var maintenanceSequence = 0, maintenanceProjectId = null, cleanupPreview = null, maintenanceBusy = false;
  var indexLogSequence = 0, indexLogOffset = 0, indexLogTotal = 0, indexLogLoading = false, cachedCleanupHistory = [];

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindEvents();
    populateStaticOptions();
    try {
      await establishSession();
      await refresh();
      newRule(false);
      await loadTaskView(false, false);
      window.setInterval(refreshWatchedPortrait, 1500);
      window.setInterval(refreshTaskActivity, 2500);
    } catch (error) {
      toast(error.message || String(error), true);
      document.getElementById("rule-list").replaceChildren(errorState("无法连接本地规则服务"));
    }
  }

  function cacheElements() {
    ["scope-nav", "project-filter", "show-inactive", "rule-search", "rule-list", "empty-rules", "rule-count",
      "new-rule", "rule-form", "editor-title", "editor-status", "rule-title", "rule-type", "scope-level",
      "project-field", "rule-project", "scope-ref-field", "scope-ref", "scope-ref-label", "scope-ref-help",
      "rule-content", "rule-reason", "version-note", "delete-rule", "reactivate-rule", "save-rule", "confirm-dialog",
      "editor-panel", "editor-close",
      "context-project", "context-task", "context-budget", "preview-context", "context-results",
      "context-summary", "empty-context",
      "storage-path", "storage-usage", "storage-counts", "refresh-storage", "cleanup-retention", "preview-cleanup", "execute-cleanup", "cleanup-result", "maintenance-auto", "maintenance-retention", "maintenance-interval", "save-maintenance", "maintenance-result", "ranking-settings-form", "ranking-business-chunk", "ranking-business-symbol", "ranking-memory", "ranking-low-chunk", "ranking-low-symbol", "reset-ranking", "save-ranking", "ranking-settings-status", "ranking-settings-result",
      "cleanup-details", "cleanup-details-title", "cleanup-details-note", "cleanup-details-table", "cleanup-history-count", "cleanup-history-list",
      "recent-index-count", "recent-index-list", "index-log-limit", "index-log-status", "index-log-prev", "index-log-next", "index-log-page", "cleanup-history-limit", "refresh-index-logs",
      "task-query", "task-status", "task-sort", "task-limit", "task-archived", "task-warnings", "task-page", "task-prev", "task-next",
      "task-project", "task-project-search", "task-project-results", "refresh-tasks", "task-loading", "task-empty", "task-workspace", "task-count", "task-list", "task-detail",
      "portrait-project", "edit-project", "index-project", "toggle-watch", "refresh-portrait", "portrait-loading", "portrait-empty", "portrait-content",
      "portrait-name", "portrait-state", "portrait-path", "portrait-index-state", "portrait-metrics", "optimize-index",
      "project-dialog", "project-form", "project-name", "project-root", "cancel-project", "save-project",
      "portrait-file-types", "portrait-git", "portrait-knowledge", "portrait-all-tasks", "portrait-tasks", "portrait-memories", "portrait-stale-memories",
      "portrait-sources", "portrait-candidates", "portrait-overview", "portrait-graph", "portrait-maintenance",
      "ignore-form", "ignore-content", "ignore-status", "reload-ignore", "save-ignore", "ignore-path", "add-ignore-path",
      "ignore-path-warning", "normalize-ignore", "ignore-impact-summary", "ignore-impact-paths",
      "graph-search-form", "graph-search", "graph-search-results", "graph-relations", "graph-layout",
      "graph-fit", "graph-relayout", "graph-loading", "graph-empty", "code-graph", "graph-details",
      "graph-detail-title", "graph-detail-body", "graph-detail-close", "graph-expand-one", "graph-expand-two",
      "graph-status", "graph-scope", "toast"].forEach(function (id) { els[id] = document.getElementById(id); });
  }

  function bindEvents() {
    document.querySelectorAll(".tab").forEach(function (button) {
      button.addEventListener("click", function () { switchView(button.dataset.view); });
    });
    els["project-filter"].addEventListener("change", renderRules);
    els["show-inactive"].addEventListener("change", renderRules);
    els["rule-search"].addEventListener("input", renderRules);
    els["new-rule"].addEventListener("click", function () { newRule(true); });
    els["editor-close"].addEventListener("click", function () { els["editor-panel"].classList.remove("open"); });
    els["scope-level"].addEventListener("change", updateScopeFields);
    els["rule-form"].addEventListener("submit", saveRule);
    els["delete-rule"].addEventListener("click", function () { els["confirm-dialog"].showModal(); });
    els["confirm-dialog"].addEventListener("close", function () {
      if (els["confirm-dialog"].returnValue === "confirm") updateSelectedStatus("deleted");
    });
    els["reactivate-rule"].addEventListener("click", function () { updateSelectedStatus("active"); });
    els["preview-context"].addEventListener("click", previewContext);
    els["task-project"].addEventListener("change", function () {
      storeTaskProjectId(els["task-project"].value);
      state.taskProjectId = null; state.taskPortrait = null; state.selectedTaskId = null; state.taskSignature = null;
      state.taskOffset = 0; state.taskDetailMode = "current"; state.taskHistorySequence++;
      syncTaskProjectSearch();
      loadTaskView(true, false);
    });
    els["task-project-search"].addEventListener("focus", function () {
      els["task-project-search"].select();
      renderTaskProjectResults("");
    });
    els["task-project-search"].addEventListener("click", function () {
      if (els["task-project-results"].hidden) {
        els["task-project-search"].select();
        renderTaskProjectResults("");
      }
    });
    els["task-project-search"].addEventListener("input", function () { renderTaskProjectResults(els["task-project-search"].value); });
    els["task-project-search"].addEventListener("keydown", taskProjectSearchKeydown);
    document.addEventListener("click", function (event) {
      if (!event.target.closest(".task-project-picker")) closeTaskProjectResults();
    });
    function changeTaskFilter() {
      window.clearTimeout(state.taskSearchTimer); state.taskSearchTimer = null;
      state.taskOffset = 0; state.taskDetailMode = "current"; state.taskHistorySequence++;
      loadTaskView(true, false);
    }
    ["task-status", "task-sort", "task-limit", "task-archived"].forEach(function (id) { els[id].addEventListener("change", changeTaskFilter); });
    els["task-query"].addEventListener("input", function () {
      window.clearTimeout(state.taskSearchTimer); state.taskSequence++;
      state.taskSearchTimer = window.setTimeout(changeTaskFilter, 300);
    });
    els["task-prev"].addEventListener("click", function () { state.taskOffset = Math.max(0, state.taskOffset - Number(els["task-limit"].value)); loadTaskView(true, false); });
    els["task-next"].addEventListener("click", function () { state.taskOffset += Number(els["task-limit"].value); loadTaskView(true, false); });
    els["refresh-tasks"].addEventListener("click", function () { loadTaskView(true, false); });
    els["portrait-all-tasks"].addEventListener("click", function () {
      var projectId = els["portrait-project"].value;
      if (!projectId) return;
      window.clearTimeout(state.taskSearchTimer); state.taskSearchTimer = null;
      els["task-query"].value = ""; els["task-status"].value = "all";
      els["task-project"].value = projectId;
      var project = projectById(projectId);
      if (project && project.archivedAt) els["task-archived"].checked = true;
      storeTaskProjectId(projectId); syncTaskProjectSearch();
      state.taskOffset = 0; state.selectedTaskId = null; state.taskDetailMode = "current";
      state.taskHistoryOffset = 0; state.taskHistorySequence++; state.taskSequence++; state.taskQueryKey = null;
      switchView("task");
    });
    els["portrait-project"].addEventListener("change", function () { resetGraph(); state.ignoreProjectId = null; resetMaintenance(); loadPortrait(true); });
    els["refresh-storage"].addEventListener("click", function () { loadMaintenance(els["portrait-project"].value); });
    els["ranking-settings-form"].addEventListener("submit", saveRankingSettings);
    els["reset-ranking"].addEventListener("click", function () { fillRankingSettings(defaultRankingSettings()); });
    els["preview-cleanup"].addEventListener("click", function () { runCleanup(false); });
    els["execute-cleanup"].addEventListener("click", function () { runCleanup(true); });
    els["cleanup-retention"].addEventListener("input", invalidateCleanupPreview);
    els["save-maintenance"].addEventListener("click", saveMaintenance);
    ["index-log-limit", "index-log-status"].forEach(function (id) { els[id].addEventListener("change", function () { loadIndexLogs(true); }); });
    els["index-log-prev"].addEventListener("click", function () { if (!indexLogLoading) { indexLogOffset = Math.max(0, indexLogOffset - Number(els["index-log-limit"].value)); loadIndexLogs(false); } });
    els["index-log-next"].addEventListener("click", function () { if (!indexLogLoading) { indexLogOffset += Number(els["index-log-limit"].value); loadIndexLogs(false); } });
    els["refresh-index-logs"].addEventListener("click", function () { loadIndexLogs(false); });
    els["cleanup-history-limit"].addEventListener("change", function () { renderCleanupHistory(cachedCleanupHistory); });
    els["edit-project"].addEventListener("click", openProjectEditor);
    els["project-form"].addEventListener("submit", saveProject);
    els["cancel-project"].addEventListener("click", function () { els["project-dialog"].close(); });
    els["index-project"].addEventListener("click", indexSelectedProject);
    els["optimize-index"].addEventListener("click", optimizeSelectedProject);
    els["toggle-watch"].addEventListener("click", toggleSelectedWatch);
    els["refresh-portrait"].addEventListener("click", function () { loadPortrait(true); });
    els["ignore-form"].addEventListener("submit", saveIgnoreRules);
    els["reload-ignore"].addEventListener("click", function () { loadIgnoreRules(els["portrait-project"].value, false); });
    els["ignore-content"].addEventListener("input", ignoreContentChanged);
    els["add-ignore-path"].addEventListener("click", addIgnorePath);
    els["ignore-path"].addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); addIgnorePath(); }
    });
    els["normalize-ignore"].addEventListener("click", function () {
      els["ignore-content"].value = els["ignore-content"].value.replaceAll("\\", "/");
      ignoreContentChanged();
    });
    document.querySelectorAll(".ignore-preset").forEach(function (button) {
      button.addEventListener("click", function () { addIgnoreRules(ignorePresets[button.dataset.ignorePreset] || []); });
    });
    document.querySelectorAll(".portrait-mode").forEach(function (button) {
      button.addEventListener("click", function () { setPortraitMode(button.dataset.portraitMode); });
    });
    els["graph-search-form"].addEventListener("submit", function (event) {
      event.preventDefault();
      if (state.graphSearchResults.length) focusGraphResult(state.graphSearchResults[0]);
      else searchGraph(true);
    });
    els["graph-search"].addEventListener("input", function () {
      clearTimeout(state.graphSearchTimer);
      state.graphSearchTimer = setTimeout(function () { searchGraph(false); }, 220);
    });
    els["graph-search"].addEventListener("blur", function () {
      setTimeout(function () { els["graph-search-results"].hidden = true; }, 140);
    });
    els["graph-relations"].addEventListener("change", reloadGraph);
    els["graph-layout"].addEventListener("change", runGraphLayout);
    els["graph-fit"].addEventListener("click", function () { if (state.graphCy) state.graphCy.animate({ fit: { eles: state.graphCy.elements(), padding: 42 }, duration: 220 }); });
    els["graph-relayout"].addEventListener("click", runGraphLayout);
    els["graph-expand-one"].addEventListener("click", function () { expandGraph(1); });
    els["graph-expand-two"].addEventListener("click", function () { expandGraph(2); });
    els["graph-detail-close"].addEventListener("click", function () { els["graph-details"].classList.remove("open"); });
    window.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !document.getElementById("rules-view").hidden) {
        event.preventDefault(); els["rule-form"].requestSubmit();
      }
    });
  }

  function populateStaticOptions() {
    scopes.slice(1).forEach(function (scope) { addOption(els["scope-level"], scope[0], scope[1]); });
    types.forEach(function (type) { addOption(els["rule-type"], type[0], type[1]); });
  }

  async function establishSession() {
    var params = new URLSearchParams(location.hash.slice(1));
    var token = params.get("token");
    if (token) {
      await fetchJson("/api/session", { method: "POST", body: { token: token }, allowUnauthorized: true });
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  async function refresh() {
    var data = await fetchJson("/api/bootstrap");
    state.projects = data.projects;
    state.memories = data.memories;
    renderProjectOptions();
    renderScopeNav();
    renderRules();
  }

  function renderProjectOptions() {
    [els["project-filter"], els["rule-project"], els["context-project"], els["portrait-project"], els["task-project"]].forEach(function (select, index) {
      var current = select.value;
      if (select === els["task-project"] && !current) current = readTaskProjectId();
      select.replaceChildren();
      if (index === 0 || select === els["task-project"]) addOption(select, "", "全部项目");
      else if (state.projects.length === 0) addOption(select, "", "没有已登记项目");
      state.projects.forEach(function (project) { addOption(select, project.id, project.name + (project.archivedAt ? "（已归档）" : "")); });
      if ([].some.call(select.options, function (option) { return option.value === current; })) select.value = current;
      if (select === els["task-project"]) {
        storeTaskProjectId(select.value);
        var restoredProject = projectById(select.value);
        if (restoredProject && restoredProject.archivedAt) els["task-archived"].checked = true;
      }
    });
    syncTaskProjectSearch();
    els["edit-project"].disabled = !els["portrait-project"].value;
  }

  function openProjectEditor() {
    var project = projectById(els["portrait-project"].value);
    if (!project) return;
    els["project-name"].value = project.name;
    els["project-root"].value = project.rootPath;
    els["project-dialog"].showModal();
    els["project-name"].focus();
    els["project-name"].select();
  }

  async function saveProject(event) {
    event.preventDefault();
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    els["save-project"].disabled = true;
    try {
      await fetchJson("/api/projects/" + encodeURIComponent(projectId), {
        method: "PUT",
        body: { name: els["project-name"].value, rootPath: els["project-root"].value }
      });
      await refresh();
      state.portraitProjectId = null;
      state.taskProjectId = null;
      state.taskPortrait = null;
      resetGraph();
      els["project-dialog"].close();
      await loadPortrait(true);
      toast("项目名称和根目录已更新");
    } catch (error) {
      toast(error.message || String(error), true);
    } finally {
      els["save-project"].disabled = false;
    }
  }

  function readTaskProjectId() {
    try { return window.localStorage.getItem(TASK_PROJECT_STORAGE_KEY) || ""; }
    catch (_) { return ""; }
  }

  function storeTaskProjectId(projectId) {
    try {
      if (projectId) window.localStorage.setItem(TASK_PROJECT_STORAGE_KEY, projectId);
      else window.localStorage.removeItem(TASK_PROJECT_STORAGE_KEY);
    } catch (_) {}
  }

  function syncTaskProjectSearch() {
    var project = projectById(els["task-project"].value);
    els["task-project-search"].value = project ? project.name : "全部项目";
    els["task-project-search"].title = project ? project.rootPath : "";
  }

  function renderTaskProjectResults(query) {
    var normalized = query.trim().toLocaleLowerCase();
    var matches = [{ id: "", name: "全部项目", rootPath: "汇总各项目任务（默认不含归档项目）" }].concat(state.projects).filter(function (project) {
      return !normalized || project.name.toLocaleLowerCase().includes(normalized) || project.rootPath.toLocaleLowerCase().includes(normalized);
    }).slice(0, 30);
    state.taskProjectActiveIndex = matches.length ? 0 : -1;
    els["task-project-results"].replaceChildren();
    if (!matches.length) els["task-project-results"].append(element("div", "task-project-no-results", "没有匹配的项目"));
    matches.forEach(function (project, index) {
      var option = element("button", "task-project-option" + (project.id === els["task-project"].value ? " selected" : "") + (index === 0 ? " focused" : ""));
      option.type = "button"; option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(project.id === els["task-project"].value));
      option.append(element("strong", "", project.name), element("small", "", project.rootPath));
      option.addEventListener("click", function () { selectTaskProject(project.id); });
      els["task-project-results"].append(option);
    });
    els["task-project-results"].hidden = false;
    els["task-project-search"].setAttribute("aria-expanded", "true");
  }

  function taskProjectSearchKeydown(event) {
    var options = [].slice.call(els["task-project-results"].querySelectorAll(".task-project-option"));
    if (event.key === "Escape") { event.preventDefault(); closeTaskProjectResults(); return; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (els["task-project-results"].hidden) { renderTaskProjectResults(els["task-project-search"].value); options = [].slice.call(els["task-project-results"].querySelectorAll(".task-project-option")); }
      if (!options.length) return;
      state.taskProjectActiveIndex = (state.taskProjectActiveIndex + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options.forEach(function (option, index) { option.classList.toggle("focused", index === state.taskProjectActiveIndex); });
      options[state.taskProjectActiveIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && !els["task-project-results"].hidden && options[state.taskProjectActiveIndex]) {
      event.preventDefault(); options[state.taskProjectActiveIndex].click();
    }
  }

  function selectTaskProject(projectId) {
    var project = projectById(projectId);
    if (project && project.archivedAt) els["task-archived"].checked = true;
    els["task-project"].value = projectId;
    closeTaskProjectResults();
    els["task-project"].dispatchEvent(new Event("change"));
  }

  function closeTaskProjectResults() {
    els["task-project-results"].hidden = true;
    els["task-project-search"].setAttribute("aria-expanded", "false");
    syncTaskProjectSearch();
  }

  function renderScopeNav() {
    els["scope-nav"].replaceChildren();
    scopes.forEach(function (scope) {
      var count = state.memories.filter(function (memory) { return scope[0] === "all" || memory.scopeLevel === scope[0]; }).length;
      var button = element("button", "scope-button" + (state.scope === scope[0] ? " active" : ""));
      button.type = "button";
      button.append(element("b", "", scope[1]), element("span", "", String(count)));
      button.addEventListener("click", function () { state.scope = scope[0]; renderScopeNav(); renderRules(); });
      els["scope-nav"].append(button);
    });
  }

  function filteredMemories() {
    var query = els["rule-search"].value.trim().toLowerCase();
    var projectId = els["project-filter"].value;
    return state.memories.filter(function (memory) {
      if (!els["show-inactive"].checked && memory.status !== "active") return false;
      if (state.scope !== "all" && memory.scopeLevel !== state.scope) return false;
      if (projectId && memory.projectId !== projectId) return false;
      if (query && (memory.title + " " + memory.content).toLowerCase().indexOf(query) < 0) return false;
      return true;
    });
  }

  function renderRules() {
    var memories = filteredMemories();
    els["rule-list"].replaceChildren();
    els["empty-rules"].hidden = memories.length !== 0;
    els["rule-count"].textContent = memories.length + " 条规则";
    memories.forEach(function (memory) {
      var button = element("button", "rule-item" + (state.selectedId === memory.id ? " selected" : ""));
      button.type = "button"; button.setAttribute("role", "listitem");
      var title = element("div", "rule-item-title");
      title.append(element("strong", "", memory.title), statusBadge(memory.status));
      var meta = element("div", "rule-meta");
      meta.append(metaPill(scopeLabel(memory.scopeLevel)), metaPill(typeLabel(memory.type)));
      var project = projectById(memory.projectId);
      if (project) meta.append(metaPill(project.name));
      button.append(title, element("p", "", memory.content), meta);
      button.addEventListener("click", function () { selectRule(memory.id); });
      els["rule-list"].append(button);
    });
  }

  function newRule(openEditor) {
    state.selectedId = null;
    els["rule-form"].reset();
    els["rule-type"].value = "constraint";
    els["scope-level"].value = state.scope === "all" ? "user" : state.scope;
    els["editor-title"].textContent = "新建规则";
    setEditorStatus("active");
    els["version-note"].hidden = true;
    els["delete-rule"].hidden = true;
    els["reactivate-rule"].hidden = true;
    els["save-rule"].hidden = false;
    updateScopeFields(); renderRules();
    if (openEditor || window.innerWidth > 980) {
      els["editor-panel"].classList.add("open");
      els["rule-title"].focus();
    }
  }

  function selectRule(id) {
    var memory = state.memories.find(function (item) { return item.id === id; });
    if (!memory) return;
    state.selectedId = id;
    els["rule-title"].value = memory.title;
    els["rule-type"].value = memory.type;
    els["scope-level"].value = memory.scopeLevel;
    els["rule-project"].value = memory.projectId || "";
    els["scope-ref"].value = memory.scopeRef || "";
    els["rule-content"].value = memory.content;
    els["rule-reason"].value = memory.reason || "";
    els["editor-title"].textContent = memory.title;
    setEditorStatus(memory.status);
    els["version-note"].hidden = memory.status !== "active";
    els["delete-rule"].hidden = memory.status !== "active";
    els["reactivate-rule"].hidden = memory.status !== "deleted";
    els["save-rule"].hidden = memory.status !== "active";
    updateScopeFields(); renderRules();
    if (window.innerWidth <= 980) {
      els["editor-panel"].classList.add("open");
      els["rule-title"].focus();
    }
  }

  function updateScopeFields() {
    var scope = els["scope-level"].value;
    var needsProject = ["project", "module", "task"].indexOf(scope) >= 0;
    var needsRef = ["workspace", "module", "task"].indexOf(scope) >= 0;
    els["project-field"].hidden = !needsProject;
    els["scope-ref-field"].hidden = !needsRef;
    els["rule-project"].required = needsProject;
    els["scope-ref"].required = needsRef;
    if (scope === "workspace") {
      els["scope-ref-label"].textContent = "工作区绝对路径";
      els["scope-ref-help"].textContent = "规则适用于该目录下的所有已登记项目。";
    } else if (scope === "module") {
      els["scope-ref-label"].textContent = "模块匹配词";
      els["scope-ref-help"].textContent = "当前任务包含这个词时应用，例如 authentication。";
    } else if (scope === "task") {
      els["scope-ref-label"].textContent = "任务匹配词";
      els["scope-ref-help"].textContent = "当前任务包含这个词时应用，例如 migration。";
    }
  }

  async function saveRule(event) {
    event.preventDefault();
    var payload = {
      title: els["rule-title"].value.trim(), type: els["rule-type"].value,
      content: els["rule-content"].value.trim(), reason: els["rule-reason"].value.trim() || undefined,
      scopeLevel: els["scope-level"].value
    };
    if (["project", "module", "task"].indexOf(payload.scopeLevel) >= 0) payload.projectId = els["rule-project"].value;
    if (["workspace", "module", "task"].indexOf(payload.scopeLevel) >= 0) payload.scopeRef = els["scope-ref"].value.trim();
    try {
      var wasEditing = Boolean(state.selectedId);
      var saved = await fetchJson(wasEditing ? "/api/memories/" + encodeURIComponent(state.selectedId) : "/api/memories", {
        method: wasEditing ? "PUT" : "POST", body: payload
      });
      await refresh(); selectRule(saved.id); toast(wasEditing ? "已保存新版本" : "规则已创建");
    } catch (error) { toast(error.message || String(error), true); }
  }

  async function updateSelectedStatus(status) {
    if (!state.selectedId) return;
    try {
      var updated = await fetchJson("/api/memories/" + encodeURIComponent(state.selectedId) + "/status", { method: "PATCH", body: { status: status } });
      await refresh(); selectRule(updated.id); toast(status === "active" ? "规则已重新启用" : "规则已停用");
    } catch (error) { toast(error.message || String(error), true); }
  }

  async function previewContext() {
    var projectId = els["context-project"].value;
    var task = els["context-task"].value.trim();
    if (!projectId || !task) { toast("请选择项目并填写模拟任务", true); return; }
    els["preview-context"].disabled = true;
    try {
      var context = await fetchJson("/api/context-preview", { method: "POST", body: {
        projectId: projectId, task: task, budgetTokens: Number(els["context-budget"].value)
      }});
      renderContext(context); toast("上下文预览已生成");
    } catch (error) { toast(error.message || String(error), true); }
    finally { els["preview-context"].disabled = false; }
  }

  function renderContext(context) {
    els["empty-context"].hidden = true;
    els["context-results"].replaceChildren();
    els["context-summary"].hidden = false;
    els["context-summary"].replaceChildren(
      summaryStat("使用", context.budget.usedTokens + " tokens"), summaryStat("预算", context.budget.requestedTokens),
      summaryStat("个人规则", context.userMemories.length), summaryStat("项目记忆", context.constraints.length + context.decisions.length + context.lessons.length),
      summaryStat("任务", context.activeTasks.length), summaryStat("检索证据", context.relevant.length)
    );
    addContextSection("个人规则", context.userMemories, function (item) { return item.scopeLevel + (item.scopeRef ? " · " + item.scopeRef : ""); });
    addContextSection("项目约束与决策", context.constraints.concat(context.decisions), function (item) { return item.type + (item.sourceRef ? " · " + item.sourceRef : ""); });
    addContextSection("任务进度", context.activeTasks, function (item) { return item.status; }, function (item) { return item.checkpoint.summary || item.goal; });
    addContextSection("相关代码与文档", context.relevant, function (item) { return item.kind + (item.source ? " · " + item.source : ""); });
    if (context.warnings.length) addContextSection("警告", context.warnings.map(function (warning) { return { title: "需要复核", content: warning }; }), function () { return "warning"; });
  }

  function addContextSection(title, items, meta, content) {
    var section = element("section", "context-section");
    section.append(element("h2", "", title + " · " + items.length));
    if (!items.length) section.append(element("p", "", "本次没有选中内容。"));
    items.forEach(function (item) {
      var entry = element("div", "context-entry");
      entry.append(element("strong", "", item.title || item.goal || item.name || "上下文项"));
      entry.append(element("p", "", content ? content(item) : (item.content || "")));
      entry.append(element("small", "", meta(item)));
      section.append(entry);
    });
    els["context-results"].append(section);
  }

  function invalidateCleanupPreview() {
    cleanupPreview = null;
    els["execute-cleanup"].disabled = true;
    els["cleanup-details"].hidden = true;
    els["cleanup-details-table"].replaceChildren();
    els["cleanup-result"].textContent = "请先预览，再确认执行。空间回收期间数据库写入可能短暂等待。";
  }

  function resetMaintenance() {
    maintenanceSequence++;
    indexLogSequence++; indexLogOffset = 0; indexLogTotal = 0; indexLogLoading = false; cachedCleanupHistory = [];
    els["index-log-page"].textContent = "";
    els["index-log-status"].value = "all";
    updateIndexLogButtons();
    maintenanceProjectId = null;
    maintenanceBusy = false;
    invalidateCleanupPreview();
    els["storage-usage"].replaceChildren();
    els["storage-counts"].replaceChildren();
    els["cleanup-history-list"].replaceChildren();
    els["cleanup-history-count"].textContent = "";
    document.getElementById("recent-index-count").textContent = "";
    document.getElementById("recent-index-list").replaceChildren();
    els["storage-path"].textContent = "正在读取数据库占用";
    els["maintenance-result"].textContent = "";
    els["maintenance-auto"].checked = false;
    els["cleanup-retention"].value = "30";
    els["maintenance-retention"].value = "30";
    els["maintenance-interval"].value = "24";
    setMaintenanceBusy(true);
  }

  function setMaintenanceBusy(busy) {
    maintenanceBusy = busy;
    ["refresh-storage", "preview-cleanup", "save-maintenance", "cleanup-retention", "maintenance-auto", "maintenance-retention", "maintenance-interval"].forEach(function (id) { els[id].disabled = busy; });
    els["execute-cleanup"].disabled = busy || !cleanupPreview;
  }

  function maintenancePath(projectId, action) { return "/api/projects/" + encodeURIComponent(projectId) + "/" + action; }
  function rankingPath(projectId) { return "/api/projects/" + encodeURIComponent(projectId) + "/search-ranking"; }
  function defaultRankingSettings() { return { businessChunk: 1, businessSymbol: 1.12, memory: 0.78, lowRelevanceChunk: 0.48, lowRelevanceSymbol: 0.62 }; }
  function fillRankingSettings(settings) {
    els["ranking-business-chunk"].value = settings.businessChunk;
    els["ranking-business-symbol"].value = settings.businessSymbol;
    els["ranking-memory"].value = settings.memory;
    els["ranking-low-chunk"].value = settings.lowRelevanceChunk;
    els["ranking-low-symbol"].value = settings.lowRelevanceSymbol;
  }
  async function loadRankingSettings(projectId) {
    var settings = await fetchJson(rankingPath(projectId));
    fillRankingSettings(settings); els["ranking-settings-status"].textContent = "已加载";
  }
  async function saveRankingSettings(event) {
    event.preventDefault();
    var projectId = els["portrait-project"].value;
    var input = ["ranking-business-chunk", "ranking-business-symbol", "ranking-memory", "ranking-low-chunk", "ranking-low-symbol"].map(function (id) { return Number(els[id].value); });
    if (input.some(function (value) { return !Number.isFinite(value) || value < 0 || value > 2; })) { els["ranking-settings-result"].textContent = "权重必须是 0 到 2 之间的数字。"; return; }
    try {
      var settings = await fetchJson(rankingPath(projectId), { method: "PUT", body: { businessChunk: input[0], businessSymbol: input[1], memory: input[2], lowRelevanceChunk: input[3], lowRelevanceSymbol: input[4] } });
      fillRankingSettings(settings); els["ranking-settings-status"].textContent = "已保存"; els["ranking-settings-result"].textContent = "已保存；新的搜索请求会立即使用这组权重。";
    } catch (error) { els["ranking-settings-result"].textContent = error.message || "保存失败，请重试。"; }
  }
  function maintenanceCurrent(projectId, sequence) { return sequence === maintenanceSequence && els["portrait-project"].value === projectId; }
  function storageBytes(value) { return (Number(value || 0) / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " MiB"; }
  function storageMetricBytes(value) {
    var amount = Number(value || 0) / 1048576, units = ["MiB", "GiB", "TiB", "PiB"], unit = 0;
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
    return amount.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " " + units[unit];
  }
  function renderStorage(usage) {
    els["storage-path"].textContent = usage.databasePath;
    els["storage-usage"].replaceChildren();
    [["总占用", usage.totalBytes], ["数据库文件", usage.databaseBytes], ["WAL 日志", usage.walBytes], ["可回收空间（估算）", usage.reclaimableBytes]].forEach(function (item) {
      var metric = element("div", "storage-metric"); metric.append(element("span", "", item[0]), element("strong", "", storageMetricBytes(item[1]))); els["storage-usage"].append(metric);
    });
    els["storage-counts"].replaceChildren();
    var sharedMemory = element("div", "storage-count"); sharedMemory.append(element("dt", "", "SHM 共享内存"), element("dd", "", storageBytes(usage.shmBytes))); els["storage-counts"].append(sharedMemory);
    var countLabels = { sources: "索引文件", chunks: "内容片段", symbols: "代码符号", relations: "代码关系", memories: "记忆", tasks: "任务", task_events: "任务历史", task_checkpoint_requests: "检查点请求记录", memory_candidates: "记忆候选", index_runs: "索引运行日志" };
    Object.keys(usage.counts || {}).forEach(function (name) {
      var count = element("div", "storage-count"); count.append(element("dt", "", countLabels[name] || name), element("dd", "", formatNumber(usage.counts[name]) + " 条")); els["storage-counts"].append(count);
    });
    if (usage.cleanupHistory) renderCleanupHistory(usage.cleanupHistory);
  }

  function updateIndexLogButtons() {
    els["refresh-index-logs"].disabled = indexLogLoading;
    els["index-log-prev"].disabled = indexLogLoading || indexLogOffset <= 0;
    els["index-log-next"].disabled = indexLogLoading || indexLogOffset + Number(els["index-log-limit"].value) >= indexLogTotal;
  }

  async function loadIndexLogs(resetPage) {
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    if (resetPage) indexLogOffset = 0;
    var sequence = ++indexLogSequence, limit = Number(els["index-log-limit"].value), status = els["index-log-status"].value, offset = indexLogOffset;
    indexLogLoading = true; updateIndexLogButtons();
    els["index-log-page"].textContent = "正在读取索引日志…";
    els["recent-index-list"].setAttribute("aria-busy", "true");
    try {
      var result = await fetchJson(maintenancePath(projectId, "index-logs") + "?limit=" + limit + "&offset=" + offset + "&status=" + encodeURIComponent(status));
      if (sequence !== indexLogSequence || els["portrait-project"].value !== projectId) return;
      indexLogTotal = result.total;
      if (result.total > 0 && offset >= result.total) { indexLogOffset = Math.floor((result.total - 1) / limit) * limit; await loadIndexLogs(false); return; }
      if (!result.total) indexLogOffset = 0;
      els["recent-index-count"].textContent = "（共 " + formatNumber(result.total) + " 条）";
      els["index-log-page"].textContent = result.total ? "第 " + (Math.floor(indexLogOffset / limit) + 1) + " / " + Math.ceil(result.total / limit) + " 页 · 显示 " + (indexLogOffset + 1) + "–" + (indexLogOffset + result.items.length) + " 条，共 " + formatNumber(result.total) + " 条" : "当前条件下没有索引运行日志";
      replaceLogContent(els["recent-index-list"], cleanupDetailTable(result.items, "索引运行日志"));
    } catch (error) {
      if (sequence !== indexLogSequence || els["portrait-project"].value !== projectId) return;
      indexLogTotal = 0; els["recent-index-count"].textContent = "";
      els["index-log-page"].textContent = (error.message || "无法读取索引日志") + "，当前保留上次显示的记录，可点击刷新日志重试。";
    } finally {
      if (sequence === indexLogSequence && els["portrait-project"].value === projectId) { indexLogLoading = false; els["recent-index-list"].removeAttribute("aria-busy"); updateIndexLogButtons(); }
    }
  }

  function replaceLogContent(container, content) {
    var openKeys = new Set(Array.from(container.querySelectorAll("details[data-view-key][open]")).map(function (item) { return item.dataset.viewKey; }));
    var active = document.activeElement, focusKey = active && container.contains(active) && active.closest("details[data-view-key]");
    var scrolls = Array.from(container.querySelectorAll(".cleanup-table-wrap")).map(function (item) { var parent = item.closest("details[data-view-key]"); return { key: parent ? parent.dataset.viewKey : "root", left: item.scrollLeft }; });
    var left = window.scrollX, top = window.scrollY;
    container.style.minHeight = container.getBoundingClientRect().height + "px";
    container.replaceChildren(content);
    container.querySelectorAll("details[data-view-key]").forEach(function (item) {
      item.open = openKeys.has(item.dataset.viewKey);
      if (focusKey && item.dataset.viewKey === focusKey.dataset.viewKey) item.querySelector("summary").focus({ preventScroll: true });
    });
    container.querySelectorAll(".cleanup-table-wrap").forEach(function (item) {
      var parent = item.closest("details[data-view-key]"), key = parent ? parent.dataset.viewKey : "root";
      var saved = scrolls.find(function (entry) { return entry.key === key; });
      if (saved) item.scrollLeft = saved.left;
    });
    container.style.minHeight = "";
    window.scrollTo({ left: left, top: top, behavior: "instant" });
  }

  function cleanupDetailTable(details, label) {
    if (!details || !details.length) return element("p", "maintenance-note", "没有可展示的索引运行日志明细。");
    var wrap = element("div", "cleanup-table-wrap"); wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", label + "，窄屏可横向滚动");
    var table = element("table", "cleanup-table"), head = element("thead"), row = element("tr"), body = element("tbody");
    table.append(element("caption", "", "扫描 / 索引 / 跳过 / 移除：该次索引运行的文件统计，不是本次删除的项目文件。"));
    ["运行 ID", "开始时间", "完成时间", "状态", "扫描 / 索引 / 跳过 / 移除"].forEach(function (label) { var th = element("th", "", label); th.scope = "col"; row.append(th); });
    head.append(row);
    details.forEach(function (detail) {
      var tr = element("tr");
      tr.dataset.cleanupRun = detail.id;
      [detail.id, formatDate(detail.startedAt), detail.completedAt ? formatDate(detail.completedAt) : "未结束", detail.status === "completed" ? "已完成" : detail.status === "failed" ? "失败" : "运行中",
        [detail.scanned, detail.indexed, detail.skipped, detail.removed].map(function (n) { return formatNumber(n || 0); }).join(" / ")].forEach(function (value) { tr.append(element("td", "", value)); });
      var logRow = element("tr"), logCell = element("td"), log = element("details", "cleanup-log"), content = element("div", "cleanup-log-content");
      log.dataset.viewKey = "log:" + detail.id;
      logCell.colSpan = 5;
      log.append(element("summary", "", "查看日志内容"));
      content.append(element("p", "", "运行 " + detail.id + "：" + (detail.status === "completed" ? "已完成" : detail.status === "failed" ? "失败" : "运行中") + "；扫描 " + formatNumber(detail.scanned || 0) + "、索引 " + formatNumber(detail.indexed || 0) + "、跳过 " + formatNumber(detail.skipped || 0) + "、移除 " + formatNumber(detail.removed || 0) + "。"));
      if (detail.processLog && Array.isArray(detail.processLog.entries)) {
        content.append(element("p", "", "运行过程 · 共 " + formatNumber(detail.processLog.totalEvents) + " 条事件" + (detail.processLog.truncated ? "，仅保存部分事件（已截断）" : "")));
        var processList = element("ol", "process-log");
        detail.processLog.entries.forEach(function (event) {
          var item = element("li"), level = event.level === "error" ? "错误" : event.level === "warn" ? "警告" : "信息";
          item.append(element("span", "process-log-meta", formatDate(event.timestamp) + " · " + level), element("span", "", event.message));
          if (event.path) item.append(element("code", "process-log-path", event.path));
          processList.append(item);
        });
        if (!detail.processLog.entries.length) content.append(element("p", "", "此运行尚无已保存的过程事件。"));
        content.append(processList);
      } else {
        content.append(element("p", "", "本次运行只保存了摘要和错误记录，没有逐文件过程明细。"));
      }
      if (!Array.isArray(detail.errors)) {
        content.append(element("p", "", "此记录未保存错误详情。"));
      } else if (!detail.errors.length && detail.logNote) {
        content.append(element("p", "", "此运行的错误内容无法完整读取；请查看下方记录说明。未保存完整终端输出。"));
      } else if (!detail.errors.length) {
        content.append(element("p", "", "本次运行未记录错误。"));
      } else {
        content.append(element("p", "", "已记录 " + formatNumber(detail.errorCount || detail.errors.length) + " 条错误；以下为数据库保存的错误信息，未保存完整终端输出。"));
        detail.errors.forEach(function (error) {
          var errorBlock = element("div", "cleanup-log-error");
          errorBlock.append(element("code", "", error.path || "未记录路径"), element("pre", "", error.message || "未记录错误信息")); content.append(errorBlock);
        });
      }
      if (detail.errorsTruncated) content.append(element("p", "", "错误内容已截断：最多展示 5 条，每条路径最多 200 字符、消息最多 500 字符；原始错误共 " + formatNumber(detail.errorCount || 0) + " 条。"));
      if (detail.logNote) content.append(element("p", "", detail.logNote));
      log.append(content); logCell.append(log); logRow.append(logCell); body.append(tr, logRow);
    });
    table.append(head, body); wrap.append(table); return wrap;
  }

  function renderCleanupDetails(result, execute) {
    els["cleanup-details"].hidden = false;
    els["cleanup-details-title"].textContent = execute ? "本次已清理的索引运行日志" : "待清理的索引运行日志";
    var total = execute ? result.deletedIndexRuns : result.eligibleIndexRuns;
    els["cleanup-details-note"].textContent = "共 " + formatNumber(total) + " 条" + (result.detailsTruncated ? "，仅展示前 " + (result.details || []).length + " 条明细（完整数量如上）" : "") + "。仅删除数据库中的运行日志记录。";
    els["cleanup-details-table"].replaceChildren(cleanupDetailTable(result.details, execute ? "已清理日志" : "待清理日志"));
  }

  function renderCleanupHistory(history) {
    cachedCleanupHistory = history;
    els["cleanup-history-count"].textContent = "（" + history.length + " 次）";
    var content = document.createDocumentFragment();
    if (!history.length) { replaceLogContent(els["cleanup-history-list"], element("p", "maintenance-note", "暂无已记录的清理。完成清理后可在这里回看；旧版本的历史明细无法恢复。")); return; }
    history.slice(0, Number(els["cleanup-history-limit"].value)).forEach(function (item) {
      var entry = element("details", "cleanup-history-item"), summary = element("summary");
      entry.dataset.viewKey = "history:" + item.id;
      summary.append(element("span", "", formatDate(item.createdAt)), element("span", "", item.trigger === "automatic" ? "自动维护" : "手动清理"), element("strong", "", "清理 " + formatNumber(item.deletedIndexRuns) + " 条日志"));
      entry.append(summary);
      entry.append(element("p", "maintenance-note", "保留 " + item.retentionDays + " 天 · 截止 " + formatDate(item.cutoff) + " · " + (item.phase === "cleanup_committed" ? "日志删除已提交，空间回收结果尚未记录" : "本次回收 " + storageBytes(item.reclaimedBytes) + "，占用 " + storageBytes(item.beforeBytes) + " → " + storageBytes(item.afterBytes))));
      entry.append(element("p", "maintenance-note", "记录 ID：" + item.id + " · " + (item.vacuumRequested ? (item.vacuumCompleted && !item.checkpointBusy ? "空间回收完成" : "空间回收未完全完成") : "本次未执行空间回收")));
      if (item.warnings && item.warnings.length) entry.append(element("p", "maintenance-note", item.warnings.join("；")));
      if (item.detailsTruncated) entry.append(element("p", "maintenance-note", "仅保留前 " + (item.details || []).length + " 条明细，完整清理数量为 " + formatNumber(item.deletedIndexRuns) + " 条。"));
      entry.append(cleanupDetailTable(item.details, "历史清理日志")); content.append(entry);
    });
    replaceLogContent(els["cleanup-history-list"], content);
  }

  function renderMaintenanceSettings(settings) {
    els["maintenance-auto"].checked = settings.enabled;
    els["maintenance-retention"].value = String(settings.retentionDays);
    els["maintenance-interval"].value = String(settings.intervalHours);
    var result = settings.lastRun;
    els["maintenance-result"].textContent = "自动维护：" + (settings.enabled ? "已开启" : "未开启") + (result ? " · 最近尝试 " + formatDate(result.attemptedAt) : " · 尚未运行") +
      (result ? " · " + (result.error || result.message || ("清理 " + (result.deletedIndexRuns || 0) + " 条日志")) + (result.warnings && result.warnings.length ? " · " + result.warnings.join("；") : "") : "");
  }

  async function loadMaintenance(projectId) {
    if (!projectId) return;
    var firstLoad = maintenanceProjectId !== projectId;
    var sequence = ++maintenanceSequence;
    if (firstLoad) invalidateCleanupPreview();
    setMaintenanceBusy(true);
    try {
      var results = await Promise.all([fetchJson(maintenancePath(projectId, "storage")), fetchJson(maintenancePath(projectId, "maintenance"))]);
      if (!maintenanceCurrent(projectId, sequence)) return;
      renderStorage(results[0]); renderMaintenanceSettings(results[1]); await loadRankingSettings(projectId); maintenanceProjectId = projectId;
      await loadIndexLogs(firstLoad);
    } catch (error) {
      if (maintenanceCurrent(projectId, sequence)) els["cleanup-result"].textContent = error.message || "无法读取数据库信息，请刷新重试";
    } finally {
      if (maintenanceCurrent(projectId, sequence)) setMaintenanceBusy(false);
    }
  }

  function cleanupRetention() {
    var value = Number(els["cleanup-retention"].value);
    if (!Number.isInteger(value) || value < 1 || value > 3650) throw new Error("保留天数必须是 1 至 3650 的整数");
    return value;
  }

  async function runCleanup(execute) {
    if (maintenanceBusy) return;
    var projectId = els["portrait-project"].value, sequence = maintenanceSequence;
    if (!projectId) return;
    try {
      var retentionDays = cleanupRetention();
      if (execute && (!cleanupPreview || cleanupPreview.projectId !== projectId || cleanupPreview.retentionDays !== retentionDays)) return;
      setMaintenanceBusy(true);
      els["cleanup-result"].textContent = execute ? "正在清理并回收空间…" : "正在计算清理范围…";
      var result = await fetchJson(maintenancePath(projectId, "cleanup"), { method: "POST", body: { dryRun: !execute, retentionDays: retentionDays, vacuum: true, ...(execute ? { confirmProjectId: projectId } : {}) } });
      if (!maintenanceCurrent(projectId, sequence)) return;
      cleanupPreview = execute ? null : { projectId: projectId, retentionDays: retentionDays };
      renderStorage(Object.assign({}, result.after || result.before, result.recentIndexRuns ? { recentIndexRuns: result.recentIndexRuns } : {}));
      renderCleanupDetails(result, execute);
      if (result.history) renderCleanupHistory(result.history);
      if (execute) loadIndexLogs(true);
      els["cleanup-result"].textContent = (execute
        ? "已清理 " + result.deletedIndexRuns + " 条日志；空间回收" + (result.vacuumCompleted && !result.checkpointBusy ? "完成" : "未完全完成") + "，本次回收 " + storageBytes(result.reclaimedBytes) + "。当前总占用 " + storageBytes((result.after || result.before).totalBytes) + "。"
        : "预计清理 " + result.eligibleIndexRuns + " 条日志（早于 " + formatDate(result.cutoff) + "），当前空闲空间 " + storageBytes(result.before.reclaimableBytes) + "。确认后按最新数据重新计算并执行。") + (result.warnings.length ? " " + result.warnings.join("；") : "");
    } catch (error) {
      if (maintenanceCurrent(projectId, sequence)) { invalidateCleanupPreview(); els["cleanup-result"].textContent = error.message || "清理失败，请刷新后重试"; }
    } finally {
      if (maintenanceCurrent(projectId, sequence)) setMaintenanceBusy(false);
    }
  }

  async function saveMaintenance() {
    if (maintenanceBusy) return;
    var projectId = els["portrait-project"].value, sequence = maintenanceSequence;
    if (!projectId) return;
    try {
      var intervalHours = Number(els["maintenance-interval"].value);
      if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 8760) throw new Error("执行间隔必须是 1 至 8760 的整数");
      var retentionDays = Number(els["maintenance-retention"].value);
      if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error("自动保留天数必须是 1 至 3650 的整数");
      var input = { enabled: els["maintenance-auto"].checked, retentionDays: retentionDays, intervalHours: intervalHours };
      setMaintenanceBusy(true);
      var settings = await fetchJson(maintenancePath(projectId, "maintenance"), { method: "PUT", body: input });
      if (!maintenanceCurrent(projectId, sequence)) return;
      renderMaintenanceSettings(settings); toast("自动维护设置已保存");
    } catch (error) {
      if (maintenanceCurrent(projectId, sequence)) els["maintenance-result"].textContent = error.message || "保存失败";
    } finally {
      if (maintenanceCurrent(projectId, sequence)) setMaintenanceBusy(false);
    }
  }

  async function loadPortrait(force, silent) {
    var projectId = els["portrait-project"].value;
    if (!projectId) {
      els["portrait-loading"].hidden = true;
      els["portrait-content"].hidden = true;
      els["portrait-empty"].hidden = false;
      return;
    }
    if (!force && state.portraitProjectId === projectId) return;
    if (state.portraitLoading) return;
    var sameProject = state.portrait && state.portrait.project.id === projectId;
    state.portraitLoading = true;
    if (!silent && !sameProject) {
      els["portrait-loading"].replaceChildren(element("strong", "", "正在读取项目画像"));
      els["portrait-loading"].hidden = false;
      els["portrait-empty"].hidden = true;
      els["portrait-content"].hidden = true;
      els["refresh-portrait"].disabled = true;
    }
    if (!silent) els["refresh-portrait"].disabled = true;
    try {
      var portrait = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/portrait");
      if (els["portrait-project"].value !== projectId) return;
      renderPortrait(portrait);
      state.portrait = portrait;
      state.portraitProjectId = projectId;
      if (state.ignoreProjectId !== projectId) await loadIgnoreRules(projectId, silent);
      if (maintenanceProjectId !== projectId || (!silent && force)) await loadMaintenance(projectId);
    } catch (error) {
      if (!silent) {
        els["portrait-content"].hidden = true;
        els["portrait-loading"].hidden = false;
        els["portrait-loading"].replaceChildren(projectErrorState(error, projectId));
        if (error.code !== "PROJECT_DATABASE_NOT_FOUND") toast(error.message || String(error), true);
      }
    } finally {
      state.portraitLoading = false;
      if (!silent) els["refresh-portrait"].disabled = false;
      if (els["portrait-project"].value !== projectId) loadPortrait(true);
    }
  }

  function projectErrorState(error, projectId) {
    if (error.code !== "PROJECT_DATABASE_NOT_FOUND") return errorState(error.message || "无法读取项目画像", error.httpStatus);
    var project = projectById(projectId);
    var panel = element("section", "empty-state missing-project-state");
    panel.append(element("strong", "", "项目数据库不存在"), element("p", "", project ? project.name + " · " + project.rootPath : projectId), element("p", "", "项目仍在登记列表中，但数据库文件已丢失或目录已移动。可修改根目录，或移除这条失效登记。"));
    var details = element("details"); details.append(element("summary", "", "查看具体路径"), element("p", "", error.message)); panel.append(details);
    var actions = element("div", "dialog-actions");
    var edit = element("button", "secondary-button", "修改项目路径"); edit.type = "button"; edit.addEventListener("click", openProjectEditor);
    var remove = element("button", "danger-button", "移除失效登记"); remove.type = "button";
    remove.addEventListener("click", function () { confirmUnregister(projectId, remove); });
    actions.append(edit, remove); panel.append(actions); return panel;
  }

  function confirmUnregister(projectId, control) {
    var project = projectById(projectId); if (!project) return;
    var dialog = document.getElementById("unregister-dialog");
    document.getElementById("unregister-description").textContent = project.name + " · " + project.rootPath;
    dialog.returnValue = "";
    dialog.addEventListener("close", async function () {
      if (dialog.returnValue !== "confirm") return;
      control.disabled = true;
      try {
        await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/unregister-missing", { method: "POST", body: { confirmProjectId: projectId } });
        state.portraitProjectId = null; state.portrait = null; state.taskQueryKey = null; state.selectedTaskId = null;
        resetGraph(); resetMaintenance(); await refresh(); await loadPortrait(true); await loadTaskView(true, false);
        toast("失效登记已移除，未删除任何项目文件");
      } catch (error) { toast(error.message || String(error), true); }
      finally { control.disabled = false; }
    }, { once: true });
    dialog.showModal();
  }

  function refreshWatchedPortrait() {
    var portraitView = document.getElementById("portrait-view");
    if (document.hidden || portraitView.hidden || !state.portrait || !state.portrait.watch) return;
    if (state.portrait.project.id !== els["portrait-project"].value) return;
    loadPortrait(true, true);
  }

  function renderPortrait(portrait) {
    var project = portrait.project;
    var health = portrait.health;
    var lastRun = health.lastIndexRun;
    els["portrait-loading"].hidden = true;
    els["portrait-content"].hidden = false;
    els["portrait-name"].textContent = project.name;
    els["portrait-path"].textContent = project.rootPath;
    els["portrait-state"].textContent = project.archivedAt ? "已归档" : "活跃";
    els["portrait-state"].className = "status-badge " + (project.archivedAt ? "inactive" : "active");
    els["toggle-watch"].textContent = portrait.watch ? "停止监听" : "启动监听";
    els["portrait-index-state"].replaceChildren(
      element("strong", "", lastRun ? indexRunLabel(lastRun.status) : "尚未建立索引"),
      element("span", "", lastRun ? "最近索引 " + formatDate(lastRun.completed_at || lastRun.started_at) : "项目已登记，等待首次索引")
    );
    els["portrait-metrics"].replaceChildren(
      portraitMetric(formatNumber(health.sources), "索引文件"),
      portraitMetric(formatNumber(health.chunks), "内容片段"),
      portraitMetric(formatNumber(health.symbols), "代码符号"),
      portraitMetric(formatNumber(health.relations), "代码关系")
    );
    renderFileTypes(portrait.fileTypes);
    renderGit(portrait);
    renderStatusGroups(portrait.statuses);
    renderPortraitList(els["portrait-tasks"], portrait.activeTasks, "当前没有进行中的任务", function (item) {
      return {
        title: item.goal, content: item.checkpoint.summary || "尚未保存任务摘要", meta: "更新于 " + formatDate(item.updatedAt),
        actions: [
          { label: "标记完成", className: "secondary-button", action: function () { updateTask(item.id, "complete"); } },
          { label: "取消任务", className: "danger-button", action: function () { updateTask(item.id, "cancel"); } }
        ]
      };
    });
    renderPortraitList(els["portrait-memories"], portrait.recentMemories, "当前没有活跃项目记忆", function (item) {
      return { title: item.title, content: item.content, meta: typeLabel(item.type) + " · " + formatDate(item.updatedAt) };
    });
    renderPortraitList(els["portrait-stale-memories"], portrait.staleMemories, "没有待处理的过期记忆", function (item) {
      return {
        title: item.title, content: item.content, meta: statusLabel(item.status) + " · " + (item.sourceRef || "无来源"),
        actions: [{ label: "标记删除", className: "danger-button", action: function () { deleteStaleMemory(item.id); } }]
      };
    });
    renderPortraitList(els["portrait-sources"], portrait.primarySources, "当前没有已索引来源", function (item) {
      return { title: item.path, content: formatBytes(item.sizeBytes), meta: "索引于 " + formatDate(item.indexedAt) };
    });
    renderPortraitList(els["portrait-candidates"], portrait.pendingCandidates, "没有待审核候选", function (item) {
      return {
        title: item.title, content: item.content, meta: item.sourceKind + " · 置信度 " + Math.round(item.confidence * 100) + "%",
        actions: [
          { label: "接受", className: "secondary-button", action: function () { reviewCandidate(item.id, "accept"); } },
          { label: "拒绝", className: "danger-button", action: function () { reviewCandidate(item.id, "reject"); } }
        ]
      };
    });
  }

  function renderFileTypes(items) {
    els["portrait-file-types"].replaceChildren();
    if (!items.length) { els["portrait-file-types"].append(element("p", "portrait-list-empty", "当前没有文件类型数据")); return; }
    var maximum = Math.max.apply(null, items.map(function (item) { return item.count; }));
    items.forEach(function (item) {
      var row = element("div", "file-type");
      var track = element("span", "file-type-track");
      var bar = element("span");
      bar.style.width = Math.max(5, Math.round(item.count / maximum * 100)) + "%";
      track.append(bar);
      row.append(element("strong", "", item.extension === "[no extension]" ? "无扩展名" : item.extension), track, element("small", "", item.count + " 个 · " + formatBytes(item.bytes)));
      els["portrait-file-types"].append(row);
    });
  }

  function renderGit(portrait) {
    var git = portrait.vcsState || portrait.gitState || {};
    var changes = parseJsonArray(git.status);
    var providerNames = { git: "Git", hg: "Mercurial", svn: "Subversion" };
    var facts = [
      ["管理工具", providerNames[git.provider] || "未检测到"],
      ["远程仓库", portrait.project.remoteUrl || "未配置"],
      ["当前分支", git.branch || "不可用"],
      ["版本", git.revision ? git.revision.slice(0, 12) : (git.head ? git.head.slice(0, 12) : "不可用")],
      ["工作区变化", git.status === undefined ? "未捕获" : changes.length + " 项"],
      ["捕获时间", portrait.vcsCapturedAt || portrait.gitCapturedAt ? formatDate(portrait.vcsCapturedAt || portrait.gitCapturedAt) : "尚未捕获"]
    ];
    els["portrait-git"].replaceChildren();
    facts.forEach(function (fact) { els["portrait-git"].append(element("dt", "", fact[0]), element("dd", "", fact[1])); });
  }

  function renderStatusGroups(statuses) {
    var groups = [["项目记忆", statuses.memories], ["记忆候选", statuses.candidates], ["任务", statuses.tasks]];
    els["portrait-knowledge"].replaceChildren();
    groups.forEach(function (group) {
      var section = element("section", "status-group");
      section.append(element("h3", "", group[0]));
      var values = element("div", "status-values");
      var entries = Object.entries(group[1]);
      if (!entries.length) values.append(element("span", "status-value", "暂无数据"));
      entries.forEach(function (entry) {
        var value = element("span", "status-value");
        value.append(element("strong", "", entry[1]), document.createTextNode(statusLabel(entry[0])));
        values.append(value);
      });
      section.append(values); els["portrait-knowledge"].append(section);
    });
  }

  function renderPortraitList(container, items, emptyText, map) {
    container.replaceChildren();
    if (!items.length) { container.append(element("p", "portrait-list-empty", emptyText)); return; }
    items.forEach(function (item) {
      var value = map(item); var row = element("article", "portrait-item");
      row.append(element("strong", "", value.title), element("span", "", value.content), element("small", "", value.meta));
      if (value.actions && value.actions.length) {
        var actions = element("div", "portrait-item-actions");
        value.actions.forEach(function (action) {
          var button = element("button", action.className || "secondary-button", action.label);
          button.type = "button";
          button.addEventListener("click", action.action);
          actions.append(button);
        });
        row.append(actions);
      }
      container.append(row);
    });
  }

  function taskKey(task) { return task.projectId + ":" + task.id; }

  function taskQuery() {
    var query = new URLSearchParams({ status: els["task-status"].value, q: els["task-query"].value.trim(), sort: els["task-sort"].value, limit: els["task-limit"].value, offset: String(state.taskOffset), includeArchived: String(els["task-archived"].checked) });
    if (els["task-project"].value) query.set("projectId", els["task-project"].value);
    return query.toString();
  }

  async function loadTaskView(force, silent) {
    var filterSummary = document.querySelector(".task-filter-options > summary");
    filterSummary.textContent = "筛选 · " + els["task-status"].selectedOptions[0].textContent + " · " + els["task-sort"].selectedOptions[0].textContent + (els["task-archived"].checked ? " · 含归档" : "");
    var query = taskQuery();
    if (!force && state.taskQueryKey === query && state.taskPortrait) return;
    if (silent && state.taskLoading) return;
    var sequence = ++state.taskSequence;
    state.taskLoading = true;
    if (!silent) {
      els["task-loading"].replaceChildren(element("strong", "", "正在读取任务动态"));
      els["task-loading"].hidden = false;
      els["task-workspace"].hidden = true;
      els["task-empty"].hidden = true;
      els["refresh-tasks"].disabled = true;
    }
    try {
      var page = await fetchJson("/api/tasks?" + query);
      if (sequence !== state.taskSequence || query !== taskQuery()) return;
      if (!page.items.length && state.taskOffset > 0 && state.taskOffset >= page.total) {
        state.taskOffset = page.total ? Math.floor((page.total - 1) / page.limit) * page.limit : 0;
        await loadTaskView(true, false); return;
      }
      var signature = JSON.stringify(page);
      var unchanged = state.taskQueryKey === query && state.taskSignature === signature;
      var changed = Boolean(state.taskSignature && !unchanged);
      state.taskPortrait = page; state.taskQueryKey = query; state.taskSignature = signature;
      if (silent && unchanged && els["task-warnings"].hidden) return;
      renderTaskView(page, changed);
    } catch (error) {
      if (sequence !== state.taskSequence) return;
      if (!silent) {
        els["task-loading"].hidden = false;
        els["task-loading"].replaceChildren(errorState(error.message || "无法读取任务动态"));
      } else {
        els["task-warnings"].hidden = false;
        els["task-warnings"].textContent = "自动刷新失败，当前仍为上次读取结果：" + (error.message || String(error));
      }
    } finally {
      if (sequence === state.taskSequence) { state.taskLoading = false; els["refresh-tasks"].disabled = false; }
    }
  }

  function refreshTaskActivity() {
    if (document.hidden || document.getElementById("task-view").hidden || state.taskSearchTimer || state.taskMutating || state.taskDetailMode === "history") return;
    loadTaskView(true, true);
  }

  function renderTaskView(page, changed) {
    var allTasks = page.items;
    if (!allTasks.some(function (task) { return taskKey(task) === state.selectedTaskId; })) {
      state.selectedTaskId = allTasks.length ? taskKey(allTasks[0]) : null;
      state.taskDetailMode = "current"; state.taskHistoryOffset = 0; state.taskHistorySequence++;
    }
    syncTaskLiveState();
    els["task-loading"].hidden = true; els["task-empty"].hidden = true; els["task-workspace"].hidden = false;
    els["task-count"].textContent = "本页 " + allTasks.length + " / 共 " + page.total;
    els["task-page"].textContent = (page.partial ? "已读取项目中：" : "") + "共 " + page.total + " 条 · " + (page.total ? page.offset + 1 : 0) + "–" + (page.offset + allTasks.length) + " 条";
    document.getElementById("task-page-number").textContent = "第 " + (page.total ? Math.floor(page.offset / page.limit) + 1 : 0) + " / " + Math.ceil(page.total / page.limit) + " 页";
    els["task-prev"].disabled = page.offset === 0;
    els["task-next"].disabled = page.offset + page.limit >= page.total;
    els["task-warnings"].replaceChildren();
    els["task-warnings"].hidden = !page.partial && !(page.warnings || []).length;
    var warningDetails = element("details");
    warningDetails.append(element("summary", "", "部分项目未能读取 · 总数仅包含已读取项目 · 展开原因"));
    (page.warnings || []).forEach(function (warning) { warningDetails.append(element("div", "", warning.projectName + "：" + warning.message)); });
    els["task-warnings"].append(warningDetails);
    els["task-list"].replaceChildren();
    allTasks.forEach(function (task) {
      var button = element("button", "task-list-item " + (task.status === "in_progress" ? "in-progress" : task.status) + (taskKey(task) === state.selectedTaskId ? " active" : ""));
      button.type = "button"; button.setAttribute("aria-pressed", String(taskKey(task) === state.selectedTaskId));
      var copy = element("span", "task-list-copy");
      var title = element("span", "task-list-title");
      var goal = element("strong", "", task.goal); goal.title = task.goal;
      var blocked = task.status === "in_progress" && task.checkpoint.blockers.length > 0;
      title.append(goal, element("span", "task-state-badge " + (blocked ? "blocked" : task.status), blocked ? "有阻塞" : statusLabel(task.status)));
      var summary = element("span", "task-list-summary", task.checkpoint.summary || "尚未记录摘要"); summary.title = task.checkpoint.summary || "尚未记录摘要";
      var metadata = element("span", "task-list-metadata");
      metadata.append(element("small", "", task.projectName + (task.projectArchived ? "（已归档）" : "")), element("small", "", formatRelativeTime(task.updatedAt)));
      copy.append(title, summary, metadata);
      button.append(element("span", "task-list-indicator"), copy);
      button.addEventListener("click", function () {
        state.selectedTaskId = taskKey(task); state.taskDetailMode = "current"; state.taskHistoryOffset = 0; state.taskHistorySequence++;
        renderTaskView(state.taskPortrait, false);
      });
      els["task-list"].append(button);
    });
    if (!allTasks.length) {
      var empty = element("div", "task-detail-empty");
      var copy = element("div");
      copy.append(element("strong", "", "没有匹配的任务"), element("span", "", "可以调整项目、状态或搜索条件。默认不包含归档项目。"));
      empty.append(copy); els["task-detail"].replaceChildren(empty); return;
    }
    renderTaskDetail(allTasks.find(function (task) { return taskKey(task) === state.selectedTaskId; }), changed);
  }

  function syncTaskLiveState() {
    var live = document.querySelector(".task-live-state");
    live.replaceChildren(element("span"), document.createTextNode(state.taskDetailMode === "history" ? "历史阅读中" : "实时更新"));
    live.setAttribute("aria-label", state.taskDetailMode === "history" ? "查看历史时暂停自动刷新，点击刷新可获取最新数据" : "自动刷新已开启");
    live.classList.toggle("paused", state.taskDetailMode === "history");
  }

  function renderTaskDetail(task, changed) {
    syncTaskLiveState();
    var checkpoint = task.checkpoint;
    var focusBand = element("section", "task-focus");
    var heading = element("div", "task-focus-heading");
    var title = element("div", "task-focus-title");
    title.append(element("span", "panel-label", "任务目标"), element("h2", "", task.goal));
    title.append(element("p", "task-identity-line", task.projectName + (task.projectArchived ? "（已归档）" : "") + " · 更新于 " + formatRelativeTime(task.updatedAt)));
    heading.append(title, element("span", "status-badge " + task.status, statusLabel(task.status)));
    var meta = element("div", "task-focus-meta");
    meta.append(
      element("span", "", "所属项目 " + task.projectName + (task.projectArchived ? "（已归档）" : "")),
      element("span", "", "状态 " + statusLabel(task.status)),
      element("span", "", "创建于 " + formatDate(task.createdAt)),
      element("span", "", "最近变化 " + formatRelativeTime(task.updatedAt)),
      element("span", "", "任务 ID " + task.id)
    );
    var processDetail = element("details", "task-process-detail");
    processDetail.append(element("summary", "", "查看流程示意"), element("p", "", "根据当前检查点展示阶段，不代表后台正在自动执行。"), taskProgress(task));
    var recordDetail = element("details", "task-record-detail");
    recordDetail.append(element("summary", "", "任务记录信息与流程说明"), meta, processDetail);
    focusBand.append(heading, taskStepper(task));

    var metrics = element("section", "task-metrics", "");
    metrics.append(
      taskMetric(checkpoint.completed.length, "已完成事项"),
      taskMetric(checkpoint.next.length, "下一步"),
      taskMetric(checkpoint.verification.length, "验证记录"),
      taskMetric(checkpoint.blockers.length, "阻塞项")
    );

    var details = element("div", "task-detail-grid");
    details.append(
      taskDetailSection("最新进展", checkpoint.summary ? [checkpoint.summary] : [], "尚未记录摘要", ""),
      taskDetailSection("接下来", checkpoint.next, task.status === "completed" ? "任务已经收尾" : "尚未记录下一步", ""),
      taskDetailSection("已完成", checkpoint.completed, "尚未记录完成事项", "success"),
      taskIssuesSection(checkpoint.blockers, checkpoint.risks),
      verificationSection(checkpoint.verification),
      taskDetailSection("修改文件", checkpoint.changedFiles || [], "尚未记录修改文件", "")
    );

    var actions = element("div", "task-detail-actions");
    if (task.status === "in_progress") {
      var complete = element("button", "secondary-button", "标记完成");
      var cancel = element("button", "danger-button", "取消任务");
      complete.type = cancel.type = "button";
      complete.addEventListener("click", function () { updateTaskFromActivity(task, "complete", complete); });
      cancel.addEventListener("click", function () { updateTaskFromActivity(task, "cancel", cancel); });
      actions.append(complete, cancel);
    }
    var tabs = element("div", "task-detail-tabs");
    [ ["current", "当前状态"], ["history", "更新历史"] ].forEach(function (entry) {
      var button = element("button", "secondary-button", entry[1]); button.type = "button";
      button.setAttribute("aria-pressed", String(state.taskDetailMode === entry[0]));
      button.addEventListener("click", function () { state.taskDetailMode = entry[0]; state.taskHistoryOffset = 0; state.taskHistorySequence++; renderTaskDetail(task, false); });
      tabs.append(button);
    });
    if (state.taskDetailMode === "history") {
      var history = element("section", "task-history");
      els["task-detail"].replaceChildren(tabs, history);
      loadTaskHistory(task, history);
    } else els["task-detail"].replaceChildren(tabs, focusBand, metrics, details, recordDetail, actions);
    els["task-detail"].classList.toggle("task-updated", changed);
    if (changed) window.setTimeout(function () { els["task-detail"].classList.remove("task-updated"); }, 700);
  }

  async function loadTaskHistory(task, container) {
    var sequence = ++state.taskHistorySequence;
    var offset = state.taskHistoryOffset;
    container.replaceChildren(element("h2", "", task.goal), element("p", "", task.projectName + " · 历史按最近记录排序；迁移快照之前的过程未保存。"), element("p", "", "正在读取更新历史…"));
    try {
      var page = await fetchJson("/api/projects/" + encodeURIComponent(task.projectId) + "/tasks/" + encodeURIComponent(task.id) + "/history?limit=10&offset=" + offset);
      if (sequence !== state.taskHistorySequence || state.selectedTaskId !== taskKey(task) || state.taskDetailMode !== "history" || !container.isConnected) return;
      container.lastChild.remove();
      if (!page.items.length) container.append(element("p", "", "尚无更新历史"));
      var kinds = { created: "创建任务", checkpoint: "更新检查点", completed: "完成任务", cancelled: "取消任务", migration_snapshot: "迁移时快照" };
      page.items.forEach(function (event) {
        var record = element("details", "task-history-record");
        record.append(element("summary", "", "#" + event.sequence + " · " + (kinds[event.kind] || event.kind) + " · " + formatDate(event.recordedAt)));
        var snapshot = event.snapshot, checkpoint = snapshot.checkpoint;
        record.append(element("p", "", "状态：" + statusLabel(snapshot.status) + " · 来源：" + event.source), element("p", "", "目标：" + snapshot.goal));
        if (event.kind === "migration_snapshot") record.append(element("p", "task-history-note", "这是迁移时保存的现存状态，不代表此前的完整历史。"));
        var grid = element("div", "task-detail-grid");
        grid.append(taskDetailSection("工作摘要", checkpoint.summary ? [checkpoint.summary] : [], "未记录摘要", ""), taskDetailSection("已完成事项", checkpoint.completed, "未记录完成事项", "success"), taskDetailSection("下一步", checkpoint.next, "未记录下一步", ""), taskDetailSection("修改文件", checkpoint.changedFiles || [], "未记录修改文件", ""), verificationSection(checkpoint.verification), taskIssuesSection(checkpoint.blockers, checkpoint.risks));
        record.append(grid); container.append(record);
      });
      var navigation = element("div", "task-pagination");
      navigation.append(element("span", "", "共 " + page.total + " 条 · 第 " + (Math.floor(page.offset / page.limit) + 1) + " 页"));
      [["上一页", -page.limit, page.offset === 0], ["下一页", page.limit, page.offset + page.limit >= page.total]].forEach(function (entry) {
        var button = element("button", "secondary-button", entry[0]); button.type = "button"; button.disabled = entry[2];
        button.addEventListener("click", function () { state.taskHistoryOffset = Math.max(0, offset + entry[1]); loadTaskHistory(task, container); }); navigation.append(button);
      });
      container.append(navigation);
    } catch (error) {
      if (sequence !== state.taskHistorySequence || !container.isConnected) return;
      container.lastChild.remove(); container.append(errorState(error.message || "无法读取历史"));
      var retry = element("button", "secondary-button", "重试读取历史"); retry.type = "button";
      retry.addEventListener("click", function () { loadTaskHistory(task, container); }); container.append(retry);
    }
  }

  function taskStepper(task) {
    var checkpoint = task.checkpoint;
    var hasProgress = Boolean(checkpoint.summary || checkpoint.completed.length || checkpoint.next.length);
    var stage = task.status === "completed" ? 3 : checkpoint.verification.length ? 2 : hasProgress ? 1 : 0;
    var blocked = task.status === "in_progress" && checkpoint.blockers.length > 0;
    var panel = element("section", "task-stepper flow-" + (blocked ? "blocked" : task.status)); panel.setAttribute("aria-label", "任务记录阶段");
    var header = element("div", "task-stepper-head");
    var heading = element("div", "flow-heading");
    heading.append(element("span", "flow-eyebrow", "WORKFLOW"), element("strong", "", "任务流水线"));
    header.append(heading, element("span", "flow-status", blocked ? "等待解除阻塞" : task.status === "completed" ? "已收尾" : task.status === "cancelled" ? "已取消 · 记录保留" : "当前记录 · " + ["任务建立", "进展更新", "验证记录", "任务收尾"][stage]));
    panel.append(header);
    var steps = element("ol", "task-steps");
    var records = [true, hasProgress, checkpoint.verification.length > 0, task.status === "completed"];
    var descriptions = ["目标已保存", hasProgress ? "已有检查点" : "尚未记录进展", checkpoint.verification.length ? checkpoint.verification.length + " 条验证记录" : "尚未记录验证", task.status === "cancelled" ? "已取消，保留进展" : task.status === "completed" ? "完成状态已记录" : "尚未完成"];
    ["建立任务", "记录进展", "验证记录", "任务收尾"].forEach(function (label, index) {
      var current = task.status !== "cancelled" && index === stage;
      var step = element("li", "task-step " + (records[index] ? "recorded" : "pending") + (current ? " current" : ""));
      if (current) step.setAttribute("aria-current", "step");
      var indicator = element("span", "task-step-index");
      indicator.append(flowIcon(index));
      indicator.setAttribute("aria-hidden", "true");
      var copy = element("span", "task-step-copy"); copy.append(element("strong", "", label), element("small", "", descriptions[index]));
      var rail = element("span", "flow-rail"); rail.setAttribute("aria-hidden", "true");
      step.append(rail, indicator, copy); steps.append(step);
    });
    panel.append(steps, element("p", "flow-caption", "依据检查点展示阶段 · 动效不代表后台自动执行"));
    if (task.status === "cancelled") panel.append(element("p", "task-cancelled-note", "任务已取消，已有进展与验证记录仍保留。"));
    return panel;
  }

  function flowIcon(index) {
    var paths = ["M7 4h10v16H5V6h2m1-3h8v4H8zM9 11h5m-5 4h7", "M4 17l5-5 4 3 7-9M15 6h5v5M4 21h16", "M10 4l-6 3v6c0 4 6 7 6 7s6-3 6-7V7zM7 12l2 2 4-4", "M6 21V3m0 1h12l-2 4 2 4H6"];
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", paths[index]);
    svg.append(path); return svg;
  }

  function taskProgress(task) {
    if (task.status === "cancelled") return element("p", "task-cancelled-note", "任务已取消。取消前的进展与验证记录仍保留，不表示任务已完成。");
    var checkpoint = task.checkpoint;
    var hasProgress = Boolean(checkpoint.summary || checkpoint.completed.length || checkpoint.next.length);
    var stage = checkpoint.verification.length ? 2 : hasProgress ? 1 : 0;
    if (task.status !== "in_progress") stage = 3;
    var blocked = task.status === "in_progress" && checkpoint.blockers.length > 0;
    var stateName = task.status !== "in_progress" ? "complete" : blocked ? "blocked" : "working";
    var labels = ["任务建立", "进展记录", "验证结果", "任务收尾"];
    var positions = ["12.5%", "37.5%", "62.5%", "87.5%"];
    var scene = element("div", "factory-scene " + stateName);
    scene.style.setProperty("--station-position", positions[stage]);
    scene.setAttribute("role", "img");
    scene.setAttribute("aria-label", blocked
      ? "任务流水线停在" + labels[stage] + "，等待解除阻塞"
      : task.status === "in_progress"
        ? "任务正在" + labels[stage] + "工位处理中"
        : "任务流水线已完成");

    var floor = element("div", "factory-floor");
    floor.setAttribute("aria-hidden", "true");
    var stations = element("div", "factory-stations");
    labels.forEach(function (label, index) {
      var stationClass = "factory-station";
      if (task.status !== "in_progress" || index < stage) stationClass += " done";
      else if (index === stage) stationClass += " current";
      var station = element("div", stationClass);
      station.append(element("span", "factory-machine"), element("span", "factory-station-label", label));
      stations.append(station);
    });
    var worker = element("div", "factory-worker");
    worker.append(
      element("span", "factory-worker-head"),
      element("span", "factory-worker-body"),
      element("span", "factory-worker-arm"),
      element("span", "factory-worker-arm right")
    );
    floor.append(
      stations,
      element("div", "factory-conveyor"),
      element("div", "factory-unit", task.status === "in_progress" ? "TASK" : "DONE"),
      worker
    );

    var verification = checkpoint.verification[checkpoint.verification.length - 1];
    var orderContent = [
      task.goal,
      checkpoint.summary || checkpoint.completed[checkpoint.completed.length - 1] || "等待记录任务进展",
      verification ? verification.command + " · " + verification.status : "等待验证结果",
      task.status !== "in_progress"
        ? checkpoint.completed[checkpoint.completed.length - 1] || checkpoint.summary || "任务已完成"
        : checkpoint.next[0] ? "下一步：" + checkpoint.next[0] : "等待任务收尾"
    ];
    var orders = element("div", "factory-work-orders");
    labels.forEach(function (label, index) {
      var order = element("div", "factory-order" + (index === stage ? " current" : ""));
      order.append(element("strong", "", "0" + (index + 1) + " · " + label), element("span", "", orderContent[index]));
      orders.append(order);
    });

    var statusCopy = element("span", "factory-status-copy");
    statusCopy.append(
      element("span", "factory-status-dot"),
      document.createTextNode(blocked ? "当前记录包含阻塞" : task.status === "in_progress" ? "依据最新检查点展示" : "任务已标记完成")
    );
    var status = element("div", "factory-status");
    status.append(statusCopy, element("span", "factory-stage-name", labels[stage]));
    scene.append(floor, orders, status);
    return scene;
  }

  function taskMetric(value, label) {
    var metric = element("div", "task-metric");
    metric.append(element("strong", "", value), element("span", "", label));
    return metric;
  }

  function taskDetailSection(title, items, emptyText, tone) {
    var section = element("section", "task-detail-section");
    section.append(element("h3", "", title));
    var list = element("div", "task-activity-list");
    if (!items.length) list.append(element("div", "task-activity", emptyText));
    items.forEach(function (item) { list.append(element("div", "task-activity " + tone, item)); });
    section.append(list);
    return section;
  }

  function verificationSection(items) {
    var section = element("section", "task-detail-section");
    section.append(element("h3", "", "验证状态"));
    var list = element("div", "task-activity-list");
    if (!items.length) list.append(element("div", "task-activity", "尚未记录验证结果"));
    items.forEach(function (item) {
      var passing = /pass|success|complete|ok/i.test(item.status);
      var entry = element("div", "task-activity " + (passing ? "success" : "warning"), item.command);
      entry.append(element("small", "", item.status + (item.summary ? " · " + item.summary : "")));
      list.append(entry);
    });
    section.append(list);
    return section;
  }

  function taskIssuesSection(blockers, risks) {
    var section = element("section", "task-detail-section");
    section.append(element("h3", "", "阻塞与风险"));
    var list = element("div", "task-activity-list");
    if (!blockers.length && !risks.length) list.append(element("div", "task-activity success", "当前没有记录的阻塞或风险"));
    blockers.forEach(function (item) { list.append(element("div", "task-activity danger", item)); });
    risks.forEach(function (item) { list.append(element("div", "task-activity warning", item)); });
    section.append(list);
    return section;
  }

  async function updateTaskFromActivity(task, action, control) {
    var projectId = task.projectId, taskId = task.id;
    if (state.taskMutating) return;
    state.taskMutating = true;
    control.disabled = true;
    try {
      await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId) + "/" + action, { method: "POST", body: {} });
      state.selectedTaskId = taskKey(task);
      await loadTaskView(true, true);
      state.portraitProjectId = null;
      toast(action === "complete" ? "任务已完成" : "任务已取消");
    } catch (error) {
      toast(error.message || String(error), true);
    } finally {
      state.taskMutating = false; control.disabled = false;
    }
  }

  async function loadIgnoreRules(projectId, silent) {
    if (!projectId) return;
    els["reload-ignore"].disabled = true;
    try {
      var data = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/ignore");
      if (els["portrait-project"].value !== projectId) return;
      els["ignore-content"].value = data.content;
      els["ignore-status"].textContent = data.content ? "已载入项目规则" : "当前无自定义规则";
      state.ignoreProjectId = projectId;
      updateIgnoreWarning();
      scheduleIgnorePreview();
    } catch (error) {
      els["ignore-status"].textContent = "载入失败";
      if (!silent) toast(error.message || String(error), true);
    } finally {
      els["reload-ignore"].disabled = false;
    }
  }

  var ignorePresets = {
    generated: ["generated/", "gen/"],
    temporary: ["*.log", "*.tmp", "*.temp"],
    snapshots: ["__snapshots__/", "*.snap"]
  };
  var ignorePreviewTimer = null;
  var ignorePreviewSequence = 0;

  function ignoreContentChanged() {
    updateIgnoreWarning();
    scheduleIgnorePreview();
  }

  function updateIgnoreWarning() {
    els["ignore-path-warning"].hidden = !els["ignore-content"].value.includes("\\");
  }

  function addIgnorePath() {
    var value = els["ignore-path"].value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!value) return;
    addIgnoreRules([value]);
    els["ignore-path"].value = "";
    els["ignore-content"].focus();
  }

  function addIgnoreRules(rules) {
    var existing = els["ignore-content"].value.replace(/\r\n?/g, "\n").split("\n");
    var seen = new Set(existing.map(function (line) { return line.trim(); }).filter(Boolean));
    rules.forEach(function (rule) { if (!seen.has(rule)) { existing.push(rule); seen.add(rule); } });
    while (existing.length && !existing[0]) existing.shift();
    els["ignore-content"].value = existing.filter(function (line, index, lines) {
      return line || (index > 0 && index < lines.length - 1);
    }).join("\n") + "\n";
    ignoreContentChanged();
  }

  function scheduleIgnorePreview() {
    if (ignorePreviewTimer) clearTimeout(ignorePreviewTimer);
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    els["ignore-impact-summary"].textContent = "正在计算影响范围";
    els["ignore-impact-paths"].replaceChildren();
    ignorePreviewTimer = window.setTimeout(function () { previewIgnoreRules(projectId); }, 300);
  }

  async function previewIgnoreRules(projectId) {
    var sequence = ++ignorePreviewSequence;
    try {
      var result = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/ignore/preview", {
        method: "POST", body: { content: els["ignore-content"].value }
      });
      if (sequence !== ignorePreviewSequence || els["portrait-project"].value !== projectId) return;
      els["ignore-impact-summary"].textContent = result.matchedCount
        ? "将排除 " + result.matchedCount + " / " + result.totalIndexed + " 个当前索引来源"
        : "不会移除当前已索引来源";
      result.samplePaths.forEach(function (path) { els["ignore-impact-paths"].append(element("code", "", path)); });
    } catch (error) {
      if (sequence !== ignorePreviewSequence || els["portrait-project"].value !== projectId) return;
      els["ignore-impact-summary"].textContent = error.message || "无法计算影响范围";
      els["ignore-impact-paths"].replaceChildren();
    }
  }

  async function saveIgnoreRules(event) {
    event.preventDefault();
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    var content = els["ignore-content"].value;
    els["save-ignore"].disabled = true;
    els["reload-ignore"].disabled = true;
    els["ignore-status"].textContent = "正在保存并更新索引";
    try {
      var result = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/ignore", {
        method: "PUT", body: { content: content }
      });
      if (els["portrait-project"].value !== projectId) return;
      els["ignore-content"].value = result.content;
      els["ignore-status"].textContent = "已保存，索引已更新";
      state.ignoreProjectId = projectId;
      await loadPortrait(true);
      toast("忽略规则已保存，项目索引已更新");
    } catch (error) {
      if (els["portrait-project"].value !== projectId) return;
      els["ignore-status"].textContent = "保存失败";
      toast(error.message || String(error), true);
    } finally {
      els["save-ignore"].disabled = false;
      els["reload-ignore"].disabled = false;
    }
  }

  async function indexSelectedProject() {
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    await mutatePortrait("/api/projects/" + encodeURIComponent(projectId) + "/index", { method: "POST", body: {} }, "项目索引已更新", els["index-project"]);
  }

  var migrationPreviewSequence = 0;
  async function migrationJobFetch(path, options) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 15000);
    try { return await fetchJson(path, Object.assign({}, options || {}, { signal: controller.signal })); }
    finally { clearTimeout(timer); }
  }
  async function runMigrationJob(projectId, kind, directories, report, requestId) {
    var path = "/api/projects/" + encodeURIComponent(projectId) + "/migration-jobs";
    var key = "project-context-migration-job:" + projectId;
    var job;
    if (!requestId) {
      requestId = crypto.randomUUID();
      try { localStorage.setItem(key, JSON.stringify({requestId:requestId, kind:kind})); } catch (_) {}
      report("正在提交后台任务…任务编号：" + requestId);
      try { job = await migrationJobFetch(path, {method:"POST", body:{confirmProjectId:projectId, kind:kind, excludeDirectories:directories, requestId:requestId}}); }
      catch (error) {
        if (error.httpStatus && error.httpStatus < 500) {
          try { localStorage.removeItem(key); } catch (_) {}
          throw error;
        }
        // Never repeat a POST when its response may have been lost. Query the same ID.
        report("提交响应中断，正在查询原任务；不会重复提交或再次备份。任务编号：" + requestId);
      }
    }
    var failures = 0;
    for (;;) {
      if (!job) {
        try { job = await migrationJobFetch(path + "/" + encodeURIComponent(requestId)); failures = 0; }
        catch (error) {
          failures++;
          report("暂时无法连接本地服务，后台结果未知，正在重连（" + failures + "/3）。不会重复执行。任务编号：" + requestId);
          if (failures >= 3 || error.httpStatus === 401 || error.httpStatus === 404) {
            var disconnected = new Error("未能查询原任务结果。连接中断不代表升级失败；请确认 Web 服务仍在运行，查看终端错误，再查询原任务。若重启服务，请使用新的带 token 地址。");
            disconnected.pendingJob = {requestId:requestId, kind:kind}; throw disconnected;
          }
          await new Promise(function (resolve) { setTimeout(resolve, 1500); }); continue;
        }
      }
      if (job.status === "completed") {
        try { localStorage.removeItem(key); } catch (_) {}
        return job.result;
      }
      if (job.status === "failed" || job.status === "interrupted") {
        try { localStorage.removeItem(key); } catch (_) {}
        var failed = new Error(job.error && job.error.message || "后台进程已中断，最终数据库状态未确认。请检查服务终端和备份，不要直接重复升级。");
        failed.details = job.error && job.error.details || {};
        if (job.status === "interrupted") failed.interrupted = true;
        throw failed;
      }
      report("后台" + (kind === "compact" ? "空间回收" : "索引升级") + "进行中，正在查询状态；无需重复点击。任务编号：" + requestId);
      job = null;
      await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    }
  }
  function migrationBytes(value) { return Number(value || 0).toLocaleString() + " 字节（" + storageBytes(value) + "）"; }
  async function optimizeSelectedProject() {
    var projectId = els["portrait-project"].value;
    if (!projectId || maintenanceBusy) return;
    var sequence = ++migrationPreviewSequence;
    var dialog = document.getElementById("migration-dialog");
    var list = document.getElementById("migration-directories");
    var note = document.getElementById("migration-note");
    var resultBox = document.getElementById("migration-result");
    var run = document.getElementById("migration-run");
    var close = document.getElementById("migration-close");
    var recommend = document.getElementById("migration-recommend");
    var recommendation = document.getElementById("migration-recommendation");
    var pageStatus = document.getElementById("migration-page-status");
    var pagePrev = document.getElementById("migration-page-prev");
    var pageNext = document.getElementById("migration-page-next");
    var search = document.getElementById("migration-search");
    var sizeSelect = document.getElementById("migration-page-size");
    var compact = document.getElementById("migration-compact");
    var spaceBox = document.getElementById("migration-space");
    var spaceRefresh = document.getElementById("migration-space-refresh");
    var checkJob = document.getElementById("migration-check-job");
    var pendingJob = null;
    var actionHint = document.getElementById("migration-action-hint");
    var actionOutcome = "";
    var retryCompact = false;
    run.textContent = "暂停访问并升级"; run.hidden = false; compact.hidden = true;
    actionHint.textContent = "正在检查升级状态和磁盘空间…";
    checkJob.hidden = true; checkJob.onclick = null;
    var spaceReady = false;
    var finished = false;
    var previewReady = false;
    var renderMigrationPage = function () {};
    search.value = ""; search.disabled = true; sizeSelect.disabled = true;
    spaceBox.textContent = "正在检查…";
    compact.disabled = true; compact.onclick = null; close.disabled = false;
    var spaceSequence = 0;
    async function refreshSpace(mode) {
      var requestSequence = ++spaceSequence;
      spaceRefresh.disabled = true;
      if (mode === "upgrade") { spaceReady = false; run.disabled = true; }
      try {
        var check = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/migration-space?mode=" + mode);
        if (sequence !== migrationPreviewSequence || requestSequence !== spaceSequence) return;
        showSpace(check);
        if (mode === "upgrade") spaceReady = check.sufficient;
        return check;
      } catch (error) { spaceBox.textContent = "无法检查空间：" + error.message; return null; }
      finally { if (requestSequence === spaceSequence && sequence === migrationPreviewSequence) { spaceRefresh.disabled = running; run.disabled = running || finished || !!pendingJob || !previewReady || !spaceReady; updateActions(); } }
    }
    function showSpace(check) {
      if (!check) return;
      if (!check.sufficient) spaceBox.parentElement.open = true;
      spaceBox.textContent = [check.sufficient ? "空间预检通过（保守估算，不保证执行期间空间不变）" : "空间不足或无法验证，暂不能执行", ...check.checks.map(function (entry) {
        var names = { database: "数据库", backup: "备份", temp: "临时目录", temporary: "临时目录" };
        return (entry.paths || [entry.path]).join("\n") + "\n用途：" + entry.roles.map(function (role) { return names[role] || role; }).join("、") + "\n可用：" + (entry.availableBytes == null ? "未知" : migrationBytes(entry.availableBytes)) + " · 预计额外需要：" + migrationBytes(entry.requiredBytes) + (entry.shortfallBytes > 0 ? "\n还缺：" + migrationBytes(entry.shortfallBytes) : "");
      }), ...(check.warnings || [])].join("\n\n");
    }
    recommend.disabled = true;
    recommendation.textContent = "推荐会结合项目语言、构建文件和目录证据；不会仅因目录名是 src、include、bin 或 lib 就排除。";
    var running = false;
    dialog.oncancel = function (event) { if (running) event.preventDefault(); };
    close.onclick = function () { if (!running) dialog.close(); };
    document.getElementById("migration-project").textContent = "项目：" + els["portrait-project"].selectedOptions[0].textContent;
    list.replaceChildren(); resultBox.hidden = true; run.disabled = true;
    pageStatus.textContent = ""; pagePrev.disabled = true; pageNext.disabled = true;
    note.textContent = "正在分析已索引目录…";
    dialog.showModal();
    checkJob.onclick = async function () {
      if (running) return;
      lockControls(true);
      try {
        var job = pendingJob || await migrationJobFetch("/api/projects/" + encodeURIComponent(projectId) + "/migration-jobs");
        if (!job) { reportJob("未找到后台任务记录。请检查终端和备份，确认状态后关闭并重新打开升级窗口。"); return; }
        renderJobResult(await runMigrationJob(projectId, job.kind, [], reportJob, job.requestId), job.kind);
        pendingJob = null; checkJob.hidden = true; finished = true;
      } catch (error) { handleJobError(error); }
      finally { lockControls(false); }
    };
    spaceRefresh.onclick = function () { if (!running) void refreshSpace("upgrade"); };
    try {
      var latest = await migrationJobFetch("/api/projects/" + encodeURIComponent(projectId) + "/migration-jobs");
      if (!dialog.open || sequence !== migrationPreviewSequence) return;
      var savedJob = null;
      try { savedJob = JSON.parse(localStorage.getItem("project-context-migration-job:" + projectId) || "null"); } catch (_) {}
      if (savedJob && (!latest || latest.requestId !== savedJob.requestId)) latest = Object.assign({status:"running"}, savedJob);
      if (latest && latest.status === "running") {
        lockControls(true);
        try { renderJobResult(await runMigrationJob(projectId, latest.kind, [], reportJob, latest.requestId), latest.kind); finished = true; }
        catch (error) { handleJobError(error); }
        finally { lockControls(false); }
      } else if (latest && latest.status === "completed") {
        renderJobResult(latest.result, latest.kind);
      } else if (latest && (latest.status === "failed" || latest.status === "interrupted")) {
        resultBox.hidden = false; resultBox.textContent = "上次任务状态：" + latest.status + "\n" + (latest.error && latest.error.message || "进程中断，结果未知，请检查备份及索引日志。");
      }
      void refreshSpace("upgrade");
      var preview = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/optimize-index");
      if (!dialog.open || sequence !== migrationPreviewSequence) return;
      note.textContent = preview.note + " 已索引 " + preview.totalIndexedFiles + " 个文件。未勾选目录会按当前规则保留。";
      var selectedDirectories = new Set();
      var pageSize = Number(sizeSelect.value); var page = 0;
      var filteredDirectories = [];
      var totalPages = 1;
      function updatePageStatus() {
        var visibleSelected = filteredDirectories.filter(function (directory) { return selectedDirectories.has(directory.path); }).length;
        pageStatus.textContent = "第 " + (page + 1) + " / " + totalPages + " 页 · 匹配 " + filteredDirectories.length + " / " + preview.directories.length + " 个目录 · 全部已选 " + selectedDirectories.size + " 个（筛选外 " + (selectedDirectories.size - visibleSelected) + " 个）";
      }
      var renderMigrationPage = function () {
        var query = search.value.trim().replaceAll("\\", "/").toLowerCase();
        filteredDirectories = preview.directories.filter(function (directory) { return directory.path.toLowerCase().includes(query); });
        totalPages = Math.max(1, Math.ceil(filteredDirectories.length / pageSize));
        page = Math.max(0, Math.min(page, totalPages - 1));
        list.replaceChildren();
        filteredDirectories.slice(page * pageSize, (page + 1) * pageSize).forEach(function (directory) {
          var label = element("label", "migration-directory");
          var checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = directory.path; checkbox.checked = selectedDirectories.has(directory.path);
          checkbox.dataset.recommended = directory.recommended ? "true" : "false";
          checkbox.disabled = running || finished;
          checkbox.addEventListener("change", function () { if (checkbox.checked) selectedDirectories.add(directory.path); else selectedDirectories.delete(directory.path); updatePageStatus(); });
          var details = element("span", "");
          details.append(element("strong", "", directory.path), element("small", "", directory.files + " 个文件 · " + directory.chunks + " 个片段 · 源码 " + migrationBytes(directory.sourceBytes)), element("small", "", directory.reason), element("small", "", "示例：" + directory.samples.join("；")));
          label.append(checkbox, details); list.append(label);
          if (directory.recommended) details.append(element("small", "", "推荐：" + (directory.recommendationReason || "符合项目构建证据") + "，可取消勾选。"));
        });
        if (!filteredDirectories.length) list.append(element("p", "maintenance-note", "没有匹配的文件夹，修改或清空搜索关键词。已有勾选仍保留。"));
        updatePageStatus(); list.scrollTop = 0;
        pagePrev.disabled = running || page === 0; pageNext.disabled = running || page >= totalPages - 1;
      };
      search.oninput = function () { page = 0; renderMigrationPage(); };
      sizeSelect.onchange = function () { pageSize = Number(sizeSelect.value); page = 0; renderMigrationPage(); };
      pagePrev.onclick = function () { if (!running) { page -= 1; renderMigrationPage(); } };
      pageNext.onclick = function () { if (!running) { page += 1; renderMigrationPage(); } };
      search.disabled = false; sizeSelect.disabled = false;
      renderMigrationPage();
      var recommendedCount = preview.directories.filter(function (directory) { return directory.recommended; }).length;
      recommend.disabled = recommendedCount === 0;
      if (preview.projectTypes && preview.projectTypes.length) recommendation.textContent += " 检测到项目类型：" + preview.projectTypes.map(function (type) { return type.name; }).join("、") + "。";
      if (!recommendedCount) recommendation.textContent += " 当前预览没有符合推荐规则的目录，可手动选择或保留当前搜索范围。";
      recommend.onclick = function () {
        var added = 0;
        preview.directories.filter(function (directory) { return directory.recommended; }).forEach(function (directory) {
          var covered = Array.from(selectedDirectories).some(function (other) { return directory.path === other || directory.path.startsWith(other + "/"); });
          if (!covered) { selectedDirectories.add(directory.path); added++; }
        });
        renderMigrationPage();
        recommendation.textContent = "本次新增勾选 " + added + " 个推荐目录，保留已有选择。可取消勾选；确认执行升级后才保存规则。";
      };
      previewReady = true; run.disabled = finished || !!pendingJob || !spaceReady; updateActions();
    } catch (error) { if (sequence === migrationPreviewSequence) { note.textContent = "无法读取升级状态或目录：" + error.message + "。请确认本地服务仍在运行；不要重复提交升级。"; checkJob.hidden = false; } return; }
    function updateActions() {
      compact.hidden = !retryCompact;
      run.hidden = !!pendingJob || retryCompact;
      run.textContent = running ? "正在升级，请稍候…" : actionOutcome === "completed" ? "升级已完成" : "暂停访问并升级";
      run.disabled = run.disabled || actionOutcome === "completed";
      actionHint.textContent = running ? "后台任务运行中，请勿重复操作。" : pendingJob ? "连接状态未知，请查询原任务，避免重复备份。" : retryCompact ? "可仅重试空间回收；不会重新备份和索引。" : actionOutcome === "completed" ? "操作已完成，可以关闭窗口。" : actionOutcome === "failed" ? "请先处理上方错误，再关闭并重新打开窗口重试升级。" : !spaceReady ? "磁盘空间预检尚未通过，请查看检查结果。" : "将暂缓新版客户端对本项目的新数据库访问和监听索引；已有或旧版连接仍可能占用。";
    }
    function reportJob(message) { resultBox.hidden = false; resultBox.textContent = message; }
    function handleJobError(error) {
      pendingJob = error.pendingJob || null;
      actionOutcome = "failed"; retryCompact = Boolean(error.details && error.details.canRetryCompaction);
      checkJob.hidden = !pendingJob;
      if (pendingJob || error.interrupted) {
        reportJob(error.message + (pendingJob ? "\n原任务编号：" + pendingJob.requestId : ""));
        finished = true;
      } else { reportJob(failureText(error)); finished = Boolean(error.details && error.details.backupCompleted); }
    }
    function renderJobResult(result, kind) {
      actionOutcome = result.status === "completed" ? "completed" : "failed";
      retryCompact = Boolean(result.canRetryCompaction);
      resultBox.hidden = false;
      if (kind === "compact") {
        resultBox.textContent = [result.status === "completed" ? "空间回收完成（未重建索引）" : "空间回收尚未完成", "活动数据库：" + migrationBytes(result.before.totalBytes) + " → " + migrationBytes(result.after.totalBytes), "回收：" + migrationBytes(result.reclaimedBytes), ...(result.warnings || [])].join("\n");
        return;
      }
      var lines = [result.status === "completed" ? "升级及空间回收完成" : "升级部分完成，仍需处理以下问题", "活动数据库（含 WAL/SHM）：" + migrationBytes(result.before.totalBytes) + " → " + migrationBytes(result.after.totalBytes), result.byteChange > 0 ? "本次占用增加：" + migrationBytes(result.byteChange) : "全流程减少：" + migrationBytes(result.reclaimedBytes), result.backupStatus === "deleted" ? "本次临时备份已自动删除，释放 " + migrationBytes(result.backupDeletedBytes) : "本次备份保留用于恢复：" + result.backupDestination, "本次备份剩余占用：" + migrationBytes(result.retainedBackupBytes) + "（与活动数据库分开统计）", "索引更新 " + result.index.indexed + "，移除 " + result.index.removed + "，文件错误 " + result.index.errors.length];
      if (result.ignoreRulesSaved) lines.push("所选目录已保存到 .project-context-ignore；源文件保持不变。");
      lines = lines.concat(result.warnings || []);
      result.index.errors.slice(0, 5).forEach(function (error) { lines.push(error.path + "：" + error.message); });
      resultBox.textContent = lines.join("\n");
      if (result.canRetryCompaction) resultBox.textContent += "\n索引已更新；释放空间或解除占用后，可仅重试空间回收。";
      showSpace(result.spaceCheck);
    }
    function failureText(error) {
      var details = error.details || {};
      showSpace(details.spaceCheck);
      var phases = { validation: "校验目录", preflight: "空间检查", backup: "备份", ignore_rules: "保存忽略规则", index: "更新索引", compaction: "压缩数据库", checkpoint: "回收 WAL 空间", integrity: "数据库完整性检查", backup_cleanup: "删除本次临时备份", completed: "完成" };
      return "操作未完成：" + error.message + (details.phase ? "\n失败阶段：" + (phases[details.phase] || details.phase) : "") + (details.backupDestination ? "\n备份路径：" + details.backupDestination + "\n备份完整：" + (details.backupCompleted ? "是" : "未确认，请勿直接用来恢复") : "") + "\n忽略规则已保存：" + (details.ignoreRulesSaved ? "是" : "否") + "\n索引更新完成：" + (details.indexCompleted ? "是" : "否") + (details.canRetryCompaction ? "\n释放空间后，可仅重试空间回收。" : "\n若索引尚未完成，请先处理错误再重新升级；仅压缩不会补建索引。");
    }
    async function confirmOperation(message) {
      var confirmDialog = document.getElementById("migration-confirm-dialog");
      document.getElementById("migration-confirm-message").textContent = message;
      return new Promise(function (resolve) {
        var done = function (value) { confirmDialog.close(); resolve(value); };
        document.getElementById("migration-confirm-ok").onclick = function () { done(true); };
        document.getElementById("migration-confirm-cancel").onclick = function () { done(false); };
        confirmDialog.oncancel = function (event) { event.preventDefault(); done(false); };
        confirmDialog.showModal();
      });
    }
    function lockControls(value) {
      running = value; maintenanceBusy = value;
      close.disabled = value; compact.disabled = value || !!pendingJob || !previewReady; spaceRefresh.disabled = value;
      checkJob.disabled = value;
      search.disabled = value; sizeSelect.disabled = value;
      run.disabled = value || finished || !!pendingJob || !previewReady || !spaceReady;
      recommend.disabled = value || finished || recommendedCount === 0;
      renderMigrationPage();
      updateActions();
    }
    compact.onclick = async function () {
      if (running || !await confirmOperation("仅压缩当前数据库并回收 WAL 空间，不会创建新备份、更新索引或保存本次目录勾选，也不会删除已有历史备份。若上次索引失败，此操作不会完成索引升级。确认继续？")) return;
      lockControls(true); resultBox.hidden = false; resultBox.textContent = "正在检查空间并压缩数据库…";
      try {
        renderJobResult(await runMigrationJob(projectId, "compact", [], reportJob), "compact");
        if (els["portrait-project"].value === projectId) await loadPortrait(true);
      } catch (error) { handleJobError(error); }
      finally { lockControls(false); void refreshSpace("upgrade"); }
    };
    compact.disabled = !!pendingJob;
    run.onclick = async function () {
      if (running || finished || !spaceReady) return;
      var selected = Array.from(selectedDirectories);
      var confirmed = await confirmOperation((selected.length ? "将排除全部已选 " + selected.length + " 个目录（包括其他分页和搜索结果外的选择），目录中的内容将不再参与本项目搜索。" : "当前保留全部搜索范围。") + "升级期间备份会临时占用空间；全部成功且完整性检查通过后删除本次备份，失败时保留。历史备份不自动删除。");
      if (!confirmed) return;
      lockControls(true);
      resultBox.hidden = false; resultBox.textContent = "正在备份、迁移索引并回收空间，大型项目可能需要较长时间…";
      try {
        renderJobResult(await runMigrationJob(projectId, "upgrade", selected, reportJob), "upgrade");
        finished = true;
        if (els["portrait-project"].value === projectId) await loadPortrait(true);
      } catch (error) {
        handleJobError(error);
      } finally { lockControls(false); void refreshSpace("upgrade"); }
    };
  }

  async function toggleSelectedWatch() {
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    var active = Boolean(state.portrait && state.portrait.project.id === projectId && state.portrait.watch);
    await mutatePortrait("/api/projects/" + encodeURIComponent(projectId) + "/watch", active
      ? { method: "DELETE" }
      : { method: "POST", body: { debounceMs: 300 } }, active ? "文件监听已停止" : "文件监听已启动", els["toggle-watch"]);
  }

  async function reviewCandidate(candidateId, action) {
    var projectId = els["portrait-project"].value;
    await mutatePortrait("/api/projects/" + encodeURIComponent(projectId) + "/candidates/" + encodeURIComponent(candidateId) + "/" + action,
      { method: "POST", body: {} }, action === "accept" ? "候选已接受" : "候选已拒绝");
  }

  async function deleteStaleMemory(memoryId) {
    var projectId = els["portrait-project"].value;
    await mutatePortrait("/api/projects/" + encodeURIComponent(projectId) + "/memories/" + encodeURIComponent(memoryId) + "/status",
      { method: "PATCH", body: { status: "deleted" } }, "过期记忆已标记删除");
  }

  async function updateTask(taskId, action) {
    var projectId = els["portrait-project"].value;
    await mutatePortrait("/api/projects/" + encodeURIComponent(projectId) + "/tasks/" + encodeURIComponent(taskId) + "/" + action,
      { method: "POST", body: {} }, action === "complete" ? "任务已完成" : "任务已取消");
  }

  async function mutatePortrait(path, options, success, control) {
    if (control) control.disabled = true;
    try {
      await fetchJson(path, options);
      await loadPortrait(true, true);
      toast(success);
    } catch (error) {
      toast(error.message || String(error), true);
    } finally {
      if (control) control.disabled = false;
    }
  }

  function setPortraitMode(mode) {
    if (["overview", "graph", "maintenance"].indexOf(mode) < 0) return;
    els["portrait-content"].dataset.mode = mode;
    els["portrait-overview"].hidden = mode !== "overview";
    els["portrait-graph"].hidden = mode !== "graph";
    els["portrait-maintenance"].hidden = mode !== "maintenance";
    document.querySelectorAll(".portrait-mode").forEach(function (button) {
      button.classList.toggle("active", button.dataset.portraitMode === mode);
      button.setAttribute("aria-pressed", String(button.dataset.portraitMode === mode));
    });
    if (mode === "graph") {
      loadGraphOverview(false);
      setTimeout(function () { els["portrait-graph"].scrollIntoView({ behavior: "smooth", block: "start" }); }, 0);
    }
  }

  async function loadGraphOverview(force) {
    var projectId = els["portrait-project"].value;
    if (!projectId) return;
    if (!force && state.graphProjectId === projectId && state.graphCy) {
      setTimeout(function () { state.graphCy.resize(); state.graphCy.fit(undefined, 42); }, 0);
      return;
    }
    setGraphLoading(true);
    try {
      var data = await fetchJson(graphPath("") + graphRelationQuery());
      state.graphProjectId = projectId;
      state.graphRoot = null;
      state.graphScope = "files";
      renderGraph(data);
    } catch (error) {
      showGraphError(error.message || String(error));
    }
  }

  async function expandGraph(depth, nodeId) {
    var target = nodeId || state.graphSelectedId;
    if (!target) return;
    setGraphLoading(true);
    try {
      var query = "?node=" + encodeURIComponent(target) + "&depth=" + depth + "&limit=120" + graphRelationSuffix();
      var data = await fetchJson(graphPath("/neighbors") + query);
      state.graphRoot = target;
      state.graphScope = "symbols";
      renderGraph(data);
      if (state.graphCy && state.graphCy.getElementById(target).length) selectGraphNode(target);
    } catch (error) {
      showGraphError(error.message || String(error));
    }
  }

  function reloadGraph(event) {
    if (event && event.target && event.target.type === "checkbox" && !selectedGraphRelations().length) {
      event.target.checked = true;
      toast("至少保留一种关系类型", true);
      return;
    }
    if (state.graphScope === "symbols" && state.graphRoot) expandGraph(1, state.graphRoot);
    else loadGraphOverview(true);
  }

  function renderGraph(data) {
    setGraphLoading(false);
    els["graph-empty"].hidden = data.nodes.length !== 0;
    if (state.graphCy) state.graphCy.destroy();
    state.graphSelectedId = null;
    setGraphDetail(null);
    if (!data.nodes.length) {
      state.graphCy = null;
      updateGraphFooter(data);
      return;
    }
    if (typeof window.cytoscape !== "function") {
      showGraphError("关系图引擎未能加载");
      return;
    }
    state.graphCy = window.cytoscape({
      container: els["code-graph"],
      elements: data.nodes.map(function (node) { return { group: "nodes", data: node }; })
        .concat(data.edges.map(function (edge) { return { group: "edges", data: edge }; })),
      minZoom: .18,
      maxZoom: 3.5,
      boxSelectionEnabled: false,
      style: graphStyles(),
      layout: graphLayoutOptions()
    });
    state.graphCy.on("tap", "node", function (event) { selectGraphNode(event.target.id()); });
    state.graphCy.on("dbltap", "node", function (event) { expandGraph(1, event.target.id()); });
    state.graphCy.on("tap", function (event) {
      if (event.target === state.graphCy) { clearGraphHighlight(); els["graph-details"].classList.remove("open"); }
    });
    state.graphCy.ready(function () { setTimeout(function () { if (state.graphCy) state.graphCy.fit(undefined, 42); }, 20); });
    updateGraphFooter(data);
  }

  function graphStyles() {
    return [
      { selector: "node", style: {
        "background-color": "#176b4d", "border-color": "#0d553b", "border-width": 1,
        "label": "data(label)", "font-family": "Segoe UI, Microsoft YaHei, sans-serif", "font-size": 10,
        "text-wrap": "ellipsis", "text-max-width": 112, "text-valign": "bottom", "text-margin-y": 7,
        "color": "#26312c", "width": "mapData(relationCount, 0, 30, 28, 58)", "height": "mapData(relationCount, 0, 30, 28, 58)"
      }},
      { selector: "node[nodeType = 'file']", style: {
        "shape": "round-rectangle", "background-color": "#245245", "border-color": "#173d33",
        "width": "mapData(symbolCount, 0, 40, 42, 82)", "height": "mapData(symbolCount, 0, 40, 30, 54)",
        "color": "#17211d", "font-weight": 700
      }},
      { selector: "node[kind = 'class']", style: { "background-color": "#3377b6", "border-color": "#23547f", "shape": "round-rectangle" }},
      { selector: "node[kind = 'interface']", style: { "background-color": "#a05d08", "border-color": "#744405", "shape": "diamond" }},
      { selector: "node[kind = 'method']", style: { "background-color": "#b27b18", "border-color": "#80580f" }},
      { selector: "node[kind = 'type']", style: { "background-color": "#697c75", "border-color": "#475750", "shape": "hexagon" }},
      { selector: "edge", style: {
        "curve-style": "bezier", "line-color": "#80a393", "target-arrow-color": "#80a393",
        "target-arrow-shape": "triangle", "arrow-scale": .65, "width": "mapData(count, 1, 20, 1, 5)",
        "opacity": .72, "label": "data(count)", "font-size": 8, "color": "#68736e",
        "text-background-color": "#fff", "text-background-opacity": .82, "text-background-padding": 2
      }},
      { selector: "edge[relationType = 'CALLS']", style: { "line-color": "#3377b6", "target-arrow-color": "#3377b6" }},
      { selector: "edge[relationType = 'EXTENDS']", style: { "line-color": "#a05d08", "target-arrow-color": "#a05d08", "line-style": "dashed" }},
      { selector: "edge[relationType = 'IMPLEMENTS']", style: { "line-color": "#a43d52", "target-arrow-color": "#a43d52", "line-style": "dotted" }},
      { selector: ":selected", style: { "border-width": 4, "border-color": "#111a16", "z-index": 20 }},
      { selector: ".dimmed", style: { "opacity": .12 }},
      { selector: ".focused", style: { "opacity": 1, "z-index": 30 } }
    ];
  }

  function graphLayoutOptions() {
    var name = els["graph-layout"].value || "cose";
    if (name === "breadthfirst") return { name: name, directed: true, padding: 48, spacingFactor: 1.15, animate: false };
    if (name === "circle") return { name: name, padding: 48, spacingFactor: 1.1, animate: false };
    return {
      name: "cose", animate: false, randomize: true, padding: 52, quality: "default",
      nodeRepulsion: function () { return 8500; }, idealEdgeLength: function () { return state.graphScope === "files" ? 115 : 90; },
      edgeElasticity: function () { return 90; }, gravity: .28, numIter: 900
    };
  }

  function runGraphLayout() {
    if (!state.graphCy || !state.graphCy.nodes().length) return;
    state.graphCy.layout(graphLayoutOptions()).run();
    setTimeout(function () { if (state.graphCy) state.graphCy.fit(undefined, 42); }, 30);
  }

  function selectGraphNode(nodeId) {
    if (!state.graphCy) return;
    var node = state.graphCy.getElementById(nodeId);
    if (!node.length) return;
    state.graphSelectedId = nodeId;
    state.graphCy.elements().unselect();
    node.select();
    state.graphCy.elements().addClass("dimmed");
    node.closedNeighborhood().removeClass("dimmed").addClass("focused");
    state.graphCy.animate({ center: { eles: node }, duration: 180 });
    loadGraphNodeDetails(nodeId);
  }

  function clearGraphHighlight() {
    if (!state.graphCy) return;
    state.graphCy.elements().removeClass("dimmed focused").unselect();
    state.graphSelectedId = null;
    setGraphDetail(null);
  }

  async function loadGraphNodeDetails(nodeId) {
    try {
      var details = await fetchJson(graphPath("/nodes/" + encodeURIComponent(nodeId)));
      if (state.graphSelectedId === nodeId) setGraphDetail(details);
    } catch (error) { toast(error.message || String(error), true); }
  }

  function setGraphDetail(details) {
    els["graph-detail-body"].replaceChildren();
    els["graph-expand-one"].disabled = !details;
    els["graph-expand-two"].disabled = !details;
    if (!details) {
      els["graph-detail-title"].textContent = "选择节点";
      els["graph-detail-body"].append(element("p", "portrait-list-empty", "选择文件或符号后显示详细信息。"));
      return;
    }
    els["graph-detail-title"].textContent = details.label;
    var facts = element("dl", "graph-facts");
    var values = details.nodeType === "file" ? [
      ["类型", "文件"], ["路径", details.path], ["大小", formatBytes(details.sizeBytes)],
      ["符号", details.symbolCount + " 个"], ["关系", details.relationCount + " 条"], ["索引时间", formatDate(details.indexedAt)]
    ] : [
      ["类型", symbolKindLabel(details.kind)], ["路径", details.sourcePath], ["行号", details.startLine + "–" + details.endLine],
      ["限定名称", details.qualifiedName], ["签名", details.signature || "无"]
    ];
    values.forEach(function (value) { facts.append(element("dt", "", value[0]), element("dd", "", value[1])); });
    els["graph-detail-body"].append(facts);
    if (details.symbols) appendGraphDetailSection("文件符号", details.symbols, function (item) {
      return { title: item.name, content: symbolKindLabel(item.kind), meta: "第 " + item.startLine + "–" + item.endLine + " 行" };
    });
    if (details.outgoing) appendGraphDetailSection("向外关系", details.outgoing, function (item) {
      return { title: item.toName, content: relationLabel(item.relationType), meta: "第 " + item.startLine + " 行" };
    });
    if (details.incoming) appendGraphDetailSection("向内关系", details.incoming, function (item) {
      return { title: item.fromName, content: relationLabel(item.relationType), meta: item.sourcePath + " · 第 " + item.startLine + " 行" };
    });
    if (window.innerWidth <= 640) els["graph-details"].classList.add("open");
  }

  function appendGraphDetailSection(title, items, map) {
    var section = element("section", "graph-detail-section");
    section.append(element("h3", "", title + " · " + items.length));
    if (!items.length) section.append(element("p", "portrait-list-empty", "暂无数据"));
    items.forEach(function (item) {
      var value = map(item); var row = element("div", "graph-detail-entry");
      row.append(element("strong", "", value.title), element("span", "", value.content), element("small", "", value.meta));
      section.append(row);
    });
    els["graph-detail-body"].append(section);
  }

  async function searchGraph(showEmptyError) {
    var query = els["graph-search"].value.trim();
    if (!query) { state.graphSearchResults = []; els["graph-search-results"].hidden = true; return; }
    var sequence = ++state.graphSearchSequence;
    try {
      var data = await fetchJson(graphPath("/search") + "?q=" + encodeURIComponent(query) + "&limit=20");
      if (sequence !== state.graphSearchSequence) return;
      state.graphSearchResults = data.results;
      renderGraphSearchResults(data.results);
      if (showEmptyError && !data.results.length) toast("没有匹配的文件或符号", true);
    } catch (error) { if (sequence === state.graphSearchSequence) toast(error.message || String(error), true); }
  }

  function renderGraphSearchResults(results) {
    els["graph-search-results"].replaceChildren();
    els["graph-search-results"].hidden = !results.length;
    results.forEach(function (result) {
      var button = element("button", "graph-search-result"); button.type = "button";
      button.append(element("strong", "", result.label), element("small", "", (result.nodeType === "file" ? "文件" : symbolKindLabel(result.kind)) + " · " + result.path));
      button.addEventListener("mousedown", function (event) { event.preventDefault(); focusGraphResult(result); });
      els["graph-search-results"].append(button);
    });
  }

  function focusGraphResult(result) {
    els["graph-search-results"].hidden = true;
    els["graph-search"].value = result.label;
    if (state.graphCy && state.graphCy.getElementById(result.id).length) selectGraphNode(result.id);
    else expandGraph(1, result.id);
  }

  function updateGraphFooter(data) {
    els["graph-status"].textContent = data.nodes.length + " 个节点 · " + data.edges.length + " 条关系" + (data.truncated ? " · 已控制规模" : "");
    els["graph-scope"].textContent = data.mode === "files" ? "文件级概览" : "符号级展开";
  }

  function setGraphLoading(loading) {
    els["graph-loading"].hidden = !loading;
    els["graph-empty"].hidden = true;
  }

  function showGraphError(message) {
    setGraphLoading(false);
    els["graph-empty"].hidden = false;
    els["graph-empty"].replaceChildren(element("strong", "", message));
    toast(message, true);
  }

  function resetGraph() {
    if (state.graphCy) state.graphCy.destroy();
    state.graphCy = null; state.graphProjectId = null; state.graphRoot = null;
    state.graphScope = "files"; state.graphSelectedId = null;
    setGraphDetail(null);
  }

  function graphPath(suffix) { return "/api/projects/" + encodeURIComponent(els["portrait-project"].value) + "/graph" + suffix; }
  function graphRelationQuery() { var suffix = graphRelationSuffix(); return suffix ? "?" + suffix.slice(1) : ""; }
  function graphRelationSuffix() { return selectedGraphRelations().map(function (type) { return "&relation=" + encodeURIComponent(type); }).join(""); }
  function selectedGraphRelations() { return [].filter.call(els["graph-relations"].querySelectorAll("input"), function (input) { return input.checked; }).map(function (input) { return input.value; }); }
  function relationLabel(type) { return { IMPORTS: "导入", CALLS: "调用", EXTENDS: "继承", IMPLEMENTS: "实现" }[type] || type; }
  function symbolKindLabel(kind) { return { class: "类", interface: "接口", method: "方法", function: "函数", type: "类型", enum: "枚举" }[kind] || kind || "符号"; }

  function switchView(view) {
    ["portrait", "task", "rules", "context"].forEach(function (name) { document.getElementById(name + "-view").hidden = name !== view; });
    document.querySelectorAll(".tab").forEach(function (button) { var selected = button.dataset.view === view; button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected)); });
    if (view === "portrait") loadPortrait(false);
    if (view === "task") loadTaskView(false, false);
  }

  async function fetchJson(path, options) {
    options = options || {};
    var response = await fetch(path, {
      signal: options.signal,
      method: options.method || "GET", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Project-Context-UI": "1" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    var data = await response.json().catch(function () { return { message: "服务返回了无效响应" }; });
    if (!response.ok) { var error = new Error(data.message || "请求失败"); error.details = data.details; error.code = data.code; error.httpStatus = response.status; throw error; }
    return data;
  }

  function addOption(select, value, label) { var option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option); }
  function element(tag, className, text) { var node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; }
  function metaPill(text) { return element("span", "meta-pill", text); }
  function statusBadge(status) { return element("span", "status-badge " + (status === "active" ? "active" : "inactive"), status.toUpperCase()); }
  function setEditorStatus(status) { els["editor-status"].textContent = status.toUpperCase(); els["editor-status"].className = "status-badge " + (status === "active" ? "active" : "inactive"); }
  function scopeLabel(value) { var found = scopes.find(function (scope) { return scope[0] === value; }); return found ? found[1] : value; }
  function typeLabel(value) { var found = types.find(function (type) { return type[0] === value; }); return found ? found[1] : value; }
  function projectById(id) { return state.projects.find(function (project) { return project.id === id; }); }
  function portraitMetric(value, label) { var item = element("div", "portrait-metric"); item.append(element("strong", "", value), element("span", "", label)); return item; }
  function formatNumber(value) { return Number(value || 0).toLocaleString("zh-CN"); }
  function formatBytes(value) { var bytes = Number(value || 0); if (bytes < 1024) return bytes + " B"; if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB"; return (bytes / 1048576).toFixed(1) + " MB"; }
  function formatDate(value) { if (!value) return "未知"; var date = new Date(value); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false }); }
  function formatRelativeTime(value) {
    var date = new Date(value); var seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (Number.isNaN(seconds)) return formatDate(value);
    if (seconds < 10) return "刚刚";
    if (seconds < 60) return seconds + " 秒前";
    if (seconds < 3600) return Math.floor(seconds / 60) + " 分钟前";
    if (seconds < 86400) return Math.floor(seconds / 3600) + " 小时前";
    return Math.floor(seconds / 86400) + " 天前";
  }
  function parseJsonArray(value) { try { var parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; } }
  function indexRunLabel(status) { return status === "completed" ? "索引正常" : status === "running" ? "正在索引" : "索引状态：" + status; }
  function statusLabel(status) { var labels = { active: "活跃", accepted: "已接受", pending: "待审核", in_progress: "进行中", completed: "已完成", cancelled: "已取消", stale: "已过期", conflicted: "有冲突", rejected: "已拒绝", superseded: "已替代", deleted: "已删除" }; return labels[status] || status; }
  function summaryStat(label, value) { var item = element("span", "summary-stat"); item.append(element("strong", "", value), document.createTextNode(label)); return item; }
  function errorState(message, status) { var node = element("div", "empty-state"); node.append(element("strong", "", message), element("span", "", status === 401 ? "登录已失效，请使用本次启动时提供的完整地址重新打开。" : "请核对错误原因后重试，或切换其他项目。")); return node; }
  function toast(message, error) { els.toast.textContent = message; els.toast.className = "toast show" + (error ? " error" : ""); clearTimeout(toast.timer); toast.timer = setTimeout(function () { els.toast.className = "toast"; }, 3200); }
})();`;
