// 为 Agent 生成技能、入口片段与禁止规则（单一模板 → 多种 Agent 的文件格式）
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DevflowError } from './core.ts';

export const AGENTS = ['claude', 'codex'] as const;
export type Agent = (typeof AGENTS)[number];

const TPL = fileURLToPath(new URL('../templates/', import.meta.url));
const SKILL_DIR: Record<Agent, string> = { claude: '.claude/skills', codex: '.agents/skills' };
const ENTRY_FILE: Record<Agent, string> = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
const BEGIN = '<!-- devflow:begin（由 devflow 生成；devflow update 会覆盖本段） -->';
const END = '<!-- devflow:end -->';

// Claude Code 项目设置中，以 / 开头的路径相对项目根目录
export const CLAUDE_DENY = [
  'Bash(devflow approve *)',
  'Bash(devflow archive *)',
  'Edit(/.devflow/specs/**)',
  'Write(/.devflow/specs/**)',
  'Edit(/.devflow/changes/**/events.jsonl)',
  'Write(/.devflow/changes/**/events.jsonl)',
];

export function parseAgents(value: string | undefined): Agent[] {
  if (!value) return [...AGENTS];
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((a) => !(AGENTS as readonly string[]).includes(a));
  if (bad.length || !list.length) throw new DevflowError(`不支持的 Agent：${bad.join(', ') || '（空）'}`, `可选：${AGENTS.join(', ')}`);
  return [...new Set(list)] as Agent[];
}

/** 已安装过技能的 Agent */
export function detectAgents(root: string): Agent[] {
  return AGENTS.filter((a) => existsSync(join(root, SKILL_DIR[a], 'devflow-ask', 'SKILL.md')));
}

/** 用 BEGIN/END 标记维护文件中的托管段落，段外内容不动 */
export function upsertBlock(text: string, block: string): string {
  const managed = `${BEGIN}\n${block.trimEnd()}\n${END}`;
  const s = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (s !== -1 && e > s) return text.slice(0, s) + managed + text.slice(e + END.length);
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
  return drift;
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
    const ef = join(root, ENTRY_FILE[a]);
    writeFileSync(ef, upsertBlock(existsSync(ef) ? readFileSync(ef, 'utf8') : '', entry));
    written.push(ENTRY_FILE[a]);
  }

  if (agents.includes('claude')) {
    const rel = '.claude/settings.json';
    const f = join(root, rel);
    let settings: any = {};
    let ok = true;
    if (existsSync(f)) {
      try {
        settings = JSON.parse(readFileSync(f, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
      } catch {
        ok = false;
        warnings.push(`${rel} 不是合法的 JSON 对象，未写入禁止规则。请手动在 permissions.deny 中加入：${CLAUDE_DENY.join(', ')}`);
      }
    }
    if (ok) {
      settings.permissions ??= {};
      const deny: unknown[] = Array.isArray(settings.permissions.deny) ? settings.permissions.deny : [];
      settings.permissions.deny = [...deny, ...CLAUDE_DENY.filter((r) => !deny.includes(r))];
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(settings, null, 2) + '\n');
      written.push(rel);
    }
  }

  if (agents.includes('codex')) {
    const rel = '.codex/rules/devflow.rules';
    mkdirSync(join(root, '.codex/rules'), { recursive: true });
    cpSync(join(TPL, 'devflow.rules'), join(root, rel));
    written.push(rel);
    warnings.push('Codex 只在项目 .codex/ 被信任时加载 rules；首次在本项目使用 Codex 时请选择信任');
  }
  return { written, warnings };
}
