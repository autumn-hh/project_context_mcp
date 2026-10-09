/** Presentation layer for the existing local workspace; no external UI dependencies. */
export const WORKSPACE_THEME_CSS = String.raw`
:root {
  --bg: #f5f7f6;
  --surface: #ffffff;
  --surface-muted: #f7f9f8;
  --text: #202d28;
  --muted: #67756e;
  --line: #e3e9e6;
  --line-strong: #ccd7d1;
  --accent: #147d64;
  --accent-strong: #0c5e4b;
  --accent-soft: #edf7f2;
  --shadow: 0 12px 36px rgba(27, 49, 39, .09);
}
body { -webkit-font-smoothing: antialiased; }
button, input, select, textarea { transition: background-color .15s, border-color .15s, box-shadow .15s; }
button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
input, select, textarea { border-color: var(--line-strong); border-radius: 8px; font-size: 13px; }
input::placeholder, textarea::placeholder { color: #839088; }
input[type="checkbox"] { accent-color: var(--accent); }
input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(20,125,100,.12); }
.primary-button, .secondary-button, .danger-button { border-radius: 8px; font-size: 12px; font-weight: 650; }
.primary-button { box-shadow: 0 1px 2px rgba(15,76,57,.12); }
.secondary-button:hover:not(:disabled) { background: #f4f7f5; border-color: #acbeb3; }
button:disabled { opacity: .48; cursor: not-allowed; }
.app-header { background: #fff; color: var(--text); border-bottom-color: var(--line); box-shadow: 0 1px 0 rgba(27,49,39,.02); }
.brand-mark { width: 37px; height: 37px; border-radius: 11px; border-color: #147d64; background: #147d64; color: #fff; box-shadow: 0 3px 7px rgba(20,125,100,.14); letter-spacing: -.4px; }
.brand strong { font-size: 15px; letter-spacing: -.25px; }
.brand div span { color: var(--muted); font-size: 11px; }
.view-tabs { padding: 4px; border-color: #e8eeea; border-radius: 10px; background: #f4f6f5; gap: 4px; }
.tab { border-radius: 7px; color: #65726a; font-weight: 650; }
.tab { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.nav-icon { width: 16px; height: 16px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.task-toolbar-description { margin-top: 5px; font-size: 12px; line-height: 1.6; color: var(--muted); }
.tab:hover { color: #263c31; background: #e9efeb; }
.tab.active { color: var(--accent-strong); background: #fff; box-shadow: 0 1px 4px rgba(24,46,34,.1), 0 0 0 1px rgba(24,46,34,.04); }
.local-state { border: 1px solid var(--line); border-radius: 9px; padding: 8px 11px; }
.local-state strong { color: #455e51; }
.local-state div span { color: var(--muted); }
.panel-label { font-size: 10px; letter-spacing: .09em; font-weight: 650; color: #7b8981; }
.task-toolbar, .portrait-toolbar, .context-header { background: #fff; box-shadow: none; }
.task-toolbar h1, .portrait-toolbar h1, .context-header h1 { font-size: 21px; font-weight: 700; letter-spacing: -.35px; }
.task-toolbar .panel-label { color: #7b8981; }
.task-project-picker input { font-weight: 500; }
.task-live-state { font-weight: 500; color: #597769; }
.task-project-results { border-radius: 10px; box-shadow: var(--shadow); }
.task-project-option { padding: 12px; }
.task-project-option strong { font-size: 12px; }
.task-project-option small { font-size: 10px; }
.task-filters { gap: 12px; background: #fff; padding-block: 12px; }
.task-filters label { font-size: 11px; }
.task-filters .task-query-field { max-width: 640px; }
.task-workspace { grid-template-columns: minmax(280px, 350px) minmax(0, 1fr); }
.task-queue { background: #fbfcfb; }
.task-queue > header { min-height: 66px; background: #fbfcfb; padding-inline: 18px; }
.task-queue > header .panel-label { margin-bottom: 4px; font-size: 9px; }
.task-count { border: 1px solid var(--line); border-radius: 6px; padding: 4px 7px; background: #fff; white-space: nowrap; font-variant-numeric: tabular-nums; }
.task-list { padding: 10px; scrollbar-width: thin; scrollbar-color: #cad5ce transparent; }
.task-list-group { margin: 14px 8px 8px; font-size: 10px; font-weight: 600; }
.task-list-item { padding: 13px 11px; border-radius: 9px; gap: 9px; margin-bottom: 5px; }
.task-list-item:hover { background: #f0f4f1; border-color: #dce5df; }
.task-list-item.active { background: #edf7f2; border-color: #9ac6b5; box-shadow: inset 3px 0 #147d64; }
.task-list-indicator { width: 6px; height: 6px; margin-top: 6px; }
.task-list-item.in-progress .task-list-indicator { background: #147d64; box-shadow: 0 0 0 3px rgba(20,125,100,.1); }
.task-list-copy strong { font-size: 12px; font-weight: 650; line-height: 1.65; }
.task-list-copy .task-list-title { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 5px 8px; min-width: 0; margin-top: 0; }
.task-list-copy .task-list-metadata { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; margin-top: 9px; }
.task-list-copy .task-list-metadata small { min-width: 0; margin: 0; }
.task-list-title > strong { min-width: 0; flex: 1 1 130px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.task-list-copy .task-state-badge { display: inline-flex; flex: 0 0 auto; margin: 2px 0 0; padding: 2px 6px; border-radius: 5px; color: #65736b; background: #eaf0ec; font-size: 9px; line-height: 1.5; white-space: nowrap; }
.task-list-copy .task-state-badge.in_progress { color: #0c654b; background: #dcefe5; }
.task-list-copy .task-state-badge.completed { color: #486555; background: #e8efea; }
.task-list-copy .task-state-badge.cancelled { color: #6c7370; background: #ecefee; }
.task-list-copy .task-state-badge.blocked { color: #8b5c1b; background: #fff0d6; }
.task-list-copy .task-list-summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: #6a786f; font-size: 11px; line-height: 1.6; margin-top: 6px; }
.task-list-copy small { color: #7a867f; font-size: 10px; line-height: 1.6; margin-top: 8px; }
.task-list-pagination { background: #fff; padding: 12px 14px; }
.task-page-summary { margin-bottom: 10px; }
.task-page-controls button { min-height: 32px; padding: 6px 10px; }
.task-page-controls > span { font-variant-numeric: tabular-nums; color: #6c7971; }
.task-detail { background: #f6f8f7; scrollbar-width: thin; scrollbar-color: #cad5ce transparent; }
.task-detail-tabs { padding: 12px 24px; background: #fff; gap: 6px; }
.task-detail-tabs .secondary-button { min-height: 33px; padding: 6px 12px; border-color: transparent; box-shadow: none; }
.task-detail-tabs button[aria-pressed="true"] { background: #edf7f2; border-color: #d1e8dc; }
.task-focus { padding: 26px 28px 24px; background: #fff; }
.task-focus-heading { gap: 16px; }
.task-focus-title { max-width: none; }
.task-focus-title h2 { font-size: clamp(19px, 1.5vw, 24px); line-height: 1.5; font-weight: 650; letter-spacing: -.25px; }
.task-focus-title p { font-size: 13px; color: #6a786f; line-height: 1.8; }
.status-badge { flex-shrink: 0; border-radius: 6px; font-weight: 600; white-space: nowrap; }
.task-focus-meta { gap: 8px 20px; font-size: 11px; line-height: 1.6; }
.task-focus-meta strong { font-weight: 500; }
.task-stepper { max-width: 1120px; margin: 23px auto 0; }
.task-stepper-head { display: flex; flex-wrap: wrap; gap: 6px 14px; justify-content: space-between; align-items: center; margin-bottom: 11px; font-size: 11px; color: #6b786f; }
.task-stepper-head > strong { color: #40584a; font-size: 12px; font-weight: 600; }
.task-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.task-step { min-width: 0; display: flex; gap: 9px; align-items: flex-start; border: 1px solid #e6ebe8; border-radius: 9px; padding: 13px 10px; background: #fafbfa; }
.task-step-index { display: grid; place-items: center; flex: 0 0 23px; height: 23px; border: 1px solid #dce3de; border-radius: 7px; color: #7d8982; background: #fff; font-size: 10px; font-variant-numeric: tabular-nums; }
.task-step-copy { min-width: 0; }
.task-step-copy strong, .task-step-copy small { display: block; overflow-wrap: anywhere; }
.task-step-copy strong { font-size: 11px; line-height: 1.7; color: #6a786f; font-weight: 600; }
.task-step-copy small { margin-top: 3px; font-size: 10px; line-height: 1.65; color: #7e8b83; }
.task-step.recorded .task-step-index { border-color: #c6e0d3; background: #edf7f2; color: #147d64; }
.task-step.recorded .task-step-copy strong { color: #4a6757; }
.task-step.current { background: #edf7f2; border-color: #a5ceba; }
.task-step.current .task-step-index { background: #147d64; border-color: #147d64; color: #fff; }
.task-step.current .task-step-copy strong { color: #0c654b; }
.task-process-detail { max-width: 1120px; margin: 14px auto 0; }
.task-process-detail > summary { color: #718177; font-size: 11px; cursor: pointer; padding: 5px 0; width: fit-content; }
.task-process-detail .factory-scene { margin-top: 12px; box-shadow: none; border-radius: 9px; }
.factory-floor { min-width: 0; }
.task-metrics { margin: 0 auto; padding: 20px 24px 0; gap: 12px; border: 0; }
.task-metric, .task-metric:last-child, .task-metric:nth-child(2), .task-metric:nth-child(-n+2) { min-width: 0; min-height: 84px; border: 1px solid var(--line); border-radius: 10px; background: #fff; padding: 15px; }
.task-metric strong { font-size: clamp(19px, 1.7vw, 25px); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task-metric span { font-size: 11px; margin-top: 7px; }
.task-detail-grid { gap: 14px; padding: 18px 24px; align-items: start; }
.task-detail-section, .task-detail-section:nth-child(2n) { min-width: 0; min-height: 0; padding: 19px; border: 1px solid var(--line); border-radius: 10px; background: #fff; }
.task-detail-section h3 { margin: 0; font-size: 13px; font-weight: 650; }
.task-activity { font-size: 12px; line-height: 1.75; padding-block: 9px; }
.task-activity small { font-size: 10px; }
.task-detail-actions { padding-top: 0; }
.task-history { max-width: 1170px; margin: 0 auto; padding: 22px 24px; }
.task-history-record { background: #fff; border-radius: 10px; margin-top: 12px; }
.task-history-record > summary { padding: 16px; }
.task-history-record[open] > summary { border-bottom: 1px solid var(--line); }
.task-history-record .task-detail-grid { padding: 14px; gap: 12px; }
.task-history-note, .task-cancelled-note { border: 1px solid #ecdcbb; border-radius: 8px; }
.scope-panel { background: #f8faf9; padding-top: 24px; }
.scope-nav { gap: 5px; }
.scope-button { border: 1px solid transparent; border-radius: 8px; min-height: 38px; font-size: 12px; }
.scope-button:hover { background: #edf2ee; }
.scope-button.active { border-color: #cde4d7; background: #eaf5ee; }
.scope-button span { font-variant-numeric: tabular-nums; }
.rule-list-panel { background: #fbfcfb; }
.panel-header, .editor-header { background: #fff; }
.search-row { background: #fbfcfb; padding: 14px; }
.rule-list { padding: 8px; }
.rule-item { border: 1px solid transparent; border-radius: 9px; margin-bottom: 5px; padding: 14px 12px; background: transparent; }
.rule-item:hover { background: #f0f4f1; border-color: #dce5df; }
.rule-item.selected { background: #edf7f2; border-color: #9ac6b5; box-shadow: inset 3px 0 var(--accent); }
.rule-item p { line-height: 1.7; }
.meta-pill { border-radius: 5px; font-size: 10px; color: #63796b; }
.editor-panel { background: #fff; }
#rule-form { gap: 20px; padding: 26px; }
#rule-form .field label { font-weight: 600; }
#rule-form textarea { min-height: 128px; }
.version-note { border-radius: 0 8px 8px 0; }
.portrait-view, .context-view { background: #f6f8f7; }
.portrait-identity { background: #fff; padding-bottom: 24px; }
.portrait-title-row h2 { font-size: 24px; font-weight: 650; letter-spacing: -.35px; overflow-wrap: anywhere; }
.portrait-heading > div { min-width: 0; }
.portrait-metrics { border: 0; gap: 12px; background: transparent; }
.portrait-metric, .portrait-metric:last-child, .portrait-metric:nth-child(2), .portrait-metric:nth-child(-n+2) { min-width: 0; padding: 18px; border: 1px solid var(--line); border-radius: 10px; background: #fafcfb; }
.portrait-metric strong { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: clamp(20px, 2vw, 26px); font-weight: 600; }
.portrait-mode-tabs { background: #fff; }
.portrait-grid { gap: 18px; border: 0; padding: 22px 24px 32px; }
.portrait-section, .portrait-section.portrait-span-2 { min-width: 0; min-height: 0; border: 1px solid var(--line); border-radius: 12px; padding: 22px; background: #fff; }
.portrait-section h2 { font-weight: 650; }
.portrait-section > header > div { min-width: 0; }
.portrait-section .panel-label { margin-bottom: 5px; font-size: 9px; }
.storage-metric { border-radius: 10px; background: #fafcfb; }
.storage-metric:first-child { background: #f0f8f3; border-color: #c4e1d2; }
.storage-metric strong { letter-spacing: -.5px; font-size: clamp(16px, 1.65vw, 24px); font-weight: 600; }
.maintenance-card { border-radius: 10px; padding: 20px; background: #fcfdfc; }
.maintenance-card h3 { font-weight: 600; }
.maintenance-scope, .ignore-impact { border-radius: 7px; }
.cleanup-history-item, .migration-directory { border-radius: 8px; }
.file-type-track { border-radius: 4px; }
.status-value { border-radius: 6px; }
.portrait-item strong { font-weight: 600; line-height: 1.6; }
.portrait-item span, .portrait-item small { line-height: 1.7; }
.context-controls { background: #fff; }
.context-controls .field { min-width: 0; }
.context-summary { background: #fff; gap: 9px; }
.summary-stat { padding: 8px 11px; border-radius: 8px; background: #f8faf9; line-height: 1.6; }
.summary-stat strong { font-variant-numeric: tabular-nums; }
.context-results { padding: 22px 24px; border: 0; gap: 16px; }
.context-section { min-width: 0; min-height: 0; padding: 20px; border: 1px solid var(--line); border-radius: 11px; background: #fff; }
.context-section h2 { font-size: 14px; font-weight: 650; }
.context-entry { padding-block: 13px; }
.context-entry p { line-height: 1.8; }
.context-entry small { font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.graph-panel { background: #fff; }
.graph-search input, .graph-search-results, .relation-filters label { border-radius: 7px; }
dialog { border-radius: 14px; box-shadow: 0 24px 80px rgba(20,40,28,.18); }
dialog::backdrop { background: rgba(25,39,31,.38); backdrop-filter: blur(3px); }
.migration-action-bar { background: #fff; }
.toast { border-radius: 9px; line-height: 1.6; overflow-wrap: anywhere; }
@media (max-width: 1200px) and (min-width: 981px) {
  .rules-layout { grid-template-columns: 185px minmax(280px, 340px) minmax(0, 1fr); }
}
@media (max-width: 980px) {
  .app-header { height: 116px; }
  .view-tabs { border: 1px solid var(--line); border-radius: 9px; background: #f4f6f5; margin-bottom: 7px; }
  .task-workspace { grid-template-columns: 280px minmax(0, 1fr); }
  .task-focus { padding-inline: 20px; }
  .task-metrics, .task-detail-grid { padding-inline: 16px; gap: 10px; }
  .task-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-detail-grid { grid-template-columns: 1fr; }
  .storage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 760px) {
  .task-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .task-step { padding: 11px 9px; }
  .task-filters { gap: 9px; }
  .task-filters .task-query-field { max-width: none; }
  .portrait-grid { gap: 14px; padding: 18px 16px; }
  .portrait-section, .portrait-section.portrait-span-2 { padding: 18px; }
}
@media (max-width: 640px) {
  .app-header { padding-inline: 14px; }
  .brand strong { font-size: 14px; }
  .brand-mark { width: 34px; height: 34px; }
  .tab { font-size: 11px; }
  .task-toolbar h1, .portrait-toolbar h1, .context-header h1 { font-size: 20px; }
  .task-toolbar-actions { gap: 6px; }
  .task-live-state { padding-inline: 5px; font-size: 10px; gap: 5px; }
  .task-workspace { display: block; }
  .task-list { padding: 10px 12px; gap: 9px; }
  .task-list-item { margin-bottom: 0; padding: 12px 10px; }
  .task-list-pagination { padding: 11px 16px; }
  .task-detail-tabs { padding: 12px 16px; }
  .task-focus { padding: 22px 16px; }
  .task-focus-heading { gap: 12px; }
  .task-focus-title h2 { font-size: 19px; }
  .task-focus-title p { font-size: 12px; }
  .task-focus-meta { margin-top: 16px; }
  .task-metrics { padding: 16px 12px 0; gap: 10px; }
  .task-metric, .task-metric:last-child, .task-metric:nth-child(2), .task-metric:nth-child(-n+2) { padding: 14px; min-height: 80px; }
  .task-detail-grid { padding: 14px 12px; gap: 12px; }
  .task-detail-section, .task-detail-section:nth-child(2n) { padding: 17px; }
  .task-history { padding: 16px 12px; }
  .task-history-record .task-detail-grid { padding: 10px; }
  .rules-layout .scope-panel .compact-field { display: grid; margin-bottom: 12px; }
  .rules-layout .scope-panel .check-row { display: flex; }
  .scope-panel { padding: 14px; }
  .scope-nav { margin-bottom: 14px; padding-bottom: 4px; }
  .scope-button { padding-inline: 10px; }
  #rule-form { padding: 22px 16px 95px; }
  .portrait-heading { gap: 16px; }
  .portrait-title-row h2 { font-size: 21px; }
  .portrait-metric, .portrait-metric:last-child, .portrait-metric:nth-child(2), .portrait-metric:nth-child(-n+2) { padding: 15px 12px; }
  .portrait-metric strong { font-size: 21px; }
  .portrait-grid { padding: 16px 12px 24px; }
  .portrait-section, .portrait-section.portrait-span-2 { padding: 17px; }
  .portrait-section > header { flex-wrap: wrap; }
  .storage-metrics { gap: 9px; }
  .storage-metric { padding: 12px 10px; }
  .storage-metric strong { font-size: 16px; letter-spacing: -.4px; }
  .storage-metric span { font-size: 11px; }
  .maintenance-columns { grid-template-columns: 1fr; gap: 12px; }
  .maintenance-card { padding: 16px; }
  .storage-counts { grid-template-columns: 1fr; }
  .file-type { grid-template-columns: minmax(50px, .7fr) minmax(50px, 1fr) auto; gap: 8px; }
  .context-results { padding: 16px 12px; gap: 12px; }
  .context-section { padding: 17px; }
  .context-summary { padding: 12px 16px; }
  .context-header { padding-inline: 16px; }
  .context-header > div { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) {
  button, input, select, textarea { transition: none; }
}
/* Content hierarchy: compact controls, generous reading area. */
.app-header { height: 60px; }
main { height: calc(100dvh - 60px); }
.task-toolbar, .portrait-toolbar, .context-header { min-height: 62px; padding: 10px 22px; }
.task-toolbar h1, .portrait-toolbar h1, .context-header h1 { font-size: 19px; }
.task-project-picker { width: min(380px, 40vw); }
.task-project-picker label, .portrait-actions .field label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.task-toolbar-actions { align-items: center; }
.task-warnings { padding: 7px 22px; font-size: 12px; }
.task-warnings summary { cursor: pointer; }
.task-warnings details > div { margin-top: 7px; }
.task-workspace { grid-template-columns: 330px minmax(0, 1fr); }
.task-queue > header { min-height: 50px; padding: 10px 14px; }
.task-queue > header .panel-label { display: none; }
.task-filters { display: block; padding: 10px 14px; }
.task-filters .task-query-field { max-width: none; }
.task-filter-options { margin-top: 9px; font-size: 12px; }
.task-filter-options summary { cursor: pointer; color: var(--muted); }
.task-filter-fields { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; padding-top: 10px; }
.task-filter-fields .task-archive-filter { grid-column: 1 / -1; }
.task-detail-tabs { padding: 9px 24px; }
.task-focus { padding: 22px 28px 16px; }
.task-focus-heading, .task-focus-meta, .task-metrics, .task-detail-grid, .task-record-detail, .task-detail-actions { max-width: 1480px; width: 100%; margin-inline: auto; }
.task-focus-title h2 { font-size: clamp(21px,1.6vw,28px); line-height: 1.5; }
.task-metrics { display: flex; flex-wrap: wrap; gap: 8px 24px; padding: 0 28px 16px; background: #fff; }
.task-metric, .task-metric:last-child, .task-metric:nth-child(2), .task-metric:nth-child(-n+2) { display: flex; align-items: baseline; gap: 7px; min-height: 0; padding: 0; border: 0; background: transparent; }
.task-metric strong { font-size: 16px; }
.task-metric span { margin: 0; font-size: 12px; }
.task-detail-grid { padding: 20px 28px; gap: 16px; }
.task-detail-section h3 { font-size: 15px; }
.task-activity { font-size: 13px; }
.task-record-detail { padding: 0 28px 20px; }
.task-record-detail > summary { font-size: 13px; color: var(--muted); cursor: pointer; }
.task-record-detail .task-focus-meta { margin-top: 16px; }
.portrait-toolbar { position: static; }
.portrait-actions { align-items: center; }
.portrait-identity { padding: 18px 24px; }
.portrait-heading, .portrait-metrics { max-width: 1480px; }
.portrait-heading { margin-bottom: 14px; }
.portrait-metric, .portrait-metric:last-child, .portrait-metric:nth-child(2), .portrait-metric:nth-child(-n+2) { padding: 12px 16px; min-height: 0; }
.portrait-mode-tabs { position: sticky; top: 0; min-height: 44px; justify-content: flex-start; padding-inline: 24px; }
#portrait-content[data-mode="graph"] .portrait-metrics,
#portrait-content[data-mode="maintenance"] .portrait-metrics { display: none; }
#portrait-content[data-mode="graph"] .portrait-heading,
#portrait-content[data-mode="maintenance"] .portrait-heading { margin-bottom: 0; }
.portrait-grid { max-width: 1530px; padding: 18px 24px; gap: 16px; }
.portrait-maintenance-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
.portrait-maintenance-actions h2 { font-size: 19px; }
.portrait-maintenance-actions p { margin-top: 5px; color: var(--muted); font-size: 12px; }
.maintenance-toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.portrait-section > header .panel-label { display: none; }
#portrait-overview { align-items: start; }
.portrait-column { display: grid; align-content: start; gap: 16px; min-width: 0; }
#portrait-overview .portrait-list { max-height: 360px; overflow-y: auto; scrollbar-width: thin; }

#portrait-overview .portrait-section:has(#portrait-file-types) { grid-column: auto; }
.portrait-item strong { font-size: 13px; }
.rules-layout { grid-template-columns: 176px 320px minmax(0, 1fr); }
.scope-panel { padding: 18px 12px; }
.panel-header, .editor-header { min-height: 64px; padding: 12px 18px; }
.editor-header > div { min-width: 0; }
.editor-header h2 { overflow-wrap: anywhere; }
#rule-form { max-width: 1050px; margin-inline: auto; padding: 22px 28px; gap: 14px; }
#rule-form #rule-content { min-height: 220px; }
#rule-form #rule-reason { min-height: 72px; }
.form-actions { flex-wrap: wrap; }
.context-view { display: grid; grid-template-columns: 300px minmax(0,1fr); grid-template-rows: auto auto minmax(0,1fr); overflow: hidden; }
.context-header { grid-column: 1 / -1; }
.context-header .panel-label { display: none; }
.context-controls { grid-column: 1; grid-row: 2 / 4; display: flex; flex-direction: column; align-items: stretch; gap: 18px; padding: 22px; border-right: 1px solid var(--line); overflow-y: auto; }
.context-controls textarea { min-height: 160px; }
.context-summary { grid-column: 2; padding: 12px 22px; }
.context-results { grid-column: 2; grid-row: 3; width: 100%; max-width: none; margin: 0; overflow-y: auto; align-content: start; padding: 20px; }
.context-empty { grid-column: 2; grid-row: 3; margin: 0; align-self: center; }
.context-entry strong, .context-entry p { font-size: 13px; }
.graph-panel { scroll-margin-top: 44px; }
.graph-workspace { height: calc(100dvh - 240px); min-height: 320px; overflow: hidden; }
dialog { max-height: calc(100dvh - 24px); overflow: auto; }
dialog h2, dialog p { overflow-wrap: anywhere; }
.dialog-actions { flex-wrap: wrap; }
@media (max-width: 1100px) {
  .context-results { grid-template-columns: 1fr; }
  .task-workspace { grid-template-columns: 300px minmax(0,1fr); }
}
@media (max-width: 980px) {
  .app-header { height: 104px; }
  main { height: calc(100dvh - 104px); }
  .editor-panel { top: 104px; }
  .rules-layout { grid-template-columns: 176px minmax(0,1fr); }
  .context-view { grid-template-columns: 260px minmax(0,1fr); }
  .task-detail-grid { padding-inline: 18px; }
}
@media (max-width: 640px) {
  .task-toolbar, .portrait-toolbar { padding: 12px 16px; gap: 10px; }
  .task-toolbar { flex-direction: row; flex-wrap: wrap; }
  .task-toolbar-actions { width: 100%; }
  .task-project-picker { width: auto; flex: 1; min-width: 0; }
  .task-live-state { display: none; }
  .task-workspace { display: block; }
  .task-warnings { padding-inline: 16px; }
  .task-queue > header { min-height: 42px; }
  .task-focus { padding: 18px 16px 12px; }
  .task-focus-title h2 { font-size: 21px; }
  .task-metrics { padding: 0 16px 14px; gap: 8px 18px; }
  .task-detail-grid { padding: 14px 12px; }
  .task-record-detail { padding-inline: 16px; }
  .portrait-actions { display: flex; gap: 8px; }
  .portrait-actions .field { flex: 1 1 100%; min-width: 0; }
  .portrait-actions > button { flex: 1; }
  .portrait-identity { padding: 16px; }
  .portrait-mode-tabs { padding-inline: 8px; }
  .portrait-mode { min-width: 0; flex: 1; min-height: 44px; }
  .portrait-grid { padding: 14px 12px; }
  .rules-layout { display: block; }
  #rule-form { padding: 18px 16px 110px; }
  .context-view { display: block; overflow-y: auto; }
  .context-controls { display: grid; grid-template-columns: minmax(0,1fr) 110px; gap: 12px; padding: 16px; border-right: 0; }
  .context-controls .task-field { grid-column: 1 / -1; grid-row: 2; }
  .context-controls textarea { min-height: 88px; }
  .context-controls .primary-button { grid-column: 1 / -1; }
  .context-results { overflow: visible; padding: 14px 12px; }
  .context-empty { padding: 32px 16px; }
  .graph-workspace { height: 65dvh; min-height: 300px; }
}
/* A compact illustrated track, always visible in the task's main reading area. */
.task-item-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 11px; }
.task-item-text { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.task-item-text > button { display: block; margin-top: 8px; }
.task-items-paged { max-height: 420px; overflow-y: auto; scrollbar-width: thin; }
.missing-project-state { max-width: 720px; width: 100%; margin: 0 auto; padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: #fff; text-align: left; }
.missing-project-state > strong { font-size: 18px; }
.missing-project-state p { overflow-wrap: anywhere; line-height: 1.8; margin-top: 10px; }
.missing-project-state details { margin-top: 12px; }
.missing-project-state .dialog-actions { justify-content: flex-start; margin-top: 20px; }
.task-stepper { max-width: 1480px; margin: 18px auto 0; padding: 18px 22px 12px; border: 1px solid #dcebe4; border-radius: 14px; background: radial-gradient(ellipse at 85% 0%, #def2e8 0%, transparent 55%), linear-gradient(115deg,#f8fbfa,#f0f7f4); overflow: hidden; }
.task-stepper-head { margin-bottom: 18px; }
.flow-heading { display: flex; align-items: center; gap: 10px; }
.flow-eyebrow { color: #729689; font-size: 9px; letter-spacing: .14em; }
.flow-heading strong { color: #284f40; font-size: 13px; }
.flow-status { color: #147d64; background: #fff; border: 1px solid #cce4d7; padding: 4px 9px; border-radius: 20px; font-size: 11px; }
.task-steps { gap: 0; }
.task-step, .task-step.current { position: relative; display: flex; flex-direction: column; align-items: center; text-align: center; padding: 0 8px; gap: 9px; border: 0; border-radius: 0; background: transparent; }
.task-step-index { position: relative; z-index: 1; display: grid; width: 42px; height: 42px; flex: 0 0 42px; border-radius: 13px; border: 1px solid #d7e4de; background: #f7faf8; color: #9daea5; box-shadow: 0 3px 8px #1f554008; }
.task-step-index svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.task-step.recorded .task-step-index { background: #e2f2e9; color: #25846a; border-color: #b6dcca; }
.task-step.current .task-step-index { background: linear-gradient(145deg,#249c7d,#0c6550); color: white; border-color: #147d64; box-shadow: 0 0 0 5px #dbeee4, 0 5px 13px #147d6426; }
.flow-rail { position: absolute; left: calc(-50% + 28px); right: calc(50% + 28px); top: 20px; height: 2px; background: repeating-linear-gradient(90deg,#ccdcd3 0 4px,transparent 4px 9px); }
.task-step:first-child .flow-rail { display: none; }
.recorded .flow-rail { background: #a7d6c1; }
.flow-in_progress .current .flow-rail::after { content: ""; position: absolute; width: 24px; height: 2px; background: linear-gradient(90deg,transparent,#208e6d); animation: flow-travel 2.8s ease-in-out infinite; }
.flow-in_progress .current .task-step-index { animation: flow-focus 3s ease-in-out infinite; }
.task-step-copy strong { font-size: 12px; line-height: 1.5; }
.task-step-copy small { font-size: 10px; margin-top: 3px; }
.flow-caption { text-align: right; margin-top: 12px; font-size: 10px; color: #7d9286; }
.flow-blocked .current .task-step-index { background: #b57c2b; border-color: #a86c1d; box-shadow: 0 0 0 5px #f5ead5; }
.flow-blocked .flow-status { color: #9a6827; border-color: #e7d6b8; }
.flow-cancelled { filter: saturate(.3); }
@keyframes flow-travel { from { left: 0; opacity: 0; } 20% { opacity: 1; } to { left: calc(100% - 24px); opacity: 0; } }
@keyframes flow-focus { 50% { box-shadow: 0 0 0 7px #dbeee470, 0 5px 18px #147d6438; } }
@media (max-width: 760px) {
  .task-steps { grid-template-columns: repeat(4,minmax(0,1fr)); }
  .task-stepper { padding: 14px 10px 10px; }
  .flow-eyebrow { display: none; }
  .task-step { padding-inline: 3px; }
  .task-step-index { width: 34px; height: 34px; flex-basis: 34px; border-radius: 10px; }
  .flow-rail { top: 16px; left: calc(-50% + 22px); right: calc(50% + 22px); }
  .task-step-copy strong { font-size: 11px; }
  .flow-caption { text-align: left; line-height: 1.6; }
}
@media (prefers-reduced-motion: reduce) { .flow-in_progress .current .flow-rail::after, .flow-in_progress .current .task-step-index { animation: none; } }
`;
