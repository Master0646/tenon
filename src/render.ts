// devflow render：把被审文件确定性地拼成 am 草稿，再交给随包附带的 am 渲染为离线 HTML
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DF, DevflowError, changeRel, hashFiles, reviewedFiles, sha256, specCaps, type Issue } from './core.ts';
import { parseDelta } from './spec.ts';
import { deriveStatus } from './status.ts';
import { loadChangeMeta, loadTasks, validateChange } from './validate.ts';

const AM = fileURLToPath(new URL('../vendor/answer-me-with-html/am.mjs', import.meta.url));
// 允许透传给 am 的代码块：图形组件与不带属性的普通代码块
const DIAGRAMS = new Set(['flow', 'sequence', 'tree', 'er']);

export interface Problem { file: string; line: number; message: string }

/**
 * 把一个 Markdown 文件变成 am 面板正文：标题降两级、转义原始 HTML、拦截不安全的块。
 * 首个一级标题（文件自身的标题）去掉，面板标题已表达它。
 */
export function toPanelBody(text: string, file: string, problems: Problem[]): string {
  const out: string[] = [];
  let fence: string | null = null;
  let droppedTitle = false;
  text.split('\n').forEach((line, i) => {
    const bad = (message: string) => problems.push({ file, line: i + 1, message });
    const open = /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
    if (fence) {
      if (open && open[1].startsWith(fence) && !open[2]) fence = null;
      out.push(line);
      return;
    }
    if (open) {
      const info = open[2].trim();
      const lang = info.split(/\s+/)[0] ?? '';
      if (lang === 'html' || lang === 'svg') bad(`审查页不允许原始 ${lang} 块`);
      else if (info && !(DIAGRAMS.has(lang) || /^[\w+#.-]+$/.test(info)) ) bad(`代码块不能带属性：${info}（只写语言名，或用 flow / sequence / tree / er）`);
      fence = open[1];
      out.push(line);
      return;
    }
    if (/^\s*:::/.test(line)) return bad('不支持 ::: 块，图请用 ```flow 等代码块');
    if (/!\[[^\]]*\]\(/.test(line)) return bad('审查页不支持图片');
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1].length === 1 && !droppedTitle) {
        droppedTitle = true;
        return;
      }
      out.push(`${'#'.repeat(Math.min(h[1].length + 2, 6))} ${escapeInline(h[2])}`);
      return;
    }
    out.push(escapeInline(line));
  });
  if (fence) problems.push({ file, line: text.split('\n').length, message: '代码块没有闭合' });
  return out.join('\n').trim();
}

/** 转义行内的 < 与 >，行内代码（`...`）原样保留：由 Markdown 渲染器自己转义 */
function escapeInline(line: string): string {
  return line.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;'))).join('');
}

const cell = (s: string) => escapeInline(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function buildDraft(root: string, id: string): { draft: string; hash: string; problems: Problem[] } {
  const base = changeRel(id);
  const problems: Problem[] = [];
  const read = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
  const hash = hashFiles(root, reviewedFiles(root, id));
  const meta = loadChangeMeta(root, id);
  const st = deriveStatus(root, id);

  const panels: string[] = [];
  panels.push(`## A 提案\n${toPanelBody(read(`${base}/proposal.md`), `${base}/proposal.md`, problems) || '（空）'}`);

  // 规范增量：按 ADDED / MODIFIED / REMOVED 分色
  const specParts: string[] = [];
  for (const cap of specCaps(root, id)) {
    const rel = `${base}/specs/${cap}/spec.md`;
    const { delta } = parseDelta(read(rel));
    const isNew = !existsSync(join(root, DF, 'specs', cap, 'spec.md'));
    specParts.push(`### 能力 ${cap}${isNew ? '（新能力）' : ''}`);
    if (delta.purpose) specParts.push(`目的：${escapeInline(delta.purpose)}`);
    const group = (kind: string, title: string, reqs: typeof delta.added) => {
      if (!reqs.length) return;
      const body = reqs.map((r) => toPanelBody(r.text, rel, problems)).join('\n\n');
      // 四个反引号：需求正文里可能有三反引号的代码块
      specParts.push(`\`\`\`\`callout ${kind} ${title}（${reqs.length}）\n${body}\n\`\`\`\``);
    };
    group('ok', '新增需求', delta.added);
    group('warn', '修改需求（整条替换当前同名需求）', delta.modified);
    group('err', '删除需求', delta.removed);
  }
  panels.push(`## B 规范增量\n${specParts.join('\n\n') || '本变更不修改任何行为规范。'}`);

  panels.push(`## C 设计\n${toPanelBody(read(`${base}/design.md`), `${base}/design.md`, problems) || '（无设计文档）'}`);

  // 任务：表格 + 由 depends_on 生成的依赖图
  const tasks = loadTasks(root, id);
  // flow 语法字符（箭头、括号、冒号等）从节点名中去掉
  const label = (t: { id: string; title: string }) => `[${t.id} ${t.title.replace(/-+>|[[\]{}():&*|]/g, ' ').replace(/\s+/g, ' ').trim()}]`;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges = tasks.flatMap((t) =>
    t.depends_on?.length ? t.depends_on.filter((d) => byId.has(d)).map((d) => `${label(byId.get(d)!)} -> ${label(t)}`) : [`(开始) -> ${label(t)}`]);
  const rows = tasks.map((t) => `| ${t.id} | ${cell(t.title)} | ${t.depends_on?.join(', ') || '—'} | ${cell((t.acceptance ?? []).join('；')) || '—'} |`);
  panels.push(`## D 任务与依赖\n${tasks.length ? `| ID | 任务 | 依赖 | 验收条件 |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n\`\`\`flow LR\n${edges.join('\n')}\n\`\`\`` : '（无任务）'}`);

  // 被审文件与哈希：人批准的就是这些文件的这份内容；project.yaml 只显示哈希看不出内容，单列验证命令
  const files = reviewedFiles(root, id);
  let verify: { name?: unknown; run?: unknown; cwd?: unknown }[] = [];
  try {
    const p = parse(read(`${DF}/project.yaml`));
    if (Array.isArray(p?.verify)) verify = p.verify.filter((v: unknown) => v && typeof v === 'object');
  } catch { /* 格式错误已由 validate 报告 */ }
  const verifyTable = verify.length
    ? `验证命令（\`${DF}/project.yaml\`，devflow verify 只运行这些）：\n\n| name | run | cwd |\n| --- | --- | --- |\n${verify.map((v) => `| ${cell(String(v.name ?? ''))} | \`${String(v.run ?? '').replace(/[`|\n]/g, ' ')}\` | ${cell(String(v.cwd ?? '.'))} |`).join('\n')}`
    : `未声明验证命令（\`${DF}/project.yaml\` 的 verify 为空）：devflow verify 的结果只会是 unknown，变更无法归档。`;
  panels.push(`## E 被审文件与内容哈希\n${verifyTable}\n\n批准时绑定的哈希：\`${hash}\`\n\n| 文件 | 内容 sha256 |\n| --- | --- |\n${files.map((f) => `| \`${f}\` | \`${sha256(readFileSync(join(root, f))).slice(7, 19)}…\` |`).join('\n')}\n\n确认无误后，在你自己的终端运行 \`devflow approve ${id}\`，核对它显示的哈希与本页一致。`);

  const title = (meta?.title || id).replace(/\n/g, ' ');
  const draft = `---
template: doc
theme: paper
lang: zh
title: ${JSON.stringify(title)}
subtitle: ${JSON.stringify(`变更 ${id} · 当前状态 ${st.status}（${st.reason}）`)}
file: ${id}
内容哈希: ${JSON.stringify(hash.slice(0, 19) + '…')}
影响路径: ${JSON.stringify((meta?.affected_paths ?? []).join(', ') || '（未填写）')}
---
本页由 devflow render 从被审文件确定性生成，不经过模型改写。

${panels.join('\n\n')}
`;
  return { draft, hash, problems };
}

export interface RenderResult { file: string; hash: string }

/** 用随包的 am 渲染草稿；成功返回 null，失败返回 am 的输出 */
function runAm(draft: string, out: string): string | null {
  // 用独立的 AM_HOME：不读写用户自己的 am 配置与页面目录
  const home = mkdtempSync(join(tmpdir(), 'devflow-am-'));
  try {
    execFileSync(process.execPath, [AM, 'render', '-', '-o', out, '--no-open', '--style', 'off'], {
      input: draft, env: { ...process.env, AM_HOME: home }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (e: any) {
    return String(e.stdout || e.stderr || e.message).trim();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

interface Block { file: string; line: number; lines: string[] }

/** 抽出已闭合的图块（flow / sequence / tree / er），line 为开始围栏所在行（从 1 起） */
function diagramBlocks(text: string, file: string): Block[] {
  const blocks: Block[] = [];
  let cur: (Block & { fence: string; keep: boolean }) | null = null;
  text.split('\n').forEach((line, i) => {
    const m = /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
    if (cur) {
      cur.lines.push(line);
      if (m && m[1].startsWith(cur.fence) && !m[2]) {
        if (cur.keep) blocks.push({ file, line: cur.line, lines: cur.lines });
        cur = null;
      }
    } else if (m) {
      cur = { file, line: i + 1, lines: [line], fence: m[1], keep: DIAGRAMS.has(m[2].trim().split(/\s+/)[0] ?? '') };
    }
  });
  return blocks;
}

/**
 * render 会拒绝的写法：toPanelBody 的规则 + 图块语法（交给 am 试渲染）。供 devflow validate 使用；
 * check 不调用，避免每次提交都起子进程。
 */
export function reviewIssues(root: string, id: string): Issue[] {
  const base = changeRel(id);
  const files = [`${base}/proposal.md`, `${base}/design.md`, ...specCaps(root, id).map((c) => `${base}/specs/${c}/spec.md`)]
    .filter((f) => existsSync(join(root, f)));
  const problems: Problem[] = [];
  const blocks: Block[] = [];
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    toPanelBody(text, f, problems);
    blocks.push(...diagramBlocks(text, f));
  }
  const issues: Issue[] = problems.map((p) => ({ level: 'error', file: `${p.file}:${p.line}`, message: p.message }));
  if (!blocks.length) return issues;

  // 每个图块一个面板；记下每块在草稿中的起始行，用于把 am 的行号映射回源文件
  const draft = ['---', 'title: diagram check', '---', ''];
  const at: { start: number; block: Block }[] = [];
  blocks.forEach((b, i) => {
    draft.push(`## 图 ${i + 1}`);
    at.push({ start: draft.length + 1, block: b });
    draft.push(...b.lines, '');
  });
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-check-'));
  let output: string | null;
  try {
    output = runAm(draft.join('\n'), join(tmp, 'check.html'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (output === null) return issues;

  let current: Issue | null = null;
  const found: Issue[] = [];
  for (const line of output.split('\n')) {
    const m = /^✗ L(\d+) (.*)$/.exec(line);
    if (m) {
      const n = Number(m[1]);
      const hit = at.findLast((a) => a.start <= n);
      const where = hit ? `${hit.block.file}:${hit.block.line + n - hit.start}` : base;
      current = { level: 'error', file: where, message: `图语法错误：${m[2]}`, hint: '' };
      found.push(current);
    } else if (line.startsWith('✗')) current = null;
    else if (current && line.startsWith('  ')) current.hint += `${current.hint ? '\n' : ''}${line.slice(2)}`;
  }
  for (const f of found) if (!f.hint) delete f.hint;
  return [...issues, ...(found.length ? found : [{ level: 'error' as const, file: base, message: '图块无法渲染', hint: output }])];
}

export function render(root: string, id: string, out?: string): RenderResult {
  const errors = validateChange(root, id, true).filter((i) => i.level === 'error');
  if (errors.length) throw new DevflowError(`变更校验有 ${errors.length} 个错误，先修正再渲染`, `运行 devflow validate ${id}`);
  const { draft, hash, problems } = buildDraft(root, id);
  if (problems.length) {
    throw new DevflowError(`审查页内容有 ${problems.length} 处不允许的写法`, problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'));
  }
  const file = out ?? join(root, DF, 'runtime', 'rendered', `${id}.html`);
  mkdirSync(dirname(file), { recursive: true });
  const failed = runAm(draft, file);
  if (failed !== null) throw new DevflowError('渲染失败', failed);
  if (hashFiles(root, reviewedFiles(root, id)) !== hash) {
    throw new DevflowError('渲染期间被审文件发生了变化', `重新运行 devflow render ${id}`);
  }
  return { file, hash };
}
