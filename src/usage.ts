// 本地使用记录与聚合，不参与业务状态判定。
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DevflowError, DF } from './core.ts';
import { parse } from 'yaml';
import { deriveStatus } from './status.ts';

const DAY = 86_400_000;
const COMMANDS = new Set(['init', 'update', 'new', 'validate', 'status', 'render', 'approve', 'apply', 'task', 'verify', 'archive', 'check', 'doctor', 'wiki', 'evidence', 'resume']);
const CATEGORIES = ['blocked', 'confusing', 'false-positive', 'missed-defect', 'other'] as const;
type Category = typeof CATEGORIES[number];
export interface UsageStart {
  tool_version: string;
  command: string;
  subcommand?: string;
  change_id?: string;
  approval_id?: string;
  status_before?: string;
}
export interface UsageEnd { outcome: 'success' | 'failure'; status_after?: string; error_code?: string; reason_code?: string }
interface RecordData extends UsageStart {
  schema_version: 1;
  invocation_id: string;
  at: string;
  end_at?: string;
  duration_ms?: number;
  outcome?: 'success' | 'failure';
  status_after?: string;
  error_code?: string;
  reason_code?: string;
}
export interface UsageHandle { root: string; file: string; started: number; record: RecordData }
export interface FeedbackInput { category: Category; impact: string; note: string; related_invocation?: string }
interface Feedback extends FeedbackInput { id: string; at: string; change_id: string; source: 'user' }
export interface Candidate {
  id: string;
  fingerprint: string;
  category: string;
  reason_code: string;
  tool_version: string;
  count: number;
  report_hash: string;
  report_path: string;
  window: { since: string; until: string };
  symptom: string;
  evidence: string[];
  hypothesis: string;
  expected_metric: string;
  regression_cases: string[];
  result_links: string[];
  status: 'open' | 'improved' | 'regressed' | 'inconclusive';
}
export interface ReportOptions { since?: string; tool_version?: string; schema_version?: number }
const dir = (root: string) => join(root, DF, 'runtime', 'usage');
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function atomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n'); renameSync(tmp, file); }
  finally { rmSync(tmp, { force: true }); }
}
function warn(): void { process.stderr.write('! 本地使用记录不可用；业务命令结果不受影响\n'); }
function validDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) throw new DevflowError('日期须为有效 YYYY-MM-DD');
  return value;
}
function safeId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value)) throw new DevflowError('记录标识格式无效');
  return value;
}
function code(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value) ? value : undefined;
}
function enabled(root: string): boolean {
  return process.env.DEVFLOW_USAGE !== 'off' && existsSync(join(root, DF, 'project.yaml')) && (!existsSync(join(dir(root), 'config.json')) || readJson<{ enabled: boolean }>(join(dir(root), 'config.json')).enabled !== false);
}
export function configureUsage(root: string, on: boolean): void { atomic(join(dir(root), 'config.json'), { enabled: on }); }
function recordFiles(root: string): string[] {
  if (!existsSync(dir(root))) return [];
  return readdirSync(dir(root), { withFileTypes: true }).filter(d => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).flatMap(d => readdirSync(join(dir(root), d.name)).filter(f => /^[a-f0-9-]+\.json$/.test(f)).map(f => join(dir(root), d.name, f)));
}
function records(root: string): { rows: RecordData[]; corrupt: number } {
  const rows: RecordData[] = []; let corrupt = 0;
  for (const file of recordFiles(root)) {
    try { const row = readJson<RecordData>(file); if (row.schema_version !== 1 || !COMMANDS.has(row.command) || typeof row.at !== 'string') throw new Error(); rows.push(row); }
    catch { corrupt++; }
  }
  return { rows, corrupt };
}
export function startUsage(root: string, input: UsageStart): UsageHandle | undefined {
  try {
    if (!COMMANDS.has(input.command) || !enabled(root)) return;
    const at = new Date().toISOString(); const id = randomUUID();
    const record: RecordData = {
      schema_version: 1, invocation_id: id, at,
      tool_version: code(input.tool_version) ?? 'unknown', command: input.command,
      subcommand: ['lint', 'done', 'add', 'confirm'].includes(input.subcommand ?? '') ? input.subcommand : undefined, change_id: code(input.change_id), approval_id: code(input.approval_id), status_before: code(input.status_before),
    };
    const file = join(dir(root), at.slice(0, 10), `${id}.json`);
    atomic(file, record);
    // 按天最多一次清理，避免每条命令都扫描全部记录。
    const marker = join(dir(root), 'prune.json');
    if (!existsSync(marker) || readJson<{ day: string }>(marker).day !== at.slice(0, 10)) {
      pruneUsage(root, new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10), 100);
      atomic(marker, { day: at.slice(0, 10) });
    }
    return { root, file, started: performance.now(), record };
  } catch { warn(); return; }
}
export function finishUsage(handle: UsageHandle | undefined, end: UsageEnd): void {
  if (!handle) return;
  try {
    const row: RecordData = { ...handle.record, end_at: new Date().toISOString(), duration_ms: Math.max(0, performance.now() - handle.started), outcome: end.outcome,
      status_after: code(end.status_after), error_code: code(end.error_code), reason_code: code(end.reason_code) };
    atomic(handle.file, row);
    maybeReport(handle.root, row.command === 'archive' && row.outcome === 'success');
  } catch { warn(); }
}
export function pruneUsage(root: string, before: string, limit = Number.MAX_SAFE_INTEGER): number {
  validDate(before); let count = 0;
  for (const file of recordFiles(root)) if (file.slice(file.lastIndexOf('/', file.lastIndexOf('/') - 1) + 1).slice(0, 10) < before && count < limit) { rmSync(file); count++; }
  const now = Date.now();
  for (const [folder, age] of [[join(dir(root), 'feedback'), 90], [join(root, DF, 'runtime', 'reports'), 180]] as const) {
    if (!existsSync(folder)) continue;
    for (const file of readdirSync(folder)) {
      if (count >= limit) break;
      if (!/\.(json|html)$/.test(file)) continue;
      const day = file.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Date.parse(day) < now - age * DAY) { rmSync(join(folder, file)); count++; }
    }
  }
  return count;
}
export function addFeedback(root: string, changeId: string, input: FeedbackInput): Feedback {
  safeId(changeId);
  if (!CATEGORIES.includes(input.category) || typeof input.note !== 'string' || input.note.length > 2000 || typeof input.impact !== 'string' || input.impact.length > 200) throw new DevflowError('反馈分类无效，impact 最多 200 字，note 最多 2000 字');
  if (input.related_invocation) safeId(input.related_invocation);
  const item: Feedback = { id: randomUUID(), at: new Date().toISOString(), change_id: changeId, source: 'user', category: input.category, impact: input.impact, note: input.note, related_invocation: input.related_invocation };
  atomic(join(dir(root), 'feedback', `${item.at.slice(0, 10)}-${item.id}.json`), item);
  return item;
}
function feedback(root: string): Feedback[] {
  const folder = join(dir(root), 'feedback');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(f => f.endsWith('.json')).flatMap(f => { try { const v = readJson<Feedback>(join(folder, f)); return CATEGORIES.includes(v.category) ? [v] : []; } catch { return []; } });
}
const tally = (values: string[]) => Object.fromEntries([...new Set(values)].sort().map(v => [v, values.filter(x => x === v).length]));
const quantile = (values: number[], p: number): number | 'unknown' => values.length ? [...values].sort((a,b) => a-b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]! : 'unknown';
const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function usageReport(root: string, options: ReportOptions = {}) {
  const since = validDate(options.since ?? new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10));
  const all = records(root); const until = new Date().toISOString();
  const changeFormat = (id: string | undefined): number | 'unknown' => {
    if (!id) return 'unknown';
    const active = join(root, DF, 'changes', id, 'change.yaml');
    const archive = join(root, DF, 'changes', 'archive');
    const archived = existsSync(archive) ? readdirSync(archive).find(n => n === id || n.endsWith(`-${id}`)) : undefined;
    const file = existsSync(active) ? active : archived ? join(archive, archived, 'change.yaml') : undefined;
    try { return file ? Number(parse(readFileSync(file, 'utf8')).schema_version) : 'unknown'; } catch { return 'unknown'; }
  };
  const rows = all.rows.filter(r => r.at.slice(0, 10) >= since && r.at <= until && (!options.tool_version || r.tool_version === options.tool_version) && (!options.schema_version || changeFormat(r.change_id) === options.schema_version));
  const ended = rows.filter(r => r.outcome); const fb = feedback(root).filter(f => f.at.slice(0, 10) >= since && f.at <= until);
  const durations = ended.map(r => r.duration_ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const reasons = tally(rows.flatMap(r => r.reason_code ? [r.reason_code] : []));
  const changes = [...new Set(rows.flatMap(r => r.change_id ? [r.change_id] : []))];
  const cycles = changes.flatMap(id => {
    const group = rows.filter(r => r.change_id === id && r.outcome === 'success');
    const start = group.filter(r => r.command === 'apply').sort((a,b) => a.at.localeCompare(b.at))[0];
    const end = group.filter(r => r.command === 'archive').sort((a,b) => b.at.localeCompare(a.at))[0];
    return start && end && end.end_at && end.end_at >= start.at ? [{ change_id: id, wall_clock_ms: Date.parse(end.end_at) - Date.parse(start.at) }] : [];
  });
  let taskDone = 0; let taskTotal = 0; let missingTaskChanges = 0;
  for (const id of changes) {
    try { if (!existsSync(join(root, DF, 'changes', id, 'change.yaml'))) throw new Error(); const st = deriveStatus(root, id); taskDone += st.tasks.done; taskTotal += st.tasks.total; } catch { missingTaskChanges++; }
  }
  const report = {
    schema_version: 1, window: { since, until }, versions: tally(rows.map(r => r.tool_version)), change_formats: tally(rows.map(r => String(changeFormat(r.change_id)))),
    count: rows.length, denominator: rows.length, ended: ended.length,
    outcomes: { success: rows.filter(r => r.outcome === 'success').length, failure: rows.filter(r => r.outcome === 'failure').length, interrupted_unknown: rows.filter(r => !r.outcome).length },
    command_counts: tally(rows.map(r => r.command)), reasons, feedback: { count: fb.length, denominator: fb.length, categories: tally(fb.map(f => f.category)) },
    duration_ms: { count: durations.length, denominator: ended.length, missing: ended.length - durations.length, median: quantile(durations, .5), p95: quantile(durations, .95) },
    repeated_verify: changes.reduce((n,id) => n + Math.max(0, rows.filter(r => r.change_id === id && r.command === 'verify').length - 1), 0),
    wall_clock_cycles: cycles, missing: { corrupt_records: all.corrupt, reason_code: rows.filter(r => !r.reason_code).length, unfinished: rows.length - ended.length },
    task_completeness: { basis: 'current-state-snapshot', done: taskDone, total: taskTotal, rate: taskTotal && !missingTaskChanges ? taskDone / taskTotal : 'unknown', missing_changes: missingTaskChanges }, missed_defect_rate: 'unknown', tokens: 'unknown', cost: 'unknown', human_time: 'unknown',
  };
  const folder = join(root, DF, 'runtime', 'reports'); const stem = `${until.slice(0, 10)}-${randomUUID()}`;
  const jsonPath = join(folder, `${stem}.json`); const htmlPath = join(folder, `${stem}.html`);
  atomic(jsonPath, report);
  writeFileSync(htmlPath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DevFlow 本地使用报告</title><style>body{font:16px/1.7 system-ui;max-width:1000px;margin:40px auto;padding:0 20px;color:#17212f;background:#fafafa}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:24px;background:#fff;border:1px solid #ddd}</style><h1>DevFlow 本地使用报告</h1><p>时间窗 ${html(since)} — ${html(until)} · ${rows.length} 次调用；未知数据保持 unknown，墙钟耗时包含等待。</p><pre>${html(JSON.stringify(report, null, 2))}</pre></html>`);
  generateCandidates(root, rows, fb, report.window, jsonPath, hash(readFileSync(jsonPath, 'utf8')));
  return { report, jsonPath, htmlPath };
}
function generateCandidates(root: string, rows: RecordData[], fb: Feedback[], window: Candidate['window'], reportPath: string, reportHash: string): void {
  const groups = new Map<string, {category: string; reason: string; version: string; evidence: string[]}>();
  for (const row of rows.filter(r => r.outcome === 'failure' && r.reason_code)) {
    const category = 'blocked'; const key = `${category}:${row.reason_code}:${row.tool_version}`;
    const g = groups.get(key) ?? { category, reason: row.reason_code!, version: row.tool_version, evidence: [] }; g.evidence.push(row.invocation_id); groups.set(key, g);
  }
  for (const f of fb) {
    const row = rows.find(r => r.invocation_id === f.related_invocation);
    const reason = row?.reason_code ?? 'user-feedback'; const version = row?.tool_version ?? 'unknown'; const key = `${f.category}:${reason}:${version}`;
    const g = groups.get(key) ?? { category: f.category, reason, version, evidence: [] }; if (!g.evidence.includes(f.related_invocation ?? f.id)) g.evidence.push(f.related_invocation ?? f.id); groups.set(key, g);
  }
  for (const [fingerprint, g] of groups) {
    if (g.evidence.length < 3) continue;
    const id = hash(`${fingerprint}:${window.since}`).slice(0, 24); const file = join(dir(root), 'candidates', `${id}.json`);
    const old = existsSync(file) ? readJson<Candidate>(file) : undefined;
    atomic(file, { id, fingerprint, category: g.category, reason_code: g.reason, tool_version: g.version, count: g.evidence.length, report_hash: reportHash, report_path: reportPath, window,
      symptom: `${g.category}/${g.reason} 出现 ${g.evidence.length} 次`, evidence: g.evidence,
      hypothesis: '待核查：重复出现的现象是否具有共同原因', expected_metric: '待提案明确目标指标与基线', regression_cases: old?.regression_cases ?? [], result_links: old?.result_links ?? [], status: old?.status ?? 'open' } satisfies Candidate);
  }
}
export function listCandidates(root: string): Candidate[] {
  const folder = join(dir(root), 'candidates');
  return existsSync(folder) ? readdirSync(folder).filter(f => /^[a-f0-9]{24}\.json$/.test(f)).map(f => readJson<Candidate>(join(folder, f))) : [];
}
export function getCandidate(root: string, id: string): Candidate {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new DevflowError('候选标识无效');
  const file = join(dir(root), 'candidates', `${id}.json`);
  if (!existsSync(file)) throw new DevflowError('候选不存在');
  return readJson<Candidate>(file);
}
export function resolveCandidate(root: string, id: string, reportPath: string): Candidate {
  const candidate = getCandidate(root, id); const report = readJson<{ result: string }>(reportPath);
  if (!['improved', 'regressed', 'inconclusive'].includes(report.result)) throw new DevflowError('结果报告缺少有效 result');
  candidate.status = report.result as Candidate['status']; candidate.result_links.push(reportPath);
  atomic(join(dir(root), 'candidates', `${id}.json`), candidate); return candidate;
}
export function exportUsage(root: string, options: ReportOptions, out: string): void {
  const { report } = usageReport(root, options);
  const { wall_clock_cycles, ...aggregate } = report;
  atomic(out, { ...aggregate, wall_clock_cycles: { count: wall_clock_cycles.length, median_ms: quantile(wall_clock_cycles.map(c => c.wall_clock_ms), .5) } });
}
export function maybeReport(root: string, force = false): void {
  const base = dir(root); const lock = join(base, 'report.lock'); let held = false;
  try {
    if (!enabled(root)) return;
    try { mkdirSync(lock); held = true; } catch { return; }
    const rows = records(root).rows; if (!rows.length) return;
    const cursorFile = join(base, 'report-cursor.json');
    const cursor = existsSync(cursorFile) ? readJson<{ count: number; at: string; ended_ids?: string[] }>(cursorFile) : { count: 0, at: rows.map(r => r.at).sort()[0]!, ended_ids: [] as string[] };
    const ended = rows.filter(r => r.outcome).length;
    const previous = new Set(cursor.ended_ids);
    const newEnded = cursor.ended_ids ? rows.filter(r => r.outcome && !previous.has(r.invocation_id)).length : ended - cursor.count;
    if (!force && newEnded < 20 && Date.now() - Date.parse(cursor.at) < 7 * DAY) return;
    usageReport(root, { since: cursor.at.slice(0,10) });
    atomic(cursorFile, { count: ended, at: new Date().toISOString(), ended_ids: rows.filter(r => r.outcome).map(r => r.invocation_id) });
  } catch { warn(); }
  finally { if (held) { try { rmSync(lock, { recursive: true, force: true }); } catch { warn(); } } }
}
