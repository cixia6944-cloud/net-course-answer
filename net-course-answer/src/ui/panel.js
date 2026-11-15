// 轻量悬浮面板: 纯原生 DOM, 零第三方 UI 依赖。
// 结构: 可拖动卡片 —— 顶栏(标题/状态灯/折叠/收起) + 分段页签(日志/题目/设置) + 状态条。
// 约定(勿改, 外部工具/测试依赖): 类名 .nca-panel/.nca-log/.nca-copy-log/.nca-q/.nca-tab/
//   .nca-course/.nca-course-state/.nca-rate/.nca-autosubmit/.nca-submitrate, 以及 data-pane-body 属性。
import { gm } from "../vendor/gm.js";
import { setSimilarityThreshold } from "../core/matcher.js";
import { readSetting, writeSetting } from "../vendor/gm.js";
import { AI_TUTOR_DEFAULTS } from "../core/ai-tutor.js";
import { DISCUSS_DEFAULTS, normalizePostMode } from "../core/discuss.js";
import { VERSION } from "../version.js";

const SETTING_KEY = "net-course-answer-config";

const PANEL_CSS = `
.nca-panel{
  --nca-primary:#2563eb; --nca-primary-2:#4f46e5; --nca-bg:#ffffff; --nca-bg-2:#f7f8fa; --nca-bg-3:#eef1f6;
  --nca-fg:#111827; --nca-fg-2:#4b5563; --nca-fg-3:#9ca3af; --nca-line:#e5e7eb; --nca-line-2:#eef0f4;
  --nca-ok:#16a34a; --nca-warn:#d97706; --nca-danger:#dc2626; --nca-radius:12px;
  position:fixed; top:96px; right:20px; z-index:100003; width:372px; max-height:min(88vh,840px);
  display:flex; flex-direction:column; overflow:hidden;
  background:var(--nca-bg); color:var(--nca-fg); border:1px solid var(--nca-line); border-radius:var(--nca-radius);
  box-shadow:0 1px 2px rgba(16,24,40,.04), 0 12px 32px -8px rgba(16,24,40,.22), 0 0 0 1px rgba(16,24,40,.02);
  font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,sans-serif;
  animation:nca-in .22s cubic-bezier(.2,.8,.3,1);
}
@keyframes nca-in{from{opacity:0;transform:translateY(-6px) scale(.985)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.nca-panel{animation:none}}

/* 顶栏 */
.nca-head{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;cursor:move;user-select:none;
  background:linear-gradient(135deg,var(--nca-primary) 0%,var(--nca-primary-2) 100%);color:#fff}
.nca-head .nca-dot{width:7px;height:7px;border-radius:50%;background:#a7f3d0;box-shadow:0 0 0 3px rgba(255,255,255,.18);flex:none}
.nca-title{font-weight:600;font-size:13px;letter-spacing:.2px;white-space:nowrap}
.nca-sub{font-size:11px;opacity:.82;margin-left:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nca-head .nca-spacer{flex:1}
.nca-icon-btn{width:22px;height:22px;display:grid;place-items:center;border:0;border-radius:6px;cursor:pointer;
  background:rgba(255,255,255,.14);color:#fff;font-size:13px;line-height:1;transition:background .15s}
.nca-icon-btn:hover{background:rgba(255,255,255,.28)}
.nca-body{padding:10px;display:flex;flex-direction:column;gap:9px;overflow:hidden}
.nca-panel.nca-collapsed .nca-body,.nca-panel.nca-collapsed .nca-statusbar{display:none}

/* 分段页签 */
.nca-tabs{display:flex;gap:2px;padding:3px;background:var(--nca-bg-3);border-radius:9px;flex:none}
.nca-tab{flex:1;padding:5px 8px;border:0;border-radius:7px;cursor:pointer;background:transparent;color:var(--nca-fg-2);
  font-size:12px;font-weight:500;transition:background .15s,color .15s,box-shadow .15s}
.nca-tab:hover{color:var(--nca-fg)}
.nca-tab.on{background:var(--nca-bg);color:var(--nca-primary);font-weight:600;box-shadow:0 1px 2px rgba(16,24,40,.10),inset 0 -2px 0 var(--nca-primary)}
.nca-count{display:inline-block;min-width:16px;margin-left:4px;padding:0 4px;border-radius:8px;background:var(--nca-bg-3);
  color:var(--nca-fg-2);font-size:10.5px;line-height:15px;text-align:center}
.nca-tab.on .nca-count{background:rgba(37,99,235,.12);color:var(--nca-primary)}
.nca-pane{display:none;min-height:0}
.nca-pane:not(.on){display:none!important}   /* 防止后面 .nca-questions{display:flex} 把隐藏态顶掉 */
.nca-pane.on{display:flex;flex-direction:column}

/* 日志 */
.nca-mode{display:flex;flex-direction:column;gap:7px}
.nca-mode-head{display:flex;align-items:center;gap:6px;font-weight:700;font-size:12px;color:var(--nca-fg);padding:1px 2px}
.nca-mode-sub{color:var(--nca-fg-3);font-weight:500;font-size:11px}
.nca-steps{display:flex;gap:6px}
.nca-steps .nca-btn{flex:1}
.nca-progress{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--nca-fg-2)}
.nca-bar{flex:1;height:5px;border-radius:99px;background:var(--nca-bg-3);overflow:hidden}
.nca-bar>i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--nca-primary),var(--nca-primary-2));transition:width .25s}
.nca-q.pending{border-color:#fcd34d;background:rgba(251,191,36,.06)}
.nca-q .nca-qact{display:flex;gap:6px;margin-top:6px}
.nca-q .nca-qact .nca-btn{min-height:26px;padding:2px 9px;font-size:11.5px}
.nca-q .nca-qact .nca-btn[disabled]{opacity:.45;cursor:not-allowed}
.nca-group{display:flex;flex-direction:column;gap:4px;margin:2px 0 8px}
.nca-group>.nca-group-title{font-size:11px;font-weight:700;letter-spacing:.4px;color:var(--nca-fg-3);text-transform:uppercase;padding:2px 2px}
.nca-unit{display:inline-flex;align-items:center;gap:4px;margin-left:auto;color:var(--nca-fg-3);font-size:11.5px}
.nca-kv{margin-left:auto;color:var(--nca-fg-3);font-size:11px}
.nca-log{max-height:230px;overflow:auto;font:11.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  background:var(--nca-bg-2);border:1px solid var(--nca-line-2);border-radius:9px;padding:6px 8px}
.nca-log .nca-row{display:flex;gap:6px;padding:2px 0;border-bottom:1px dashed var(--nca-line-2)}
.nca-log .nca-row:last-child{border-bottom:0}
.nca-log .nca-t{color:var(--nca-fg-3);flex:none;font-variant-numeric:tabular-nums}
.nca-log .nca-m{word-break:break-word}
.nca-log .nca-m.danger{color:var(--nca-danger)} .nca-log .nca-m.success{color:var(--nca-ok)}
.nca-log .nca-m.warning{color:var(--nca-warn)} .nca-log .nca-m.primary{color:var(--nca-primary)}
.nca-empty{color:var(--nca-fg-3);font-size:11.5px;padding:8px 2px;text-align:center}

/* 题目 */
.nca-questions{max-height:250px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.nca-q{border:1px solid var(--nca-line);border-radius:9px;padding:7px 9px;background:var(--nca-bg);font-size:12px;
  box-shadow:0 1px 1px rgba(16,24,40,.03)}
.nca-q .t{font-weight:600;color:var(--nca-fg);display:block;margin-bottom:3px}
.nca-q .a{color:#15803d} .nca-q .e{color:#b91c1c}
.nca-q .a .nca-ans-label,.nca-q .e .nca-ans-label{font-weight:600;color:var(--nca-fg-2);margin-right:4px}
.nca-q .e{opacity:.85}
.nca-badge{display:inline-block;margin-right:5px;padding:0 5px;border-radius:5px;background:rgba(37,99,235,.10);
  color:var(--nca-primary);font-size:10.5px;font-weight:600;line-height:16px;vertical-align:1px}

/* AI助教(一题一会话) */
.nca-pane[data-pane-body="tutor"]{min-height:0}
.nca-pane[data-pane-body="tutor"] .nca-mode{overflow:auto;padding-right:2px}
.nca-pane[data-pane-body="tutor"] .nca-tutor-items{flex:none}
.nca-tutor-list{width:100%;box-sizing:border-box;min-height:66px;max-height:120px;resize:vertical;padding:6px 8px;
  border:1px solid var(--nca-line);border-radius:8px;background:var(--nca-bg);color:var(--nca-fg);font:inherit;font-size:12px;line-height:1.6}
.nca-tutor-list:focus{outline:0;border-color:var(--nca-primary);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
.nca-mode .nca-tutor-praise,.nca-mode .nca-tutor-cai-reason{width:100%;box-sizing:border-box;padding:4px 7px;
  border:1px solid var(--nca-line);border-radius:6px;background:var(--nca-bg);color:var(--nca-fg);font:inherit;font-size:12px}
.nca-tutor-items{max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:3px;font-size:11.5px}
.nca-tutor-item{display:flex;gap:6px;padding:3px 7px;border-radius:7px;background:var(--nca-bg-2);border:1px solid var(--nca-line-2)}
.nca-tutor-item .nca-tutor-st{flex:none;font-weight:600;min-width:52px;color:var(--nca-fg-2)}
.nca-tutor-item .nca-tutor-q{color:var(--nca-fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nca-tutor-item.ok .nca-tutor-st{color:var(--nca-ok)} .nca-tutor-item.bad .nca-tutor-st{color:var(--nca-danger)}
.nca-tutor-item.cur{background:rgba(37,99,235,.08);border-color:rgba(37,99,235,.35)}

/* 讨论区(默认逐条确认) */
.nca-pane[data-pane-body="discuss"]{min-height:0}
.nca-pane[data-pane-body="discuss"] .nca-mode{overflow:auto;padding-right:2px}
.nca-discuss-status{font-size:11.5px;color:var(--nca-fg-2);background:var(--nca-bg-2);border:1px solid var(--nca-line-2);
  border-radius:8px;padding:5px 8px;word-break:break-all;line-height:1.6}
.nca-discuss-status.bad{color:var(--nca-danger);border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.05)}
.nca-discuss-counts{margin-left:auto;font-size:11.5px;color:var(--nca-fg-3);font-variant-numeric:tabular-nums}
.nca-discuss-num{width:58px;padding:3px 6px;border:1px solid var(--nca-line);border-radius:6px;background:var(--nca-bg);
  color:var(--nca-fg);font:inherit;font-size:12px;text-align:right}
.nca-discuss-draft{border:1px solid rgba(37,99,235,.35);background:rgba(37,99,235,.05);border-radius:9px;padding:7px 9px;
  display:flex;flex-direction:column;gap:5px}
.nca-discuss-draft .nca-discuss-draft-title{font-size:11.5px;color:var(--nca-fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nca-discuss-draft .nca-discuss-draft-text{width:100%;box-sizing:border-box;min-height:78px;resize:vertical;padding:6px 8px;
  border:1px solid var(--nca-line);border-radius:7px;background:var(--nca-bg);color:var(--nca-fg);font:inherit;font-size:12px;line-height:1.65}
.nca-discuss-draft .nca-discuss-draft-meta{font-size:11px;color:var(--nca-fg-3)}
.nca-discuss-items{max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:3px;font-size:11.5px}
.nca-discuss-item{display:flex;gap:6px;padding:3px 7px;border-radius:7px;background:var(--nca-bg-2);border:1px solid var(--nca-line-2)}
.nca-discuss-item .nca-discuss-st{flex:none;font-weight:600;min-width:64px;color:var(--nca-fg-2)}
.nca-discuss-item .nca-discuss-q{color:var(--nca-fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nca-discuss-item.ok .nca-discuss-st{color:var(--nca-ok)} .nca-discuss-item.bad .nca-discuss-st{color:var(--nca-danger)}
.nca-discuss-item.cur{background:rgba(37,99,235,.08);border-color:rgba(37,99,235,.35)}

/* AI陪练(自动作答 + 判分记录) */
.nca-pane[data-pane-body="practice"]{min-height:0}
.nca-pane[data-pane-body="practice"] .nca-mode{overflow:auto;padding-right:2px}
.nca-practice-status{font-size:11.5px;color:var(--nca-fg-2);background:var(--nca-bg-2);border:1px solid var(--nca-line-2);
  border-radius:8px;padding:5px 8px;word-break:break-all;line-height:1.6}
.nca-practice-status.bad{color:var(--nca-danger);border-color:rgba(220,38,38,.35);background:rgba(220,38,38,.05)}
.nca-practice-points{margin-left:auto;font-size:11.5px;color:var(--nca-fg-3);font-variant-numeric:tabular-nums}
.nca-practice-current{border:1px solid rgba(37,99,235,.35);background:rgba(37,99,235,.05);border-radius:9px;padding:7px 9px;
  display:flex;flex-direction:column;gap:4px;font-size:11.5px}
.nca-practice-current .nca-practice-qtype{color:var(--nca-fg-3);font-size:11px}
.nca-practice-current .nca-practice-stem{color:var(--nca-fg);line-height:1.6;max-height:96px;overflow:auto}
.nca-practice-current .nca-practice-options{color:var(--nca-fg-2);display:flex;flex-direction:column;gap:2px}
.nca-practice-stats{font-size:11.5px;color:var(--nca-fg-2);font-variant-numeric:tabular-nums}
.nca-practice-items{max-height:170px;overflow:auto;display:flex;flex-direction:column;gap:3px;font-size:11.5px}
.nca-practice-item{display:flex;flex-direction:column;gap:1px;padding:4px 7px;border-radius:7px;background:var(--nca-bg-2);border:1px solid var(--nca-line-2)}
.nca-practice-item .nca-practice-item-stem{color:var(--nca-fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nca-practice-item .nca-practice-item-meta{color:var(--nca-fg-3);font-size:11px}
.nca-practice-item.wrong .nca-practice-item-meta{color:var(--nca-danger)}
.nca-practice-item.right .nca-practice-item-meta{color:var(--nca-ok)}
.nca-practice-export-text{width:100%;box-sizing:border-box;min-height:96px;resize:vertical;padding:6px 8px;
  border:1px solid var(--nca-line);border-radius:7px;background:var(--nca-bg);color:var(--nca-fg);font:inherit;font-size:12px;line-height:1.6}

/* 设置 */
.nca-set{display:flex;flex-direction:column;gap:2px;max-height:300px;overflow:auto;padding-right:2px}
.nca-set label{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:9px;background:var(--nca-bg-2);
  border:1px solid var(--nca-line-2);font-size:12px;color:var(--nca-fg-2)}
.nca-set label:hover{border-color:var(--nca-line)}
.nca-set label.nca-stack{flex-direction:column;align-items:stretch;gap:6px}
.nca-set .nca-label-txt{font-weight:600;color:var(--nca-fg);flex:none}
.nca-set .nca-hint{color:var(--nca-fg-3);font-size:11px}
.nca-set input[type=number]{width:64px;padding:3px 6px;border:1px solid var(--nca-line);border-radius:6px;
  background:var(--nca-bg);color:var(--nca-fg);font:inherit;font-size:12px;text-align:right}
.nca-set input[type=number]:focus{outline:0;border-color:var(--nca-primary);box-shadow:0 0 0 3px rgba(37,99,235,.14)}
.nca-set input[type=checkbox]{width:15px;height:15px;accent-color:var(--nca-primary);flex:none}
.nca-set input[type=range]{width:100%;accent-color:var(--nca-primary)}
.nca-mode input[type=range]{width:100%;accent-color:var(--nca-primary)}
.nca-mode .nca-slider-row{display:flex;flex-direction:column;gap:6px}
.nca-btn{min-height:32px;padding:6px 12px;border:1px solid var(--nca-line);border-radius:8px;background:var(--nca-bg);color:var(--nca-fg);
  cursor:pointer;font:inherit;font-size:12px;font-weight:500;transition:background .15s,border-color .15s,transform .05s}
.nca-btn:hover{background:var(--nca-bg-3)}
.nca-btn:active{transform:translateY(1px)}
.nca-btn.primary{background:var(--nca-primary);border-color:var(--nca-primary);color:#fff}
.nca-btn.primary:hover{background:#1d4ed8}
.nca-btn.danger{background:#fff;border-color:#fecaca;color:var(--nca-danger)}
.nca-btn.danger:hover{background:#fef2f2}
/* 一轮答题进行中: 步骤按钮变忙且不可点, 旁边露出「停止」 */
.nca-btn[disabled]{opacity:.5;cursor:not-allowed}
.nca-btn.busy{background:var(--nca-bg-3);border-color:var(--nca-line);color:var(--nca-fg-3)}
.nca-copy-log{padding:4px 10px;border:1px solid var(--nca-line);border-radius:8px;background:var(--nca-bg);
  cursor:pointer;font:inherit;font-size:11.5px;color:var(--nca-fg-2);transition:background .15s}
.nca-copy-log:hover{background:var(--nca-bg-3)}
.nca-row-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}

/* 状态条 */
.nca-statusbar{display:flex;align-items:center;gap:8px;padding:7px 10px;border-top:1px solid var(--nca-line-2);
  background:var(--nca-bg-2);font-size:11.5px;color:var(--nca-fg-2);flex:none}
.nca-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:var(--nca-bg);
  border:1px solid var(--nca-line);white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.nca-chip .nca-led{width:6px;height:6px;border-radius:50%;background:var(--nca-fg-3);flex:none}
.nca-chip.ok .nca-led{background:var(--nca-ok);box-shadow:0 0 0 3px rgba(22,163,74,.15)}
.nca-chip.bad .nca-led{background:var(--nca-danger);box-shadow:0 0 0 3px rgba(220,38,38,.15)}
.nca-chip.busy .nca-led{background:var(--nca-primary);animation:nca-pulse 1.2s infinite}
@keyframes nca-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.nca-statusbar .nca-spacer{flex:1}

/* 滚动条 */
.nca-panel ::-webkit-scrollbar{width:8px;height:8px}
.nca-panel ::-webkit-scrollbar-thumb{background:#cbd2dd;border:2px solid transparent;background-clip:content-box;border-radius:8px}
.nca-panel ::-webkit-scrollbar-thumb:hover{background:#aab4c3;background-clip:content-box}
.nca-panel ::-webkit-scrollbar-track{background:transparent}

/* 深色模式 */
@media (prefers-color-scheme:dark){
  .nca-panel{--nca-bg:#1c1f26;--nca-bg-2:#22262e;--nca-bg-3:#2a2f38;--nca-fg:#e8eaee;--nca-fg-2:#b6bcc7;--nca-fg-3:#7d8593;
    --nca-line:#31363f;--nca-line-2:#2a2f38;--nca-primary:#60a5fa;--nca-primary-2:#818cf8;
    box-shadow:0 12px 32px -8px rgba(0,0,0,.6)}
  .nca-tab.on{color:var(--nca-primary);background:#2f3540}
  .nca-btn{background:#262b33}
  .nca-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
  .nca-btn.danger{background:#2a2226;border-color:#5b2b2b;color:#f87171}
  .nca-panel ::-webkit-scrollbar-thumb{background:#3d4553;background-clip:content-box}
  .nca-panel ::-webkit-scrollbar-thumb:hover{background:#4b5464;background-clip:content-box}
}
`;

export class Panel {
  constructor({ log } = {}) {
    this.logFn = log || (() => {});
    this.questions = [];
    this.host = null;
    this.root = null;
    this.answered = 0;
    this.logCount = 0;
    this.courseOn = false;
    this.bridgeOk = null;
    this.answerRunning = false;
    this.tutorRunning = false;
    this.tutorListDraft = "";
    this.practiceRunning = false;
  }

  mount() {
    const host = document.createElement("div");
    host.className = "nca-panel";
    document.body.appendChild(host);
    this.host = host;

    if (gm.addStyle) gm.addStyle(PANEL_CSS);
    else {
      const st = document.createElement("style");
      st.textContent = PANEL_CSS;
      document.head.appendChild(st);
    }

    host.innerHTML = `
      <div class="nca-head">
        <span class="nca-dot"></span>
        <span class="nca-title">网课答题助手</span>
        <span class="nca-sub"></span>
        <span class="nca-spacer"></span>
        <button class="nca-icon-btn nca-collapse" title="折叠/展开">▾</button>
        <button class="nca-icon-btn nca-min" title="隐藏面板(刷新页面可回来)">✕</button>
      </div>
      <div class="nca-body">
        <div class="nca-tabs">
          <button class="nca-tab on" data-pane="answer">答题<span class="nca-count nca-q-count">0</span></button>
          <button class="nca-tab" data-pane="course">刷课<span class="nca-count nca-course-count">—</span></button>
          <button class="nca-tab" data-pane="tutor">AI助教<span class="nca-count nca-tutor-count">0</span></button>
          <button class="nca-tab" data-pane="discuss">讨论区<span class="nca-count nca-discuss-count">0</span></button>
          <button class="nca-tab" data-pane="practice">AI陪练<span class="nca-count nca-practice-count">0</span></button>
          <button class="nca-tab" data-pane="log">日志<span class="nca-count nca-log-count">0</span></button>
        </div>

        <!-- ===== 答题(半自动: 人工把关) ===== -->
        <div class="nca-pane on" data-pane-body="answer">
          <div class="nca-mode">
            <div class="nca-mode-head">答题 · 半自动 <span class="nca-mode-sub">逐题确认, 不会自动提交</span></div>
            <div class="nca-steps">
              <button class="nca-btn nca-parse">① 解析题目</button>
              <button class="nca-btn nca-ask">② 取答案</button>
              <button class="nca-btn primary nca-fill">③ 填入页面</button>
              <button class="nca-btn danger nca-stop" style="display:none">停止</button>
            </div>
            <div class="nca-progress">
              <span class="nca-progress-text">未开始</span>
              <span class="nca-bar"><i class="nca-bar-in"></i></span>
            </div>
            <div class="nca-questions"></div>
            <div class="nca-row-inline" style="justify-content:space-between">
              <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0">
                <input type="checkbox" class="nca-autoanswer"><span class="nca-hint">全自动答题(不推荐: 不稳定)</span>
              </label>
              <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0">
                <input type="checkbox" class="nca-autosubmit"><span class="nca-hint">答完自动提交</span>
              </label>
            </div>
            <label style="background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">答案相似度阈值</span>
              <span class="nca-unit" style="margin-left:auto">下限 +<input type="number" class="nca-threshold" min="0" max="100" step="1">%</span></label>
            <div class="nca-slider-row">
              <input type="range" class="nca-threshold-range" min="0" max="100" step="1" title="拖动调整相似度阈值">
            </div>
            <label style="background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">正确率门槛</span>
              <span class="nca-unit" style="margin-left:auto">≥<input type="number" class="nca-submitrate" min="0" max="100" step="5">%</span></label>
          </div>
        </div>

        <!-- ===== 刷课(全自动: 无人值守) ===== -->
        <div class="nca-pane" data-pane-body="course">
          <div class="nca-mode">
            <div class="nca-mode-head">刷课 · 全自动 <span class="nca-mode-sub">自然播放, 不伪造心跳</span></div>
            <label class="nca-stack" style="background:transparent;border:0;padding:0">
              <span class="nca-row-inline">
                <button class="nca-btn primary nca-course">开始刷课</button>
                <span class="nca-chip nca-course-chip"><i class="nca-led"></i><span class="nca-course-state">未运行</span></span>
              </span>
            </label>
            <div class="nca-progress"><span class="nca-progress-text nca-course-progress">等待开始</span><span class="nca-bar"><i class="nca-bar-in nca-course-bar"></i></span></div>
            <label style="background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">刷课倍速</span>
              <span class="nca-unit" style="margin-left:auto"><input type="number" class="nca-rate" min="1" max="2" step="0.25">x</span></label>
            <label style="background:transparent;border:0;padding:0"><input type="checkbox" class="nca-course-autonext"><span class="nca-hint">完成后自动进入下一个任务点(默认开)</span></label>
            <div class="nca-hint" style="line-height:1.7;padding:2px">
              支持: 一页多任务点(3.9) · 新版泛雅3 入口(自动跳旧版) · 多轮扫描 · 失败重试<br>
              注意: 需保持本窗口在前台(学习通失焦会暂停视频)
            </div>
          </div>
        </div>

        <!-- ===== AI助教(一题一会话 + 自动评价) ===== -->
        <div class="nca-pane" data-pane-body="tutor">
          <div class="nca-mode">
            <div class="nca-mode-head">AI助教 · 一题一会话 <span class="nca-mode-sub">每题新建会话, 答完自动赞/踩</span></div>
            <label class="nca-stack" style="background:transparent;border:0;padding:0">
              <span class="nca-label-txt" style="font-size:11.5px">问题清单 <span class="nca-hint">一行一题, 至少要跟课程章节相关</span></span>
              <textarea class="nca-tutor-list" rows="4" placeholder="一行一题, 至少要跟课程章节相关&#10;例如: 1.4 节讲机会成本时说它是「放弃掉的最高价值选项」, 为什么不把所有放弃的选项加起来?"></textarea>
            </label>
            <label class="nca-stack" style="background:transparent;border:0;padding:0">
              <span class="nca-label-txt" style="font-size:11.5px">赞的理由 <span class="nca-hint">赞的弹窗没有理由框, 这里只记在日志里</span></span>
              <input type="text" class="nca-tutor-praise">
            </label>
            <label class="nca-stack" style="background:transparent;border:0;padding:0">
              <span class="nca-label-txt" style="font-size:11.5px">踩的理由 <span class="nca-hint">会填进评价框</span></span>
              <input type="text" class="nca-tutor-cai-reason">
            </label>
            <label style="background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">判分策略</span>
              <span class="nca-unit" style="margin-left:auto">回复少于 <input type="number" class="nca-tutor-minchars" min="0" max="5000" step="10"> 字 → 踩, 否则赞</span></label>
            <div class="nca-steps">
              <button class="nca-btn nca-tutor-preview">预览</button>
              <button class="nca-btn primary nca-tutor-start">开始</button>
              <button class="nca-btn danger nca-tutor-stop" style="display:none">停止</button>
            </div>
            <div class="nca-progress"><span class="nca-progress-text nca-tutor-progress">未开始</span><span class="nca-bar"><i class="nca-bar-in nca-tutor-bar"></i></span></div>
            <div class="nca-tutor-items"></div>
            <div class="nca-hint" style="line-height:1.7;padding:2px">
              点「开始」先确认一次; 「停止」= 不再发下一题, 正在等回复的那题直接放弃(不评价)。
            </div>
          </div>
        </div>

        <!-- ===== 讨论区(默认逐条确认) ===== -->
        <div class="nca-pane" data-pane-body="discuss">
          <div class="nca-mode">
            <div class="nca-mode-head">讨论区 · 自动回复 <span class="nca-mode-sub">默认逐条确认: 生成完停住, 你点「发送」才发</span></div>
            <div class="nca-discuss-status">bbsid — · courseId — · classId —</div>
            <div class="nca-row-inline" style="align-items:center">
              <span class="nca-label-txt" style="font-size:11.5px">频率与额度</span>
              <span class="nca-discuss-counts">今日 0 / 累计 0</span>
            </div>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">目标总条数</span>
              <input type="number" class="nca-discuss-num nca-discuss-total" min="1" max="999" step="1"></label>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">每天上限</span>
              <input type="number" class="nca-discuss-num nca-discuss-daily" min="1" max="99" step="1"></label>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">间隔(秒)</span>
              <span class="nca-unit" style="margin-left:auto">
                <input type="number" class="nca-discuss-num nca-discuss-iv-min" min="0" max="3600" step="5">
                <span>–</span>
                <input type="number" class="nca-discuss-num nca-discuss-iv-max" min="0" max="3600" step="5">
              </span></label>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">正文字数</span>
              <span class="nca-unit" style="margin-left:auto">
                <input type="number" class="nca-discuss-num nca-discuss-minchars" min="10" max="1000" step="10">
                <span>–</span>
                <input type="number" class="nca-discuss-num nca-discuss-maxchars" min="10" max="2000" step="10">
              </span></label>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">发帖通道</span>
              <select class="nca-discuss-postmode" title="UI = 打开话题页用页面自己的按钮发(中文正常); API = 直接调接口(实测中文会变成等长问号)">
                <option value="ui">页面 UI(推荐)</option>
                <option value="api">接口 API(中文可能变问号)</option>
              </select></label>
            <label style="background:transparent;border:0;padding:0">
              <input type="checkbox" class="nca-discuss-auto">
              <span class="nca-label-txt" style="font-size:11.5px">连续自动 <span class="nca-hint">不等确认直接发, 打开会先弹一次确认</span></span>
            </label>
            <label style="background:transparent;border:0;padding:0">
              <input type="checkbox" class="nca-discuss-batch">
              <span class="nca-label-txt" style="font-size:11.5px">批量模式 <span class="nca-hint">自己跑完: 带接地校验, 到目标/上限自动停, 跑完出报告</span></span>
            </label>
            <div class="nca-steps">
              <button class="nca-btn primary nca-discuss-start">开始</button>
              <button class="nca-btn danger nca-discuss-stop" style="display:none">停止</button>
              <button class="nca-btn nca-discuss-resend" title="对上次那条草稿强制重发(已发过的话题也发)">重发上一条</button>
            </div>
            <div class="nca-discuss-draft" style="display:none">
              <div class="nca-discuss-draft-title"></div>
              <textarea class="nca-discuss-draft-text" rows="4"></textarea>
              <div class="nca-discuss-draft-meta"></div>
              <div class="nca-steps">
                <button class="nca-btn primary nca-discuss-send">发送</button>
                <button class="nca-btn nca-discuss-skip">跳过</button>
              </div>
            </div>
            <div class="nca-progress"><span class="nca-progress-text nca-discuss-progress">未开始</span><span class="nca-bar"><i class="nca-bar-in nca-discuss-bar"></i></span></div>
            <div class="nca-discuss-items"></div>
            <div class="nca-steps">
              <button class="nca-btn nca-discuss-sample" title="从本轮已发里等距抽 1/10(至少 1 条, 最多 5 条), 拼成可复制文本给 agent 抽查">抽样</button>
              <button class="nca-btn nca-discuss-report" title="导出本轮 run 报告(JSON: sent/failed/skipped)">导出报告</button>
              <button class="nca-btn nca-discuss-copy-export" style="display:none">复制</button>
            </div>
            <div class="nca-discuss-export" style="display:none">
              <textarea class="nca-discuss-export-text" rows="6" placeholder="「抽样」或「导出报告」的内容会出现在这里, 可全选复制"></textarea>
            </div>
            <div class="nca-hint" style="line-height:1.7;padding:2px">
              默认不自动开跑。已回复过的话题不会再发(要发就点「重发上一条」)。到今日上限/目标总条数自动停;
              单条失败只记失败, 连续 3 条失败自动停; 「停止」立即生效(不再发下一条)。
              批量模式 = 连续自动 + 接地校验(正文一个话题关键词都不沾就重生成一次, 仍不沾则不发送、记进报告的待人工清单) + 跑完自动生成报告。
            </div>
          </div>
        </div>

        <!-- ===== AI陪练(自动化作答 + 判分记录) ===== -->
        <div class="nca-pane" data-pane-body="practice">
          <div class="nca-mode">
            <div class="nca-mode-head">AI陪练 · 自动作答 <span class="nca-mode-sub">默认逐题确认: 生成完一题停下来等你点「发送」</span></div>
            <div class="nca-practice-status">未开始</div>
            <label class="nca-stack" style="background:transparent;border:0;padding:0">
              <span class="nca-label-txt" style="font-size:11.5px">练习方向 <span class="nca-hint">开始时会写回页面「练习方向」输入框; 留空就用页面里已有的</span></span>
              <textarea class="nca-practice-direction" rows="2" placeholder="例如: 机会成本 / elasticity / 供给与需求"></textarea>
            </label>
            <div class="nca-row-inline" style="align-items:center">
              <button class="nca-btn nca-practice-weak" title="把页面上 span.weakKnowledgepoint 全部点上(按 topicid 去重)">用薄弱知识点</button>
              <button class="nca-btn nca-practice-clear" title="取消页面上已选的知识点">清空</button>
              <span class="nca-practice-points">已选 0 个</span>
            </div>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">最多刷</span>
              <input type="number" class="nca-practice-max" min="1" max="99" step="1">
              <span class="nca-hint">题(我们自己的上限, 到数自动点「结束陪练」)</span></label>
            <label style="display:flex;align-items:center;gap:6px;background:transparent;border:0;padding:0"><span class="nca-label-txt" style="font-size:11.5px">模式</span>
              <select class="nca-practice-mode" title="逐题确认 = 每题等你点「发送」; 连跑 = 不问直接发">
                <option value="confirm">逐题确认(默认)</option>
                <option value="auto">连跑(打开要先确认)</option>
              </select></label>
            <div class="nca-steps">
              <button class="nca-btn primary nca-practice-start">开始</button>
              <button class="nca-btn danger nca-practice-stop" style="display:none">停止</button>
              <button class="nca-btn nca-practice-skip" disabled>跳过这题</button>
              <button class="nca-btn primary nca-practice-send" disabled>发送</button>
            </div>
            <div class="nca-practice-current" style="display:none">
              <div class="nca-practice-qtype"></div>
              <div class="nca-practice-stem"></div>
              <div class="nca-practice-options"></div>
            </div>
            <div class="nca-progress"><span class="nca-progress-text nca-practice-progress">未开始</span><span class="nca-bar"><i class="nca-bar-in nca-practice-bar"></i></span></div>
            <div class="nca-practice-stats">正确 0 / 错误 0 / 跳过 0 · 正确率 —</div>
            <div class="nca-practice-items"></div>
            <div class="nca-steps">
              <button class="nca-btn nca-practice-sample" title="从本轮错题里等距抽 1/5, 拼成可复制文本">抽样错题</button>
              <button class="nca-btn nca-practice-report" title="导出本轮 run 报告(JSON: answers/skipped/failed, 不含凭据)">导出报告</button>
            </div>
            <div class="nca-practice-export" style="display:none">
              <textarea class="nca-practice-export-text" rows="6" placeholder="「抽样错题」或「导出报告」的内容会出现在这里, 可全选复制"></textarea>
            </div>
            <div class="nca-hint" style="line-height:1.7;padding:2px">
              「不会」= 点页面的「不会」并记跳过(跳过不进正确率分母)。停止 = 立刻不再发、不点继续, 已生成的题留在页面上。
              陪练页开跑时不会同时动答题/刷课流程(同一页面只允许一个操作者)。
            </div>
          </div>
        </div>

        <!-- ===== 日志 ===== -->
        <div class="nca-pane" data-pane-body="log">
          <div class="nca-log"></div>
          <div class="nca-row-inline" style="margin-top:7px;justify-content:space-between">
            <span class="nca-hint" style="color:var(--nca-fg-3);font-size:11px">面板日志(最近 400 条)</span>
            <button class="nca-copy-log" title="把日志复制到剪贴板, 粘给 agent 排障">复制日志</button>
          </div>
        </div>
      </div>
      <div class="nca-statusbar">
        <span class="nca-chip nca-chip-bridge"><i class="nca-led"></i><span class="nca-bridge-mini">桥 · 未检测</span></span>
        <span class="nca-chip nca-chip-course"><i class="nca-led"></i><span class="nca-course-mini">刷课 · 未运行</span></span>
        <span class="nca-spacer"></span>
        <span class="nca-hint" style="color:var(--nca-fg-3)">v${VERSION}</span>
      </div>`;
    this.root = host;
    this.bindEvents();
    this.applyStoredConfig();
    this.log("面板已挂载; 脚本加载成功", "success");
  }

  bindEvents() {
    const head = this.root.querySelector(".nca-head");
    head.addEventListener("mousedown", this.startDrag.bind(this));
    const minBtn = this.root.querySelector(".nca-min");
    if (minBtn) minBtn.addEventListener("click", () => this.hide());
    const colBtn = this.root.querySelector(".nca-collapse");
    if (colBtn) colBtn.addEventListener("click", (e) => this.toggleCollapse(e.currentTarget));
    this.root.querySelectorAll(".nca-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.root.querySelectorAll(".nca-tab").forEach((b) => b.classList.toggle("on", b === btn));
        const pane = btn.dataset.pane;
        this.root.querySelectorAll("[data-pane-body]").forEach((p) => p.classList.toggle("on", p.dataset.paneBody === pane));
      });
    });

    // 所有绑定都容忍元素缺失(布局会演进, 缺元素不该把整个面板搞崩)
    const on = (sel, ev, fn) => {
      const el = this.root.querySelector(sel);
      if (el) el.addEventListener(ev, fn);
      return el;
    };

    const applyThreshold = (v, echo) => {
      const n = Math.min(100, Math.max(0, Number(v) || 0));
      const num = this.root.querySelector(".nca-threshold");
      const range = this.root.querySelector(".nca-threshold-range");
      if (num) num.value = String(n);
      if (range) range.value = String(n);
      setSimilarityThreshold(n);
      this.saveConfig({ threshold: n });
      if (echo) this.log(`相似度阈值设为 ${n}%`, "primary");
    };
    on(".nca-threshold", "change", (e) => applyThreshold(e.target.value, true));
    on(".nca-threshold-range", "input", (e) => applyThreshold(e.target.value, false));

    const rateInput = on(".nca-rate", "change", (e) => {
      const r = Math.min(2, Math.max(1, Number(e.target.value) || 1.5));
      e.target.value = String(r);
      this.saveConfig({ courseRate: r });
      this.log(`刷课倍速设为 ${r}x`, "primary");
      this.onCourseRate && this.onCourseRate(r);
    });

    const autoSub = on(".nca-autosubmit", "change", (e) => {
      this.saveConfig({ autoSubmit: e.target.checked });
      this.log(e.target.checked ? `已开答完自动提交(阈值 ${this.getSubmitRate()}%)` : "已关答完自动提交", "primary");
    });
    const autoNext = on(".nca-course-autonext", "change", (e) => {
      this.saveConfig({ courseAutoNext: e.target.checked });
    });

    on(".nca-submitrate", "change", (e) => {
      const rateIn = e.target;
      const v = Math.min(100, Math.max(0, Number(rateIn.value) || 85));
      rateIn.value = String(v);
      this.saveConfig({ submitRate: v });
      this.log(`自动提交阈值设为 ${v}%`, "primary");
    });

    // 半自动答题: 三步按钮(由 runtime 注入 onParse/onAskAll/onFillAll 与逐题回调)
    const w = (sel, fn) => {
      const el = this.root.querySelector(sel);
      if (el && fn) el.addEventListener("click", () => fn());
    };
    w(".nca-parse", () => this.onParse && this.onParse());
    w(".nca-ask", () => this.onAskAll && this.onAskAll());
    w(".nca-fill", () => this.onFillAll && this.onFillAll());
    w(".nca-stop", () => this.onStopAnswer && this.onStopAnswer());
    on(".nca-autoanswer", "change", (e) => {
      this.saveConfig({ autoAnswer: e.target.checked });
      this.log(e.target.checked ? "已开「全自动答题」(不稳定, 慎用)" : "已切回半自动答题(逐步确认)", e.target.checked ? "warning" : "primary");
      // 即时生效: runtime 收到后立刻开跑 / 立刻刹车(以前只在页面加载时看一眼)
      this.onAutoAnswerChange && this.onAutoAnswerChange(e.target.checked);
    });

    // AI助教: 三个按钮 + 清单/理由/阈值入 GM 存储
    on(".nca-tutor-preview", "click", () => this.onTutorPreview && this.onTutorPreview());
    on(".nca-tutor-start", "click", () => this.onTutorStart && this.onTutorStart());
    on(".nca-tutor-stop", "click", () => this.onTutorStop && this.onTutorStop());
    on(".nca-tutor-list", "change", (e) => this.saveConfig({ tutorList: e.target.value }));
    on(".nca-tutor-list", "input", (e) => {
      this.tutorListDraft = e.target.value;
      this.saveConfig({ tutorList: e.target.value });
    });
    on(".nca-tutor-praise", "change", (e) => this.saveConfig({ tutorPraise: e.target.value }));
    on(".nca-tutor-cai-reason", "change", (e) => this.saveConfig({ tutorCriticize: e.target.value }));
    on(".nca-tutor-minchars", "change", (e) => {
      const v = Math.max(0, Math.min(5000, Number(e.target.value) || 0));
      e.target.value = String(v);
      this.saveConfig({ tutorMinChars: v });
      this.log(`AI助教: 回复少于 ${v} 字判踩`, "primary");
    });

    // 讨论区: 参数写回 GM 存储(下次开页不变); 开始/停止/发送/跳过/重发全交给 runtime
    on(".nca-discuss-start", "click", () => this.onDiscussStart && this.onDiscussStart());
    on(".nca-discuss-stop", "click", () => this.onDiscussStop && this.onDiscussStop());
    on(".nca-discuss-send", "click", () => this.onDiscussSend && this.onDiscussSend());
    on(".nca-discuss-skip", "click", () => this.onDiscussSkip && this.onDiscussSkip());
    on(".nca-discuss-resend", "click", () => this.onDiscussResend && this.onDiscussResend());
    on(".nca-discuss-sample", "click", () => this.onDiscussSample && this.onDiscussSample());
    on(".nca-discuss-report", "click", () => this.onDiscussReport && this.onDiscussReport());

    // AI陪练: 参数写回 GM 存储; 开始/停止/发送/跳过/知识点交给 runtime
    on(".nca-practice-start", "click", () => this.onPracticeStart && this.onPracticeStart());
    on(".nca-practice-stop", "click", () => this.onPracticeStop && this.onPracticeStop());
    on(".nca-practice-send", "click", () => this.onPracticeSend && this.onPracticeSend());
    on(".nca-practice-skip", "click", () => this.onPracticeSkip && this.onPracticeSkip());
    on(".nca-practice-weak", "click", () => this.onPracticeWeak && this.onPracticeWeak());
    on(".nca-practice-clear", "click", () => this.onPracticeClear && this.onPracticeClear());
    on(".nca-practice-report", "click", () => this.onPracticeReport && this.onPracticeReport());
    on(".nca-practice-sample", "click", () => this.onPracticeSample && this.onPracticeSample());
    on(".nca-practice-direction", "change", (e) => this.saveConfig({ practiceDirection: e.target.value }));
    on(".nca-practice-max", "change", (e) => {
      const v = Math.min(99, Math.max(1, Number(e.target.value) || 10));
      e.target.value = String(v);
      this.saveConfig({ practiceMax: v });
    });
    on(".nca-practice-mode", "change", (e) => {
      // 连跑 = 不再逐题确认, 错一次就是真发出去 —— 跟讨论区「连续自动」一样先确认一次
      let ok = true;
      if (e.target.value === "auto") {
        try {
          ok = typeof confirm !== "function" || confirm("「连跑」会自己一题接一题地作答, 不再等你点「发送」。\n到「最多刷 N 题」自动停。确定要开?");
        } catch (err) {
          ok = false;
        }
      }
      if (!ok) {
        e.target.value = "confirm";
        this.log("已取消「连跑」: 仍然是逐题确认", "primary");
        return;
      }
      this.saveConfig({ practiceMode: e.target.value });
      this.log(e.target.value === "auto" ? "AI陪练: 连跑模式(到上限自动停)" : "AI陪练: 逐题确认", e.target.value === "auto" ? "warning" : "primary");
    });
    on(".nca-discuss-copy-export", "click", () => this.copyDiscussExport());
    on(".nca-discuss-postmode", "change", (e) => {
      const mode = normalizePostMode(e.target.value);
      e.target.value = mode;
      this.saveConfig({ discussPostMode: mode });
      this.log(mode === "ui" ? "发帖通道: 页面 UI(打开话题页点发表)" : "发帖通道: 接口 API(实测中文会变成等长问号, 只在排查时用)", mode === "ui" ? "primary" : "warning");
    });
    on(".nca-discuss-batch", "change", (e) => {
      // 批量模式 = 不再逐条确认 —— 跟「连续自动」一样, 打开必须先确认一次
      let ok = true;
      if (e.target.checked) {
        try {
          ok =
            typeof confirm !== "function" ||
            confirm("「批量模式」会自己跑: 不经你确认按间隔发送, 到目标/上限自动停。\n每条生成完先做接地校验(不沾话题词就不发), 跑完出一份报告。确定要开?");
        } catch (err) {
          ok = false;
        }
      }
      if (!ok) {
        e.target.checked = false;
        this.log("已取消「批量模式」", "primary");
        return;
      }
      this.saveConfig({ discussBatch: e.target.checked });
      this.log(e.target.checked ? "已开「批量模式」: 自驱跑完 + 接地校验 + run 报告" : "已关「批量模式」", e.target.checked ? "warning" : "primary");
    });
    on(".nca-discuss-auto", "change", (e) => {
      // 连续自动 = 不再逐条确认, 错一次的代价是真发出去 —— 打开必须二次确认
      let ok = true;
      if (e.target.checked) {
        try {
          ok = typeof confirm !== "function" || confirm("打开「连续自动」后, 生成的正文不再等你确认, 会按间隔直接发送。\n只看得到日志, 来不及改。确定要开?");
        } catch (err) {
          ok = false;
        }
      }
      if (!ok) {
        e.target.checked = false;
        this.log("已取消「连续自动」: 仍然是逐条确认", "primary");
        return;
      }
      this.saveConfig({ discussAuto: e.target.checked });
      this.log(e.target.checked ? "已开「连续自动」: 不停顿直接发" : "已切回逐条确认(生成完停住)", e.target.checked ? "warning" : "primary");
    });
    const numCfg = (sel, key, lo, hi, dflt) => {
      on(sel, "change", (e) => {
        const raw = Number(e.target.value);
        const v = Math.min(hi, Math.max(lo, Number.isFinite(raw) && raw > 0 ? raw : dflt));
        e.target.value = String(v);
        this.saveConfig({ [key]: v });
      });
    };
    numCfg(".nca-discuss-total", "discussTotal", 1, 999, DISCUSS_DEFAULTS.targetTotal);
    numCfg(".nca-discuss-daily", "discussDaily", 1, 99, DISCUSS_DEFAULTS.dailyLimit);
    numCfg(".nca-discuss-iv-min", "discussIvMin", 0, 3600, DISCUSS_DEFAULTS.intervalMinSec);
    numCfg(".nca-discuss-iv-max", "discussIvMax", 0, 3600, DISCUSS_DEFAULTS.intervalMaxSec);
    numCfg(".nca-discuss-minchars", "discussMinChars", 10, 1000, DISCUSS_DEFAULTS.minChars);
    numCfg(".nca-discuss-maxchars", "discussMaxChars", 10, 2000, DISCUSS_DEFAULTS.maxChars);

    on(".nca-course", "click", () => {
      this.courseOn = !this.courseOn;
      this.setCourseOn(this.courseOn);
      this.onCourseToggle && this.onCourseToggle(this.courseOn);
    });
    on(".nca-copy-log", "click", () => this.copyLog());

    // 双击顶栏 = 折叠
    head.addEventListener("dblclick", (e) => {
      if (e.target.closest(".nca-icon-btn")) return;
      this.toggleCollapse();
    });
  }

  toggleCollapse(btn) {
    if (!this.root) return;
    const collapsed = this.root.classList.toggle("nca-collapsed");
    const b = btn || this.root.querySelector(".nca-collapse");
    if (b) b.textContent = collapsed ? "▸" : "▾";
    this.saveConfig({ collapsed });
  }

  startDrag(e) {
    if (e.target.closest(".nca-icon-btn") || e.target.closest(".nca-min")) return;
    const rect = this.root.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    this.root.style.transition = "none";
    const move = (ev) => {
      this.root.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - offX))}px`;
      this.root.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY))}px`;
      this.root.style.right = "auto";
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      try {
        const r = this.root.getBoundingClientRect();
        this.saveConfig({ pos: { x: Math.round(r.left), y: Math.round(r.top) } });
      } catch (err) {}
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }

  hide() {
    if (!this.root) return;
    this.root.style.display = this.root.style.display === "none" ? "flex" : "none";
  }

  /** 追加一条日志(保留 400 条上限) */
  log(message, type) {
    if (!this.root) return;
    const box = this.root.querySelector(".nca-log");
    if (!box) return;
    const row = document.createElement("div");
    row.className = "nca-row";
    const time = new Date().toTimeString().slice(0, 8);
    const t = document.createElement("span");
    t.className = "nca-t";
    t.textContent = time;
    const m = document.createElement("span");
    m.className = `nca-m${type ? " " + type : ""}`;
    m.textContent = String(message);
    row.append(t, m);
    box.appendChild(row);
    while (box.childElementCount > 400) box.removeChild(box.firstElementChild);
    box.scrollTop = box.scrollHeight;
    this.logCount++;
    const c = this.root.querySelector(".nca-log-count");
    if (c) c.textContent = String(box.childElementCount);
    this.logFn(message, type);
  }

  /** 把当前日志整段复制到剪贴板(排障用: 面板被截断时直接粘给 agent) */
  async copyLog() {
    const box = this.root && this.root.querySelector(".nca-log");
    if (!box) return "";
    const text = Array.from(box.children)
      .map((d) => d.textContent.trim())
      .join("\n");
    const head = `[网课答题助手] ${location.href}\n${new Date().toLocaleString()}\n---- 面板日志(${box.childElementCount} 条) ----\n`;
    const payload = head + text;
    let okCopy = false;
    try {
      if (gm.setClipboard) {
        gm.setClipboard(payload, "text");
        okCopy = true;
      }
    } catch (e) {}
    if (!okCopy) {
      try {
        await navigator.clipboard.writeText(payload);
        okCopy = true;
      } catch (e) {}
    }
    if (!okCopy) {
      try {
        const ta = document.createElement("textarea");
        ta.value = payload;
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        okCopy = document.execCommand("copy");
        ta.remove();
      } catch (e) {}
    }
    if (!okCopy) this.showLogBox(payload);
    if (!this.root) return payload;
    const btn = this.root.querySelector(".nca-copy-log");
    if (btn) {
      const old = btn.dataset.old || btn.textContent;
      btn.dataset.old = old;
      btn.textContent = okCopy ? "已复制 ✓" : "请手动复制";
      setTimeout(() => {
        btn.textContent = old;
      }, 1500);
    }
    return payload;
  }

  /** 复制彻底失败时: 弹一个已全选的文本框, 用户 Ctrl+C 即可 */
  showLogBox(payload) {
    try {
      const wrap = document.createElement("div");
      wrap.style.cssText =
        "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:100099;background:#fff;border:1px solid #ccc;" +
        "box-shadow:0 8px 32px rgba(0,0,0,.25);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;width:640px;max-width:90vw";
      const tip = document.createElement("div");
      tip.textContent = "自动复制失败 —— 已全选,按 Ctrl+C 复制后关闭";
      tip.style.cssText = "font:12px/1.6 sans-serif;color:#c0392b";
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.style.cssText = "width:100%;height:40vh;font:12px/1.5 Consolas,monospace;resize:vertical";
      const close = document.createElement("button");
      close.textContent = "关闭";
      close.style.cssText = "align-self:flex-end;padding:3px 12px;cursor:pointer";
      close.addEventListener("click", () => wrap.remove());
      wrap.append(tip, ta, close);
      document.body.appendChild(wrap);
      ta.focus();
      ta.select();
    } catch (e) {}
  }

  /**
   * 题目列表渲染。
   * ⚠️ runner 对同一道题会回调两次(解析出时 / 拿到答案后) —— 这里按 index 复用同一行,
   * 否则列表和计数都会翻倍。
   */
  /** 兼容旧调用(答题开始时清空) */
  clearQuestions() {
    const pane = this.root && this.root.querySelector(".nca-questions");
    if (pane) pane.innerHTML = '<div class="nca-empty">正在解析题目…</div>';
    this.questions = [];
    this.answered = 0;
    this.setAnswerProgress(0, 0, "解析中…");
  }

  esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ================= 半自动答题(由 runtime 注入) ================= */

  /** 渲染一道题(带 取答案/填入 小按钮)。question.__ncaIdx 由 runtime 标注 */
  renderQuestionItem(q, index) {
    const pane = this.root.querySelector(".nca-questions");
    if (!pane) return null;
    q.__ncaIdx = index;
    let row = pane.querySelector(`.nca-q[data-idx="${index}"]`);
    if (!row) {
      // 解析成功后第一道题要顶掉「点「① 解析题目」开始」那个占位 —— 以前它一直挂在列表第一位
      const empty = pane.querySelector(".nca-empty");
      if (empty) empty.remove();
      row = document.createElement("div");
      row.className = "nca-q pending";
      row.dataset.idx = String(index);
      pane.appendChild(row);
    }
    const okAns = !!(q.answer && q.answer.length);
    const typeName = ({ 0: "单选", 1: "多选", 2: "填空", 3: "判断", 4: "简答" })[String(q.type)] || "题目";
    row.classList.toggle("pending", !okAns);
    row.innerHTML =
      `<div class="t"><span class="nca-badge">${this.esc(typeName)}</span>${this.esc(q.title || "")}</div>` +
      `<div class="${okAns ? "a" : "e"}"><span class="nca-ans-label">${okAns ? "答案" : "状态"}</span>${this.esc((q.answer || []).join("；") || "待取答案")}</div>` +
      `<div class="nca-qact">
         <button class="nca-btn nca-qask">取答案</button>
         <button class="nca-btn nca-qfill"${okAns ? "" : " disabled"}>填入</button>
       </div>`;
    row.querySelector(".nca-qask").addEventListener("click", () => this.onAskOne && this.onAskOne(index));
    row.querySelector(".nca-qfill").addEventListener("click", () => this.onFillOne && this.onFillOne(index));
    // 拿到答案的是最后一行 → 顶着看(行是复用的, 所以用 DOM 里的行数而不是 this.questions)
    if (okAns && index === pane.childElementCount - 1) pane.scrollTop = pane.scrollHeight;
    return row;
  }

  setAnswerProgress(done, total, text) {
    if (!this.root) return;
    const t = this.root.querySelector('[data-pane-body="answer"] .nca-progress-text');
    const bar = this.root.querySelector('[data-pane-body="answer"] .nca-bar-in');
    if (t) t.textContent = text || `${done}/${total}`;
    if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    const c = this.root.querySelector(".nca-q-count");
    if (c) c.textContent = total ? `${done}/${total}` : "0";
  }

  setCourseProgress(text, pct) {
    if (!this.root) return;
    const t = this.root.querySelector(".nca-course-progress");
    if (t) t.textContent = String(text || "").slice(0, 46);
    const bar = this.root.querySelector(".nca-course-bar");
    if (bar && Number.isFinite(pct)) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    const c = this.root.querySelector(".nca-course-count");
    if (c) c.textContent = Number.isFinite(pct) ? `${Math.round(pct)}%` : "—";
  }

  /** 题目区清空(重新解析时) */
  resetQuestions() {
    const pane = this.root && this.root.querySelector(".nca-questions");
    if (pane) pane.innerHTML = '<div class="nca-empty">点「① 解析题目」开始</div>';
    this.questions = [];
    this.setAnswerProgress(0, 0, "未开始");
  }

  /** 答题桥健康状态(由 runtime 探活后调用) —— 只在底部状态栏显示一处 */
  setBridge(ok) {
    this.bridgeOk = ok;
    if (!this.root) return;
    const text = ok ? "答题桥 · 已连接" : "答题桥 · 未连接";
    const mini = this.root.querySelector(".nca-bridge-mini");
    if (mini) mini.textContent = text;
    const chip = this.root.querySelector(".nca-chip-bridge");
    if (chip) {
      chip.classList.toggle("ok", !!ok);
      chip.classList.toggle("bad", !ok);
      chip.title = ok ? "已连上 127.0.0.1:30142, 可以答题" : "桥没启动: 双击 网课答题助手 文件夹里的「启动答题桥.cmd」";
    }
  }

  /**
   * 一轮答题是否进行中(由 runtime 在 startAnswerRun/finishAnswerRun 调用)。
   * 职责: 跑起来时三枚步骤按钮变忙、露出「停止」; 跑完/停下就还原。
   * 与 setAnswerProgress 分开: 进度是"做到第几题", 这个是"还有没有在跑"。
   */
  setAnswerRunning(running) {
    const on = !!running;
    this.answerRunning = on;
    if (!this.root) return;
    [".nca-parse", ".nca-ask", ".nca-fill"].forEach((sel) => {
      const btn = this.root.querySelector(sel);
      if (!btn) return;
      btn.classList.toggle("busy", on);
      btn.disabled = on; // 跑着的时候别再叠一轮
    });
    const stop = this.root.querySelector(".nca-stop");
    if (stop) stop.style.display = on ? "" : "none";
  }

  /**
   * 把「全自动答题」勾选框拨到指定状态(不触发 change → 不会反过来再喂 runtime)。
   * runtime 主动停车时用(例如点了「停止」), 免得下次打开页面又自己跑。
   */
  setAutoAnswer(on) {
    const cb = this.root && this.root.querySelector(".nca-autoanswer");
    if (!cb) return;
    cb.checked = !!on;
    this.saveConfig({ autoAnswer: !!on });
  }

  /** 刷新刷课按钮/状态文案 */
  setCourseOn(on) {
    this.courseOn = !!on;
    if (!this.root) return;
    const btn = this.root.querySelector(".nca-course");
    if (btn) {
      btn.textContent = on ? "停止刷课" : "开始刷课";
      btn.classList.toggle("danger", !!on);
      btn.classList.toggle("primary", !on);
    }
    this.setCourseState(on ? "运行中…" : "未运行");
  }

  setCourseState(text) {
    if (!this.root) return;
    const s = String(text || "");
    const el = this.root.querySelector(".nca-course-state");
    if (el) el.textContent = s.slice(0, 40);
    const mini = this.root.querySelector(".nca-course-mini");
    if (mini) mini.textContent = `刷课 · ${s.slice(0, 18)}`;
    // 两个状态芯片(面板里的 + 底部状态栏的)共用同一套灯色
    const running = /运行|扫描|进入|分支|等待/.test(s);
    const finished = !running && /完成|结束/.test(s);
    [".nca-course-chip", ".nca-chip-course"].forEach((sel) => {
      const chip = this.root.querySelector(sel);
      if (!chip) return;
      chip.classList.toggle("busy", running);
      chip.classList.toggle("ok", finished);
    });
  }

  /* ================= AI助教(一题一会话 + 自动评价) ================= */

  /** 读当前配置: 清单原文 / 赞理由 / 踩理由 / 字数阈值 */
  getTutorConfig() {
    const q = (sel) => (this.root && this.root.querySelector(sel)) || null;
    const listEl = q(".nca-tutor-list");
    const praiseEl = q(".nca-tutor-praise");
    const caiEl = q(".nca-tutor-cai-reason");
    const minEl = q(".nca-tutor-minchars");
    const minChars = Number(minEl && minEl.value);
    return {
      list: listEl ? String(listEl.value || "") : String(this.tutorListDraft || ""),
      praise: (praiseEl && praiseEl.value) || "",
      criticize: (caiEl && caiEl.value) || "",
      minChars: Number.isFinite(minChars) ? minChars : 300,
    };
  }

  /** 一轮 AI助教 是否在跑: 开始/预览变忙, 停止按钮露出来 */
  setTutorRunning(running) {
    const on = !!running;
    this.tutorRunning = on;
    if (!this.root) return;
    [".nca-tutor-preview", ".nca-tutor-start"].forEach((sel) => {
      const btn = this.root.querySelector(sel);
      if (!btn) return;
      btn.classList.toggle("busy", on);
      btn.disabled = on;
    });
    const stop = this.root.querySelector(".nca-tutor-stop");
    if (stop) stop.style.display = on ? "" : "none";
  }

  setTutorProgress(done, total, text) {
    if (!this.root) return;
    const t = this.root.querySelector(".nca-tutor-progress");
    if (t) t.textContent = String(text || `${done}/${total}`);
    const bar = this.root.querySelector(".nca-tutor-bar");
    if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    const c = this.root.querySelector(".nca-tutor-count");
    if (c) c.textContent = total ? `${done}/${total}` : "0";
  }

  /** 按清单铺行(预览/开始时调), 每题一行状态 */
  resetTutorItems(items) {
    const box = this.root && this.root.querySelector(".nca-tutor-items");
    if (!box) return;
    box.innerHTML = "";
    (items || []).forEach((q, i) => {
      const row = document.createElement("div");
      row.className = "nca-tutor-item";
      row.dataset.idx = String(i);
      row.title = String(q || "");
      const st = document.createElement("span");
      st.className = "nca-tutor-st";
      st.textContent = "待发";
      const txt = document.createElement("span");
      txt.className = "nca-tutor-q";
      txt.textContent = String(q || "");
      row.append(st, txt);
      box.appendChild(row);
    });
    if (!(items || []).length) box.innerHTML = '<div class="nca-empty">清单为空: 一行一题</div>';
    this.setTutorProgress(0, (items || []).length, (items || []).length ? `待发 0/${items.length}` : "未开始");
  }

  /** 更新某题状态: 待发 / 已提问 / 已回复 / 已评价 / 失败[原因] */
  renderTutorItem(index, status, extra = {}) {
    const box = this.root && this.root.querySelector(".nca-tutor-items");
    if (!box) return;
    let row = box.querySelector(`.nca-tutor-item[data-idx="${index}"]`);
    if (!row) {
      const empty = box.querySelector(".nca-empty");
      if (empty) empty.remove();
      row = document.createElement("div");
      row.className = "nca-tutor-item";
      row.dataset.idx = String(index);
      row.innerHTML = '<span class="nca-tutor-st"></span><span class="nca-tutor-q"></span>';
      box.appendChild(row);
    }
    box.querySelectorAll(".nca-tutor-item").forEach((r) => r.classList.toggle("cur", r === row));
    const st = row.querySelector(".nca-tutor-st");
    const note = extra && extra.note ? `(${extra.note})` : "";
    if (st) st.textContent = String(status || "") + note;
    if (extra && extra.chars) row.dataset.chars = String(extra.chars);
    if (extra && extra.verdict) row.dataset.verdict = extra.verdict;
    row.classList.toggle("ok", status === "已评价");
    row.classList.toggle("bad", status === "失败");
    row.scrollIntoView && row.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- 讨论区 ---------------- */

  /** 讨论区参数(未挂载时返回默认值, 方便单测/未就绪时调用) */
  getDiscussConfig() {
    const q = (sel) => (this.root && this.root.querySelector(sel)) || null;
    const num = (sel, dflt) => {
      const el = q(sel);
      const v = Number(el && el.value);
      return Number.isFinite(v) && v > 0 ? v : dflt;
    };
    const d = DISCUSS_DEFAULTS;
    const total = num(".nca-discuss-total", d.targetTotal);
    const daily = num(".nca-discuss-daily", d.dailyLimit);
    const ivMin = Math.max(0, Number((q(".nca-discuss-iv-min") || {}).value) || d.intervalMinSec);
    const ivMax = Math.max(ivMin, Number((q(".nca-discuss-iv-max") || {}).value) || d.intervalMaxSec);
    const minChars = num(".nca-discuss-minchars", d.minChars);
    const maxChars = Math.max(minChars, Number((q(".nca-discuss-maxchars") || {}).value) || d.maxChars);
    const autoEl = q(".nca-discuss-auto");
    const batchEl = q(".nca-discuss-batch");
    const modeEl = q(".nca-discuss-postmode");
    return {
      targetTotal: total,
      dailyLimit: daily,
      intervalMinSec: ivMin,
      intervalMaxSec: ivMax,
      minChars,
      maxChars,
      auto: !!(autoEl && autoEl.checked),
      batch: !!(batchEl && batchEl.checked),
      postMode: normalizePostMode(modeEl && modeEl.value),
    };
  }

  /** 状态行: bbsid / courseId / classId(缺东西时用 bad 样式, 不静默) */
  setDiscussStatus(text, bad) {
    if (!this.root) return;
    const el = this.root.querySelector(".nca-discuss-status");
    if (!el) return;
    el.textContent = String(text || "");
    el.classList.toggle("bad", !!bad);
  }

  /** 今日/累计已发 */
  setDiscussCounts(today, total) {
    if (!this.root) return;
    const el = this.root.querySelector(".nca-discuss-counts");
    if (el) el.textContent = `今日 ${Number(today) || 0} / 累计 ${Number(total) || 0}`;
  }

  /** 一轮是否在跑: 开始变忙、停止露出来、草稿区收起 */
  setDiscussRunning(running) {
    const on = !!running;
    this.discussRunning = on;
    if (!this.root) return;
    const start = this.root.querySelector(".nca-discuss-start");
    if (start) {
      start.classList.toggle("busy", on);
      start.disabled = on;
    }
    const stop = this.root.querySelector(".nca-discuss-stop");
    if (stop) stop.style.display = on ? "" : "none";
    if (!on) this.clearDiscussDraft();
  }

  setDiscussProgress(done, total, text) {
    if (!this.root) return;
    const t = this.root.querySelector(".nca-discuss-progress");
    if (t) t.textContent = String(text || `${done}/${total}`);
    const bar = this.root.querySelector(".nca-discuss-bar");
    if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    const c = this.root.querySelector(".nca-discuss-count");
    if (c) c.textContent = total ? `${done}/${total}` : "0";
  }

  /** 按话题列表铺行(开始前调), 每行一个话题 */
  resetDiscussItems(topics) {
    const box = this.root && this.root.querySelector(".nca-discuss-items");
    if (!box) return;
    box.innerHTML = "";
    (topics || []).forEach((t) => {
      const row = document.createElement("div");
      row.className = "nca-discuss-item";
      row.dataset.uuid = String((t && t.uuid) || "");
      row.title = String((t && t.title) || "");
      const st = document.createElement("span");
      st.className = "nca-discuss-st";
      st.textContent = "待处理";
      const txt = document.createElement("span");
      txt.className = "nca-discuss-q";
      txt.textContent = String((t && t.title) || "");
      row.append(st, txt);
      box.appendChild(row);
    });
    if (!(topics || []).length) box.innerHTML = '<div class="nca-empty">话题列表为空: 先打开本课程的讨论区列表页</div>';
  }

  /** 更新某个话题的状态行 */
  renderDiscussItem(uuid, status, extra = {}) {
    const box = this.root && this.root.querySelector(".nca-discuss-items");
    if (!box) return;
    const key = String(uuid || "");
    let row = key ? box.querySelector(`.nca-discuss-item[data-uuid="${key}"]`) : null;
    if (!row) {
      const empty = box.querySelector(".nca-empty");
      if (empty) empty.remove();
      row = document.createElement("div");
      row.className = "nca-discuss-item";
      row.dataset.uuid = key;
      row.innerHTML = '<span class="nca-discuss-st"></span><span class="nca-discuss-q"></span>';
      box.appendChild(row);
    }
    if (extra && extra.title) {
      row.title = String(extra.title);
      const q = row.querySelector(".nca-discuss-q");
      if (q) q.textContent = String(extra.title);
    }
    box.querySelectorAll(".nca-discuss-item").forEach((r) => r.classList.toggle("cur", r === row));
    const st = row.querySelector(".nca-discuss-st");
    const note = extra && extra.note ? `(${extra.note})` : "";
    if (st) st.textContent = String(status || "") + note;
    row.classList.toggle("ok", /已发送/.test(String(status || "")));
    row.classList.toggle("bad", /失败|不合格/.test(String(status || "")));
    row.scrollIntoView && row.scrollIntoView({ block: "nearest" });
  }

  /** 逐条确认: 把草稿摆到面板里(正文可改, 「发送」时用面板里的文本) */
  showDiscussDraft(draft) {
    const d = draft || {};
    this.discussDraft = { uuid: String(d.uuid || ""), title: String(d.title || "") };
    if (!this.root) return;
    const box = this.root.querySelector(".nca-discuss-draft");
    const title = this.root.querySelector(".nca-discuss-draft-title");
    const text = this.root.querySelector(".nca-discuss-draft-text");
    const meta = this.root.querySelector(".nca-discuss-draft-meta");
    if (title) title.textContent = `草稿 · ${this.discussDraft.title}`;
    if (text) text.value = String(d.text || "");
    if (meta) meta.textContent = `${Number(d.chars) || 0} 字 · 确认后点「发送」; 不想发就点「跳过」`;
    if (box) box.style.display = "";
  }

  /** 当前草稿正文(用户可能改过) */
  getDiscussDraftText() {
    if (!this.root) return "";
    const el = this.root.querySelector(".nca-discuss-draft-text");
    return el ? String(el.value || "") : "";
  }

  clearDiscussDraft() {
    this.discussDraft = null;
    if (!this.root) return;
    const box = this.root.querySelector(".nca-discuss-draft");
    if (box) box.style.display = "none";
  }

  /**
   * 把「抽样」/「导出报告」的文本摆进可复制文本框(默认已全选, Ctrl+C 就能贴给 agent)。
   * 纯本地拼接 —— 不调模型、不花 token。
   */
  showDiscussExport(text, hint) {
    const payload = String(text || "");
    if (this.root) {
      const box = this.root.querySelector(".nca-discuss-export");
      const ta = this.root.querySelector(".nca-discuss-export-text");
      const copy = this.root.querySelector(".nca-discuss-copy-export");
      if (ta) {
        ta.value = payload;
        try {
          ta.focus();
          ta.select();
        } catch (e) {
          /* 选中失败不影响展示 */
        }
      }
      if (box) box.style.display = "";
      if (copy) copy.style.display = "";
    }
    if (hint) this.log(hint, "primary");
    return payload;
  }

  /** 复制导出框里的内容(优先 GM 剪贴板, 再退浏览器剪贴板, 最后弹全选框) */
  async copyDiscussExport() {
    const ta = this.root && this.root.querySelector(".nca-discuss-export-text");
    const payload = ta ? String(ta.value || "") : "";
    if (!payload) return "";
    let okCopy = false;
    try {
      if (gm.setClipboard) {
        gm.setClipboard(payload, "text");
        okCopy = true;
      }
    } catch (e) {
      /* 落到下面 */
    }
    if (!okCopy) {
      try {
        await navigator.clipboard.writeText(payload);
        okCopy = true;
      } catch (e) {
        /* 落到下面 */
      }
    }
    if (!okCopy) this.showLogBox(payload);
    const btn = this.root && this.root.querySelector(".nca-discuss-copy-export");
    if (btn) {
      const old = btn.dataset.old || btn.textContent;
      btn.dataset.old = old;
      btn.textContent = okCopy ? "已复制 ✓" : "请手动复制";
      setTimeout(() => {
        btn.textContent = old;
      }, 1500);
    }
    return payload;
  }

  /** 是否「全自动答题」(默认关 —— 答题不稳定, 默认半自动人工把关) */
  getAutoAnswer() {
    if (!this.root) return false;
    const cb = this.root.querySelector(".nca-autoanswer");
    return cb ? !!cb.checked : false;
  }

  /** 是否答完自动提交(默认开: 用户明确要的 P1) */
  getAutoSubmit() {
    if (!this.root) return true;
    const cb = this.root.querySelector(".nca-autosubmit");
    return cb ? !!cb.checked : true;
  }

  /** 自动提交阈值(正确率 %, 默认 85) */
  getSubmitRate() {
    if (!this.root) return 85;
    const v = Number((this.root.querySelector(".nca-submitrate") || {}).value);
    return Number.isFinite(v) && v > 0 ? Math.min(100, v) : 85;
  }

  /** 当前刷课倍速 */
  getCourseRate() {
    if (!this.root) return 1.5;
    const input = this.root.querySelector(".nca-rate");
    const v = Number(input && input.value);
    return Number.isFinite(v) && v >= 1 ? Math.min(2, v) : 1.5;
  }

  /* ---------------- AI陪练 ---------------- */

  /** AI陪练参数(未挂载时给默认值) */
  getPracticeConfig() {
    const q = (sel) => (this.root && this.root.querySelector(sel)) || null;
    const ta = q(".nca-practice-direction");
    const maxEl = q(".nca-practice-max");
    const modeEl = q(".nca-practice-mode");
    const maxV = Number(maxEl && maxEl.value);
    return {
      direction: ta ? String(ta.value || "") : "",
      maxQuestions: Number.isFinite(maxV) && maxV > 0 ? Math.min(99, Math.round(maxV)) : 10,
      mode: modeEl && modeEl.value === "auto" ? "auto" : "confirm",
      useWeak: true, // 页面上已点的知识点就是「要用的」; 面板的「用薄弱知识点」只是帮你点
    };
  }

  /** 预填练习方向(只填空值, 不覆盖用户正在输的) */
  setPracticeDirection(text) {
    if (!this.root) return;
    const ta = this.root.querySelector(".nca-practice-direction");
    if (ta && !String(ta.value || "").trim()) ta.value = String(text || "");
  }

  setPracticeStatus(text, bad) {
    if (!this.root) return;
    const el = this.root.querySelector(".nca-practice-status");
    if (!el) return;
    el.textContent = String(text || "");
    el.classList.toggle("bad", !!bad);
  }

  /** 运行态: 开始变忙/禁用, 停止露出来; 结束时把待发送按钮收回去 */
  setPracticeRunning(running) {
    const on = !!running;
    this.practiceRunning = on;
    if (!this.root) return;
    const start = this.root.querySelector(".nca-practice-start");
    if (start) {
      start.classList.toggle("busy", on);
      start.disabled = on;
    }
    const stop = this.root.querySelector(".nca-practice-stop");
    if (stop) stop.style.display = on ? "" : "none";
    if (!on) this.clearPracticeCurrent();
  }

  setPracticeProgress(done, total, text) {
    if (!this.root) return;
    const t = this.root.querySelector(".nca-practice-progress");
    if (t) t.textContent = String(text || `${done}/${total}`);
    const bar = this.root.querySelector(".nca-practice-bar");
    if (bar) bar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
    const c = this.root.querySelector(".nca-practice-count");
    if (c) c.textContent = String(Number(done) || 0);
  }

  /** 统计行: 第 n 题 · 正确 x / 错误 y / 跳过 z · 正确率 p% */
  setPracticeStats(stats, index) {
    if (!this.root) return;
    const el = this.root.querySelector(".nca-practice-stats");
    if (!el) return;
    const s = stats || {};
    const acc = s.graded ? `${s.accuracy}%` : "—";
    el.textContent = `第 ${Number(index) || 0} 题 · 正确 ${Number(s.right) || 0} / 错误 ${Number(s.wrong) || 0} / 跳过 ${Number(s.skipped) || 0} · 正确率 ${acc}`;
  }

  /** 已选知识点个数 */
  setPracticePoints(n) {
    if (!this.root) return;
    const el = this.root.querySelector(".nca-practice-points");
    if (el) el.textContent = `已选 ${Number(n) || 0} 个`;
  }

  /** 把当前题摆到面板上(逐题确认时你对着它决定发送/跳过) */
  showPracticeCurrent(q) {
    if (!this.root) return;
    const box = this.root.querySelector(".nca-practice-current");
    if (!box) return;
    const type = box.querySelector(".nca-practice-qtype");
    const stem = box.querySelector(".nca-practice-stem");
    const opts = box.querySelector(".nca-practice-options");
    if (type) type.textContent = `第 ${q && q.index ? q.index : 1} 题 · ${q && q.type ? q.type : "unknown"}`;
    if (stem) stem.textContent = String((q && q.stem) || "(题干为空)");
    if (opts) {
      opts.innerHTML = "";
      for (const o of (q && q.options) || []) {
        const row = document.createElement("div");
        row.textContent = `${o.key}. ${o.text}`;
        opts.appendChild(row);
      }
    }
    box.style.display = "";
    const send = this.root.querySelector(".nca-practice-send");
    if (send) send.disabled = false;
    const skip = this.root.querySelector(".nca-practice-skip");
    if (skip) skip.disabled = false;
  }

  clearPracticeCurrent() {
    if (!this.root) return;
    const box = this.root.querySelector(".nca-practice-current");
    if (box) box.style.display = "none";
    const send = this.root.querySelector(".nca-practice-send");
    if (send) send.disabled = true;
    const skip = this.root.querySelector(".nca-practice-skip");
    if (skip) skip.disabled = true;
  }

  resetPracticeItems() {
    const box = this.root && this.root.querySelector(".nca-practice-items");
    if (box) box.innerHTML = "";
    const c = this.root && this.root.querySelector(".nca-practice-count");
    if (c) c.textContent = "0";
  }

  /** 错题表一行: 题干前 40 字 + 你的答案 + 正确答案(就地渲染, 不用弹窗) */
  /** 就地把一道题的「正确答案」补上(流式晚到的场景), 不新增节点 */
  patchPracticeItem(row) {
    const box = this.root && this.root.querySelector(".nca-practice-items");
    if (!box || !row) return false;
    const el = box.querySelector(`.nca-practice-item[data-index="${row.index}"] .nca-practice-item-meta`);
    if (!el) return false;
    el.textContent = `你的答案: ${row.answer || "(空)"} · 正确答案: ${row.correct || "(未取到)"}`;
    return true;
  }

  renderPracticeItem(row) {
    const box = this.root && this.root.querySelector(".nca-practice-items");
    if (!box || !row) return;
    const el = document.createElement("div");
    el.className = `nca-practice-item ${row.result === "wrong" ? "wrong" : row.result === "right" ? "right" : ""}`;
    el.dataset.index = String(row.index || "");
    const stem = document.createElement("div");
    stem.className = "nca-practice-item-stem";
    stem.textContent = `第${row.index}题 ${String(row.stem || "").slice(0, 40)}`;
    const meta = document.createElement("div");
    meta.className = "nca-practice-item-meta";
    meta.textContent = `你的答案: ${row.answer || "(空)"} · 正确答案: ${row.correct || "(未取到)"}`;
    el.append(stem, meta);
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  /** 导出框(与讨论区同构: 摆进文本框并全选) */
  showPracticeExport(text, hint) {
    const payload = String(text || "");
    if (this.root) {
      const box = this.root.querySelector(".nca-practice-export");
      const ta = this.root.querySelector(".nca-practice-export-text");
      if (ta) {
        ta.value = payload;
        try {
          ta.focus();
          ta.select();
        } catch (e) {
          /* 选中失败不影响展示 */
        }
      }
      if (box) box.style.display = "";
    }
    if (hint) this.log(hint, "primary");
    return payload;
  }

  saveConfig(partial) {
    const cfg = { ...readSetting(SETTING_KEY, {}), ...partial };
    writeSetting(SETTING_KEY, cfg);
  }

  applyStoredConfig() {
    if (!this.root) return;
    const cfg = readSetting(SETTING_KEY, {});
    const num = this.root.querySelector(".nca-threshold");
    const range = this.root.querySelector(".nca-threshold-range");
    if (typeof cfg.threshold === "number") {
      setSimilarityThreshold(cfg.threshold);
      if (num) num.value = String(cfg.threshold);
      if (range) range.value = String(cfg.threshold);
    } else {
      if (num) num.value = String(num.value || 85);
      if (range) range.value = String(num ? num.value : 85);
    }
    const rateInput = this.root.querySelector(".nca-rate");
    if (rateInput) rateInput.value = String(typeof cfg.courseRate === "number" ? cfg.courseRate : 1.5);
    const autoSub = this.root.querySelector(".nca-autosubmit");
    if (autoSub) autoSub.checked = cfg.autoSubmit !== false;
    const autoAns = this.root.querySelector(".nca-autoanswer");
    if (autoAns) autoAns.checked = cfg.autoAnswer === true; // 默认关(半自动)
    const autoNext = this.root.querySelector(".nca-course-autonext");
    if (autoNext) autoNext.checked = cfg.courseAutoNext !== false; // 默认开
    const subRate = this.root.querySelector(".nca-submitrate");
    if (subRate) subRate.value = String(typeof cfg.submitRate === "number" ? cfg.submitRate : 85);
    // AI助教: 清单 / 两个理由 / 判分阈值
    const tutorList = this.root.querySelector(".nca-tutor-list");
    if (tutorList) tutorList.value = typeof cfg.tutorList === "string" ? cfg.tutorList : "";
    const tutorPraise = this.root.querySelector(".nca-tutor-praise");
    if (tutorPraise) tutorPraise.value = typeof cfg.tutorPraise === "string" ? cfg.tutorPraise : AI_TUTOR_DEFAULTS.praise;
    const tutorCai = this.root.querySelector(".nca-tutor-cai-reason");
    if (tutorCai) tutorCai.value = typeof cfg.tutorCriticize === "string" ? cfg.tutorCriticize : AI_TUTOR_DEFAULTS.criticize;
    const tutorMin = this.root.querySelector(".nca-tutor-minchars");
    if (tutorMin) tutorMin.value = String(typeof cfg.tutorMinChars === "number" ? cfg.tutorMinChars : 300);
    // 讨论区: 目标/每日/间隔/字数/连续自动
    const d = DISCUSS_DEFAULTS;
    const dNum = (sel, key, dflt) => {
      const el = this.root.querySelector(sel);
      if (el) el.value = String(typeof cfg[key] === "number" ? cfg[key] : dflt);
    };
    dNum(".nca-discuss-total", "discussTotal", d.targetTotal);
    dNum(".nca-discuss-daily", "discussDaily", d.dailyLimit);
    dNum(".nca-discuss-iv-min", "discussIvMin", d.intervalMinSec);
    dNum(".nca-discuss-iv-max", "discussIvMax", d.intervalMaxSec);
    dNum(".nca-discuss-minchars", "discussMinChars", d.minChars);
    dNum(".nca-discuss-maxchars", "discussMaxChars", d.maxChars);
    const dAuto = this.root.querySelector(".nca-discuss-auto");
    if (dAuto) dAuto.checked = cfg.discussAuto === true; // 默认关(逐条确认)
    const dBatch = this.root.querySelector(".nca-discuss-batch");
    if (dBatch) dBatch.checked = cfg.discussBatch === true; // 默认关(批量自驱)
    const dMode = this.root.querySelector(".nca-discuss-postmode");
    if (dMode) dMode.value = normalizePostMode(cfg.discussPostMode); // 默认 UI
    // AI陪练: 方向/上限/模式
    const pDir = this.root.querySelector(".nca-practice-direction");
    if (pDir) pDir.value = typeof cfg.practiceDirection === "string" ? cfg.practiceDirection : "";
    const pMax = this.root.querySelector(".nca-practice-max");
    if (pMax) pMax.value = String(typeof cfg.practiceMax === "number" ? cfg.practiceMax : 10);
    const pMode = this.root.querySelector(".nca-practice-mode");
    if (pMode) pMode.value = cfg.practiceMode === "auto" ? "auto" : "confirm";
    // 位置 / 折叠状态
    if (cfg.pos && Number.isFinite(cfg.pos.x) && Number.isFinite(cfg.pos.y)) {
      this.root.style.left = `${cfg.pos.x}px`;
      this.root.style.top = `${cfg.pos.y}px`;
      this.root.style.right = "auto";
    }
    if (cfg.collapsed) {
      this.root.classList.add("nca-collapsed");
      const b = this.root.querySelector(".nca-collapse");
      if (b) b.textContent = "▸";
    }
    this.courseOn = false;
  }

  destroy() {
    if (this.host) this.host.remove();
    this.host = null;
  }
}
