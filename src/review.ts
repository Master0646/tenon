// devflow review：本地审查台。由人在终端启动，之后在浏览器里批准、确认人工证据、归档。
// 只监听 127.0.0.1；所有地址都带启动时生成的随机令牌，令牌只打印在人的终端里。
// 与 requireHuman 一样，这不是防篡改，只防 Agent 越级。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { commitArchive, pendingTx, stageArchive } from './archive.ts';
import { CHANGE_ID, DevflowError, listChanges, readEvents, requireChange, requireInit, withWorktreeLock, type EvidenceRecord } from './core.ts';
import { confirmEvidence, evidenceMatrix } from './evidence.ts';
import { renderHtml } from './render.ts';
import { approve, deriveStatus, humanTodo, prepareApproval } from './status.ts';
import { finishUsage, startUsage } from './usage.ts';
import { loadChangeMeta } from './validate.ts';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MAX_BODY = 64 * 1024;

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
const TOKENS = `--lin-canvas:#010102;--lin-s1:#0f1011;--lin-s2:#141516;--lin-s3:#18191b;--lin-line:#23252a;--lin-line-2:#34343a;--lin-ink:#f7f8f8;--lin-ink-2:#d0d6e0;--lin-ink-3:#8a8f98;--lin-primary:#5e6ad2;--lin-primary-hover:#828fff;--lin-focus:#5e69d1;--lin-font:Inter,"SF Pro Display",-apple-system,system-ui,"Segoe UI",Roboto,"PingFang SC",sans-serif;--lin-mono:"JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace`;

const SHELL = (title: string, body: string, refresh = false) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${esc(title)}</title>
<style>
:root{color-scheme:dark;${TOKENS}}
*{box-sizing:border-box}
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
tbody tr:hover{background:var(--lin-s2)}
.id{white-space:nowrap;font-family:var(--lin-mono);font-size:13px}
.todo{white-space:nowrap;display:inline-flex;align-items:center;gap:8px;font-weight:500}
.todo::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--lin-primary);flex:none}
.pill{display:inline-block;padding:2px 8px;border-radius:9999px;background:var(--lin-s3);color:var(--lin-ink-2);font:400 12px/1.4 var(--lin-mono)}
.muted{color:var(--lin-ink-3);font-size:12px}
.num{color:var(--lin-ink-2);font-variant-numeric:tabular-nums;white-space:nowrap}
.empty{padding:48px 24px;text-align:center;color:var(--lin-ink-3)}
pre{white-space:pre-wrap;font:13px/1.5 var(--lin-mono);color:var(--lin-ink-2);background:var(--lin-s1);border:1px solid var(--lin-line);border-radius:12px;padding:16px 24px}
</style></head><body><header class="nav"><span class="mark"></span>DevFlow 审查台</header><main>${body}</main></body></html>`;

function index(root: string, token: string): string {
  const rows = listChanges(root).map((id) => {
    try {
      const st = deriveStatus(root, id);
      return { id, title: loadChangeMeta(root, id)?.title ?? '', status: st.status, reason: st.reason, tasks: `${st.tasks.done}/${st.tasks.total}`, todo: humanTodo(root, id, st), last: readEvents(root, id).at(-1)?.at };
    } catch (e) {
      return { id, title: '', status: '无法读取', reason: e instanceof Error ? e.message : String(e), tasks: '—', todo: null, last: undefined };
    }
  }).sort((a, b) => Number(!!b.todo) - Number(!!a.todo));
  const body = rows.length
    ? `<table><thead><tr><th>变更</th><th>轮到你</th><th>状态</th><th>任务</th><th>最后活动</th></tr></thead><tbody>${rows.map((r) => `<tr>
<td><a class="id" href="/${token}/c/${r.id}">${esc(r.id)}</a><br><span class="muted">${esc(r.title)}</span></td>
<td>${r.todo ? `<span class="todo">${esc(r.todo)}</span>` : '<span class="muted">Agent 进行中</span>'}</td>
<td><span class="pill">${esc(r.status)}</span><br><span class="muted">${esc(r.reason)}</span></td><td class="num">${r.tasks}</td><td class="num">${ago(r.last)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="empty">没有进行中的变更。</p>';
  return SHELL('DevFlow 审查台', `<h1>变更</h1><p class="lead">本页每 5 秒自动刷新。需要你操作的变更排在前面。</p><div class="panel">${body}</div>`, true);
}

// 只在审查台注入：把 answer-me 纸张主题的变量换成 Linear 深色；离线审查页（devflow render）不受影响。
// 用户要求保留：面板字母徽标、右侧大纲、差异与状态的红绿色、图表原有强调色。
const PAGE_STYLE = `<style>
html[data-theme][data-mode]{color-scheme:dark;${TOKENS};--font-sans:var(--lin-font);--font-serif:var(--lin-font);--head-font:var(--lin-font);--font-mono:var(--lin-mono);--radius:8px;--bg:var(--lin-canvas);--paper:var(--lin-s1);--fill:var(--lin-s2);--ink:var(--lin-ink);--ink-2:var(--lin-ink-2);--ink-3:var(--lin-ink-3);--line:var(--lin-line-2);--line-2:var(--lin-line);--accent:var(--lin-primary-hover);--accent-bg:rgb(94 106 210/.16);--ok:#8cc79a;--ok-bg:#1c3122;--err:#f0928a;--err-bg:#3a1d1a;--warn:#e3b866;--warn-bg:#352a13;--head-bg:var(--lin-ink);--head-fg:var(--lin-canvas)}
html[data-theme] .am-head h1{font-weight:600;letter-spacing:-.6px}
html[data-theme] .am-panel{border-radius:12px;border-color:var(--lin-line);box-shadow:inset 0 1px 0 rgb(255 255 255/.04)}
html[data-theme] .am-panel-head h2{font-weight:500;letter-spacing:-.2px}
html[data-theme] .am-md p,html[data-theme] .am-md li,html[data-theme] .am-intro{line-height:1.6}
html[data-theme] .am-diagram{--accent:#e59a7d;--accent-bg:#3a2219}
</style>`;

const BAR_STYLE = `<style>
body{padding-bottom:72px}
.df-bar,.df-dlg{${TOKENS};color-scheme:dark}
.df-bar{position:fixed;left:0;right:0;bottom:0;z-index:50;display:flex;flex-wrap:wrap;gap:12px;align-items:center;min-height:56px;padding:8px 24px;background:var(--lin-s1);color:var(--lin-ink);border-top:1px solid var(--lin-line);box-shadow:inset 0 1px 0 rgb(255 255 255/.04);font:400 14px/1.4 var(--lin-font)}
.df-bar a{color:var(--lin-ink-3);text-decoration:none}
.df-bar a:hover{color:var(--lin-ink)}
.df-bar button,.df-dlg button{font:500 14px/1.2 var(--lin-font);padding:8px 14px;min-height:36px;border-radius:8px;border:1px solid var(--lin-line);background:var(--lin-s2);color:var(--lin-ink);cursor:pointer}
.df-bar button:hover,.df-dlg button:hover{border-color:var(--lin-line-2)}
.df-bar button[data-df],.df-dlg button[data-df=confirm]{background:var(--lin-primary);border-color:var(--lin-primary);color:#fff}
.df-bar button[data-df]:hover,.df-dlg button[data-df=confirm]:hover{background:var(--lin-primary-hover);border-color:var(--lin-primary-hover)}
.df-bar button:focus-visible,.df-dlg button:focus-visible,.df-dlg input:focus-visible{outline:2px solid color-mix(in srgb,var(--lin-focus) 50%,transparent);outline-offset:2px}
.df-state{color:var(--lin-ink-3);font:400 12px/1.4 var(--lin-mono);padding:2px 8px;border-radius:9999px;background:var(--lin-s3)}
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
</style>`;

const BAR_SCRIPT = `<script>
(() => {
  const bar = document.querySelector('.df-bar');
  const msg = bar.querySelector('.df-msg');
  const dlg = document.querySelector('.df-dlg');
  const base = location.pathname.replace(/\\/$/, '');
  const post = async (action, body, done) => {
    msg.textContent = '处理中…';
    try {
      const r = await fetch(base + '/' + action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) { msg.textContent = '✗ ' + j.error + (j.hint ? '（' + j.hint + '）' : ''); return; }
      done ? done() : location.reload();
    } catch { msg.textContent = '✗ 审查台没有响应：devflow review 还在运行吗？'; }
  };
  // 没有按钮时是在等 Agent：定时刷新，轮到人时按钮自己出现
  if (!bar.querySelector('[data-df]')) setInterval(() => { if (!dlg.open) location.reload(); }, 5000);
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-df]');
    if (!b) return;
    const a = b.dataset.df;
    if (a === 'open') dlg.showModal();
    if (a === 'cancel') dlg.close();
    // 待拍板事项按顺序提交选中项的序号；没选的用建议项
    if (a === 'approve') post('approve', { hash: b.dataset.hash, answers: [...document.querySelector('.am-panel').querySelectorAll('fieldset.am-ask')].map((f) => {
      const inputs = [...f.querySelectorAll('input')];
      const i = inputs.findIndex((x) => x.checked);
      return i >= 0 ? i : inputs.findIndex((x) => x.hasAttribute('data-suggested'));
    }) });
    if (a === 'confirm') { dlg.close(); post('confirm', { evidence_ids: [...dlg.querySelectorAll('input:checked')].map((x) => x.value) }); }
    // 不用浏览器原生确认框：内嵌浏览器会屏蔽它，点了没有反应。改为同一个按钮点两次
    if (a === 'archive') {
      if (b.dataset.armed) post('archive', {}, () => { location.href = bar.dataset.home; });
      else { b.dataset.armed = '1'; b.textContent = '再点一次确认归档'; msg.textContent = '归档会把规范增量合并进 .devflow/specs/，并把变更目录移到 archive'; }
    }
  });
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
  if (!action) action = '<span>现在不需要你操作，等 Agent 继续；本页每 5 秒自动刷新</span>';
  const row = (k: string, v: string | undefined) => (v ? `<dt>${k}</dt><dd>${esc(v)}</dd>` : '');
  const dialog = `<dialog class="df-dlg"><h3>确认人工证据</h3><p>勾选你认可的条目。不认可的取消勾选，回到 Agent 说明要补什么。</p>${pending.map((e) => `<label><input type="checkbox" value="${esc(e.evidence_id)}" checked> <b>${esc(e.task)} / ${esc(e.acceptance)}</b> ${esc(e.summary)}
<dl>${row('步骤', e.procedure)}${row('预期', e.expected)}${row('实际', e.observed)}</dl></label>`).join('')}
<menu><button type="button" data-df="cancel">取消</button><button type="button" data-df="confirm">确认所选</button></menu></dialog>`;
  return `${PAGE_STYLE}${BAR_STYLE}<div class="df-bar" data-home="/${token}/"><a href="/${token}/">← 全部变更</a><span class="df-state">${esc(st.status)} · ${esc(st.reason)}</span>${action}<span class="df-msg" role="status"></span></div>${dialog}${BAR_SCRIPT}`;
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
      const id = parts[1] ?? '';
      if (parts[0] !== 'c' || !CHANGE_ID.test(id)) return send(res, 404, 'text/plain', 'not found');
      if (req.method === 'GET' && parts.length === 2) {
        requireChange(root, id);
        return send(res, 200, 'text/html', renderHtml(root, id, (hash) => actionBar(root, id, token, hash)).html);
      }
      if (post && parts.length === 3) {
        requireChange(root, id);
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, message: act(root, id, parts[2], await readJson(req), version) }));
      }
      return send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      if (!(e instanceof DevflowError)) {
        console.error(e);
        return send(res, 500, post ? 'application/json' : 'text/plain', post ? JSON.stringify({ ok: false, error: '内部错误，详见运行 devflow review 的终端' }) : '内部错误，详见运行 devflow review 的终端');
      }
      if (post) return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: e.message, hint: e.hint }));
      return send(res, 400, 'text/html', SHELL('无法显示', `<p><a href="/${token}/">← 全部变更</a></p><h1>${esc(e.message)}</h1><pre>${esc(e.hint ?? '')}</pre>`));
    }
  });
  return server;
}
