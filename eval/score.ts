// 评测评分：只用确定性规则，不调用模型
import { parse } from 'yaml';

export interface Question {
  id: string;
  q: string;
  must?: string[][];
  ok?: string[];
  unanswerable?: boolean;
  expect?: string[]; // 结论正则：全部匹配才算结论正确
}

export interface Score {
  id: string;
  cited: string[];       // 解析到项目真实文件的引用
  unresolved: string[];  // 像文件路径、但项目里找不到（编造或写错）
  recall?: number;       // 可回答题：满足的 must 组 / must 组数
  precision?: number;    // 可回答题：相关引用 / 全部引用
  noCitation?: boolean;  // 可回答题：一个文件引用都没有
  saidUnknown: boolean;
  correct?: boolean;     // 不可回答题：是否回答了未知
  conclusion?: boolean;  // 有 expect 的题：结论是否正确
}

const FILE_RE = /(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.(?:java|xml|ya?ml|sql|vue|js|ts|json|properties)\b/g;
// 回答以"未知"开头，或明确说明代码中没有找到 / 没有使用
const UNKNOWN_RE = /未知|(?:没有|未)(?:找到|发现|使用|引入|实现|配置)|不存在|并未(?:使用|实现)|没有(?:相关|任何)/;
// 不计入评分的路径：Tenon 与 Agent 自己的文件
const IGNORED = /^(?:\.tenon|\.claude|\.agents|\.codex)\//;

export function loadQuestions(text: string): Question[] {
  const doc = parse(text);
  const prefix: Record<string, string> = doc.prefix ?? {};
  const expand = (p: string) => p.replace(/^([A-Z])\//, (m, k) => (prefix[k] ? `${prefix[k]}/` : m));
  return doc.questions.map((q: Question) => ({
    ...q,
    must: q.must?.map((group) => group.map(expand)),
    ok: q.ok?.map(expand),
  }));
}

/** 从回答中抽出文件引用，解析到项目文件；只写文件名时按唯一后缀匹配 */
export function extractCitations(answer: string, files: string[]): { cited: string[]; unresolved: string[] } {
  const cited = new Set<string>();
  const unresolved = new Set<string>();
  for (const m of answer.matchAll(FILE_RE)) {
    const raw = m[0].replace(/^(?:\.\.?\/)+/, ''); // ./x 与 ../x（回答里引用的 import 路径）按后缀匹配
    if (IGNORED.test(raw) || /^(?:CLAUDE|AGENTS)\.md$/.test(raw)) continue;
    const hits = files.includes(raw) ? [raw] : files.filter((f) => f.endsWith(`/${raw}`));
    if (hits.length) hits.forEach((h) => cited.add(h));
    else unresolved.add(raw);
  }
  return { cited: [...cited].sort(), unresolved: [...unresolved].sort() };
}

export function scoreAnswer(q: Question, answer: string, files: string[]): Score {
  const { cited, unresolved } = extractCitations(answer, files);
  const saidUnknown = UNKNOWN_RE.test(answer);
  if (q.unanswerable) return { id: q.id, cited, unresolved, saidUnknown, correct: saidUnknown };
  const must = q.must ?? [];
  const relevant = new Set([...must.flat(), ...(q.ok ?? [])]);
  return {
    id: q.id, cited, unresolved, saidUnknown,
    recall: must.length ? must.filter((g) => g.some((f) => cited.includes(f))).length / must.length : 1,
    precision: cited.length ? cited.filter((f) => relevant.has(f)).length / cited.length : 0,
    noCitation: cited.length === 0,
    ...(q.expect ? { conclusion: q.expect.every((re) => new RegExp(re).test(answer)) } : {}),
  };
}

export interface Summary {
  answerable: number;
  unanswerable: number;
  recall: number;
  precision: number;
  noCitationRate: number;
  unknownCorrectRate: number;
  unresolvedCitations: number;
  reasoning: number;      // 有 expect 的题数
  conclusionRate: number; // 其中结论正确的比例
}

export function summarize(scores: Score[]): Summary {
  const a = scores.filter((s) => s.recall !== undefined);
  const u = scores.filter((s) => s.correct !== undefined);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : 0);
  return {
    answerable: a.length,
    unanswerable: u.length,
    recall: mean(a.map((s) => s.recall!)),
    precision: mean(a.map((s) => s.precision!)),
    noCitationRate: mean(a.map((s) => (s.noCitation ? 1 : 0))),
    unknownCorrectRate: mean(u.map((s) => (s.correct ? 1 : 0))),
    unresolvedCitations: scores.reduce((n, s) => n + s.unresolved.length, 0),
    reasoning: scores.filter((s) => s.conclusion !== undefined).length,
    conclusionRate: mean(scores.filter((s) => s.conclusion !== undefined).map((s) => (s.conclusion ? 1 : 0))),
  };
}
