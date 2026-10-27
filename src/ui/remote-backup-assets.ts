export const REMOTE_BACKUP_HTML = String.raw`
<section id="portrait-backup" class="remote-backup-panel" hidden aria-labelledby="remote-backup-title">
  <header><div><span class="panel-label">ENCRYPTED BACKUP</span><h2 id="remote-backup-title">远程备份</h2></div><button id="remote-refresh" class="secondary-button" type="button">刷新记录</button></header>
  <p class="maintenance-note">将本项目的记忆、候选、任务和历史加密备份。代码索引、来源摘录和个人规则默认不上传；已保存在记忆或任务正文中的内容会随包备份。</p>
  <section class="maintenance-card remote-sync-card" aria-labelledby="remote-sync-title"><h3 id="remote-sync-title">多机同步</h3><p id="remote-sync-state" class="maintenance-note">正在读取状态</p><div class="remote-sync-actions"><button id="remote-sync-push" class="secondary-button" type="button" disabled>推送本地更新</button><button id="remote-sync-pull" class="secondary-button" type="button" disabled>拉取远端更新</button></div><p class="maintenance-note">先通过 sync configure 将两台机器绑定到同一同步空间。同步包含项目规则；全局与工作区规则保持本地。未解决冲突保留双方版本。</p><div id="remote-sync-conflicts"></div></section>
  <div class="remote-backup-grid">
    <section class="maintenance-card"><h3>备份目标</h3><div class="field"><label for="remote-target">已配置的存储</label><select id="remote-target"></select></div>
      <p id="remote-target-details" class="maintenance-note"></p><p id="remote-latest" class="maintenance-note">尚未读取备份记录</p>
      <button id="remote-upload" class="primary-button" type="button" disabled>加密并备份当前项目</button>
    </section>
    <section class="maintenance-card"><h3>恢复到新目录</h3><p class="maintenance-note">在记录中选择备份，或填写已保存的对象键。校验通过后生成 project.db 和暂存规则；不会覆盖已有项目或自动应用个人规则。</p>
      <div class="field"><label for="remote-object-key">备份对象键</label><input id="remote-object-key" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="remote-restore-directory">全新的本地绝对目录</label><input id="remote-restore-directory" autocomplete="off" spellcheck="false"></div>
      <button id="remote-restore" class="secondary-button" type="button" disabled>下载并校验恢复</button>
    </section>
  </div>
  <p id="remote-backup-status" class="ignore-impact" role="status" aria-live="polite"></p>
  <details class="remote-setup"><summary>首次配置与恢复说明</summary><p>先在本机运行 remote add 配置目标及凭据环境变量名称。口令与存储凭据由运行服务的环境提供，页面不接收密钥。</p><p>恢复出的 project.db 可通过 project restore 登记为新项目，再按需要重建代码索引。所选个人规则保存在 rules.db，需另行明确作用域后导入。仅有知识备份不包含 Git 源码。</p></details>
  <h3>最近成功的备份</h3><p class="maintenance-note">显示最近 50 条本机记录；更早备份或另一台机器的对象键仍可用于恢复。记录不代表远端对象当前仍存在。</p>
  <div id="remote-backup-history" class="remote-backup-history"></div>
  <section class="maintenance-card remote-sync-card"><h3>团队审核</h3><p class="maintenance-note">以本地服务配置的团队身份访问共享项目，所有操作由服务端重新检查权限并记录审计。</p><button id="team-review-refresh" class="secondary-button" type="button">读取团队项目</button><div class="field"><label for="team-review-share">共享项目</label><select id="team-review-share"></select></div><p id="team-review-status" role="status" class="maintenance-note"></p><div id="team-review-items"></div></section>
</section>
<dialog id="remote-confirm-dialog" aria-labelledby="remote-confirm-title"><div class="migration-body"><h2 id="remote-confirm-title">确认操作</h2><p id="remote-confirm-message" style="overflow-wrap:anywhere"></p><div class="dialog-actions"><button id="remote-confirm-cancel" class="secondary-button" type="button">取消</button><button id="remote-confirm-ok" class="primary-button" type="button">确认执行</button></div></div></dialog>`;

export const REMOTE_BACKUP_CSS = String.raw`
.remote-backup-panel { max-width: 1280px; margin: 0 auto; padding: 24px; min-width: 0; }
.remote-backup-panel > header { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
.remote-backup-panel h2 { font-size:20px; } .remote-backup-panel h3 { font-size:15px; margin:12px 0; }
.remote-backup-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin:20px 0; }
.remote-sync-card { margin-top:16px; } .remote-sync-actions { display:flex; flex-wrap:wrap; gap:10px; }
.remote-sync-version { margin:10px 0; padding:10px; border:1px solid var(--line); min-width:0; }
.remote-sync-version pre { max-height:240px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
.remote-backup-panel .field { margin:12px 0; min-width:0; }
.remote-backup-panel input, .remote-backup-panel select { width:100%; min-width:0; max-width:100%; }
.remote-backup-panel p, .remote-backup-panel h2, .remote-backup-panel h3, .remote-backup-panel summary { overflow-wrap:anywhere; }
.remote-backup-panel button { max-width:100%; white-space:normal; overflow-wrap:anywhere; }
.remote-backup-panel button:focus-visible, .remote-backup-panel summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
#remote-backup-status { white-space:pre-wrap; } .remote-setup { margin:18px 0; } .remote-setup p { margin-top:10px; }
.remote-backup-history { display:grid; gap:10px; }
.remote-backup-record { border:1px solid var(--line); border-radius:6px; padding:14px; min-width:0; }
.remote-backup-record summary { cursor:pointer; display:list-item; line-height:1.7; }
.remote-backup-record p { font-family:Consolas,monospace; font-size:12px; margin:10px 0; }
.remote-backup-record[open] { background:var(--surface-muted); }
@media(max-width:700px) { .remote-backup-grid { grid-template-columns:minmax(0,1fr); } .remote-backup-panel { padding:20px 16px; } }
`;

export const REMOTE_BACKUP_JS = String.raw`
  var remoteSequence = 0, remoteBusy = false, remoteTargets = [], remoteSyncConfigured = false, teamShares = [];
  function remoteElement(id) { return document.getElementById(id); }
  function confirmRemoteOperation(message) {
    var dialog = remoteElement("remote-confirm-dialog");
    if (dialog.open) return Promise.resolve(false);
    remoteElement("remote-confirm-message").textContent = message;
    return new Promise(function(resolve) {
      function done(value) { dialog.close(); resolve(value); }
      remoteElement("remote-confirm-ok").onclick = function() { done(true); };
      remoteElement("remote-confirm-cancel").onclick = function() { done(false); };
      dialog.oncancel = function(event) { event.preventDefault(); done(false); }; dialog.showModal();
    });
  }
  function remoteControls() {
    ["remote-sync-push", "remote-sync-pull"].forEach(function(id) { remoteElement(id).disabled = !remoteSyncConfigured || remoteBusy; });
    remoteElement("remote-sync-conflicts").querySelectorAll("button").forEach(function(button) { button.disabled = remoteBusy; });
    var enabled = Boolean(remoteElement("remote-target").value) && !remoteBusy;
    remoteElement("remote-upload").disabled = !enabled || !els["portrait-project"].value;
    remoteElement("remote-restore").disabled = !enabled || !remoteElement("remote-object-key").value.trim() || !remoteElement("remote-restore-directory").value.trim();
    ["remote-target", "remote-object-key", "remote-restore-directory", "remote-refresh"].forEach(function(id) { remoteElement(id).disabled = remoteBusy; });
    remoteElement("remote-backup-history").querySelectorAll("button").forEach(function(button) { button.disabled = remoteBusy; });
  }
  function remoteTargetDetails() {
    var target = remoteTargets.find(function(item) { return item.name === remoteElement("remote-target").value; });
    remoteElement("remote-target-details").textContent = target ? target.endpoint + " / " + target.bucket + " / " + target.prefix : "尚未配置目标，请先查看首次配置说明。";
    remoteControls();
  }
  function bindRemoteBackupEvents() {
    remoteElement("team-review-refresh").addEventListener("click", loadTeamShares);
    remoteElement("team-review-share").addEventListener("change", loadTeamReview);
    remoteElement("remote-sync-push").addEventListener("click", function() { runRemoteSync("push"); });
    remoteElement("remote-sync-pull").addEventListener("click", function() { runRemoteSync("pull"); });
    remoteElement("remote-refresh").addEventListener("click", loadRemoteBackups);
    remoteElement("remote-target").addEventListener("change", remoteTargetDetails);
    ["remote-object-key", "remote-restore-directory"].forEach(function(id) { remoteElement(id).addEventListener("input", remoteControls); });
    remoteElement("remote-upload").addEventListener("click", uploadRemoteBackup);
    remoteElement("remote-restore").addEventListener("click", restoreRemoteBackup);
  }
  async function loadRemoteBackups() {
    var projectId = els["portrait-project"].value, sequence = ++remoteSequence;
    if (!projectId || remoteBusy) return;
    remoteElement("remote-backup-status").textContent = "正在读取本地目标与备份记录…";
    try {
      var data = await Promise.all([fetchJson("/api/remote-targets"), fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/remote-backups")]);
      if (sequence !== remoteSequence || projectId !== els["portrait-project"].value) return;
      remoteTargets = data[0]; var previous = remoteElement("remote-target").value;
      remoteElement("remote-target").replaceChildren();
      remoteTargets.forEach(function(target) { addOption(remoteElement("remote-target"), target.name, target.name); });
      if (remoteTargets.some(function(target) { return target.name === previous; })) remoteElement("remote-target").value = previous;
      remoteTargetDetails();
      remoteElement("remote-latest").textContent = data[1].length ? "最近成功：" + new Date(data[1][0].completedAt).toLocaleString() : "暂无成功备份";
      var container = remoteElement("remote-backup-history"); container.replaceChildren();
      if (!data[1].length) container.append(element("p", "maintenance-note", "成功备份后，可在这里选择恢复。"));
      data[1].forEach(function(record) {
        var item = element("details", "remote-backup-record");
        item.append(element("summary", "", new Date(record.completedAt).toLocaleString() + " · " + record.remoteName + " · " + Number(record.bytes).toLocaleString() + " 字节"));
        item.append(element("p", "", "对象键：" + record.key), element("p", "", "SHA-256：" + record.sha256));
        var choose = element("button", "secondary-button", "选择此备份恢复"); choose.type = "button";
        choose.addEventListener("click", function() {
          if (!remoteTargets.some(function(target) { return target.name === record.remoteName; })) { remoteElement("remote-backup-status").textContent = "此备份的存储目标尚未配置。"; return; }
          remoteElement("remote-target").value = record.remoteName; remoteElement("remote-object-key").value = record.key;
          remoteTargetDetails(); remoteElement("remote-restore-directory").focus();
        }); item.append(choose); container.append(item);
      });
      remoteElement("remote-backup-status").textContent = "记录已更新。远程存储不可用时，本地项目仍可读写。";
      await loadRemoteSync(projectId);
    } catch(error) { if (sequence === remoteSequence) remoteElement("remote-backup-status").textContent = error.message; }
    finally { remoteControls(); }
  }
  async function uploadRemoteBackup() {
    if (remoteBusy) return;
    var projectId = els["portrait-project"].value, remoteName = remoteElement("remote-target").value;
    if (!await confirmRemoteOperation("将当前项目的记忆、候选、任务及历史加密上传到 " + remoteName + "。默认不包含代码索引、来源摘录或个人规则。确认备份？")) return;
    remoteBusy = true; remoteControls();
    remoteElement("remote-backup-status").textContent = "正在打包、加密并上传，请保持服务运行…";
    try {
      var result = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/remote-backups", { method: "POST", body: { remoteName: remoteName, confirmProjectId: projectId } });
      remoteBusy = false; if (projectId === els["portrait-project"].value) await loadRemoteBackups();
      remoteElement("remote-backup-status").textContent = "备份成功。对象键：" + result.key + (result.warning ? "\n" + result.warning : "");
    } catch(error) { remoteElement("remote-backup-status").textContent = "备份未确认：" + error.message + "。请先刷新记录；连接中断时远端可能已经收到备份，再次提交将创建新版本。"; }
    finally { remoteBusy = false; remoteControls(); }
  }
  async function restoreRemoteBackup() {
    if (remoteBusy) return; remoteBusy = true; remoteControls();
    remoteElement("remote-backup-status").textContent = "正在下载、认证并恢复到新目录…";
    try {
      var result = await fetchJson("/api/remote-restore", { method: "POST", body: { remoteName: remoteElement("remote-target").value,
        key: remoteElement("remote-object-key").value.trim(), directory: remoteElement("remote-restore-directory").value.trim() } });
      remoteElement("remote-backup-status").textContent = "恢复校验完成：" + result.directory + "\n项目尚未登记，个人规则未应用。";
    } catch(error) { remoteElement("remote-backup-status").textContent = "恢复未完成：" + error.message; }
    finally { remoteBusy = false; remoteControls(); }
  }
  async function loadRemoteSync(projectId) {
    var state = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/sync");
    if (projectId !== els["portrait-project"].value) return;
    remoteSyncConfigured = state.configured;
    ["remote-sync-push", "remote-sync-pull"].forEach(function(id) { remoteElement(id).disabled = !state.configured || remoteBusy; });
    var box = remoteElement("remote-sync-conflicts"); box.replaceChildren();
    if (!state.configured) { remoteElement("remote-sync-state").textContent = "仅本地 · 尚未配置增量同步"; return; }
    var labels = { conflict: "有冲突", pending: "待推送", waiting: "等待依赖事件", synced: "本地队列已处理" };
    remoteElement("remote-sync-state").textContent = (labels[state.state] || state.state) + " · 空间 " + state.syncId + " · 待推送 " + (state.pending + (state.pendingRules || 0)) + " · 冲突 " + state.conflicts + "。拉取可检查远端新更新。";
    if (!state.conflicts) return;
    var conflicts = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/sync/conflicts");
    if (projectId !== els["portrait-project"].value) return;
    conflicts.forEach(function(conflict) {
      var details = element("details", "remote-backup-record"); details.append(element("summary", "", conflict.table + " · " + conflict.entity));
      conflict.versions.forEach(function(version) {
        var item = element("div", "remote-sync-version"); item.append(element("p", "", version.device + " · 版本 " + version.version), element("pre", "", JSON.stringify(version.payload, null, 2)));
        var choose = element("button", "secondary-button", "采用此版本"); choose.type = "button";
        choose.addEventListener("click", async function() {
          if (remoteBusy || !await confirmRemoteOperation("采用此版本解决当前冲突？将保留历史，并生成待推送的解决记录。")) return;
          remoteBusy = true; remoteControls(); choose.disabled = true;
          try { await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/sync/resolve", { method: "POST", body: { table: conflict.table, entity: conflict.entity, chosenEventId: version.id } }); }
          catch(error) { remoteElement("remote-backup-status").textContent = error.message; }
          finally { remoteBusy = false; remoteControls(); await loadRemoteSync(els["portrait-project"].value); }
        }); item.append(choose); details.append(item);
      }); box.append(details);
    });
  }
  async function runRemoteSync(action) {
    if (remoteBusy) return; remoteBusy = true; remoteControls();
    var projectId = els["portrait-project"].value;
    ["remote-sync-push", "remote-sync-pull"].forEach(function(id) { remoteElement(id).disabled = true; });
    remoteElement("remote-backup-status").textContent = action === "push" ? "正在加密并推送更新…" : "正在拉取并合并更新…";
    try { var result = await fetchJson("/api/projects/" + encodeURIComponent(projectId) + "/sync/" + action, { method: "POST", body: {} });
      remoteElement("remote-backup-status").textContent = "本次处理 " + result.events + " 个事件、" + result.batches + " 个批次。";
    } catch(error) { remoteElement("remote-backup-status").textContent = "同步未完成：" + error.message + "。本地写入仍可继续。"; }
    finally { remoteBusy = false; remoteControls(); await loadRemoteSync(els["portrait-project"].value); }
  }
  async function loadTeamShares() {
    try {
      var shares = await fetchJson("/api/team"); var select = remoteElement("team-review-share"); select.replaceChildren();
      teamShares = shares;
      shares.forEach(function(share) { addOption(select, share.shareId, share.name + " · " + share.workspaceId); });
      await loadTeamReview();
    } catch(error) { remoteElement("team-review-status").textContent = error.message; }
  }
  async function loadTeamReview() {
    var shareId = remoteElement("team-review-share").value, container = remoteElement("team-review-items"); container.replaceChildren();
    if (!shareId) { remoteElement("team-review-status").textContent = "没有可访问的共享项目"; return; }
    var base = "/api/team/" + encodeURIComponent(shareId);
    var share = teamShares.find(function(item) { return item.shareId === shareId; });
    var canReview = share && (share.role === "owner" || share.role === "reviewer");
    var results = await Promise.allSettled([share && share.role !== "viewer" ? fetchJson(base + "/candidates") : Promise.resolve([]), canReview ? fetchJson(base + "/conflicts") : Promise.resolve([])]);
    if (shareId !== remoteElement("team-review-share").value) return;
    remoteElement("team-review-status").textContent = results.filter(function(result) { return result.status === "rejected"; }).map(function(result) { return result.reason.message; }).join("；") || "审核队列已更新";
    function action(button, path, body) { button.addEventListener("click", async function() {
      if (!await confirmRemoteOperation("确认执行此审核操作？结果将记录到团队审计。")) return; button.disabled = true;
      try { await fetchJson(base + path, { method: "POST", body: body }); await loadTeamReview(); await loadRemoteSync(els["portrait-project"].value); }
      catch(error) { remoteElement("team-review-status").textContent = error.message; button.disabled = false; }
    }); }
    if (results[0].status === "fulfilled") results[0].value.forEach(function(candidate) {
      var item = element("details", "remote-backup-record"); item.append(element("summary", "", "候选 · " + candidate.title), element("p", "", candidate.content));
      var accept = element("button", "secondary-button", canReview || !share.requireReviewer ? "接受候选" : "等待审核员接受"); accept.type = "button"; accept.disabled = !canReview && Boolean(share.requireReviewer); action(accept, "/accept", { candidateId: candidate.id }); item.append(accept); container.append(item);
    });
    if (results[1].status === "fulfilled") results[1].value.forEach(function(conflict) {
      var item = element("details", "remote-backup-record"); item.append(element("summary", "", "冲突 · " + conflict.entity));
      conflict.versions.forEach(function(version) { var card = element("div", "remote-sync-version"); card.append(element("pre", "", JSON.stringify(version.payload,null,2)));
        var choose=element("button", "secondary-button", "采用此版本"); choose.type="button"; action(choose, "/resolve", { entity: conflict.entity, eventId: version.id }); card.append(choose); item.append(card); }); container.append(item);
    });
    if (!container.children.length) container.append(element("p", "maintenance-note", "当前身份下没有可处理的候选或冲突。"));
    if (share && share.codeGraphEnabled) {
      var download = element("button", "secondary-button", "导出只读代码关系图（JSON）"); download.type = "button";
      download.addEventListener("click", async function() {
        download.disabled = true;
        try { var graph = await fetchJson(base + "/graph"); var objectUrl = URL.createObjectURL(new Blob([JSON.stringify(graph,null,2)], {type:"application/json"}));
          var link = document.createElement("a"); link.href = objectUrl; link.download = "team-code-graph.json"; link.click(); setTimeout(function(){URL.revokeObjectURL(objectUrl);},1000);
          remoteElement("team-review-status").textContent = "已导出 " + graph.nodes.length + " 个节点、" + graph.edges.length + " 条关系" + (graph.manifest.truncated ? "（达到上限，包含部分结构）" : "") + "。";
        } catch(error) { remoteElement("team-review-status").textContent = error.message; } finally {download.disabled=false;}
      }); container.append(download);
    }
  }
`;
