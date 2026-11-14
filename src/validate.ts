// schema 校验：报错写给 Agent 看，带文件、原因和正确示例
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { dfOf, changeRel, git, repoFiles, rootOf, type Issue } from './core.ts';
import { mergeSpec, parseDelta } from './spec.ts';

const EX_PROJECT = `schema_version: 1
verify:
  - name: backend-test
    run: mvn -q test
    cwd: backend
exclude: [".env*"]
enforce: warn`;

const EX_CHANGE = `schema_version: 1
title: 新增角色权限控制
affected_paths:
  - backend/src/main/java/example/auth/**
summary:                 # 方案要点：最多 7 条，每条一句，显示在审查页首屏
  - 用户列表接口只允许 ADMIN 访问
decisions:               # 需要人拍板的事项；没有就写 []
  - question: 普通用户访问时返回 403 还是空列表？
    options: [返回 403, 返回空列表]
    recommend: 返回 403`;

export const MAX_SUMMARY = 7;

const EX_TASKS = `schema_version: 1
tasks:
  - id: T1
    title: 定义角色与权限模型
    acceptance: [UserRole 包含 ADMIN、USER]
  - id: T2
    title: 用户列表接口增加权限判断
    depends_on: [T1]`;

const EX_DELTA = `## ADDED Requirements

### Requirement: 用户列表需要 ADMIN 角色
系统 SHALL 拒绝非 ADMIN 用户访问用户列表。

#### Scenario: 普通用户访问
- WHEN USER 角色请求 /api/users
- THEN 返回 403`;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

/** 读 YAML；文件不存在返回 undefined，解析失败记一条错误并返回 undefined */
function loadYaml(root: string, rel: string, issues: Issue[], hint: string): unknown {
  const abs = join(root, rel);
  if (!existsSync(abs)) return undefined;
  try {
    return parse(readFileSync(abs, 'utf8'));
  } catch (e: any) {
    const line = e?.linePos?.[0]?.line;
    issues.push({ level: 'error', file: line ? `${rel}:${line}` : rel, message: `YAML 解析失败：${String(e?.message).split('\n')[0]}`, hint });
    return undefined;
  }
}

export function validateProject(root: string): Issue[] {
  const issues: Issue[] = [];
  const file = `${dfOf(root)}/project.yaml`;
  const err = (message: string) => issues.push({ level: 'error', file, message, hint: `示例：\n${EX_PROJECT}` });
  const p = loadYaml(root, file, issues, `示例：\n${EX_PROJECT}`);
  if (p === undefined) {
    if (!issues.length) err('文件不存在');
    return issues;
  }
  if (!isObj(p)) return (err('顶层必须是对象'), issues);
  if (p.schema_version !== 1) err('schema_version 必须为 1');
  if (!Array.isArray(p.verify)) err('verify 必须是数组（可以为空）');
  else {
    const names = new Set<string>();
    p.verify.forEach((v: any, i: number) => {
      if (!isObj(v) || !isStr(v.name) || !isStr(v.run)) err(`verify[${i}] 必须有 name 和 run`);
      else if (v.cwd !== undefined && !isStr(v.cwd)) err(`verify[${i}].cwd 必须是字符串`);
      else if (names.has(v.name)) err(`verify[${i}].name 重复：${v.name}`);
      else names.add(v.name);
    });
  }
  if (p.exclude !== undefined && !isStrList(p.exclude)) err('exclude 必须是字符串数组');
  if (p.code_roots !== undefined) {
    if (!isStrList(p.code_roots) || !p.code_roots.length) err('code_roots 必须是非空字符串数组：代码所在的 Git 仓库，路径相对本仓库根，例如 [../backend, ../frontend]');
    else for (const rel of p.code_roots) {
      // 必须是仓库根：子目录的树哈希会混进仓库其他部分的暂存状态
      let top = '';
      try { top = realpathSync(git(resolve(root, rel), ['rev-parse', '--show-toplevel']).trim()); } catch { /* 不存在或不是仓库 */ }
      if (!top || top !== realpathSync(resolve(root, rel))) err(`code_roots 中的 ${rel} 不是 Git 仓库的根目录`);
    }
  }
  if (p.stale_hours !== undefined && !(typeof p.stale_hours === 'number' && p.stale_hours > 0)) err('stale_hours 必须是正数（小时）');
  if (!['warn', 'strict'].includes(p.enforce)) err('enforce 必须是 warn 或 strict');
  return issues;
}

/** 读取 project.yaml 的 enforce；文件无效时按 warn 处理（错误另由 validateProject 报告） */
export function enforceLevel(root: string): 'warn' | 'strict' {
  try {
    return parse(readFileSync(join(root, dfOf(root), 'project.yaml'), 'utf8'))?.enforce === 'strict' ? 'strict' : 'warn';
  } catch {
    return 'warn';
  }
}

export interface Decision { question: string; options: string[]; recommend: string }
export interface ChangeMeta { title: string; affected_paths: string[]; summary?: string[]; decisions?: Decision[] }

// 选项会写进审查页的 ask 块：一行一个，`|` 是选项与备注的分隔符
const oneLine = (v: unknown): v is string => isStr(v) && !/[\n|]/.test(v);

/** decisions 的格式问题；合法时为空 */
function decisionErrors(list: unknown): string[] {
  if (!Array.isArray(list)) return ['decisions 必须是数组（没有待拍板事项时写 []）'];
  const out: string[] = [];
  list.forEach((d: any, i: number) => {
    const at = `decisions[${i}]`;
    if (!isObj(d) || !isStr(d.question) || d.question.includes('\n')) return out.push(`${at}.question 必须是单行非空字符串`);
    if (!Array.isArray(d.options) || d.options.length < 2 || !d.options.every(oneLine) || new Set(d.options).size !== d.options.length) {
      return out.push(`${at}.options 至少两个互不相同的单行选项，且不含 |`);
    }
    // 审查页的单选组件要求恰好一个建议项；提方案的人也应当给出推荐
    if (!d.options.includes(d.recommend)) out.push(`${at}.recommend 必须是 options 中的一项（每个事项都要给出推荐）`);
  });
  return out;
}
export interface Acceptance { id: string; text: string; method: 'automated' | 'manual'; check?: string }
export interface TaskDef { id: string; title: string; depends_on?: string[]; acceptance?: (string | Acceptance)[] }

/** change.yaml 合法时返回内容，否则返回 null */
export function loadChangeMeta(root: string, id: string): ChangeMeta | null {
  const issues: Issue[] = [];
  const m = loadYaml(root, `${changeRel(root, id)}/change.yaml`, issues, '');
  if (!isObj(m) || !isStr(m.title) || !isStrList(m.affected_paths)) return null;
  // 格式不对的 summary / decisions 由 validate 报错；这里按"没有"处理，调用方不必再判断
  return {
    title: m.title, affected_paths: m.affected_paths,
    summary: isStrList(m.summary) ? m.summary : [],
    decisions: m.decisions !== undefined && !decisionErrors(m.decisions).length ? m.decisions : [],
  };
}

export function loadTasks(root: string, id: string): TaskDef[] {
  const issues: Issue[] = [];
  const t = loadYaml(root, `${changeRel(root, id)}/tasks.yaml`, issues, '');
  return isObj(t) && Array.isArray(t.tasks) ? t.tasks.filter((x: any) => isObj(x) && isStr(x.id)) : [];
}

/**
 * 校验一个变更。complete=true（validate / approve）要求内容齐全；
 * complete=false（check）只校验已存在文件的格式，允许草稿写到一半。
 */
export function validateChange(root: string, id: string, complete: boolean): Issue[] {
  const issues: Issue[] = [];
  const base = changeRel(root, id);
  const err = (file: string, message: string, hint?: string) => issues.push({ level: 'error', file: `${base}/${file}`, message, hint });

  // change.yaml
  const m = loadYaml(root, `${base}/change.yaml`, issues, `示例：\n${EX_CHANGE}`);
  const hc = `示例：\n${EX_CHANGE}`;
  if (m === undefined) {
    if (!existsSync(join(root, base, 'change.yaml'))) err('change.yaml', '文件不存在', hc);
  } else if (!isObj(m)) err('change.yaml', '顶层必须是对象', hc);
  else {
    if (![1, 2].includes(m.schema_version)) err('change.yaml', 'schema_version 必须为 1 或 2', hc);
    if (m.schema_version === 2 && m.min_cli_version !== '0.2.0') err('change.yaml', 'v2 需要 min_cli_version: 0.2.0', hc);
    if (typeof m.title !== 'string' || (complete && !isStr(m.title))) err('change.yaml', 'title 必须是非空字符串', hc);
    if (!Array.isArray(m.affected_paths) || !m.affected_paths.every((p: unknown) => typeof p === 'string')) {
      err('change.yaml', 'affected_paths 必须是字符串数组', hc);
    } else {
      if (complete && !m.affected_paths.length) err('change.yaml', 'affected_paths 不能为空：列出本变更会改动的路径（glob）', hc);
      for (const p of m.affected_paths as string[]) {
        // 代码仓库里的路径：以某个 code_roots 项开头，去掉前缀后按仓库内路径检查
        const inner = rootOf(root, p)?.rest ?? p;
        if (!inner.trim() || inner.startsWith('/') || inner.split('/').includes('..') || inner === dfOf(root) || inner.startsWith(`${dfOf(root)}/`)) {
          err('change.yaml', `affected_paths 路径无效：${JSON.stringify(p)}（须为本仓库或 code_roots 声明的仓库内的相对路径，且不在 ${dfOf(root)}/ 下）`, hc);
        }
      }
    }
    // 审查页首屏：方案要点与待拍板事项。缺 summary 只提醒，不拦已在进行中的旧变更
    const warn = (message: string) => issues.push({ level: 'warn', file: `${base}/change.yaml`, message, hint: hc });
    if (m.summary !== undefined && !isStrList(m.summary)) err('change.yaml', 'summary 必须是字符串数组：每条一句方案要点', hc);
    else if (complete && !m.summary?.length) warn('没有 summary：审查页首屏不会显示方案要点');
    else if ((m.summary?.length ?? 0) > MAX_SUMMARY) warn(`summary 有 ${m.summary.length} 条，审查页首屏建议不超过 ${MAX_SUMMARY} 条`);
    if (m.decisions !== undefined) for (const e of decisionErrors(m.decisions)) err('change.yaml', e, hc);
  }

  // tasks.yaml
  const ht = `示例：\n${EX_TASKS}`;
  const t = loadYaml(root, `${base}/tasks.yaml`, issues, ht);
  if (t === undefined) {
    if (complete && !existsSync(join(root, base, 'tasks.yaml'))) err('tasks.yaml', '文件不存在', ht);
  } else if (!isObj(t) || ![1, 2].includes(t.schema_version) || !Array.isArray(t.tasks)) {
    err('tasks.yaml', '必须包含 schema_version: 1 和 tasks 数组', ht);
  } else {
    if (complete && !t.tasks.length) err('tasks.yaml', 'tasks 不能为空', ht);
    if (isObj(m) && t.schema_version !== m.schema_version) err('tasks.yaml', 'tasks 与 change 的 schema_version 必须一致');
    const acceptanceIds = new Set<string>();
    const project = loadYaml(root, `${dfOf(root)}/project.yaml`, issues, '检查 verify 配置');
    const checks = isObj(project) && Array.isArray(project.verify) ? project.verify.map((v: any) => v.name) : [];
    const ids = new Set<string>();
    t.tasks.forEach((x: any, i: number) => {
      if (!isObj(x) || !isStr(x.id) || !/^[A-Za-z][\w-]*$/.test(x.id)) return err('tasks.yaml', `tasks[${i}].id 必须是字母开头的标识，如 T1`, ht);
      if (ids.has(x.id)) err('tasks.yaml', `任务 ID 重复：${x.id}`, ht);
      ids.add(x.id);
      if (!isStr(x.title)) err('tasks.yaml', `${x.id}.title 必须是非空字符串`, ht);
      if (x.depends_on !== undefined && !isStrList(x.depends_on)) err('tasks.yaml', `${x.id}.depends_on 必须是任务 ID 数组`, ht);
      if (t.schema_version === 1 && x.acceptance !== undefined && !isStrList(x.acceptance)) err('tasks.yaml', `${x.id}.acceptance 必须是字符串数组`, ht);
      if (t.schema_version === 2) {
        if (!Array.isArray(x.acceptance) || !x.acceptance.length) err('tasks.yaml', `${x.id}.acceptance 不能为空`);
        else for (const a of x.acceptance) {
          if (!isObj(a) || !isStr(a.id) || !/^[A-Za-z][\w-]*$/.test(a.id) || !isStr(a.text) || !['automated', 'manual'].includes(a.method)) { err('tasks.yaml', `${x.id} 验收条件需要 id/text/method`); continue; }
          if (acceptanceIds.has(a.id)) err('tasks.yaml', `验收编号重复：${a.id}`);
          acceptanceIds.add(a.id);
          if (a.method === 'automated' && !checks.includes(a.check)) err('tasks.yaml', `${a.id}.check 不在 project.verify 中`);
        }
      }
      if ('status' in x || 'done' in x) err('tasks.yaml', `${x.id} 不能包含进度字段：进度由 tenon task done 记录在事件日志`);
    });
    const deps = new Map<string, string[]>();
    for (const x of t.tasks) if (isObj(x) && isStr(x.id)) deps.set(x.id, isStrList(x.depends_on) ? x.depends_on : []);
    for (const [tid, ds] of deps) for (const d of ds) if (!deps.has(d)) err('tasks.yaml', `${tid}.depends_on 引用了不存在的任务：${d}`, ht);
    const cycle = findCycle(deps);
    if (cycle) err('tasks.yaml', `任务依赖成环：${cycle.join(' -> ')}`);
  }

  // proposal.md
  const prop = join(root, base, 'proposal.md');
  if (complete) {
    const body = existsSync(prop) ? readFileSync(prop, 'utf8') : '';
    if (!body.split('\n').some((l) => l.trim() && !l.trim().startsWith('#') && !l.trim().startsWith('<!--'))) {
      err('proposal.md', existsSync(prop) ? '只有标题，没有正文：写清为什么改、改什么、影响什么' : '文件不存在');
    }
  }

  // delta specs
  const hd = `示例：\n${EX_DELTA}`;
  const specFiles = repoFiles(root, `${base}/specs`).filter((f) => f !== '.gitkeep');
  for (const f of specFiles) {
    if (!/^[a-z0-9][a-z0-9-]*\/spec\.md$/.test(f)) {
      err(`specs/${f}`, 'delta spec 路径必须是 specs/<capability>/spec.md（capability 用小写字母、数字、连字符）', hd);
      continue;
    }
    if (!complete) continue;
    const text = readFileSync(join(root, base, 'specs', f), 'utf8');
    if (!/^## (ADDED|MODIFIED|REMOVED) Requirements\s*$/m.test(text)) {
      err(`specs/${f}`, '缺少 ## ADDED / MODIFIED / REMOVED Requirements 小节', hd);
      continue;
    }
    // 解析并对当前规范做一次合并试算：名称冲突、改了不存在的需求等在审批前就暴露
    const { delta, errors } = parseDelta(text);
    for (const e of errors) issues.push({ level: 'error', file: `${base}/specs/${f}:${e.line}`, message: e.message, hint: hd });
    if (!errors.length) {
      const cap = f.split('/')[0];
      const cur = join(root, dfOf(root), 'specs', cap, 'spec.md');
      const merged = mergeSpec(cap, existsSync(cur) ? readFileSync(cur, 'utf8') : null, delta);
      for (const m of merged.errors) err(`specs/${f}`, m, `当前规范：${dfOf(root)}/specs/${cap}/spec.md`);
    }
  }
  if (complete && !specFiles.length) {
    issues.push({ level: 'warn', file: `${base}/specs/`, message: '没有 delta spec：归档时不会更新任何规范。若变更改变了系统行为，请补上', hint: hd });
  }
  return issues;
}

function findCycle(deps: Map<string, string[]>): string[] | null {
  const state = new Map<string, 1 | 2>(); // 1=访问中 2=已完成
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const d of deps.get(n) ?? []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of deps.keys()) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}
