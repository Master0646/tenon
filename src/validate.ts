// schema 校验：报错写给 Agent 看，带文件、原因和正确示例
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DF, changeDir, changeRel, listFiles, type Issue } from './core.ts';

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
  - backend/src/main/java/example/auth/**`;

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
  const file = `${DF}/project.yaml`;
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
  if (!['warn', 'strict'].includes(p.enforce)) err('enforce 必须是 warn 或 strict');
  return issues;
}

/** 读取 project.yaml 的 enforce；文件无效时按 warn 处理（错误另由 validateProject 报告） */
export function enforceLevel(root: string): 'warn' | 'strict' {
  try {
    return parse(readFileSync(join(root, DF, 'project.yaml'), 'utf8'))?.enforce === 'strict' ? 'strict' : 'warn';
  } catch {
    return 'warn';
  }
}

export interface ChangeMeta { title: string; affected_paths: string[] }
export interface TaskDef { id: string; title: string; depends_on?: string[]; acceptance?: string[] }

/** change.yaml 合法时返回内容，否则返回 null */
export function loadChangeMeta(root: string, id: string): ChangeMeta | null {
  const issues: Issue[] = [];
  const m = loadYaml(root, `${changeRel(id)}/change.yaml`, issues, '');
  return isObj(m) && isStr(m.title) && isStrList(m.affected_paths) ? (m as ChangeMeta) : null;
}

export function loadTasks(root: string, id: string): TaskDef[] {
  const issues: Issue[] = [];
  const t = loadYaml(root, `${changeRel(id)}/tasks.yaml`, issues, '');
  return isObj(t) && Array.isArray(t.tasks) ? t.tasks.filter((x: any) => isObj(x) && isStr(x.id)) : [];
}

/**
 * 校验一个变更。complete=true（validate / approve）要求内容齐全；
 * complete=false（check）只校验已存在文件的格式，允许草稿写到一半。
 */
export function validateChange(root: string, id: string, complete: boolean): Issue[] {
  const issues: Issue[] = [];
  const base = changeRel(id);
  const err = (file: string, message: string, hint?: string) => issues.push({ level: 'error', file: `${base}/${file}`, message, hint });

  // change.yaml
  const m = loadYaml(root, `${base}/change.yaml`, issues, `示例：\n${EX_CHANGE}`);
  const hc = `示例：\n${EX_CHANGE}`;
  if (m === undefined) {
    if (!existsSync(join(root, base, 'change.yaml'))) err('change.yaml', '文件不存在', hc);
  } else if (!isObj(m)) err('change.yaml', '顶层必须是对象', hc);
  else {
    if (m.schema_version !== 1) err('change.yaml', 'schema_version 必须为 1', hc);
    if (typeof m.title !== 'string' || (complete && !isStr(m.title))) err('change.yaml', 'title 必须是非空字符串', hc);
    if (!Array.isArray(m.affected_paths) || !m.affected_paths.every((p: unknown) => typeof p === 'string')) {
      err('change.yaml', 'affected_paths 必须是字符串数组', hc);
    } else {
      if (complete && !m.affected_paths.length) err('change.yaml', 'affected_paths 不能为空：列出本变更会改动的路径（glob）', hc);
      for (const p of m.affected_paths as string[]) {
        if (!p.trim() || p.startsWith('/') || p.split('/').includes('..') || p === DF || p.startsWith(`${DF}/`)) {
          err('change.yaml', `affected_paths 路径无效：${JSON.stringify(p)}（须为仓库内相对路径，且不在 ${DF}/ 下）`, hc);
        }
      }
    }
  }

  // tasks.yaml
  const ht = `示例：\n${EX_TASKS}`;
  const t = loadYaml(root, `${base}/tasks.yaml`, issues, ht);
  if (t === undefined) {
    if (complete && !existsSync(join(root, base, 'tasks.yaml'))) err('tasks.yaml', '文件不存在', ht);
  } else if (!isObj(t) || t.schema_version !== 1 || !Array.isArray(t.tasks)) {
    err('tasks.yaml', '必须包含 schema_version: 1 和 tasks 数组', ht);
  } else {
    if (complete && !t.tasks.length) err('tasks.yaml', 'tasks 不能为空', ht);
    const ids = new Set<string>();
    t.tasks.forEach((x: any, i: number) => {
      if (!isObj(x) || !isStr(x.id) || !/^[A-Za-z][\w-]*$/.test(x.id)) return err('tasks.yaml', `tasks[${i}].id 必须是字母开头的标识，如 T1`, ht);
      if (ids.has(x.id)) err('tasks.yaml', `任务 ID 重复：${x.id}`, ht);
      ids.add(x.id);
      if (!isStr(x.title)) err('tasks.yaml', `${x.id}.title 必须是非空字符串`, ht);
      if (x.depends_on !== undefined && !isStrList(x.depends_on)) err('tasks.yaml', `${x.id}.depends_on 必须是任务 ID 数组`, ht);
      if (x.acceptance !== undefined && !isStrList(x.acceptance)) err('tasks.yaml', `${x.id}.acceptance 必须是字符串数组`, ht);
      if ('status' in x || 'done' in x) err('tasks.yaml', `${x.id} 不能包含进度字段：进度由 devflow task done 记录在事件日志`);
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
  const specFiles = listFiles(join(changeDir(root, id), 'specs')).filter((f) => f !== '.gitkeep');
  for (const f of specFiles) {
    if (!/^[a-z0-9][a-z0-9-]*\/spec\.md$/.test(f)) {
      err(`specs/${f}`, 'delta spec 路径必须是 specs/<capability>/spec.md（capability 用小写字母、数字、连字符）', hd);
      continue;
    }
    if (complete && !/^## (ADDED|MODIFIED|REMOVED) Requirements\s*$/m.test(readFileSync(join(root, base, 'specs', f), 'utf8'))) {
      err(`specs/${f}`, '缺少 ## ADDED / MODIFIED / REMOVED Requirements 小节', hd);
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
