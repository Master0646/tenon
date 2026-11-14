// 为 Agent 生成技能、入口片段与禁止规则（单一模板 → 多种 Agent 的文件格式）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevflowError } from './core.ts';

export const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];

const TPL = fileURLToPath(new URL('../templates/', import.meta.url));
const SKILL_DIR: Record<Agent, string> = { claude: '.claude/skills', codex: '.agents/skills' };
const ENTRY_FILE: Record<Agent, string> = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
const BEGIN = '<!-- tenon:begin（由 tenon 生成；tenon update 会覆盖本段） -->';
const END = '<!-- tenon:end -->';
// 改名前生成的托管段落：升级时原地替换成新标记，段外内容不动
const OLD_BEGIN = /<!-- devflow:begin[^>]*-->/;
const OLD_END = '<!-- devflow:end -->';

// Claude Code 项目设置中，以 / 开头的路径相对项目根目录
// 两种数据目录都保护：旧项目沿用 .devflow/
export const CLAUDE_DENY = [
  'Bash(tenon approve *)',
  'Bash(tenon archive *)',
  'Bash(tenon evidence confirm *)',
  'Bash(tenon review)',
  'Bash(tenon review *)',
  ...['.tenon', '.devflow'].flatMap((d) => [
    `Edit(/${d}/specs/**)`,
    `Write(/${d}/specs/**)`,
    `Edit(/${d}/changes/**/events.jsonl)`,
    `Write(/${d}/changes/**/events.jsonl)`,
  ]),
];

const CLAUDE_SETTINGS = '.claude/settings.json';
const CODEX_RULES = '.codex/rules/tenon.rules';
const CODEX_HOOKS = '.codex/hooks.json';
// Codex 的 PreToolUse 钩子：rules 只管命令前缀，换个写法就漏，也不管文件编辑（apply_patch）
// 命令不写绝对路径：hooks.json 会提交进仓库，给多台机器用
export const CODEX_HOOK = { matcher: 'Bash|apply_patch', hooks: [{ type: 'command', command: 'tenon guard' }] };
const hasGuard = (hooks: any): boolean => JSON.stringify(hooks?.hooks?.PreToolUse ?? '').includes(CODEX_HOOK.hooks[0].command);

/** 读 JSON 对象：文件不存在给 {}，不是合法的 JSON 对象给 null */
function readJsonObject(file: string): any {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

export function parseAgents(value: string | undefined): Agent[] {
  if (!value) return [...AGENTS];
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (bad.length || !list.length) throw new DevflowError(`不支持的 Agent：${bad.join(', ') || '（空）'}`, `可选：${AGENTS.join(', ')}`);
  return [...new Set(list)] as Agent[];
}

const MARKERS: Record<Agent, string[]> = { claude: ['.claude', 'CLAUDE.md'], codex: ['.codex', '.agents', 'AGENTS.md'] };

/** init 未指定 --agents 时：已安装的，加上项目里有目录或说明文件的；一个都没有时返回 null */
export function guessAgents(root: string): Agent[] | null {
  const found = AGENTS.filter((a) => MARKERS[a].some((m) => existsSync(join(root, m))));
  return found.length ? found : null;
}

/** 已安装过技能的 Agent */
export function detectAgents(root: string): Agent[] {
  return AGENTS.filter((a) => ['tenon-ask', 'devflow-ask'].some((s) => existsSync(join(root, SKILL_DIR[a], s, 'SKILL.md'))));
}

/** 用 BEGIN/END 标记维护文件中的托管段落，段外内容不动 */
export function upsertBlock(text: string, block: string): string {
  const managed = `${BEGIN}\n${block.trimEnd()}\n${END}`;
  const s = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (s !== -1 && e > s) return text.slice(0, s) + managed + text.slice(e + END.length);
  const os = text.search(OLD_BEGIN);
  const oe = text.indexOf(OLD_END);
  if (os !== -1 && oe > os) return text.slice(0, os) + managed + text.slice(oe + OLD_END.length);
  return text ? `${text.trimEnd()}\n\n${managed}\n` : `${managed}\n`;
}

export interface AgentResult { written: string[]; warnings: string[] }

const templateSkills = () => readdirSync(join(TPL, 'skills')).filter((s) => existsSync(join(TPL, 'skills', s, 'SKILL.md')));

/** 与当前版本模板不一致（缺失或被改动）的 Agent 文件 */
export function agentDrift(root: string, agent: Agent): string[] {
  const drift: string[] = [];
  for (const s of templateSkills()) {
    const rel = `${SKILL_DIR[agent]}/${s}/SKILL.md`;
    const f = join(root, rel);
    if (!existsSync(f) || readFileSync(f, 'utf8') !== readFileSync(join(TPL, 'skills', s, 'SKILL.md'), 'utf8')) drift.push(rel);
  }
  const ef = join(root, ENTRY_FILE[agent]);
  const entry = readFileSync(join(TPL, 'entry.md'), 'utf8');
  const text = existsSync(ef) ? readFileSync(ef, 'utf8') : '';
  if (upsertBlock(text, entry) !== text) drift.push(ENTRY_FILE[agent]);
  // 防线文件：被删或被改时技能还在，但 Agent 越级不再被拦
  if (agent === 'claude') {
    const deny = readJsonObject(join(root, CLAUDE_SETTINGS))?.permissions?.deny;
    if (!Array.isArray(deny) || CLAUDE_DENY.some((r) => !deny.includes(r))) drift.push(CLAUDE_SETTINGS);
  } else {
    const rules = join(root, CODEX_RULES);
    if (!existsSync(rules) || readFileSync(rules, 'utf8') !== readFileSync(join(TPL, 'tenon.rules'), 'utf8')) drift.push(CODEX_RULES);
    if (!hasGuard(readJsonObject(join(root, CODEX_HOOKS)))) drift.push(CODEX_HOOKS);
  }
  return drift;
}

/** 改名前生成、内容仍带生成标记的技能与规则：删掉，免得新旧两套同时生效。被人改过（没有标记）的保留 */
function removeOldGenerated(root: string, dir: string): string[] {
  const removed: string[] = [];
  const base = join(root, dir);
  if (!existsSync(base)) return removed;
  for (const name of readdirSync(base)) {
    if (!/^devflow(-[a-z]+|\.rules)$/.test(name)) continue;
    const file = name.endsWith('.rules') ? join(base, name) : join(base, name, 'SKILL.md');
    if (!existsSync(file) || !readFileSync(file, 'utf8').includes('由 devflow 生成')) continue;
    rmSync(join(base, name), { recursive: true, force: true });
    removed.push(`${dir}/${name}（已删除旧版生成的文件）`);
  }
  return removed;
}

export function installAgents(root: string, agents: Agent[]): AgentResult {
  const written: string[] = [];
  const warnings: string[] = [];
  const entry = readFileSync(join(TPL, 'entry.md'), 'utf8');
  const skills = templateSkills();

  for (const a of agents) {
    for (const s of skills) {
      const dest = `${SKILL_DIR[a]}/${s}`;
      cpSync(join(TPL, 'skills', s), join(root, dest), { recursive: true });
      written.push(`${dest}/SKILL.md`);
    }
    written.push(...removeOldGenerated(root, SKILL_DIR[a]));
    const ef = join(root, ENTRY_FILE[a]);
    writeFileSync(ef, upsertBlock(existsSync(ef) ? readFileSync(ef, 'utf8') : '', entry));
    written.push(ENTRY_FILE[a]);
  }

  const writeJson = (rel: string, value: unknown) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), JSON.stringify(value, null, 2) + '\n');
    written.push(rel);
  };

  if (agents.includes('claude')) {
    const settings = readJsonObject(join(root, CLAUDE_SETTINGS));
    if (!settings) warnings.push(`${CLAUDE_SETTINGS} 不是合法的 JSON 对象，未写入禁止规则。请手动在 permissions.deny 中加入：${CLAUDE_DENY.join(', ')}`);
    else {
      settings.permissions ??= {};
      const deny: unknown[] = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];
      settings.permissions.deny = [...deny, ...CLAUDE_DENY.filter((r) => !deny.includes(r))];
      writeJson(CLAUDE_SETTINGS, settings);
    }
  }

  if (agents.includes('codex')) {
    mkdirSync(join(root, '.codex/rules'), { recursive: true });
    cpSync(join(TPL, 'tenon.rules'), join(root, CODEX_RULES));
    written.push(...removeOldGenerated(root, '.codex/rules'));
    written.push(CODEX_RULES);
    const hooks = readJsonObject(join(root, CODEX_HOOKS));
    if (!hooks) warnings.push(`${CODEX_HOOKS} 不是合法的 JSON 对象，未登记钩子。请手动在 hooks.PreToolUse 中加入：${JSON.stringify(CODEX_HOOK)}`);
    else {
      if (!hasGuard(hooks)) {
        hooks.hooks ??= {};
        hooks.hooks.PreToolUse = [...(Array.isArray(hooks.hooks.PreToolUse) ? hooks.hooks.PreToolUse : []), CODEX_HOOK];
      }
      writeJson(CODEX_HOOKS, hooks);
    }
    warnings.push('Codex 只在项目 .codex/ 被信任时加载 rules 和 hooks；首次在本项目使用 Codex 时请选择信任，并用 /hooks 确认 tenon guard 钩子');
  }
  return { written, warnings };
}
