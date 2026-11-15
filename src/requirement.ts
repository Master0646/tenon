// tenon req render：把 <数据目录>/requirements/<章节>/ 下的需求 md 确定性地渲染成仿 Stripe 文档样式的离线 html
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { dfOf, DevflowError, REQUIREMENT_DIR, requirementsRel } from './core.ts';
import { runAm, toPanelBody, type Problem } from './render.ts';

const USAGE = '用法：tenon req render <数据目录>/requirements/<章节>（或其中的 requirement.md）';

// 仿 Stripe 文档：白底、深蓝墨色、紫色强调、无边框面板、细分隔线
export const STRIPE_THEME = {
  label: { zh: 'Stripe 文档', en: 'Stripe docs' },
  tokens: {
    common: {
      '--radius': '8px', '--shadow': 'none',
      '--font-sans': '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei"',
      '--font-mono': '"SFMono-Regular", Menlo, Consolas',
    },
    light: {
      '--bg': '#ffffff', '--paper': '#ffffff', '--ink': '#1a1f36', '--ink-2': '#3c4257', '--ink-3': '#5b6478',
      '--line': '#e3e8ee', '--line-2': '#d5dbe1', '--fill': '#f6f9fc', '--accent': '#533afd', '--accent-bg': '#f2f0ff',
      '--ok': '#0e6245', '--ok-bg': '#d7f7c2', '--err': '#a41c4e', '--err-bg': '#ffe7f2', '--warn': '#8a3a0b', '--warn-bg': '#fcedb9',
      '--head-bg': '#ffffff', '--head-fg': '#1a1f36',
    },
    dark: {
      '--bg': '#0a2540', '--paper': '#0d2b4a', '--ink': '#f6f9fc', '--ink-2': '#c4cfdc', '--ink-3': '#9fb0c4',
      '--line': '#23415f', '--line-2': '#2f5072', '--fill': '#11335a', '--accent': '#a9a1ff', '--accent-bg': '#1d2f63',
      '--ok': '#8fe3b0', '--ok-bg': '#0f3b2f', '--err': '#ff9ac2', '--err-bg': '#4a1830', '--warn': '#ffd27a', '--warn-bg': '#4a3410',
      '--head-bg': '#0d2b4a', '--head-fg': '#f6f9fc',
    },
  },
  css: [
    '& .am-panel { border: none; box-shadow: none; background: transparent; }',
    '& .am-panel-head { background: transparent; border-bottom: 1px solid var(--line); padding-left: 0; }',
    '& .am-panel-head h2 { font-size: 1.35em; font-weight: 600; letter-spacing: -0.01em; }',
    '& .am-panel-id { display: none; }',
    '& .am-panel-body { padding-left: 0; padding-right: 0; line-height: 1.7; }',
    '& .am-head h1 { font-weight: 700; letter-spacing: -0.02em; }',
    '& .am-md code { background: var(--fill); border-radius: 4px; }',
    '& .am-callout { border-radius: 8px; }',
  ].join(' '),
};

/** 把需求 md 按 ## 切成面板；返回标题、导语与面板（标题 + 正文），problems 收集不允许的写法 */
export function splitRequirement(text: string, file: string, problems: Problem[]): { title: string | null; intro: string; panels: { title: string; body: string }[] } {
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  // toPanelBody 去掉首个一级标题、把 ## 降成 ###、逐行转义并报告问题，行号与原文一致
  const lines = toPanelBody(text, file, problems).split('\n');
  const panels: { title: string; body: string[] }[] = [];
  const intro: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^\s*(```+|~~~+)\s*(.*)$/.exec(line);
    if (fence) { if (open && open[1].startsWith(fence) && !open[2]) fence = null; }
    else if (open) fence = open[1];
    else {
      const h = /^###\s+(.*)$/.exec(line);
      if (h) { panels.push({ title: h[1], body: [] }); continue; }
    }
    (panels.at(-1)?.body ?? intro).push(line);
  }
  return { title, intro: intro.join('\n').trim(), panels: panels.map((p) => ({ title: p.title, body: p.body.join('\n').trim() })) };
}

/** 参数（目录或其中的 requirement.md，相对 cwd 或绝对路径）→ 需求目录相对仓库根的路径 */
function requirementDir(root: string, target: string | undefined): string {
  if (!target) throw new DevflowError('缺少需求目录', USAGE);
  const abs = resolve(target);
  const dir = basename(abs) === 'requirement.md' ? dirname(abs) : abs;
  const rel = relative(root, dir).split(sep).join('/');
  const parent = requirementsRel(root);
  if (dirname(rel) !== parent || !REQUIREMENT_DIR.test(basename(rel))) {
    throw new DevflowError(`不是需求目录：${target}`, `${USAGE}；目录名用小写字母、数字、. 和 -`);
  }
  if (!existsSync(join(root, rel, 'requirement.md'))) throw new DevflowError(`${rel}/requirement.md 不存在`, `先用 tenon-intake 技能生成需求文档；${USAGE}`);
  return rel;
}

export function buildRequirementDraft(root: string, rel: string): { draft: string; problems: Problem[] } {
  const problems: Problem[] = [];
  const main = splitRequirement(readFileSync(join(root, rel, 'requirement.md'), 'utf8'), `${rel}/requirement.md`, problems);
  const panels = main.panels.map((p) => `## ${p.title}\n${p.body || '（空）'}`);
  if (existsSync(join(root, rel, 'revisions.md'))) {
    const body = toPanelBody(readFileSync(join(root, rel, 'revisions.md'), 'utf8'), `${rel}/revisions.md`, problems);
    panels.push(`## 修订记录\n${body || '（空）'}`);
  }
  const title = (main.title ?? basename(rel)).replace(/\n/g, ' ');
  const draft = `---\ntemplate: doc\ntheme: stripe\nlang: zh\ntitle: ${JSON.stringify(title)}\nsubtitle: ${JSON.stringify(`需求说明 · ${rel}`)}\nfile: ${basename(rel)}\n---\n${main.intro ? `${main.intro}\n\n` : ''}${panels.join('\n\n')}\n`;
  return { draft, problems };
}

export function renderRequirement(root: string, target: string | undefined, out?: string): { file: string } {
  const rel = requirementDir(root, target);
  const { draft, problems } = buildRequirementDraft(root, rel);
  if (problems.length) throw new DevflowError(`需求文档有 ${problems.length} 处不允许的写法`, problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'));
  const file = out ?? join(root, dfOf(root), 'runtime', 'rendered', 'requirements', `${basename(rel)}.html`);
  mkdirSync(dirname(file), { recursive: true });
  // 先写到临时文件再落盘：渲染失败时不留下半成品
  const tmp = mkdtempSync(join(tmpdir(), 'tenon-req-'));
  try {
    const failed = runAm(draft, join(tmp, 'page.html'), { stripe: STRIPE_THEME });
    if (failed !== null) throw new DevflowError('渲染失败', failed);
    copyFileSync(join(tmp, 'page.html'), file);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { file };
}
