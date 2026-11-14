// 从评测目录中的原始结果评分并写 report.md
// 单独运行：node eval/report.ts <结果目录>（评分规则修改后重算，不调用模型）
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles } from '../src/core.ts';
import { loadQuestions, scoreAnswer, summarize, type Summary } from './score.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEMO = fileURLToPath(new URL('../examples/user-admin', import.meta.url));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

export function writeReport(dir: string): Summary & { avgTurns: number; avgCost: number; answerCost: number } {
  const { answers, files } = JSON.parse(readFileSync(join(dir, 'answers.json'), 'utf8'));
  const meta = JSON.parse(readFileSync(join(dir, 'scan.json'), 'utf8'));
  const projectFiles: string[] = files ?? listFiles(DEMO); // 早期结果没有保存文件清单，用演示项目代替
  const byId = new Map(answers.map((a: any) => [a.id, a]));
  // 只评当次答过的题：题库新增题目不影响旧结果
  const questions = loadQuestions(readFileSync(join(HERE, 'questions.yaml'), 'utf8')).filter((q) => byId.has(q.id));
  const scores = questions.map((q) => scoreAnswer(q, (byId.get(q.id) as any)?.answer ?? '', projectFiles));
  const summary = summarize(scores);
  const ans = questions.map((q) => byId.get(q.id) as any);
  const turns: number[] = ans.map((a) => a?.turns ?? 0);
  const costs: number[] = ans.map((a) => a?.cost ?? 0);
  const sum = (xs: number[]) => xs.reduce((x, y) => x + y, 0);
  const usage = { avgTurns: sum(turns) / turns.length, avgCost: sum(costs) / costs.length, answerCost: sum(costs) };

  const rows = scores.map((s, i) => {
    const q = questions[i];
    const conclusion = s.conclusion === undefined ? '' : s.conclusion ? ' · 结论 ✓' : ' · **结论 ✗**';
    const cell = q.unanswerable ? (s.correct ? 'ok 拒答' : 'no 未拒答') : `召回 ${pct(s.recall!)} · 准确 ${pct(s.precision!)}${conclusion}`;
    return `| ${s.id} | ${q.q} | ${cell} | ${s.cited.length} | ${s.unresolved.join(', ') || '—'} | ${turns[i]} | $${costs[i].toFixed(3)} |`;
  });
  const lintErrors = meta.lint?.issues?.filter((x: any) => x.level === 'error').length ?? 0;
  const tenonLines = [
    `- 禁止规则探针：\`tenon approve\` ${meta.probe?.denied ? '被拦截' : '**未被拦截**'}`,
    `- scan：${meta.pages?.length ?? '?'} 个知识页，wiki lint ${meta.lint?.ok ? '通过' : `**有 ${lintErrors} 个错误**`}，${meta.scan?.num_turns ?? '?'} 轮，$${meta.scan?.total_cost_usd?.toFixed(2) ?? '?'}`,
  ];
  writeFileSync(join(dir, 'report.md'), `# 评测结果 ${basename(dir)}

- 组别：${meta.control ? '**对照组**：未安装 Tenon，引用要求放在系统提示中' : 'Tenon 组：init + scan 后作答'}
- 模型：${meta.model ?? 'claude 默认'}；只加载项目级设置（--setting-sources project,local）
${meta.control ? '' : tenonLines.join('\n') + '\n'}- 总花费：${meta.cost !== undefined ? `$${meta.cost.toFixed(2)}` : '见 answers.json'}

| 指标 | 值 |
| --- | --- |
| 引用召回率（可回答 ${summary.answerable} 题） | ${pct(summary.recall)} |
| 引用准确率 | ${pct(summary.precision)} |
| 无引用回答率 | ${pct(summary.noCitationRate)} |
| "未知"题正确拒答率（${summary.unanswerable} 题） | ${pct(summary.unknownCorrectRate)} |
| 找不到的引用（编造或写错）总数 | ${summary.unresolvedCitations} |
${summary.reasoning ? `| 推理题结论正确率（${summary.reasoning} 题） | ${pct(summary.conclusionRate)} |\n` : ''}| 每题平均轮数 | ${usage.avgTurns.toFixed(1)} |
| 每题平均花费 | $${usage.avgCost.toFixed(3)} |
| 作答总花费（不含 scan） | $${usage.answerCost.toFixed(2)} |

| 题 | 问题 | 结果 | 引用数 | 找不到的引用 | 轮数 | 花费 |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}
`);
  writeFileSync(join(dir, 'scores.json'), JSON.stringify({ summary, usage, scores }, null, 2));
  return { ...summary, ...usage };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法：node eval/report.ts <结果目录>');
    process.exit(1);
  }
  console.log(JSON.stringify(writeReport(resolve(dir)), null, 2));
}
