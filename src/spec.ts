// 行为规范的 delta 格式：解析、校验与合并（格式与 OpenSpec 一致，便于迁移）
//
// 当前规范 specs/<cap>/spec.md：
//   # <cap>
//   ## Purpose
//   ## Requirements
//   ### Requirement: <名称>      ← 需求块直到下一个 ### Requirement 或 ## 标题
//   #### Scenario: <名称>
//
// 变更中的 delta specs/<cap>/spec.md：
//   ## Purpose（仅新能力，可选）
//   ## ADDED Requirements / ## MODIFIED Requirements / ## REMOVED Requirements

export interface Requirement { name: string; text: string; line: number }
export interface Delta {
  purpose?: string;
  added: Requirement[];
  modified: Requirement[];
  removed: Requirement[];
}

const REQ = /^### Requirement:\s*(.+?)\s*$/;
const SECTION = /^## (ADDED|MODIFIED|REMOVED) Requirements\s*$/;

/** 拆出需求块：每块从 ### Requirement 到下一块或下一个 ## 标题之前 */
function splitRequirements(lines: string[], offset: number): { reqs: Requirement[]; stray: number[] } {
  const reqs: Requirement[] = [];
  const stray: number[] = []; // 需求块之外的非空行
  let cur: Requirement | null = null;
  lines.forEach((line, i) => {
    const m = REQ.exec(line);
    if (m) {
      if (cur) reqs.push(cur);
      cur = { name: m[1], text: line, line: offset + i + 1 };
    } else if (cur) cur.text += `\n${line}`;
    else if (line.trim()) stray.push(offset + i + 1);
  });
  if (cur) reqs.push(cur);
  for (const r of reqs) r.text = r.text.trimEnd();
  return { reqs, stray };
}

/** 把文本按 ## 标题切段，返回 [标题, 起始行号(0 起), 段内行] */
function sections(text: string): { title: string; start: number; lines: string[] }[] {
  const out: { title: string; start: number; lines: string[] }[] = [];
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^## /.test(line)) out.push({ title: line, start: i, lines: [] });
    else if (out.length) out[out.length - 1].lines.push(line);
  });
  return out;
}

export function parseDelta(text: string): { delta: Delta; errors: { line: number; message: string }[] } {
  const delta: Delta = { added: [], modified: [], removed: [] };
  const errors: { line: number; message: string }[] = [];
  for (const s of sections(text)) {
    if (/^## Purpose\s*$/.test(s.title)) {
      delta.purpose = s.lines.join('\n').trim();
      continue;
    }
    const m = SECTION.exec(s.title);
    if (!m) {
      errors.push({ line: s.start + 1, message: `不认识的小节：${s.title.trim()}（只允许 Purpose 与 ADDED / MODIFIED / REMOVED Requirements）` });
      continue;
    }
    const { reqs, stray } = splitRequirements(s.lines, s.start + 1);
    for (const l of stray) errors.push({ line: l, message: '需求小节中的内容必须写在 ### Requirement: <名称> 之下' });
    const kind = m[1].toLowerCase() as 'added' | 'modified' | 'removed';
    delta[kind].push(...reqs);
    if (kind !== 'removed') {
      for (const r of reqs) {
        const body = r.text.split('\n').slice(1);
        if (!body.some((l) => /^#### Scenario:/.test(l))) errors.push({ line: r.line, message: `需求「${r.name}」至少要有一个 #### Scenario:` });
        if (!body.some((l) => /\b(SHALL|MUST)\b|必须|应当/.test(l))) errors.push({ line: r.line, message: `需求「${r.name}」需要用 SHALL / MUST（或"必须"）写出约束` });
      }
    }
  }
  const all = [...delta.added, ...delta.modified, ...delta.removed];
  const seen = new Set<string>();
  for (const r of all) {
    if (seen.has(r.name)) errors.push({ line: r.line, message: `需求名称重复：${r.name}` });
    seen.add(r.name);
  }
  if (!all.length) errors.push({ line: 1, message: 'delta 中没有任何需求' });
  return { delta, errors };
}

/** 当前规范中的需求名称 */
export function requirementNames(current: string): string[] {
  const req = sections(current).find((s) => /^## Requirements\s*$/.test(s.title));
  return req ? splitRequirements(req.lines, req.start + 1).reqs.map((r) => r.name) : [];
}

/**
 * 把 delta 合并进当前规范；current 为 null 表示新能力。
 * 返回新规范全文，或错误列表（任一错误都不产生结果）。
 */
export function mergeSpec(cap: string, current: string | null, delta: Delta): { text?: string; errors: string[] } {
  const errors: string[] = [];
  if (current === null) {
    if (delta.modified.length || delta.removed.length) errors.push(`能力 ${cap} 还没有当前规范，只能 ADDED`);
    if (errors.length) return { errors };
    const body = delta.added.map((r) => r.text).join('\n\n');
    return { text: `# ${cap}\n\n## Purpose\n\n${delta.purpose || '（待补充）'}\n\n## Requirements\n\n${body}\n`, errors };
  }

  const secs = sections(current);
  const reqSec = secs.find((s) => /^## Requirements\s*$/.test(s.title));
  if (!reqSec) return { errors: [`当前规范 ${cap} 缺少 ## Requirements 小节`] };
  const { reqs } = splitRequirements(reqSec.lines, reqSec.start + 1);
  const names = new Set(reqs.map((r) => r.name));
  for (const r of delta.added) if (names.has(r.name)) errors.push(`ADDED 的需求已存在：${r.name}（要改它请用 MODIFIED）`);
  for (const r of [...delta.modified, ...delta.removed]) if (!names.has(r.name)) errors.push(`要修改或删除的需求在当前规范中不存在：${r.name}`);
  if (delta.purpose !== undefined) errors.push(`能力 ${cap} 已有规范，delta 中不能再写 ## Purpose`);
  if (errors.length) return { errors };

  const modified = new Map(delta.modified.map((r) => [r.name, r.text]));
  const removed = new Set(delta.removed.map((r) => r.name));
  const kept = reqs.filter((r) => !removed.has(r.name)).map((r) => modified.get(r.name) ?? r.text);
  const newBody = [...kept, ...delta.added.map((r) => r.text)].join('\n\n');

  // 重建：Requirements 小节之前的内容原样保留，之后的其他小节也原样保留
  const lines = current.split('\n');
  const before = lines.slice(0, reqSec.start).join('\n').trimEnd();
  const afterStart = reqSec.start + 1 + reqSec.lines.length;
  const after = lines.slice(afterStart).join('\n').trim();
  const text = `${before}\n\n## Requirements\n\n${newBody}\n${after ? `\n${after}\n` : ''}`;
  return { text: text.replace(/^\n+/, ''), errors };
}
