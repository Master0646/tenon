// devflow wiki lint：知识页校验与过期检测（§6.2）
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, matchesGlob, normalize } from 'node:path';
import { parse } from 'yaml';
import { DF, archiveTarget, git, listChanges, listFiles, type Issue } from './core.ts';

const KDIR = `${DF}/knowledge`;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

const EX_PAGE = `---
schema_version: 1
title: 用户管理模块
verified_commit: "9f3a2c1"
sources:
  - path: backend/src/main/java/com/example/user/UserController.java
    symbol: UserController#list
  - path: backend/src/main/resources/mapper/UserMapper.xml
    lines: [10, 30]
related_specs: []
---`;

export interface PageSource { path: string; symbol?: string; lines?: [number, number] }
export interface Page { slug: string; title: string; verified_commit: string; sources: PageSource[] }

/** 拆出 frontmatter 与正文；没有 frontmatter 时返回 null */
function splitFrontmatter(text: string): { fm: string; body: string; bodyLine: number } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(text);
  return m ? { fm: m[1], body: text.slice(m[0].length), bodyLine: m[0].split('\n').length } : null;
}

/** project.yaml 的 exclude：不含 / 的模式匹配任意层级的文件名（同 .gitignore） */
export function loadExcludes(root: string): string[] {
  try {
    const p = parse(readFileSync(join(root, DF, 'project.yaml'), 'utf8'));
    return Array.isArray(p?.exclude) ? p.exclude.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function isExcluded(path: string, patterns: string[]): boolean {
  return patterns.some((p) => (p.includes('/') ? matchesGlob(path, p) : path.split('/').some((seg) => matchesGlob(seg, p))));
}

export function lintWiki(root: string): { issues: Issue[]; pages: Page[] } {
  const issues: Issue[] = [];
  const pages: Page[] = [];
  const excludes = loadExcludes(root);
  const files = listFiles(join(root, KDIR, 'pages')).filter((f) => f !== '.gitkeep');
  const slugs = new Set(files.filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));

  for (const f of files) {
    const rel = `${KDIR}/pages/${f}`;
    const err = (message: string, hint?: string, line?: number) =>
      issues.push({ level: 'error', file: line ? `${rel}:${line}` : rel, message, hint });
    const slug = f.replace(/\.md$/, '');
    if (!f.endsWith('.md') || !SLUG.test(slug)) {
      err('知识页必须是 pages/<slug>.md，slug 用小写字母、数字、连字符，不建子目录');
      continue;
    }
    const text = readFileSync(join(root, rel), 'utf8');
    const parts = splitFrontmatter(text);
    if (!parts) {
      err('缺少 frontmatter', `页面开头示例：\n${EX_PAGE}`, 1);
      continue;
    }
    let fm: any;
    try {
      fm = parse(parts.fm);
      // 不加引号的短哈希可能被 YAML 当成数字（1234567、1e23456、0123456 丢掉前导 0）：按原文字符串读取
      const raw = parse(parts.fm, { schema: 'failsafe' });
      if (fm && typeof fm === 'object' && raw && typeof raw.verified_commit === 'string') fm.verified_commit = raw.verified_commit;
    } catch (e: any) {
      err(`frontmatter YAML 解析失败：${String(e?.message).split('\n')[0]}`, undefined, (e?.linePos?.[0]?.line ?? 0) + 1);
      continue;
    }
    const before = issues.length;
    if (!fm || typeof fm !== 'object' || fm.schema_version !== 1) err('frontmatter 必须包含 schema_version: 1', `示例：\n${EX_PAGE}`);
    else {
      if (typeof fm.title !== 'string' || !fm.title.trim()) err('title 必须是非空字符串', `示例：\n${EX_PAGE}`);
      if (typeof fm.verified_commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(fm.verified_commit)) {
        err('verified_commit 必须是提交哈希', '写完页面后填入 git rev-parse --short HEAD 的输出');
      }
      if (!Array.isArray(fm.sources) || !fm.sources.length) err('sources 不能为空：每页至少引用一个源码文件', `示例：\n${EX_PAGE}`);
      if (fm.related_specs !== undefined && !(Array.isArray(fm.related_specs) && fm.related_specs.every((s: unknown) => typeof s === 'string'))) {
        err('related_specs 必须是字符串数组');
      }
    }
    if (issues.length > before) continue;

    const sources: PageSource[] = [];
    fm.sources.forEach((s: any, i: number) => {
      const at = `sources[${i}]`;
      if (!s || typeof s.path !== 'string' || !s.path.trim()) return err(`${at}.path 必须是仓库内相对路径`, `示例：\n${EX_PAGE}`);
      const p = normalize(s.path).split('\\').join('/');
      if (p.startsWith('/') || p.startsWith('..')) return err(`${at}.path 必须是仓库内相对路径：${s.path}`);
      if (isExcluded(p, excludes)) return err(`${at}.path 属于 project.yaml 的 exclude，不得引用：${s.path}`);
      const abs = join(root, p);
      if (!existsSync(abs)) return err(`${at}.path 文件不存在：${s.path}`, '路径改了就更新引用；功能删了就更新页面内容');
      const content = readFileSync(abs, 'utf8');
      if (s.symbol !== undefined) {
        const missing = typeof s.symbol === 'string' && s.symbol.trim()
          ? s.symbol.split(/[#.]/).filter(Boolean).filter((part: string) => !content.includes(part))
          : ['(空)'];
        if (missing.length) return err(`${at}.symbol ${JSON.stringify(s.symbol)} 在 ${s.path} 中找不到：${missing.join(', ')}`, '符号写成 类名 或 类名#方法名，须与源码中的文字一致');
      }
      if (s.lines !== undefined) {
        const n = content.split('\n').length;
        const ok = Array.isArray(s.lines) && s.lines.length === 2 && s.lines.every(Number.isInteger) && s.lines[0] >= 1 && s.lines[0] <= s.lines[1] && s.lines[1] <= n;
        if (!ok) return err(`${at}.lines 必须是 [起始行, 结束行]，且在 1..${n} 之内`);
      }
      sources.push({ path: p, symbol: s.symbol, lines: s.lines });
    });

    // 正文链接：[[slug]] 与指向 .md 的相对链接
    const lines = parts.body.split('\n');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\[\[([^\]]+)\]\]/g)) {
        if (!slugs.has(m[1])) err(`链接 [[${m[1]}]] 指向的页面不存在`, undefined, parts.bodyLine + i);
      }
      for (const m of line.matchAll(/\]\(([^)\s#]+\.md)(#[^)]*)?\)/g)) {
        if (/^[a-z]+:/i.test(m[1])) continue;
        const target = normalize(join(dirname(rel), m[1])).split('\\').join('/');
        if (!existsSync(join(root, target)) && !pendingArchiveFile(root, target)) err(`链接 ${m[1]} 指向的文件不存在`, undefined, parts.bodyLine + i);
      }
    });

    // 正文以完整路径引用、但没列进 sources 的文件：它变了页面不会被标 stale
    const listedPaths = new Set(sources.map((s) => s.path));
    const unlisted = new Set<string>();
    for (const m of parts.body.matchAll(/(?:[\w@.-]+\/)+[\w@.-]+\.\w+/g)) {
      const p = m[0];
      if (!listedPaths.has(p) && !p.startsWith(`${DF}/`) && existsSync(join(root, p))) unlisted.add(p);
    }
    if (unlisted.size) {
      issues.push({ level: 'warn', file: rel, message: `正文引用了未列入 sources 的文件：${[...unlisted].join(', ')}`, hint: '把这些文件加进 sources，否则它们改动时本页不会被标为 stale' });
    }

    if (sources.length === fm.sources.length) {
      pages.push({ slug, title: fm.title, verified_commit: fm.verified_commit, sources });
      issues.push(...staleness(root, rel, fm.verified_commit, sources.map((s) => s.path)));
    }
  }

  // index.md 必须恰好列出全部页面
  const indexRel = `${KDIR}/index.md`;
  const indexText = (existsSync(join(root, indexRel)) ? readFileSync(join(root, indexRel), 'utf8') : '').replace(/<!--[\s\S]*?-->/g, '');
  const listed = new Set([...indexText.matchAll(/\]\(pages\/([^)\s]+)\.md\)/g)].map((m) => m[1]));
  for (const s of slugs) {
    if (!listed.has(s)) issues.push({ level: 'error', file: indexRel, message: `漏列了页面 pages/${s}.md`, hint: `加一行：- [标题](pages/${s}.md) — 一句话摘要` });
  }
  for (const s of listed) {
    if (!slugs.has(s)) issues.push({ level: 'error', file: indexRel, message: `列了不存在的页面 pages/${s}.md` });
  }
  return { issues, pages };
}

/** 链接指向某个进行中变更归档后的位置，且该文件现在就在变更目录里：归档前写好的设计原因链接 */
function pendingArchiveFile(root: string, target: string): boolean {
  const m = /^\.devflow\/changes\/archive\/([^/]+)\/(.+)$/.exec(target);
  if (!m) return false;
  return listChanges(root).some((id) => archiveTarget(id) === `${DF}/changes/archive/${m[1]}` && existsSync(join(root, DF, 'changes', id, m[2])));
}

/** 引用文件在 verified_commit 之后（含未提交的修改）有改动 → stale */
function staleness(root: string, rel: string, commit: string, paths: string[]): Issue[] {
  let changed: string[];
  try {
    git(root, ['cat-file', '-e', `${commit}^{commit}`]);
    changed = git(root, ['diff', '--name-only', commit, '--', ...paths]).split('\n').filter(Boolean);
  } catch {
    return [{ level: 'error', file: rel, message: `verified_commit ${commit} 不在当前仓库历史中`, hint: '核对页面内容后，填入 git rev-parse --short HEAD 的输出' }];
  }
  return changed.length ? [{
    level: 'warn', file: rel,
    message: `stale：引用的文件在 ${commit} 之后有改动：${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' …' : ''}`,
    hint: '对照源码核对页面内容，更新后把 verified_commit 改为当前提交',
  }] : [];
}
