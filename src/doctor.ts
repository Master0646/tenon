// devflow doctor：逐项自检，每个问题附修复命令
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { agentDrift, detectAgents } from './agents.ts';
import { DF, git, listChanges } from './core.ts';
import { HOOK_MARK } from './init.ts';
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
    add('warn', '仓库', '当前目录不在 Git 仓库中，其余检查已跳过', '在项目根目录运行 devflow doctor');
    return out;
  }
  add('ok', '仓库', root);

  if (!existsSync(join(root, DF, 'project.yaml'))) {
    add('error', '初始化', '项目尚未初始化 DevFlow', 'devflow init');
    return out;
  }
  add('ok', '初始化', `${DF}/ 存在`);

  // hook：存在、带标记、exec 行指向的 node 与 cli 都存在
  const hook = join(resolve(root, git(root, ['rev-parse', '--git-path', 'hooks']).trim()), 'pre-commit');
  if (!existsSync(hook)) add('error', 'hook', '没有 pre-commit hook', 'devflow init');
  else {
    const text = readFileSync(hook, 'utf8');
    if (!text.includes(HOOK_MARK)) {
      add(text.includes('devflow') ? 'ok' : 'warn', 'hook', text.includes('devflow') ? '已有其他 hook，其中调用了 devflow' : '已有其他 hook，其中没有调用 devflow check', '在 hook 中加一行：devflow check --staged');
    } else {
      const m = /exec '((?:[^']|'\\'')*)' '((?:[^']|'\\'')*)'/.exec(text);
      const unq = (s: string) => s.replaceAll(`'\\''`, `'`);
      const missing = m ? [unq(m[1]), unq(m[2])].filter((p) => !existsSync(p)) : ['（无法解析 exec 行）'];
      if (missing.length) add('error', 'hook', `hook 指向的文件不存在：${missing.join(', ')}`, 'devflow init（重新安装 hook）');
      else add('ok', 'hook', `指向 ${unq(m![2])}`);
    }
  }

  const agents = detectAgents(root);
  if (!agents.length) add('warn', 'Agent 文件', '没有安装任何 Agent 的技能', 'devflow update --agents claude,codex');
  for (const a of agents) {
    const drift = agentDrift(root, a);
    if (drift.length) add('warn', `Agent 文件（${a}）`, `与当前版本不一致：${drift.join(', ')}`, `devflow update --agents ${a}`);
    else add('ok', `Agent 文件（${a}）`, '与当前版本一致');
  }

  const projectErrors = validateProject(root);
  if (projectErrors.length) add('error', 'project.yaml', projectErrors.map((i) => i.message).join('；'), 'devflow check 查看详情');
  else {
    const p = readFileSync(join(root, DF, 'project.yaml'), 'utf8');
    if (/^verify:\s*\[\s*\]\s*$/m.test(p)) add('warn', 'project.yaml', '没有声明验证命令，devflow verify 的结果只会是 unknown', '在 .devflow/project.yaml 的 verify 中加入测试命令（由人维护）');
    else add('ok', 'project.yaml', '已声明验证命令');
  }

  for (const id of listChanges(root)) {
    const errors = validateChange(root, id, false).filter((i) => i.level === 'error');
    if (errors.length) add('error', `变更格式 ${id}`, errors.map((i) => i.message).join('；'), '升级兼容 CLI 并运行 devflow validate ' + id);
  }

  const pages = lintWiki(root).pages.length;
  if (pages) add('ok', '知识页', `${pages} 个`);
  else add('warn', '知识页', '知识页为空，devflow-archive 没有页面可更新', '用 devflow-scan 技能生成知识页；小项目可以跳过');

  const gi = join(root, '.gitignore');
  if (existsSync(gi) && readFileSync(gi, 'utf8').split('\n').some((l) => l.trim() === `${DF}/runtime/`)) add('ok', '.gitignore', `已忽略 ${DF}/runtime/`);
  else add('warn', '.gitignore', `没有忽略 ${DF}/runtime/（验证日志与渲染页会被提交）`, `echo '${DF}/runtime/' >> .gitignore`);
  return out;
}
