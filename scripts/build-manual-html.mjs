#!/usr/bin/env node
// 从 docs/使用手册.md 生成 docs/使用手册.html（Stripe 风格单页）。Markdown 是唯一源文件。
// shortcut: 只支持使用手册用到的 Markdown 子集（标题、段落、列表、表格、引用、代码块、行内代码/粗体/链接），手册用上新语法时再扩展。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../docs/使用手册.md', import.meta.url));
const out = src.replace(/\.md$/, '.html');
const md = readFileSync(src, 'utf8');

// 概览页和写作检查都交给随包附带的 answer-me-with-html；独立 AM_HOME，不碰用户自己的配置
const AM = fileURLToPath(new URL('../vendor/answer-me-with-html/am.mjs', import.meta.url));
const amHome = mkdtempSync(join(tmpdir(), 'tenon-am-'));
const am = (...args) => {
  try {
    return { ok: true, text: execFileSync(process.execPath, [AM, ...args], { env: { ...process.env, AM_HOME: amHome }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) { return { ok: false, text: String(e.stdout || '') + String(e.stderr || e.message) }; }
};
try {
  const lint = am('lint', src, '--style', '80');
  // 写作警告只提示，不阻止生成
  console.log(/0 warnings/.test(lint.text) || !lint.text.trim() ? '✓ 使用手册.md 写作检查无警告' : `! 使用手册.md 写作检查：\n${lint.text.trimEnd()}`);
  const overview = src.replace(/\.md$/, '-概览.md');
  const r = am('render', overview, '-o', overview.replace(/\.md$/, '.html'), '--no-open');
  if (!r.ok) { console.error(`✗ 概览页渲染失败：\n${r.text}`); process.exit(1); }
  console.log(r.text.trimEnd());
} finally { rmSync(amHome, { recursive: true, force: true }); }

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// 与 GitHub 的标题锚点规则一致，手册里的 #链接 才能对上
const slug = (s) => s.replace(/`/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

function inline(text) {
  const codes = [];
  let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _f, c) => {
    codes.push(`<code>${esc(c.replace(/^ (.*) $/, '$1'))}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

const splitRow = (line) => {
  const cells = []; let cur = ''; let tick = false;
  for (const ch of line.trim().replace(/^\||\|$/g, '')) {
    if (ch === '`') tick = !tick;
    if (ch === '|' && !tick) { cells.push(cur.trim()); cur = ''; } else cur += ch;
  }
  return [...cells, cur.trim()];
};

const CODE_LABEL = { bash: '终端', text: '输出', json: 'JSON', yaml: 'YAML', markdown: 'Markdown' };
const ROLE = { '人': 'human', 'Agent': 'agent' };

const lines = md.split('\n');
const html = [];
const toc = [];
const ids = new Set();
let title = '';
let i = 0;
let inOptional = false;

const closeOptional = () => { if (inOptional) { html.push('</div></details>'); inOptional = false; } };

while (i < lines.length) {
  const line = lines[i];
  const fence = line.match(/^(`{3,})(\w*)/);
  if (fence) {
    const body = [];
    const close = new RegExp(`^${fence[1]}\\s*$`);
    for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
    i++;
    const lang = fence[2] || 'text';
    html.push(`<div class="code"><div class="code-bar"><span>${CODE_LABEL[lang] ?? lang}</span><button class="copy" type="button">复制</button></div><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
    continue;
  }
  const h = line.match(/^(#{1,4}) (.+)$/);
  if (h) {
    const level = h[1].length;
    const text = h[2];
    if (level === 1) { title = text; i++; continue; }
    const id = slug(text);
    ids.add(id);
    let label = inline(text);
    const role = text.match(/（(人|Agent)([^）]*)）$/);
    if (role) label = inline(text.slice(0, role.index)) + `<span class="badge ${ROLE[role[1]]}">${esc(role[1] + role[2])}</span>`;
    if (level === 2) {
      closeOptional();
      toc.push({ id, text: text.replace(/`/g, ''), sub: [] });
      if (text.startsWith('可选：')) {
        inOptional = true;
        html.push(`<details class="optional" id="${id}"><summary><h2>${label.replace('可选：', '<span class="badge optional-tag">可选</span>')}</h2></summary><div>`);
      } else html.push(`<h2 id="${id}">${label}</h2>`);
    } else {
      if (level === 3) toc.at(-1)?.sub.push({ id, text: text.replace(/`/g, '').replace(/（.*）$/, '') });
      html.push(`<h${level} id="${id}">${label}</h${level}>`);
    }
    i++;
    continue;
  }
  if (/^---\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
  if (line.startsWith('|')) {
    const rows = [];
    for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(splitRow(lines[i]));
    const [head, , ...body] = rows;
    html.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    continue;
  }
  if (line.startsWith('>')) {
    const quote = [];
    for (; i < lines.length && lines[i].startsWith('>'); i++) quote.push(lines[i].replace(/^> ?/, ''));
    const warn = quote[0].trim() === '**注意**';
    const body = (warn ? quote.slice(1) : quote).join('\n').trim();
    html.push(`<div class="callout ${warn ? 'warn' : 'note'}">${warn ? '<div class="callout-title">注意</div>' : ''}<p>${inline(body).replace(/\n/g, ' ')}</p></div>`);
    continue;
  }
  const li = line.match(/^(-|\d+\.) /);
  if (li) {
    const tag = li[1] === '-' ? 'ul' : 'ol';
    const items = [];
    for (; i < lines.length && /^(-|\d+\.) /.test(lines[i]); i++) items.push(lines[i].replace(/^(-|\d+\.) /, ''));
    html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
    continue;
  }
  if (!line.trim()) { i++; continue; }
  const para = [];
  for (; i < lines.length && lines[i].trim() && !/^(#|>|\||-|\d+\. |`{3}|---)/.test(lines[i]); i++) para.push(lines[i]);
  if (!para.length) { para.push(lines[i]); i++; }
  // 整行粗体是 FAQ 的问题行，后面换行接答案
  html.push(`<p>${para.map((l, k) => inline(l) + (k < para.length - 1 ? (/^\*\*.+\*\*$/.test(l.trim()) ? '<br>' : ' ') : '')).join('')}</p>`);
}
closeOptional();

// 自检：手册里每个页内锚点都必须对应一个标题，否则生成失败
const broken = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => decodeURIComponent(m[1])).filter((a) => !ids.has(a));
if (broken.length) { console.error(`✗ 找不到这些锚点对应的标题：${broken.join(', ')}`); process.exit(1); }

const nav = toc.map((s) => `<li><a href="#${s.id}">${esc(s.text)}</a>${s.sub.length ? `<ul>${s.sub.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ul>` : ''}</li>`).join('');

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--text:#1a2c44;--text-2:#50617a;--text-3:#667691;--brand:#533afd;--border:#d4dee9;--subtle:#f4f7fa;--code-bg:#1a2c44;--warn-bg:#fef9ec;--warn-border:#f5c44f;--human:#b13600;--agent:#217005;--top:56px}
*{box-sizing:border-box}
html{scroll-padding-top:calc(var(--top) + 16px)}
body{margin:0;color:var(--text);font:14px/22px -apple-system,system-ui,"Segoe UI",Roboto,Helvetica,Arial,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--brand);text-decoration:none;font-weight:500}
a:hover{text-decoration:underline}
code{font:500 12px/20px "Source Code Pro",Menlo,Monaco,monospace;background:var(--subtle);border:1px solid var(--border);border-radius:6px;padding:1px 5px;word-break:break-word}
header{position:fixed;inset:0 0 auto;height:var(--top);display:flex;align-items:center;gap:16px;padding:0 24px;background:#fff;border-bottom:1px solid var(--border);z-index:10}
.logo{font-weight:700;font-size:16px;color:var(--text)}
.logo span{color:var(--brand);font-weight:600;font-size:12px;margin-left:6px;letter-spacing:.04em}
header .spacer{flex:1}
.btn{font:inherit;font-size:12px;color:var(--text-2);background:#fff;border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer}
.btn:hover{color:var(--brand);border-color:var(--brand)}
.search{font:inherit;width:220px;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--subtle);color:var(--text)}
.layout{display:flex;padding-top:var(--top)}
nav{position:sticky;top:var(--top);width:280px;flex:none;height:calc(100vh - var(--top));overflow:auto;padding:24px 16px 48px 24px;border-right:1px solid var(--border)}
nav ul{list-style:none;margin:0;padding:0}
nav li a{display:block;padding:3px 8px;border-radius:6px;color:var(--text-2);font-weight:500}
nav li a:hover{color:var(--text);background:var(--subtle);text-decoration:none}
nav li a.active{color:var(--brand);background:#f1efff}
nav ul ul{margin:2px 0 6px 10px;border-left:1px solid var(--border);padding-left:6px}
nav ul ul a{font-weight:400;font-size:13px}
nav li.hidden{display:none}
main{flex:1;min-width:0;padding:40px 48px 120px}
article{max-width:760px}
h1{font-size:32px;line-height:40px;margin:0 0 8px}
.subtitle{font-size:16px;line-height:24px;color:var(--text-2);margin:0 0 20px}
h2{font-size:22px;line-height:30px;margin:48px 0 12px}
h3{font-size:17px;line-height:26px;margin:32px 0 8px;font-weight:600}
h4{font-size:14px;margin:24px 0 8px}
hr{border:0;border-top:1px solid var(--border);margin:48px 0}
p{margin:0 0 14px}
ul,ol{margin:0 0 14px;padding-left:22px}
li{margin:4px 0}
.badge{display:inline-block;vertical-align:middle;margin-left:8px;font-size:11px;line-height:18px;font-weight:600;padding:0 7px;border-radius:9px;border:1px solid}
.badge.human{color:var(--human);border-color:#f3c3ab;background:#fff5f0}
.badge.agent{color:var(--agent);border-color:#b5dfa5;background:#f2fbef}
.badge.optional-tag{margin:0 8px 0 0;color:var(--text-3);border-color:var(--border);background:var(--subtle)}
.code{margin:0 0 16px;border-radius:8px;overflow:hidden;background:var(--code-bg)}
.code-bar{display:flex;justify-content:space-between;align-items:center;padding:6px 12px;background:rgba(255,255,255,.06);color:#a3b1c6;font-size:12px}
.code-bar .copy{font:inherit;color:#a3b1c6;background:none;border:1px solid rgba(255,255,255,.15);border-radius:5px;padding:1px 8px;cursor:pointer}
.code-bar .copy:hover{color:#fff}
pre{margin:0;padding:12px 16px;overflow:auto}
pre code{all:unset;font:13px/20px "Source Code Pro",Menlo,Monaco,monospace;color:#f5f7fa;white-space:pre}
.table{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:13px;line-height:20px}
th{text-align:left;font-weight:600;color:var(--text-2);border-bottom:1px solid var(--border);padding:8px 12px 8px 0;white-space:nowrap}
td{border-bottom:1px solid var(--border);padding:8px 12px 8px 0;vertical-align:top}
.callout{margin:0 0 16px;padding:12px 16px;border-radius:8px;background:var(--subtle);border:1px solid var(--border)}
.callout p{margin:0}
.callout.warn{background:var(--warn-bg);border-color:var(--warn-border)}
.callout-title{font-weight:700;margin-bottom:4px}
details.optional{border:1px solid var(--border);border-radius:8px;margin:16px 0;padding:0 20px}
details.optional>summary{cursor:pointer;list-style:none;display:flex;align-items:center}
details.optional>summary::-webkit-details-marker{display:none}
details.optional>summary::after{content:"展开";margin-left:auto;font-size:12px;color:var(--text-3)}
details.optional[open]>summary::after{content:"收起"}
details.optional>summary h2{margin:16px 0;font-size:18px}
details.optional>div{padding-bottom:8px}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--text);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none}
.toast.show{opacity:1}
@media (max-width:900px){nav{display:none}main{padding:24px 20px 80px}.search{display:none}}
@media print{header,nav{display:none}.layout{padding:0}details.optional{border:0}}
</style>
</head>
<body>
<header>
<div class="logo">Tenon<span>DOCS</span></div>
<div class="spacer"></div>
<input class="search" type="search" placeholder="筛选目录　按 / 聚焦" aria-label="筛选目录">
<a class="btn" href="使用手册-概览.html">一页概览</a>
<button class="btn" type="button" id="copy-md">复制给 LLM</button>
<a class="btn" href="使用手册.md">查看 Markdown</a>
</header>
<div class="layout">
<nav aria-label="目录"><ul>${nav}</ul></nav>
<main><article>
<h1>${inline(title)}</h1>
${html.join('\n')}
</article></main>
</div>
<div class="toast" role="status" aria-live="polite"></div>
<script>
const MD=${JSON.stringify(md).replace(/</g, '\\u003c')};
const toast=(t)=>{const el=document.querySelector('.toast');el.textContent=t;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),1400)};
const copy=(t,msg)=>navigator.clipboard.writeText(t).then(()=>toast(msg),()=>toast('复制失败，请手动选择'));
// 第一段正文是副标题
const first=document.querySelector('article h1+p');if(first)first.className='subtitle';
document.querySelectorAll('.code .copy').forEach(b=>b.addEventListener('click',()=>copy(b.closest('.code').querySelector('code').textContent,'已复制代码')));
document.getElementById('copy-md').addEventListener('click',()=>copy(MD,'已复制 Markdown 全文'));
// 跳到折叠的可选章节里时，先展开它
const openTarget=()=>{const el=location.hash&&document.getElementById(decodeURIComponent(location.hash.slice(1)));if(!el)return;const d=el.closest('details')||(el.tagName==='DETAILS'?el:null);if(d&&!d.open){d.open=true;el.scrollIntoView()}};
addEventListener('hashchange',openTarget);openTarget();
// 目录高亮当前章节
const links=new Map([...document.querySelectorAll('nav a')].map(a=>[decodeURIComponent(a.hash.slice(1)),a]));
const spy=new IntersectionObserver(es=>{for(const e of es)if(e.isIntersecting){links.forEach(a=>a.classList.remove('active'));links.get(e.target.id)?.classList.add('active')}},{rootMargin:'-60px 0px -75% 0px'});
document.querySelectorAll('h2[id],h3[id],details[id]').forEach(h=>spy.observe(h));
// 目录筛选与 / 快捷键
const search=document.querySelector('.search');
search.addEventListener('input',()=>{const q=search.value.trim().toLowerCase();document.querySelectorAll('nav li').forEach(li=>li.classList.toggle('hidden',!!q&&!li.textContent.toLowerCase().includes(q)))});
addEventListener('keydown',e=>{if(e.key==='/'&&document.activeElement!==search){e.preventDefault();search.focus()}});
</script>
</body>
</html>
`;
writeFileSync(out, page);
console.log(`✓ ${out}`);
