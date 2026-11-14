// tenon review：本地审查台。由人在终端启动，之后在浏览器里批准、确认人工证据、归档。
// 只监听 127.0.0.1；所有地址都带启动时生成的随机令牌，令牌只打印在人的终端里。
// 与 requireHuman 一样，这不是防篡改，只防 Agent 越级。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { commitArchive, pendingTx, stageArchive } from './archive.ts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { dfOf, CHANGE_ID, DevflowError, hashFiles, listChanges, readEvents, requireChange, requireInit, reviewedFiles, withWorktreeLock, type EvidenceRecord } from './core.ts';
import { confirmEvidence, evidenceMatrix } from './evidence.ts';
import { isWaiting, listFeedback, saveFeedback } from './feedback.ts';
import { renderArchived, renderHtml } from './render.ts';
import { approve, deriveStatus, listArchived, prepareApproval, staleHours, staleText, workNode, type Status } from './status.ts';
import { finishUsage, startUsage } from './usage.ts';
import { loadChangeMeta } from './validate.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_BODY = 64 * 1024;

// 审查台上状态的中文名与颜色：薰衣草=轮到人批准，琥珀=需重新批准，红=待修复，蓝=Agent 在做，绿=可归档，灰=已结束
const STATUS: Record<Status, [label: string, color: string]> = {
  draft: ['待批准', '#828fff'],
  rebase_required: ['需重新批准', '#e3b866'],
  approved: ['已批准', '#6ea8fe'],
  applying: ['开发中', '#6ea8fe'],
  needs_fix: ['待修复', '#f0928a'],
  ready_to_archive: ['待归档', '#4cc764'],
  archived: ['已归档', '#8a8f98'],
};
const statusLabel = (s: string): string => STATUS[s as Status]?.[0] ?? s;
// 每个状态一个类，颜色放在 --st 里；页面有内容安全策略，不用行内 style 属性
const STATUS_CSS = Object.entries(STATUS).map(([s, [, c]]) => `.st-${s}{--st:${c}}`).join('');
const STATUS_PILL = 'color:var(--st,#d0d6e0);background:color-mix(in srgb,var(--st,#8a8f98) 14%,transparent);border:1px solid color-mix(in srgb,var(--st,#8a8f98) 35%,transparent);border-radius:9999px';

/** 等待人确认的人工证据（当前代码、当前批准下已记录但未确认） */
function pendingEvidence(root: string, id: string): EvidenceRecord[] {
  const events = readEvents(root, id);
  return evidenceMatrix(root, id).filter((r) => r.status === 'unconfirmed').flatMap((r) => {
    const ev = events.find((e) => e.type === 'evidence-recorded' && e.evidence_id === r.evidence_id);
    return ev?.type === 'evidence-recorded' ? [ev] : [];
  });
}

function ago(at: string | undefined): string {
  if (!at) return '—';
  const min = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return min < 60 ? `${min} 分钟前` : min < 48 * 60 ? `${Math.round(min / 60)} 小时前` : `${Math.round(min / 1440)} 天前`;
}

// 外观按 Linear 的 DESIGN.md：近黑画布、四级表面、1px 细线、唯一强调色薰衣草蓝。
// surface-1..4 与 line-2/line-3 文档未给取值，取自 Linear 的 CSS 变量。
// 选区、滚动条这些浏览器自带的部分也跟主题走
const CHROME = '::selection{background:rgb(94 106 210/.45);color:#fff}html{scrollbar-color:#34343a transparent}';
const TOKENS = `--lin-canvas:#010102;--lin-s1:#0f1011;--lin-s2:#141516;--lin-s3:#18191b;--lin-line:#23252a;--lin-line-2:#34343a;--lin-ink:#f7f8f8;--lin-ink-2:#d0d6e0;--lin-ink-3:#8a8f98;--lin-primary:#5e6ad2;--lin-primary-hover:#828fff;--lin-primary-press:#4f5bbf;--lin-focus:#5e69d1;--lin-font:Inter,"SF Pro Display",-apple-system,system-ui,"Segoe UI",Roboto,"PingFang SC",sans-serif;--lin-mono:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace`;

const SHELL = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark;${TOKENS}}
*{box-sizing:border-box}
${CHROME}
body{margin:0;background:var(--lin-canvas);color:var(--lin-ink);font:400 14px/1.5 var(--lin-font);-webkit-font-smoothing:antialiased}
a{color:var(--lin-ink);text-decoration:none}
a:hover{color:var(--lin-primary-hover)}
a:focus-visible{outline:2px solid color-mix(in srgb,var(--lin-focus) 50%,transparent);outline-offset:2px;border-radius:4px}
.nav{position:sticky;top:0;z-index:10;height:56px;display:flex;align-items:center;gap:10px;padding:0 24px;background:var(--lin-canvas);border-bottom:1px solid var(--lin-line);font-weight:500}
.mark{width:18px;height:18px;border-radius:5px;background:var(--lin-primary)}
main{max-width:1280px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:40px;font-weight:600;line-height:1.15;letter-spacing:-1px;margin:0 0 8px}
.lead{font-size:16px;letter-spacing:-.05px;color:var(--lin-ink-3);margin:0 0 32px}
.panel{background:var(--lin-s1);border:1px solid var(--lin-line);border-radius:16px;overflow-x:auto;box-shadow:inset 0 1px 0 rgb(255 255 255/.04)}
table{width:100%;border-collapse:collapse}
th{white-space:nowrap;font-size:12px;font-weight:500;color:var(--lin-ink-3);text-align:left;padding:10px 16px;background:var(--lin-s2);border-bottom:1px solid var(--lin-line)}
td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--lin-line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
tbody tr{position:relative}
tbody tr:hover{background:var(--lin-s2)}
.id::after{content:"";position:absolute;inset:0}
/* 窄屏把每行叠成两层：标题一行，工作节点一行；任务数和最后活动不显示 */
@media (max-width:640px){table,tbody{display:block}thead{display:none}tbody tr{display:grid;grid-template-columns:1fr;gap:8px;padding:14px 16px;border-bottom:1px solid var(--lin-line)}tbody tr:last-child{border-bottom:0}td{padding:0;border:0}td:nth-child(n+3){display:none}}
.id{white-space:nowrap;font-family:var(--lin-mono);font-size:13px}
.node{white-space:nowrap;display:inline-flex;align-items:center;gap:8px;font-weight:500;color:var(--lin-ink-2)}
.node::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--lin-ink-3);flex:none}
.node[data-human]{color:var(--lin-ink)}
.node[data-human]::before{background:var(--lin-primary)}
.arch{margin-top:40px}
.arch>summary{cursor:pointer;font-size:20px;font-weight:500;letter-spacing:-.3px;margin-bottom:16px}
.df-new{position:fixed;top:68px;left:50%;transform:translateX(-50%);z-index:60;font:500 14px/1.2 var(--lin-font);padding:10px 16px;border-radius:9999px;border:1px solid var(--lin-primary);background:var(--lin-primary);color:#fff;cursor:pointer;box-shadow:0 4px 16px rgb(0 0 0/.5)}
.df-new[hidden]{display:none}
.pill{display:inline-block;padding:2px 8px;font:500 12px/1.4 var(--lin-font);white-space:nowrap;${STATUS_PILL}}
${STATUS_CSS}
.muted{color:var(--lin-ink-3);font-size:12px}
.stale{color:#f2c94c;font-size:12px}
.num{color:var(--lin-ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{padding:48px 24px;text-align:center;color:var(--lin-ink-3)}
pre{white-space:pre-wrap;font:13px/1.5 var(--lin-mono);color:var(--lin-ink-2);background:var(--lin-s1);border:1px solid var(--lin-line);border-radius:12px;padding:16px 24px}
</style></head><body><header class="nav"><span class="mark"></span>Tenon 审查台</header><main>${body}</main></body></html>`;

const fingerprint = (data: unknown): string => createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);

function indexRows(root: string) {
  return listChanges(root).map((id) => {
    try {
      const st = deriveStatus(root, id);
      return { id, title: loadChangeMeta(root, id)?.title ?? '', reason: st.reason, tasks: `${st.tasks.done}/${st.tasks.total}`, node: workNode(root, id, st), last: readEvents(root, id).at(-1)?.at, stale: staleHours(root, id, st) };
    } catch (e) {
      return { id, title: '', reason: e instanceof Error ? e.message : String(e), tasks: '—', node: { label: '无法读取', human: false }, last: undefined, stale: null };
    }
  }).sort((a, b) => Number(b.node.human) - Number(a.node.human));
}

/** 已归档，最新归档的在前；没有归档时间的排最后 */
function archivedRows(root: string) {
  return listArchived(root).map((a) => {
    let title = '';
    try { title = String(parse(readFileSync(join(root, dfOf(root), 'changes', 'archive', a.id, 'change.yaml'), 'utf8'))?.title ?? ''); } catch { /* 读不到标题只显示 id */ }
    return { ...a, title };
  }).sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''));
}

/** 首页版本号：各行的节点、原因、任务数、最后活动与已归档列表，任何一个变了就提示刷新 */
const indexVersion = (root: string, rows = indexRows(root)): string =>
  fingerprint([rows.map((r) => [r.id, r.node.label, r.reason, r.tasks, r.last ?? null]), listArchived(root).map((a) => a.id)]);

/** 变更页版本号：状态、原因、节点、任务数、最后一条事件与被审内容哈希。等待进程起停太频繁，不算在内 */
function changeVersion(root: string, id: string): string {
  const st = deriveStatus(root, id);
  // 批注记录也算：发送或被 Agent 读取后提示刷新，记录面板才跟得上
  const notes = listFeedback(root, id).map((n) => [n.at, n.read]);
  return fingerprint([st.status, st.reason, workNode(root, id, st).label, st.tasks, readEvents(root, id).at(-1)?.at ?? null, hashFiles(root, reviewedFiles(root, id)), notes]);
}

function index(root: string, token: string): string {
  const rows = indexRows(root);
  const body = rows.length
    ? `<table><thead><tr><th>变更</th><th>工作节点</th><th>任务</th><th>最后活动</th></tr></thead><tbody>${rows.map((r) => `<tr>
<td><a class="id" href="/${token}/c/${r.id}">${esc(r.id)}</a><br><span class="muted">${esc(r.title)}</span></td>
<td><span class="node"${r.node.human ? ' data-human' : ''}>${esc(r.node.label)}</span><br><span class="muted">${esc(r.reason)}</span></td>
<td class="num">${r.tasks}</td><td class="num">${ago(r.last)}${r.stale === null ? '' : `<br><span class="stale">${staleText(r.stale)}</span>`}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">没有进行中的变更。</p>';
  const archived = archivedRows(root);
  const arch = archived.length
    ? `<details class="arch"><summary>已归档（${archived.length}）</summary><div class="panel"><table><thead><tr><th>变更</th><th>归档时间</th></tr></thead><tbody>${archived.map((a) => `<tr>
<td><a class="id" href="/${token}/a/${esc(a.id)}">${esc(a.id)}</a><br><span class="muted">${esc(a.title)}</span></td><td class="num">${ago(a.archived_at ?? undefined)}</td></tr>`).join('')}</tbody></table></div></details>`
    : '';
  return SHELL('Tenon 审查台', `<h1>变更</h1><p class="lead">需要你操作的变更排在前面。有新进展时页面上方会提示刷新。</p><div class="panel" data-v="${indexVersion(root, rows)}">${body}</div>${arch}
<button type="button" class="df-new" hidden>有新进展，点此刷新</button>
<script>
(() => {
  const v = document.querySelector('[data-v]').dataset.v;
  const tip = document.querySelector('.df-new');
  tip.addEventListener('click', () => location.reload());
  const timer = setInterval(async () => {
    try {
      const j = await (await fetch(location.pathname.replace(/\\/?$/, '/state'))).json();
      if (j.v !== v) { tip.hidden = false; clearInterval(timer); }
    } catch { /* 审查台停了：不提示 */ }
  }, 5000);
})();
</script>`);
}

/** 已归档变更的只读页：只有返回链接，没有操作栏、批注和状态轮询 */
const ARCHIVED_BAR = (token: string) => `${PAGE_STYLE('archived')}<style>.df-ro{${TOKENS};position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;gap:12px;align-items:center;min-height:48px;padding:8px 24px;background:var(--lin-s1);color:var(--lin-ink-3);border-top:1px solid var(--lin-line);font:400 14px/1.4 var(--lin-font)}.df-ro a{color:var(--lin-ink-3);text-decoration:none}.df-ro a:hover{color:var(--lin-ink)}body{padding-bottom:64px}</style><div class="df-ro"><a href="/${token}/">← 全部变更</a><span>已归档，只读</span></div>`;

// 只在审查台注入：把 answer-me 纸张主题的变量换成 Linear 深色；离线审查页（tenon render）不受影响。
// 用户要求保留：面板字母徽标、右侧大纲、差异与状态的红绿色、图表原有强调色。
const PAGE_STYLE = (status: Status) => `<style>
html[data-theme][data-mode]{color-scheme:dark;${TOKENS};--font-sans:var(--lin-font);--font-serif:var(--lin-font);--head-font:var(--lin-font);--font-mono:var(--lin-mono);--radius:8px;--bg:var(--lin-canvas);--paper:var(--lin-s1);--fill:var(--lin-s2);--ink:var(--lin-ink);--ink-2:var(--lin-ink-2);--ink-3:var(--lin-ink-3);--line:var(--lin-line-2);--line-2:var(--lin-line);--accent:var(--lin-primary-hover);--accent-bg:rgb(94 106 210/.16);--ok:#8cc79a;--ok-bg:#1c3122;--err:#f0928a;--err-bg:#3a1d1a;--warn:#e3b866;--warn-bg:#352a13;--head-bg:var(--lin-ink);--head-fg:var(--lin-canvas)}
${CHROME}
html[data-theme] .am-head h1{font-weight:600;letter-spacing:-.6px}
${STATUS_CSS}
/* 状态放在标题右侧，副标题那行（变更 ID · 英文状态）在审查台上隐藏；底部操作栏里有原因 */
html[data-theme] .am-sub{display:none}
html[data-theme] .am-head h1::after{content:"${STATUS[status][0]}";display:inline-block;vertical-align:middle;margin-left:12px;padding:2px 10px;font:500 13px/1.5 var(--lin-font);letter-spacing:0;${STATUS_PILL}}
html[data-theme] .am-head h1{--st:${STATUS[status][1]}}
html[data-theme] .am-panel{border-radius:12px;border-color:var(--lin-line);box-shadow:inset 0 1px 0 rgb(255 255 255/.04)}
html[data-theme] .am-panel-head h2{font-weight:500;letter-spacing:-.2px}
html[data-theme] .am-md p,html[data-theme] .am-md li,html[data-theme] .am-intro{line-height:1.6}
html[data-theme] .am-btn--reply{background:var(--lin-primary);border-color:var(--lin-primary);color:#fff}
html[data-theme] .am-btn--reply:hover{background:var(--lin-primary-press);border-color:var(--lin-primary-press);opacity:1}
html[data-theme] .am-diagram{--accent:#e59a7d;--accent-bg:#3a2219}
/* 渲染器的回复、标注模式、面板评论并入审查台的「批注」：这里只隐藏，离线审查页照旧 */
.am-btn--reply,.am-btn--remark,.am-btn--remark-clear,.am-comment,.am-comment-btn,.am-reply,.am-reply-bar,.am-remark-pop,.am-remark-hover{display:none!important}
body.am-has-reply-bar{padding-block-end:0}
.df-panel-note{margin-inline-start:auto;font:500 12px/1.2 var(--lin-font);padding:4px 10px;border-radius:6px;border:1px solid var(--lin-line-2);background:transparent;color:var(--lin-ink-2);cursor:pointer}
.df-panel-note:hover{color:var(--lin-ink);border-color:var(--lin-primary)}
/* 折叠提示「收起/展开」也靠 margin-left:auto 靠右：有批注按钮时让按钮占住右侧，提示紧跟其后 */
.am-panel-head:has(.df-panel-note)::after{margin-left:8px!important}
</style>`;

const BAR_STYLE = `<style>
/* 操作栏固定在顶部，左侧固定目录；栏高由目录脚本量出来写进 --df-bar-h（栏内按钮多时会换行） */
body{padding-top:var(--df-bar-h,64px)}
html{scroll-padding-top:calc(var(--df-bar-h,64px) + 12px)}
.df-bar,.df-dlg,.df-toc{${TOKENS};color-scheme:dark}
.df-bar{position:fixed;left:0;right:0;top:0;z-index:50;display:flex;flex-wrap:wrap;gap:12px;align-items:center;min-height:56px;padding:8px 24px;background:var(--lin-s1);color:var(--lin-ink);border-bottom:1px solid var(--lin-line);box-shadow:inset 0 -1px 0 rgb(255 255 255/.04);font:400 14px/1.4 var(--lin-font)}
/* 渲染器自带的右侧大纲由左侧目录代替 */
.am-toc{display:none!important}
.df-toc{position:fixed;left:0;top:var(--df-bar-h,64px);bottom:0;width:220px;overflow:auto;z-index:40;padding:16px 8px;background:var(--lin-canvas);border-right:1px solid var(--lin-line);font:500 13px/1.35 var(--lin-font)}
.df-toc a{display:block;padding:7px 10px;border-radius:6px;color:var(--lin-ink-2);text-decoration:none}
.df-toc a:hover{color:var(--lin-ink);background:var(--lin-s2)}
.df-toc a[aria-current=true]{color:var(--lin-ink);background:var(--lin-s3);box-shadow:inset 2px 0 0 var(--lin-primary)}
.df-toc a:focus-visible{outline:2px solid color-mix(in srgb,var(--lin-focus) 50%,transparent);outline-offset:1px}
.df-toc small{display:block;margin-top:2px;font-weight:400;font-size:12px;color:var(--lin-ink-3)}
@media (min-width:1024px){body{padding-left:236px}}
@media (max-width:1023px){.df-toc{display:none}}
.df-bar a{color:var(--lin-ink-3);text-decoration:none}
.df-bar a:hover{color:var(--lin-ink)}
.df-bar button,.df-dlg button{font:500 14px/1.2 var(--lin-font);padding:8px 14px;min-height:36px;border-radius:8px;border:1px solid var(--lin-line);background:var(--lin-s2);color:var(--lin-ink);cursor:pointer}
.df-bar button:hover,.df-dlg button:hover{border-color:var(--lin-line-2)}
.df-bar button[data-df],.df-dlg button[data-df=confirm]{background:var(--lin-primary);border-color:var(--lin-primary);color:#fff}
.df-bar button[data-df]:hover,.df-dlg button[data-df=confirm]:hover{background:var(--lin-primary-press);border-color:var(--lin-primary-press)}
.df-bar button:focus-visible,.df-dlg button:focus-visible,.df-dlg input:focus-visible{outline:2px solid color-mix(in srgb,var(--lin-focus) 50%,transparent);outline-offset:2px}
.df-state{font:500 12px/1.4 var(--lin-font);padding:2px 8px;white-space:nowrap;${STATUS_PILL}}
.df-reason{color:var(--lin-ink-3);font-size:13px;margin-left:-4px}
.df-bar button:disabled,.df-dlg button:disabled{opacity:.55;cursor:progress}
.df-msg[data-tone=err]{color:#f0928a}
${STATUS_CSS}
.df-msg{margin-left:auto;color:var(--lin-ink-2)}
.df-dlg{max-width:720px;width:90%;padding:24px;border:1px solid var(--lin-line);border-radius:12px;background:var(--lin-s1);color:var(--lin-ink);font:400 14px/1.5 var(--lin-font)}
.df-dlg::backdrop{background:rgb(0 0 0/.7)}
.df-dlg h3{margin:0 0 4px;font-size:22px;font-weight:500;letter-spacing:-.4px}
.df-dlg p{margin:0 0 16px;color:var(--lin-ink-3)}
.df-dlg input{accent-color:var(--lin-primary)}
.df-dlg label{display:block;padding:12px 0;border-top:1px solid var(--lin-line);cursor:pointer}
.df-dlg dl{margin:8px 0 0 24px;display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;font-size:13px}
.df-dlg dt{color:var(--lin-ink-3)}
.df-dlg dd{margin:0;color:var(--lin-ink-2)}
.df-dlg menu{display:flex;justify-content:flex-end;gap:8px;padding:16px 0 0;margin:0;border-top:1px solid var(--lin-line)}
.df-pin{${TOKENS};position:absolute;z-index:60;font:500 13px/1.2 var(--lin-font);padding:6px 12px;border-radius:8px;border:1px solid var(--lin-primary);background:var(--lin-primary);color:#fff;cursor:pointer;box-shadow:0 4px 16px rgb(0 0 0/.5)}
.df-pin[hidden],.df-bar [hidden]{display:none}
.df-bar .df-new{border-color:#4cc764;color:#8cc79a;background:color-mix(in srgb,#4cc764 14%,transparent)}
.df-wait{color:var(--lin-ink-3);font-size:13px}
.df-wait[data-on]{color:#8cc79a}
.df-dlg blockquote{margin:0 0 12px;padding:8px 12px;border-left:3px solid var(--lin-primary);background:var(--lin-s2);color:var(--lin-ink-2);font-size:13px;white-space:pre-wrap;max-height:160px;overflow:auto}
.df-dlg textarea{width:100%;min-height:120px;padding:10px 12px;border-radius:8px;border:1px solid var(--lin-line-2);background:var(--lin-canvas);color:var(--lin-ink);font:400 14px/1.5 var(--lin-font);resize:vertical}
.df-dlg textarea:focus-visible{outline:2px solid color-mix(in srgb,var(--lin-focus) 50%,transparent);outline-offset:2px}
.df-dlg ol{margin:0;padding:0 0 0 20px;max-height:50vh;overflow:auto}
.df-dlg li{padding:12px 0;border-top:1px solid var(--lin-line)}
.df-dlg li small{display:block;color:var(--lin-ink-3)}
.df-dlg li p{margin:4px 0;color:var(--lin-ink);white-space:pre-wrap}
.df-dlg .df-err{color:#f0928a;min-height:1.5em;margin:8px 0 0}
</style>`;

const BAR_SCRIPT = `<script>
(() => {
  const bar = document.querySelector('.df-bar');
  const msg = bar.querySelector('.df-msg');
  const dlg = document.querySelector('.df-dlg');
  const base = location.pathname.replace(/\\/$/, '');
  // 刷新前记下滚动位置和展开的面板，刷新后恢复：折叠脚本在前面已把 A–E 收起
  const viewKey = 'df-view:' + base;
  const panels = () => [...document.querySelectorAll('.am-panel[id]')];
  const reload = () => {
    try { sessionStorage.setItem(viewKey, JSON.stringify({ y: scrollY, open: panels().filter((p) => !p.classList.contains('df-closed')).map((p) => p.id) })); } catch { /* 没有 sessionStorage：照常刷新 */ }
    location.reload();
  };
  try {
    const view = JSON.parse(sessionStorage.getItem(viewKey) || 'null');
    sessionStorage.removeItem(viewKey);
    if (view) {
      for (const p of panels()) if (view.open.includes(p.id) && p.classList.contains('df-closed')) p.querySelector('.am-panel-head').click();
      requestAnimationFrame(() => scrollTo(0, view.y));
    }
  } catch { /* 记录损坏：按默认折叠显示 */ }
  const post = async (action, body, done) => {
    const btns = [...document.querySelectorAll('button[data-df]')];
    const fail = (text) => { btns.forEach((x) => { x.disabled = false; }); msg.dataset.tone = 'err'; msg.textContent = text; };
    btns.forEach((x) => { x.disabled = true; });
    delete msg.dataset.tone;
    msg.textContent = '处理中…';
    try {
      const r = await fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) return fail(j.error + (j.hint ? '（' + j.hint + '）' : ''));
      done ? done() : reload();
    } catch { fail('审查台没有响应：tenon review 还在运行吗？'); }
  };
  // 不定时整页刷新：后台查状态，变了只提示，人点了才刷新
  const tip = bar.querySelector('.df-new');
  const wait = bar.querySelector('.df-wait');
  tip.addEventListener('click', () => {
    // 有没发送的批注或对话框开着时不刷新：刷新会打断人正在写的东西
    if (dlg.open || document.documentElement.dataset.dfHold) { msg.dataset.tone = 'err'; msg.textContent = '先发送或删除没发送的批注、关掉对话框，再刷新'; return; }
    reload();
  });
  const timer = setInterval(async () => {
    try {
      const j = await (await fetch(base + '/state')).json();
      if (wait && j.waiting !== wait.hasAttribute('data-on')) {
        if (j.waiting) wait.dataset.on = ''; else delete wait.dataset.on;
        wait.textContent = j.waiting ? 'Agent 正在等待' : '没有 Agent 在等待：批注会在它下次运行 tenon wait 时送达';
      }
      if (j.v !== bar.dataset.v) { tip.hidden = false; clearInterval(timer); }
    } catch { /* 审查台停了：不提示 */ }
  }, 5000);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-df]');
    if (!b) return;
    const a = b.dataset.df;
    if (a === 'open') dlg.showModal();
    if (a === 'cancel') dlg.close();
    // 待拍板事项按顺序提交选中项的序号；没选的用建议项
    if (a === 'approve' && Number(document.documentElement.dataset.dfNotes || 0) > 0) { msg.dataset.tone = 'err'; msg.textContent = '还有没发送的批注：先发送或删除，再批准'; return; }
    if (a === 'approve') post('approve', { hash: b.dataset.hash, answers: [...document.querySelector('.am-panel').querySelectorAll('fieldset.am-ask')].map((f) => {
      const inputs = [...f.querySelectorAll('input')];
      const i = inputs.findIndex((x) => x.checked);
      return i >= 0 ? i : inputs.findIndex((x) => x.hasAttribute('data-suggested'));
    }) });
    if (a === 'confirm') { dlg.close(); post('confirm', { evidence_ids: [...dlg.querySelectorAll('input:checked')].map((x) => x.value) }); }
    // 不用浏览器原生确认框：内嵌浏览器会屏蔽它，点了没有反应。改为同一个按钮点两次
    if (a === 'archive') {
      if (b.dataset.armed) post('archive', {}, () => { location.href = bar.dataset.home; });
      else { b.dataset.armed = '1'; b.textContent = '再点一次确认归档'; msg.textContent = '归档会把规范增量合并进数据目录的 specs/，并把变更目录移到 archive'; }
    }
  });
})();
</script>`;

// 左侧目录：读每个面板的字母和标题生成链接，标题括号里的状态（如「与上次批准相同」）放第二行
const TOC_SCRIPT = `<script>
(() => {
  const root = document.documentElement;
  const bar = document.querySelector('.df-bar');
  const toc = document.querySelector('.df-toc');
  const barH = () => bar.offsetHeight;
  const setH = () => root.style.setProperty('--df-bar-h', barH() + 'px');
  setH();
  addEventListener('resize', setH);
  const panels = [...document.querySelectorAll('.am-panel[id]')];
  const links = panels.map((p) => {
    const letter = (p.querySelector('.am-panel-id') || {}).textContent || '';
    const full = ((p.querySelector('h2') || {}).textContent || '').trim();
    const m = /^(.*?)（(.*)）$/.exec(full);
    const a = document.createElement('a');
    a.href = '#' + p.id;
    const t = document.createElement('span');
    t.textContent = (letter.trim() ? letter.trim() + ' ' : '') + (m ? m[1] : full);
    a.append(t);
    if (m) { const s = document.createElement('small'); s.textContent = m[2]; a.append(s); }
    // 折叠的面板先展开再跳过去
    a.addEventListener('click', (e) => {
      e.preventDefault();
      if (p.classList.contains('df-closed')) p.querySelector('.am-panel-head').click();
      p.scrollIntoView({ block: 'start' });
      history.replaceState(null, '', '#' + p.id);
    });
    toc.append(a);
    return a;
  });
  // 当前面板：标题已经滚过操作栏下沿的最后一个
  let queued = false;
  const mark = () => {
    queued = false;
    let cur = 0;
    panels.forEach((p, i) => { if (p.getBoundingClientRect().top <= barH() + 24) cur = i; });
    // 滚到底时最后几个面板的标题到不了顶部：直接标最后一个
    if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) cur = panels.length - 1;
    links.forEach((a, i) => a.setAttribute('aria-current', String(i === cur)));
  };
  addEventListener('scroll', () => { if (!queued) { queued = true; setTimeout(mark, 60); } }, { passive: true });
  mark();
})();
</script>`;

// 选中文字批注：只在审查台注入。所有人写的文字都用 textContent 显示，不拼进 HTML
const FEEDBACK_SCRIPT = `<script>
(() => {
  const root = document.documentElement;
  const bar = document.querySelector('.df-bar');
  const base = location.pathname.replace(/\\/$/, '');
  const key = 'df-notes:' + base;
  let mem = [];
  const load = () => { try { return JSON.parse(sessionStorage.getItem(key) || '[]'); } catch { return mem; } };
  const save = (list) => { mem = list; try { sessionStorage.setItem(key, JSON.stringify(list)); } catch { /* 没有 sessionStorage 时只存在内存里 */ } };
  const bytes = (s) => new TextEncoder().encode(s).length;
  const cut = (s, n) => { if (bytes(s) <= n) return s; let t = s; while (bytes(t + '…') > n) t = t.slice(0, -1); return t + '…'; };
  const pin = document.querySelector('.df-pin');
  const note = document.querySelector('.df-note');
  const list = document.querySelector('.df-fbl');
  const open = bar.querySelector('[data-fb=list]');
  const wait = bar.querySelector('.df-wait');
  let draft = null;
  const sync = () => {
    const n = load().length;
    root.dataset.dfNotes = String(n);
    if (n || note.open || list.open) root.dataset.dfHold = '1'; else delete root.dataset.dfHold;
    open.hidden = !n;
    open.textContent = '发送批注（' + n + ' 条）';
  };
  const panelOf = (node) => { const el = node && (node.nodeType === 1 ? node : node.parentElement); return el && el.closest('.am-panel'); };
  const label = (panel) => [panel.querySelector('.am-panel-id'), panel.querySelector('h2')].filter(Boolean).map((x) => x.textContent.trim()).join(' ');
  const place = () => {
    const sel = getSelection();
    const text = sel && sel.rangeCount ? sel.toString().replace(/\\s+/g, ' ').trim() : '';
    const panel = text && panelOf(sel.anchorNode);
    // 选区跨面板时不出按钮：一条批注只针对一处内容
    if (!panel || panel !== panelOf(sel.focusNode)) { pin.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    draft = { panel: label(panel), quote: cut(text, 400) };
    pin.style.left = Math.max(8, Math.min(innerWidth - 80, r.right + scrollX - 40)) + 'px';
    pin.style.top = (r.bottom + scrollY + 8) + 'px';
    pin.hidden = false;
  };
  // 按 Esc 关掉对话框也要恢复自动刷新
  [note, list].forEach((d) => d.addEventListener('close', sync));
  // 每个面板标题旁一个「批注」：对整个面板提意见
  for (const panel of document.querySelectorAll('.am-panel')) {
    const head = panel.querySelector('.am-panel-head');
    if (!head) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'df-panel-note'; b.dataset.fb = 'panel'; b.textContent = '批注';
    b.setAttribute('aria-label', '对「' + label(panel) + '」整个面板写批注');
    // 标题栏点击会折叠面板：按钮自己处理，不让事件冒到标题栏
    b.addEventListener('click', (e) => { e.stopPropagation(); draft = { panel: label(panel), quote: '整个面板' }; openNote(); });
    b.addEventListener('keydown', (e) => e.stopPropagation());
    head.append(b);
  }
  document.addEventListener('mouseup', () => setTimeout(place, 0));
  document.addEventListener('selectionchange', () => { if (!getSelection().toString().trim()) pin.hidden = true; });
  const err = (box, t) => { box.querySelector('.df-err').textContent = t; };
  const openNote = () => {
    note.querySelector('blockquote').textContent = draft.panel + ' · 「' + draft.quote + '」';
    note.querySelector('textarea').value = '';
    err(note, '');
    pin.hidden = true;
    note.showModal(); sync();
    note.querySelector('textarea').focus();
  };
  const renderList = () => {
    const ol = list.querySelector('ol');
    ol.replaceChildren(...load().map((it, i) => {
      const li = document.createElement('li');
      const small = document.createElement('small'); small.textContent = it.panel + ' · 「' + it.quote + '」';
      const p = document.createElement('p'); p.textContent = it.note;
      const del = document.createElement('button'); del.type = 'button'; del.dataset.fb = 'del'; del.dataset.i = String(i); del.textContent = '删除';
      li.append(small, p, del);
      return li;
    }));
  };
  document.addEventListener('click', async (e) => {
    const b = e.target.closest && e.target.closest('[data-fb]');
    if (!b) return;
    const a = b.dataset.fb;
    if (a === 'pin' && draft) openNote();
    if (a === 'note-cancel') { note.close(); sync(); }
    if (a === 'note-save') {
      const text = note.querySelector('textarea').value.trim();
      if (!text) return err(note, '写点意见再保存');
      if (bytes(text) > 2000) return err(note, '意见超过 2000 字节，请精简');
      save([...load(), { ...draft, note: text }]);
      note.close(); getSelection().removeAllRanges(); sync();
    }
    if (a === 'list') { renderList(); err(list, ''); list.showModal(); sync(); }
    if (a === 'list-close') { list.close(); sync(); }
    if (a === 'del') { const l = load(); l.splice(Number(b.dataset.i), 1); save(l); renderList(); sync(); if (!l.length) { list.close(); sync(); } }
    if (a === 'send') {
      const items = load();
      if (!items.length) return;
      b.disabled = true;
      try {
        const r = await fetch(base + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: bar.dataset.hash, items }) });
        const j = await r.json();
        if (!j.ok) return err(list, j.error + (j.hint ? '（' + j.hint + '）' : ''));
        save([]); list.close(); sync();
        const msg = bar.querySelector('.df-msg');
        delete msg.dataset.tone;
        msg.textContent = j.message;
        if (j.waiting) wait.dataset.on = ''; else delete wait.dataset.on;
        wait.textContent = j.waiting ? 'Agent 正在等待' : '没有 Agent 在等待：批注会在它下次运行 tenon wait 时送达';
      } catch { err(list, '审查台没有响应：tenon review 还在运行吗？'); }
      finally { b.disabled = false; }
    }
  });
  sync();
})();
</script>`;

function actionBar(root: string, id: string, token: string, hash: string): string {
  const st = deriveStatus(root, id);
  let action = '';
  if (st.status === 'draft' || st.status === 'rebase_required') {
    try {
      prepareApproval(root, id);
      action = `<button type="button" data-df="approve" data-hash="${esc(hash)}">批准此版本（${esc(hash.slice(7, 19))}）</button>`;
    } catch (e) {
      if (!(e instanceof DevflowError)) throw e;
      action = `<span>现在不能批准：${esc(e.message)}${e.hint ? `。${esc(e.hint.replace(/\n/g, '；'))}` : ''}</span>`;
    }
  } else if (st.status === 'ready_to_archive') action = '<button type="button" data-df="archive">归档</button>';
  const pending = ['applying', 'needs_fix'].includes(st.status) ? pendingEvidence(root, id) : [];
  if (pending.length) action = `<button type="button" data-df="open">确认人工证据（${pending.length} 条）</button>`;
  if (!action) action = '<span>现在不需要你操作，等 Agent 继续；有新进展时这里会提示刷新</span>';
  const row = (k: string, v: string | undefined) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');
  const dialog = `<dialog class="df-dlg"><h3>确认人工证据</h3><p>勾选你认可的条目。不认可的取消勾选，回到 Agent 说明要补什么。</p>${pending.map((e) => `<label><input type="checkbox" value="${esc(e.evidence_id)}" checked> <b>${esc(e.task)} / ${esc(e.acceptance)}</b> ${esc(e.summary)}
<dl>${row('步骤', e.procedure)}${row('预期', e.expected)}${row('实际', e.observed)}</dl></label>`).join('')}
<menu><button type="button" data-df="cancel">取消</button><button type="button" data-df="confirm">确认所选</button></menu></dialog>`;
  const waiting = isWaiting(root, id);
  const feedback = `<button type="button" data-fb="list" hidden>发送批注</button><span class="df-wait"${waiting ? ' data-on' : ''}>${waiting ? 'Agent 正在等待' : '没有 Agent 在等待：批注会在它下次运行 tenon wait 时送达'}</span>`;
  const fbDialogs = `<button type="button" class="df-pin" data-fb="pin" hidden>批注</button>
<dialog class="df-dlg df-note"><h3>批注</h3><blockquote></blockquote><textarea maxlength="2000" placeholder="写下你的意见，Agent 会按它修改方案或回答"></textarea><p class="df-err" role="alert"></p><menu><button type="button" data-fb="note-cancel">取消</button><button type="button" data-fb="note-save">保存</button></menu></dialog>
<dialog class="df-dlg df-fbl"><h3>待发送的批注</h3><p>发送后直接交给正在等待的 Agent；没有 Agent 在等待时，留到它下次运行 tenon wait。</p><ol></ol><p class="df-err" role="alert"></p><menu><button type="button" data-fb="list-close">关闭</button><button type="button" data-fb="send">发送</button></menu></dialog>`;
  return `${PAGE_STYLE(st.status)}${BAR_STYLE}<div class="df-bar" data-home="/${token}/" data-hash="${esc(hash)}" data-v="${changeVersion(root, id)}"><a href="/${token}/">← 全部变更</a><span class="df-state st-${st.status}">${statusLabel(st.status)}</span><span class="df-reason">${esc(st.reason)}</span>${action}${feedback}<button type="button" class="df-new" hidden>有新进展，点此刷新</button><span class="df-msg" role="status"></span></div><nav class="df-toc" aria-label="目录"></nav>${dialog}${fbDialogs}${TOC_SCRIPT}${BAR_SCRIPT}${FEEDBACK_SCRIPT}`;
}

/** 页面提交的选项序号 → 写进批准事件的结论；序号无效或数量对不上时拒绝 */
function pickDecisions(root: string, id: string, answers: unknown): { question: string; answer: string }[] {
  const defs = loadChangeMeta(root, id)?.decisions ?? [];
  if (!defs.length) return [];
  if (!Array.isArray(answers) || answers.length !== defs.length) throw new DevflowError('待拍板事项与页面不一致，未批准', '刷新页面后重试');
  return defs.map((d, i) => {
    const n = answers[i];
    if (!Number.isInteger(n) || n < 0 || n >= d.options.length) throw new DevflowError(`还没有选择：${d.question}`, '在页面首屏选好后再批准');
    return { question: d.question, answer: d.options[n] };
  });
}

function run(root: string, id: string, action: string, body: Record<string, unknown>): string {
  switch (action) {
    case 'approve': {
      // 页面上的哈希必须等于此刻的内容哈希：人看到的就是被批准的
      if (prepareApproval(root, id).hash !== body.hash) throw new DevflowError('页面已过期：打开页面后被审文件又有改动，未批准', '刷新页面，看过最新内容后再批准');
      approve(root, id, String(body.hash), pickDecisions(root, id, body.answers));
      return '已批准';
    }
    case 'confirm': {
      const ids = body.evidence_ids;
      if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) throw new DevflowError('没有勾选任何证据');
      for (const evidenceId of ids) confirmEvidence(root, id, evidenceId);
      return `已确认 ${ids.length} 条人工证据`;
    }
    case 'archive': {
      if (!pendingTx(root, id)) stageArchive(root, id);
      return `已归档到 ${commitArchive(root, id).target}`;
    }
    default:
      throw new DevflowError(`未知操作：${action}`);
  }
}

/** 执行一次人的操作：与 CLI 的同名命令一样持工作树锁、记使用记录 */
function act(root: string, id: string, action: string, body: Record<string, unknown>, version: string): string {
  const status = () => { try { return deriveStatus(root, id).status; } catch { return undefined; } };
  const handle = startUsage(root, { tool_version: version, command: action === 'confirm' ? 'evidence' : action, subcommand: action === 'confirm' ? 'confirm' : undefined, change_id: id, status_before: status() });
  try {
    const message = withWorktreeLock(root, () => run(root, id, action, body));
    finishUsage(handle, { outcome: 'success', status_after: status(), reason_code: 'completed' });
    return message;
  } catch (e) {
    finishUsage(handle, { outcome: 'failure', status_after: status(), error_code: e instanceof DevflowError ? 'DEVFLOW_ERROR' : 'UNEXPECTED_ERROR', reason_code: 'command-failed' });
    throw e;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) throw new DevflowError('请求必须是 application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new DevflowError('请求体过大');
    chunks.push(chunk);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new DevflowError('请求体不是合法的 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DevflowError('请求体必须是 JSON 对象');
  return value as Record<string, unknown>;
}

export function reviewServer(root: string, token: string, version: string): Server {
  requireInit(root);
  const send = (res: ServerResponse, status: number, type: string, body: string) => {
    res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(body);
  };
  const server = createServer(async (req, res) => {
    const post = req.method === 'POST';
    try {
      // Host 必须是本机地址（防 DNS 重绑定）；令牌不对一律 404，不提示原因
      const port = (server.address() as AddressInfo).port;
      const parts = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? '') || parts.shift() !== token) return send(res, 404, 'text/plain', 'not found');
      if (req.method === 'GET' && !parts.length) return send(res, 200, 'text/html', index(root, token));
      // 状态接口只读：页面拿它判断要不要提示刷新
      if (req.method === 'GET' && parts.length === 1 && parts[0] === 'state') return send(res, 200, 'application/json', JSON.stringify({ v: indexVersion(root) }));
      const id = parts[1] ?? '';
      if (parts[0] === 'a' && req.method === 'GET' && parts.length === 2 && CHANGE_ID.test(id) && listArchived(root).some((a) => a.id === id)) {
        return send(res, 200, 'text/html', renderArchived(root, id, ARCHIVED_BAR(token)));
      }
      if (parts[0] !== 'c' || !CHANGE_ID.test(id)) return send(res, 404, 'text/plain', 'not found');
      if (req.method === 'GET' && parts.length === 2) {
        requireChange(root, id);
        return send(res, 200, 'text/html', renderHtml(root, id, (hash) => actionBar(root, id, token, hash), listFeedback(root, id)).html);
      }
      if (req.method === 'GET' && parts.length === 3 && parts[2] === 'state') {
        requireChange(root, id);
        return send(res, 200, 'application/json', JSON.stringify({ v: changeVersion(root, id), waiting: isWaiting(root, id) }));
      }
      if (post && parts.length === 3 && parts[2] === 'feedback') {
        requireChange(root, id);
        // 批注不是批准材料：不持工作树锁、不写事件日志
        const n = saveFeedback(root, id, await readJson(req));
        const waiting = isWaiting(root, id);
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, waiting, message: `已发送 ${n} 条批注${waiting ? '，Agent 会马上收到' : '；Agent 下次运行 tenon wait 时收到'}` }));
      }
      if (post && parts.length === 3) {
        requireChange(root, id);
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, message: act(root, id, parts[2], await readJson(req), version) }));
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      if (!(e instanceof DevflowError)) {
        console.error(e);
        return send(res, 500, post ? 'application/json' : 'text/plain', post ? JSON.stringify({ ok: false, error: '内部错误，详见运行 tenon review 的终端' }) : '内部错误，详见运行 tenon review 的终端');
      }
      if (post) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: e.message, hint: e.hint }));
      return send(res, 400, 'text/html', SHELL('无法显示', `<p><a href="/${token}/">← 全部变更</a></p><h1>${esc(e.message)}</h1><pre>${esc(e.hint ?? '')}</pre>`));
    }
  });
  return server;
}
