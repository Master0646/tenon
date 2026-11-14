// devflow render：把被审文件确定性地拼成 am 草稿，再交给随包附带的 am 渲染为离线 HTML
import { evidenceMatrix } from './evidence.ts';
import { approvalDiff, decisionAnswers } from './status.ts';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DF, DevflowError, changeRel, hashFiles, parseEvents, reviewedFiles, sha256, specCaps, type DevflowEvent, type Issue } from './core.ts';
import type { Feedback } from './feedback.ts';
import { parseDelta } from './spec.ts';
import { deriveStatus, workNode } from './status.ts';
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
      // 面板标题是 h2，文件里的 ## 降一级成 h3，不跳级；多出来的 # 也落到 h3，不会另起面板
      out.push(`${'#'.repeat(Math.min(Math.max(h[1].length + 1, 3), 6))} ${escapeInline(h[2])}`);
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

/** 两份文本的行级差异，写成 diff 代码块；新增或删除的文件只说明，不贴全文 */
export function lineDiff(before: string | null, after: string | null): string {
  if (before === null) return `新增文件（${(after ?? '').split('\n').length} 行），全文见下方对应面板。`;
  if (after === null) return '文件已删除。';
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-diff-'));
  try {
    writeFileSync(join(tmp, 'a'), before);
    writeFileSync(join(tmp, 'b'), after);
    let out = '';
    // git diff --no-index 在有差异时退出码为 1，输出在 stdout
    try {
      execFileSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U2', 'a', 'b'], { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e: any) {
      out = String(e.stdout ?? '');
    }
    const lines = out.split('\n');
    const body = lines.slice(Math.max(0, lines.findIndex((l) => l.startsWith('@@')))).filter((l) => !l.startsWith('\\ No newline')).join('\n').trim();
    if (!body) return '只有空白或换行符差异。';
    // 围栏比正文里最长的反引号串多一个，正文里的代码块不会把它截断
    const fence = '`'.repeat(Math.max(3, ...(body.match(/`+/g) ?? []).map((m) => m.length + 1)));
    return `${fence}diff\n${body}\n${fence}`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 进度条的 5 段，每段包含哪些工作节点（workNode 的 label 前缀）
const STAGES: [stage: string, nodes: string[]][] = [
  ['方案', ['写方案中']],
  ['批准', ['待你批准']],
  ['实现', ['待开工', '实现中']],
  ['验证与证据', ['补证据中', '修复中', '待重新验证', '待你确认']],
  ['归档', ['归档准备中', '待你归档']],
];

/** 一行表格：之前的段打勾，当前段加粗并写出工作节点 */
export function progressRow(label: string): string {
  const at = STAGES.findIndex(([, nodes]) => nodes.some((n) => label.startsWith(n)));
  const cells = STAGES.map(([stage], i) => (i < at ? `✓ ${stage}` : i === at ? `**${stage}**` : stage));
  const marks = STAGES.map((_, i) => (i === at ? `**${cell(label)}**` : ' '));
  return `| ${cells.join(' | ')} |\n| ${STAGES.map(() => '---').join(' | ')} |\n| ${marks.join(' | ')} |`;
}

export function todoText(node: { label: string; human: boolean }, decisions: number): string {
  if (node.label === '待你批准') return decisions ? `选好 ${decisions} 个待拍板事项后点批准` : '看完方案后点批准';
  const confirm = /^待你确认 (\d+) 条/.exec(node.label);
  if (confirm) return `核对 ${confirm[1]} 条人工证据后点确认`;
  if (node.label === '待你归档') return '点归档';
  return `现在不需要你操作：Agent 当前在「${node.label}」`;
}

type TaskDef = ReturnType<typeof loadTasks>[number];
const taskCards = (tasks: TaskDef[]): string[] => tasks.map((t) => {
  const head = `**${t.id} ${escapeInline(t.title.replace(/\n/g, ' '))}**${t.depends_on?.length ? `　依赖：${t.depends_on.join(', ')}` : ''}`;
  const acc = t.acceptance?.length ? t.acceptance.map((a) => `- ${escapeInline((typeof a === 'string' ? a : `${a.id}: ${a.text}`).replace(/\n/g, ' '))}`).join('\n') : '（未写验收条件）';
  return `${head}\n\n${acc}`;
});

/** 规范增量面板正文：按 ADDED / MODIFIED / REMOVED 分色 */
function specBody(caps: { cap: string; rel: string; text: string; isNew: boolean }[], problems: Problem[], count: { added: number; modified: number; removed: number }): string {
  const parts: string[] = [];
  for (const { cap, rel, text, isNew } of caps) {
    const { delta } = parseDelta(text);
    for (const k of ['added', 'modified', 'removed'] as const) count[k] += delta[k].length;
    parts.push(`### 能力 ${cap}${isNew ? '（新能力）' : ''}`);
    if (delta.purpose) parts.push(`目的：${escapeInline(delta.purpose)}`);
    const group = (kind: string, title: string, reqs: typeof delta.added) => {
      if (!reqs.length) return;
      // toPanelBody 总是调用：它负责拦截不安全写法；能识别场景结构时用表格版式
      const body = reqs.map((r) => {
        const raw = toPanelBody(r.text, rel, problems);
        return formatRequirement(r.text) ?? raw;
      }).join('\n\n');
      // 四个反引号：需求正文里可能有三反引号的代码块
      parts.push(`\`\`\`\`callout ${kind} ${title}（${reqs.length}）\n${body}\n\`\`\`\``);
    };
    group('ok', '新增需求', delta.added);
    group('warn', '修改需求（整条替换当前同名需求）', delta.modified);
    group('err', '删除需求', delta.removed);
  }
  return parts.join('\n\n');
}

/** notes：审查台传入的批注记录；离线页不传，也就没有这个面板 */
export function buildDraft(root: string, id: string, notes: (Feedback & { read: boolean })[] = []): { draft: string; hash: string; problems: Problem[] } {
  const base = changeRel(id);
  const problems: Problem[] = [];
  const read = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), 'utf8') : '');
  const hash = hashFiles(root, reviewedFiles(root, id));
  const meta = loadChangeMeta(root, id);
  const st = deriveStatus(root, id);

  const panels: string[] = [];
  const diff = approvalDiff(root, id);
  const matrix = evidenceMatrix(root, id);

  // 首屏：要人拍板的事项 + 方案要点。细节面板（A–E）在页面上默认折叠
  const decisions = meta?.decisions ?? [];
  // 当前内容已批准时不再让人选：列出批准时定下的结论
  const settled = !['draft', 'rebase_required'].includes(st.status);
  const asks = settled
    ? decisionAnswers(root, id).map((d) => `- ${escapeInline(d.question)} → **${escapeInline(d.answer)}**${d.by === 'human' ? '' : '（未作答，按推荐项）'}`)
    : decisions.map((d) => `\`\`\`\`ask\n${escapeInline(d.question)}\n${d.options.map((o) => `${o === d.recommend ? '*' : '-'} ${escapeInline(o)}`).join('\n')}\n\`\`\`\``);
  const points = meta?.summary?.length ? meta.summary.map((s) => `- ${escapeInline(s.replace(/\n/g, ' '))}`).join('\n') : `- ${cell(meta?.title ?? id)}\n- （change.yaml 没有填写 summary）`;
  // 首屏只放：现在到哪一步、要你做什么、待拍板事项（审查台的批准按钮从第一个面板里读选项）
  const node = workNode(root, id, st);
  panels.push(`## 进展与待办\n${progressRow(node.label)}\n\n**要你做什么**：${escapeInline(todoText(node, decisions.length))}\n\n### ${settled ? '已拍板' : '待你拍板'}（${decisions.length} 项）\n\n${asks.join(settled ? '\n' : '\n\n') || '没有需要你拍板的事项。'}`);
  panels.push(`## 方案要点与影响范围\n### 方案要点\n\n${points}\n\n### 影响范围\n\n${meta?.affected_paths.map((p) => `- \`${p.replace(/`/g, '')}\``).join('\n') || '- 未填写'}`);

  // 重新批准：只列改动的行；没改的面板在标题上注明，可以不再看
  const changed = diff.available ? diff.files : [];
  if (changed.length) panels.push(`## 批准差异（${changed.length} 个文件，相对上次批准）\n${changed.map((f) => `### ${cell(f.path)}\n\n${lineDiff(f.before, f.after)}`).join('\n\n')}`);
  const same = (...match: string[]) => (changed.length && !changed.some((f) => match.some((m) => f.path.startsWith(`${base}/${m}`))) ? ' · 与上次批准相同' : '');
  // 没有任何证据时矩阵只是任务面板里验收条件的重复，不显示
  if (matrix.some((e) => e.status !== 'missing')) panels.push(`## 验收矩阵\n| 验收条件 | 状态 | 依据 | 说明 |\n| --- | --- | --- | --- |\n${matrix.map((e) => `| ${cell(e.acceptance + ' ' + e.text)} | ${MATRIX_STATUS[e.status]} | ${cell(e.basis ?? (e.method === 'manual' ? '人工' : '自动'))} | ${cell(e.status === 'valid' ? '' : e.reason ?? '')} |`).join('\n')}`);

  const proposal = read(`${base}/proposal.md`);
  panels.push(`## A 提案（${proposal.split('\n').filter((l) => /^\s*[-*]\s/.test(l)).length} 条${same('proposal.md')}）\n${toPanelBody(proposal, `${base}/proposal.md`, problems) || '（空）'}`);

  const reqCount = { added: 0, modified: 0, removed: 0 };
  const specText = specBody(specCaps(root, id).map((cap) => {
    const rel = `${base}/specs/${cap}/spec.md`;
    return { cap, rel, text: read(rel), isNew: !existsSync(join(root, DF, 'specs', cap, 'spec.md')) };
  }), problems, reqCount);
  panels.push(`## B 规范增量（新增 ${reqCount.added} · 修改 ${reqCount.modified} · 删除 ${reqCount.removed}${same('specs/')}）\n${specText || '本变更不修改任何行为规范。'}`);

  const design = read(`${base}/design.md`);
  const sections = design.split('\n').filter((l) => /^##\s/.test(l)).length;
  const diagrams = diagramBlocks(design, '').length;
  panels.push(`## C 设计（${sections} 节 · ${diagrams} 张图${same('design.md')}）\n${toPanelBody(design, `${base}/design.md`, problems) || '（无设计文档）'}`);

  // 任务：每个任务一段（验收条件逐条列出）+ 由 depends_on 生成的依赖图
  const tasks = loadTasks(root, id);
  // flow 语法字符（箭头、括号、冒号等）从节点名中去掉
  const label = (t: { id: string; title: string }) => `[${t.id} ${t.title.replace(/-+>|[[\]{}():&*|]/g, ' ').replace(/\s+/g, ' ').trim()}]`;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges = tasks.flatMap((t) =>
    t.depends_on?.length ? t.depends_on.filter((d) => byId.has(d)).map((d) => `${label(byId.get(d)!)} -> ${label(t)}`) : [`(开始) -> ${label(t)}`]);
  const cards = taskCards(tasks);
  const accCount = tasks.reduce((n, t) => n + (t.acceptance?.length ?? 0), 0);
  panels.push(`## D 任务与依赖（${tasks.length} 个任务 · ${accCount} 条验收${same('tasks.yaml')}）\n${tasks.length ? `${cards.join('\n\n')}\n\n\`\`\`flow LR\n${edges.join('\n')}\n\`\`\`` : '（无任务）'}`);

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
  panels.push(`## E 被审文件与内容哈希（${files.length} 个文件）\n${verifyTable}\n\n批准时绑定的哈希：\`${hash}\`\n\n| 文件 | 内容 sha256 |\n| --- | --- |\n${files.map((f) => `| \`${f}\` | \`${sha256(readFileSync(join(root, f))).slice(7, 19)}…\` |`).join('\n')}\n\n批准方式二选一。哈希与本页不一致时都会拒绝批准：\n\n- 审查台：在你自己的终端运行一次 \`devflow review\`，之后都在浏览器里点「批准此版本」。\n- 终端：复制下面的命令运行。\n\n\`\`\`bash\ndevflow approve ${id} --hash ${hash.slice(7, 19)}\n\`\`\``);

  // 批注是人写的任意文字：HTML 与 Markdown 记号都转成字符实体，按纯文本显示（不会变成链接、代码或页面代码）
  const plain = (s: string) => s.replace(/&/g, '&amp;').replace(/[<>`*_[\]~\\|!#]/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\s+/g, ' ').trim();
  const noteRows = notes.flatMap((n) => n.items.map((it) => `| ${plain(n.at.replace('T', ' ').slice(0, 19))} | ${plain(it.panel || '—')} | ${plain(it.quote)} | ${plain(it.note)} | ${n.read ? 'Agent 已读' : '未读'} |`));
  if (noteRows.length) panels.push(`## 批注记录（${noteRows.length} 条）\n| 时间 | 面板 | 引用原文 | 意见 | 状态 |\n| --- | --- | --- | --- | --- |\n${noteRows.join('\n')}`);

  const title = (meta?.title || id).replace(/\n/g, ' ');
  const draft = `---
template: doc
theme: paper
lang: zh
title: ${JSON.stringify(title)}
subtitle: ${JSON.stringify(`变更 ${id} · 当前状态 ${st.status}（${st.reason}）`)}
file: ${id}
---
${panels.join('\n\n')}
`;
  return { draft, hash, problems };
}

/**
 * 需求原文 → 需求名、约束与场景表。场景下出现 WHEN / THEN / AND 以外的内容、或约束中有代码块时返回 null（按原文展示）。
 */
export function formatRequirement(text: string): string | null {
  const lines = text.split('\n');
  const name = /^###\s+Requirement:\s*(.*)$/.exec(lines[0] ?? '')?.[1];
  if (name === undefined) return null;
  const intro: string[] = [];
  const rows: { name: string; when: string[]; then: string[] }[] = [];
  let last: string[] | null = null;
  for (const line of lines.slice(1)) {
    const sc = /^####\s+Scenario:\s*(.*)$/.exec(line);
    if (sc) {
      rows.push({ name: sc[1], when: [], then: [] });
      last = null;
      continue;
    }
    const cur = rows.at(-1);
    if (!cur) {
      if (/^\s*(```|~~~)/.test(line) || /^#{1,6}\s/.test(line)) return null;
      intro.push(line);
      continue;
    }
    if (!line.trim()) continue;
    const m = /^\s*-\s+(WHEN|THEN|AND)\s+(.*)$/.exec(line);
    if (!m) return null;
    if (m[1] !== 'AND') last = m[1] === 'WHEN' ? cur.when : cur.then;
    if (!last) return null; // AND 之前没有 WHEN / THEN
    last.push(m[2]);
  }
  const body = intro.map(escapeInline).join('\n').trim();
  const table = rows.length
    ? `\n\n| 场景 | WHEN | THEN |\n| --- | --- | --- |\n${rows.map((r) => `| ${cell(r.name)} | ${cell(r.when.join('；')) || '—'} | ${cell(r.then.join('；')) || '—'} |`).join('\n')}`
    : '';
  return `**${escapeInline(name)}**${body ? `\n\n${body}` : ''}${table}`;
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

const MAX_SENTENCES = 3;

/** 超过 3 句的段落（连续的普通文本行；标题、列表、表格、引用、缩进行、代码块不算） → warn */
export function longParagraphs(text: string, file: string): Issue[] {
  const issues: Issue[] = [];
  let fence: string | null = null;
  let start = 0;
  let buf: string[] = [];
  const flush = () => {
    const n = buf.join('').match(/[。！？]|[.!?](?=\s|$)/g)?.length ?? 0;
    if (n > MAX_SENTENCES) {
      issues.push({ level: 'warn', file: `${file}:${start}`, message: `段落有 ${n} 句，审查页建议每段不超过 ${MAX_SENTENCES} 句`, hint: '拆成列表，每条一句；能画图的用图表达' });
    }
    buf = [];
  };
  text.split('\n').forEach((line, i) => {
    const open = /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
    if (fence) {
      if (open && open[1].startsWith(fence) && !open[2]) fence = null;
      return;
    }
    if (open) {
      flush();
      fence = open[1];
      return;
    }
    if (!line.trim() || /^(#{1,6}\s|\s*([-*+]|\d+\.)\s|\s*\||\s*>|\s{2,}\S)/.test(line)) return flush();
    if (!buf.length) start = i + 1;
    buf.push(line);
  });
  flush();
  return issues;
}

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
  for (const f of files.filter((f) => !f.includes('/specs/'))) issues.push(...longParagraphs(readFileSync(join(root, f), 'utf8'), f));
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
    else if (current && line.startsWith('  ') && !line.startsWith('  draft:')) current.hint += `${current.hint ? '\n' : ''}${line.slice(2)}`;
  }
  for (const f of found) if (!f.hint) delete f.hint;
  return [...issues, ...(found.length ? found : [{ level: 'error' as const, file: base, message: '图块无法渲染', hint: output }])];
}

// 细节面板（A–E）默认折叠：点标题展开，从目录或锚点跳转时自动展开，打印时全部展开。
// 这段由 devflow 自己注入，不来自被审文件；被审文件里的原始 HTML 仍由 toPanelBody 拦截。
const FOLD = `<style>
.am-colophon{display:none}
.am-toolbar>:not(.am-btn--reply){display:none}
.am-panel-head[role=button]{cursor:pointer}
.am-panel-head[role=button]::after{content:"收起 ▾";margin-left:auto;align-self:center;padding:0 12px;font-size:12px;opacity:.6;white-space:nowrap}
.am-panel.df-closed .am-panel-head::after{content:"展开 ▸"}
.am-panel.df-closed .am-panel-body{display:none}
@media print{.am-panel.df-closed .am-panel-body{display:block}}
</style>
<script>
(() => {
  const set = (p, open) => { p.classList.toggle('df-closed', !open); p.querySelector('.am-panel-head').setAttribute('aria-expanded', String(open)); };
  for (const p of document.querySelectorAll('.am-panel')) {
    if (!/^panel-[A-E]$/.test(p.id)) continue;
    const head = p.querySelector('.am-panel-head');
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.addEventListener('click', () => set(p, p.classList.contains('df-closed')));
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } });
    set(p, false);
  }
  const reveal = () => {
    const el = location.hash.length > 1 && document.getElementById(decodeURIComponent(location.hash.slice(1)));
    const p = el && el.closest('.am-panel.df-closed');
    if (p) { set(p, true); el.scrollIntoView(); }
  };
  addEventListener('hashchange', reveal);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('a[href^="#"]')) setTimeout(reveal); });
  reveal();
})();
</script>
`;

/** 在渲染好的页面末尾注入折叠脚本；extra 是审查台追加的操作栏 */
const MATRIX_STATUS: Record<string, string> = { valid: '有效', missing: '缺证据', stale: '已过期', unconfirmed: '待你确认', invalid: '无效' };

/** 渲染器的「回复」按钮及其面板评论改叫「批注」：审查页上只有一种提意见的叫法（用户在审查台拍板） */
const relabel = (html: string): string =>
  html.replace(/<button class="am-btn am-btn--reply"[^>]*>回复<\/button>/, (m) => m.replaceAll('回复', '批注').replaceAll('&quot;评论&quot;', '&quot;批注&quot;'));

export function decorate(html: string, extra = ''): string {
  html = relabel(html);
  const i = html.lastIndexOf('</body>');
  if (i < 0) return html;
  const added = FOLD + extra;
  // 页面的内容安全策略只放行登记过哈希的脚本：把 devflow 自己注入的脚本登记进去
  const hashes = [...added.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return (html.slice(0, i) + added + html.slice(i)).replace(/(<meta http-equiv="Content-Security-Policy" content="[^"]*script-src)/, `$1 ${hashes.join(' ')}`);
}

/** 校验并渲染为 HTML 字符串；审查台每次打开页面都调用，保证看到的是当前内容 */
export function renderHtml(root: string, id: string, extra?: (hash: string) => string, notes?: (Feedback & { read: boolean })[]): { html: string; hash: string } {
  const errors = validateChange(root, id, true).filter((i) => i.level === 'error');
  if (errors.length) throw new DevflowError(`变更校验有 ${errors.length} 个错误，先修正再渲染`, `运行 devflow validate ${id}`);
  const { draft, hash, problems } = buildDraft(root, id, notes);
  if (problems.length) {
    throw new DevflowError(`审查页内容有 ${problems.length} 处不允许的写法`, problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'));
  }
  const html = amHtml(draft);
  if (hashFiles(root, reviewedFiles(root, id)) !== hash) {
    throw new DevflowError('渲染期间被审文件发生了变化', `重新运行 devflow render ${id}`);
  }
  return { html: decorate(html, extra?.(hash)), hash };
}

function amHtml(draft: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-render-'));
  try {
    const failed = runAm(draft, join(tmp, 'page.html'));
    if (failed !== null) throw new DevflowError('渲染失败', failed);
    return readFileSync(join(tmp, 'page.html'), 'utf8');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const EVENT_NAME: Record<string, string> = {
  approved: '批准', 'apply-started': '开工', verified: '验证', 'task-done': '完成任务', 'evidence-recorded': '记录证据',
  'evidence-confirmed': '确认证据', archived: '归档',
};

/** 已归档变更的只读页：方案原文、拍板结论、事件时间线。不校验、不绑定哈希，extra 是审查台追加的样式 */
export function renderArchived(root: string, id: string, extra = ''): string {
  const base = `${DF}/changes/archive/${id}`;
  const read = (rel: string) => (existsSync(join(root, base, rel)) ? readFileSync(join(root, base, rel), 'utf8') : '');
  const yaml = (rel: string) => { try { return parse(read(rel)) ?? {}; } catch { return {}; } };
  const meta = yaml('change.yaml');
  let events: DevflowEvent[] = [];
  try { events = parseEvents(read('events.jsonl'), id); } catch { /* 日志损坏：时间线留空 */ }
  const problems: Problem[] = [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  const picked = events.findLast((e) => e.type === 'approved')?.decisions ?? [];
  const decisions = (Array.isArray(meta.decisions) ? meta.decisions : []).map((d: any) => {
    const hit = picked.find((p) => p.question === d?.question);
    return `- ${escapeInline(str(d?.question))} → **${escapeInline(hit?.answer ?? str(d?.recommend))}**${hit ? '' : '（未作答，按推荐项）'}`;
  });
  const summary = (Array.isArray(meta.summary) ? meta.summary : []).map((s: unknown) => `- ${escapeInline(str(s).replace(/\n/g, ' '))}`);
  const archivedAt = events.findLast((e) => e.type === 'archived')?.at;
  const panels = [`## 概要\n归档时间：${archivedAt ?? '未知'}\n\n### 拍板结论\n\n${decisions.join('\n') || '没有待拍板事项。'}\n\n### 方案要点\n\n${summary.join('\n') || '- （未填写）'}`];
  panels.push(`## A 提案\n${toPanelBody(read('proposal.md'), `${base}/proposal.md`, problems) || '（空）'}`);
  const specDir = join(root, base, 'specs');
  const caps = existsSync(specDir) ? readdirSync(specDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  const count = { added: 0, modified: 0, removed: 0 };
  panels.push(`## B 规范增量\n${specBody(caps.map((cap) => ({ cap, rel: `${base}/specs/${cap}/spec.md`, text: read(`specs/${cap}/spec.md`), isNew: false })), problems, count) || '本变更不修改任何行为规范。'}`);
  panels.push(`## C 设计\n${toPanelBody(read('design.md'), `${base}/design.md`, problems) || '（无设计文档）'}`);
  const tasks = (Array.isArray(yaml('tasks.yaml').tasks) ? yaml('tasks.yaml').tasks : []).filter((t: any) => t && typeof t.id === 'string' && typeof t.title === 'string');
  panels.push(`## D 任务\n${taskCards(tasks).join('\n\n') || '（无任务）'}`);
  // 显式占用 E：渲染器给不带字母的面板顺延编号，概要因此落在 F，不被折叠脚本（只收起 A–E）收起
  panels.push(`## E 事件时间线（${events.length} 条）\n${events.length ? `| 时间 | 事件 | 操作人 |\n| --- | --- | --- |\n${events.map((e) => `| ${cell(e.at)} | ${cell(`${EVENT_NAME[e.type] ?? e.type}（${e.type}）`)} | ${cell('actor' in e && typeof e.actor === 'string' ? e.actor : '—')} |`).join('\n')}` : '没有事件记录。'}`);
  // 与进行中的变更一样：有不允许的写法就不出页面，并指出位置
  if (problems.length) throw new DevflowError(`已归档变更的文件有 ${problems.length} 处审查页不允许的写法`, problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'));
  const title = str(meta.title) || id;
  const draft = `---\ntemplate: doc\ntheme: paper\nlang: zh\ntitle: ${JSON.stringify(title.replace(/\n/g, ' '))}\nsubtitle: ${JSON.stringify(`已归档变更 ${id} · 只读`)}\nfile: ${id}\n---\n${panels.join('\n\n')}\n`;
  return decorate(amHtml(draft), extra);
}

export function render(root: string, id: string, out?: string): RenderResult {
  const { html, hash } = renderHtml(root, id);
  const file = out ?? join(root, DF, 'runtime', 'rendered', `${id}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  return { file, hash };
}
