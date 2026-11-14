// tenon doctor：逐项自检，每个问题附修复命令
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentDrift, detectAgents } from './agents.ts';
import { dfOf, codeRoots, git, listChanges } from './core.ts';
import { HOOK_MARK, OLD_HOOK_MARK, hookFile } from './init.ts';
import { validateProject, validateChange } from './validate.ts';
import { lintWiki } from './wiki.ts';

export interface Finding { level: 'ok' | 'warn' | 'error'; item: string; message: string; hint?: string }

const MIN_NODE = 22;

export function doctor(cwd: string, nodeVersion = process.versions.node): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding['level'], item: string, message: string, hint?: string) => out.push({ level, item, message, hint });

  const major = Number(nodeVersion.split('.')[0]);
  if (major >= MIN_NODE) add('ok', 'Node', `v${nodeVersion}`);
  else add('error', 'Node', `v${nodeVersion} 低于要求的 ${MIN_NODE}`, `安装 Node ${MIN_NODE} 或更高版本`);

  try {
    add('ok', 'git', git(cwd, ['--version']).trim());
  } catch {
    add('error', 'git', '找不到 git 命令', '安装 git 后重试');
    return out;
  }

  let root: string;
  try {
    root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    add('warn', '仓库', '当前目录不在 Git 仓库中，其余检查已跳过', '在项目根目录运行 tenon doctor');
    return out;
  }
  add('ok', '仓库', root);

  if (!existsSync(join(root, dfOf(root), 'project.yaml'))) {
    add('error', '初始化', '项目尚未初始化 Tenon', 'tenon init');
    return out;
  }
  add('ok', '初始化', `${dfOf(root)}/ 存在`);

  // hook：存在、带标记、exec 行指向的 node 与 cli 都存在；code_roots 里的每个仓库也要有
  for (const rel of ['.', ...(codeRoots(root) ?? [])]) {
    const item = rel === '.' ? 'hook' : `hook ${rel}`;
    let hook: string;
    try { hook = hookFile(resolve(root, rel)); } catch { add('error', item, `${rel} 不是 Git 仓库`, '检查 project.yaml 的 code_roots'); continue; }
    if (!existsSync(hook)) { add('error', item, '没有 pre-commit hook', 'tenon init'); continue; }
    const text = readFileSync(hook, 'utf8');
    if (text.includes(OLD_HOOK_MARK)) { add('warn', item, '还是改名前装的 devflow 钩子', 'tenon init（原地更新为 tenon 钩子）'); continue; }
    if (!text.includes(HOOK_MARK)) {
      add(/tenon|devflow/.test(text) ? 'ok' : 'warn', item, /tenon|devflow/.test(text) ? '已有其他 hook，其中调用了 tenon' : '已有其他 hook，其中没有调用 tenon check', `在 hook 中加一行：tenon check --staged${rel === '.' ? '' : ` --project ${resolve(root)}`}`);
      continue;
    }
    const m = /exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/.exec(text);
    const unq = (s: string) => s.replaceAll(`'\\''`, `'`);
    const missing = m ? [unq(m[1]), unq(m[2])].filter((p) => !existsSync(p)) : ['（无法解析 exec 行）'];
    if (missing.length) add('error', item, `hook 指向的文件不存在：${missing.join(', ')}`, 'tenon init（重新安装 hook）');
    else add('ok', item, `指向 ${unq(m![2])}`);
  }

  const agents = detectAgents(root);
  if (!agents.length) add('warn', 'Agent 文件', '没有安装任何 Agent 的技能', 'tenon update --agents claude,codex');
  for (const a of agents) {
    const drift = agentDrift(root, a);
    if (drift.length) add('warn', `Agent 文件（${a}）`, `与当前版本不一致：${drift.join(', ')}`, `tenon update --agents ${a}`);
    else add('ok', `Agent 文件（${a}）`, '与当前版本一致');
  }

  const projectErrors = validateProject(root);
  if (projectErrors.length) add('error', 'project.yaml', projectErrors.map((i) => i.message).join('；'), 'tenon check 查看详情');
  else {
    const p = readFileSync(join(root, dfOf(root), 'project.yaml'), 'utf8');
    if (/^verify:\s*\[\s*\]\s*$/m.test(p)) add('warn', 'project.yaml', '没有声明验证命令，tenon verify 的结果只会是 unknown', `在 ${dfOf(root)}/project.yaml 的 verify 中加入测试命令（由人维护）`);
    else add('ok', 'project.yaml', '已声明验证命令');
  }

  for (const id of listChanges(root)) {
    const errors = validateChange(root, id, false).filter((i) => i.level === 'error');
    if (errors.length) add('error', `变更格式 ${id}`, errors.map((i) => i.message).join('；'), '升级兼容 CLI 并运行 tenon validate ' + id);
  }

  const pages = lintWiki(root).pages.length;
  if (pages) add('ok', '知识页', `${pages} 个`);
  else add('warn', '知识页', '知识页为空，tenon-archive 没有页面可更新', '用 tenon-scan 技能生成知识页；小项目可以跳过');

  const gi = join(root, '.gitignore');
  if (existsSync(gi) && readFileSync(gi, 'utf8').split('\n').some((l) => l.trim() === `${dfOf(root)}/runtime/`)) add('ok', '.gitignore', `已忽略 ${dfOf(root)}/runtime/`);
  else add('warn', '.gitignore', `没有忽略 ${dfOf(root)}/runtime/（验证日志与渲染页会被提交）`, `echo '${dfOf(root)}/runtime/' >> .gitignore`);
  return out;
}
