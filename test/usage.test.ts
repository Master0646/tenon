import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addFeedback, configureUsage, exportUsage, finishUsage, getCandidate, listCandidates, maybeReport, pruneUsage, resolveCandidate, startUsage, usageReport } from '../src/usage.ts';
const root = () => { const r = mkdtempSync(join(tmpdir(), 'tenon-usage-')); mkdirSync(join(r,'.tenon'),{recursive:true}); writeFileSync(join(r,'.tenon','project.yaml'),'schema_version: 1\n'); return r; };
const input = { tool_version:'0.2.0', command:'verify', change_id:'change-1' };
const json = (file:string) => JSON.parse(readFileSync(file,'utf8'));

test('usage 独立原子文件、缺少结束保持 unknown、仅保存白名单', () => {
 const r=root(); const a=startUsage(r,{...input, argv:'TOKEN-secret', stdout:'secret'} as typeof input); const b=startUsage(r,input);
 assert.ok(a); assert.ok(b); assert.notEqual(a.file,b.file);
 finishUsage(a,{outcome:'failure',reason_code:'check_failed'});
 const report=usageReport(r);
 assert.deepEqual(report.report.outcomes,{success:0,failure:1,interrupted_unknown:1});
 assert.equal(report.report.tokens,'unknown'); assert.equal(report.report.missed_defect_rate,'unknown');
 assert.ok(!readFileSync(a.file,'utf8').includes('secret')); assert.ok(!readFileSync(b.file,'utf8').includes('outcome'));
 rmSync(r,{recursive:true,force:true});
});

test('关闭和记录失败不抛错，业务 stdout 不受影响', () => {
 const r=root(); configureUsage(r,false); assert.equal(startUsage(r,input),undefined);
 configureUsage(r,true); const old=process.env.DEVFLOW_USAGE; process.env.DEVFLOW_USAGE='off';
 try { assert.equal(startUsage(r,input),undefined); } finally { if(old===undefined) delete process.env.DEVFLOW_USAGE; else process.env.DEVFLOW_USAGE=old; }
 assert.equal(startUsage(r,{...input,command:'usage'}),undefined);
 rmSync(join(r,'.tenon','runtime','usage'),{recursive:true}); writeFileSync(join(r,'.tenon','runtime','usage'),'blocked');
 let warning=''; const original=process.stderr.write; process.stderr.write=((v:unknown)=>{warning+=String(v); return true;}) as typeof process.stderr.write;
 try { assert.doesNotThrow(()=>startUsage(r,input)); assert.match(warning,/业务命令结果不受影响/); } finally {process.stderr.write=original;}
 rmSync(r,{recursive:true,force:true});
});

test('反馈产生去重候选，导出仅聚合，结果可关联', () => {
 const r=root();
 for(let i=0;i<3;i++){const h=startUsage(r,input)!; finishUsage(h,{outcome:'failure',reason_code:'missing_evidence'});addFeedback(r,'change-1',{category:'blocked',impact:'cannot archive',note:'PRIVATE-note',related_invocation:h.record.invocation_id});}
 const first=usageReport(r); const candidates=listCandidates(r); assert.equal(candidates.length,1); assert.equal(candidates[0]!.count,3);
 usageReport(r); assert.equal(listCandidates(r).length,1);
 const exp=join(r,'export.json');exportUsage(r,{},exp); const text=readFileSync(exp,'utf8');
 assert.ok(!text.includes('PRIVATE-note'));assert.ok(!text.includes('change-1'));assert.ok(!text.includes('invocation_id'));
 const result=join(r,'result.json');writeFileSync(result,JSON.stringify({result:'inconclusive'}));
 assert.equal(resolveCandidate(r,candidates[0]!.id,result).status,'inconclusive');
 assert.equal(getCandidate(r,candidates[0]!.id).result_links.length,1); assert.ok(existsSync(first.htmlPath));
 assert.throws(()=>getCandidate(r,'../escape'));assert.throws(()=>addFeedback(r,'x',{category:'blocked',impact:'x',note:'x'.repeat(2001)}));
 rmSync(r,{recursive:true,force:true});
});

test('20 个结束调用触发报告且 usage 不递归；7 天新调用触发', () => {
 const r=root();
 for(let i=0;i<19;i++)finishUsage(startUsage(r,input),{outcome:'success'});
 const reports=join(r,'.tenon','runtime','reports');assert.equal(existsSync(reports),false);
 finishUsage(startUsage(r,input),{outcome:'success'});assert.equal(readdirSync(reports).length,2);
 maybeReport(r);assert.equal(readdirSync(reports).length,2);
 const cursor=join(r,'.tenon','runtime','usage','report-cursor.json');const c=json(cursor);c.at='2020-01-01T00:00:00Z';writeFileSync(cursor,JSON.stringify(c));
 finishUsage(startUsage(r,input),{outcome:'success'});assert.equal(readdirSync(reports).length,4);
 rmSync(r,{recursive:true,force:true});
});

test('清理有界且不触及审批和业务证据', () => {
 const r=root();const base=join(r,'.tenon','runtime','usage');mkdirSync(join(base,'2020-01-01'),{recursive:true});
 for(let i=0;i<105;i++)writeFileSync(join(base,'2020-01-01',`${i.toString(16)}.json`),'{}');
 mkdirSync(join(r,'.tenon','evidence'),{recursive:true});writeFileSync(join(r,'.tenon','evidence','keep'),'evidence');
 assert.equal(pruneUsage(r,'2021-01-01',100),100);assert.equal(readdirSync(join(base,'2020-01-01')).length,5);assert.ok(existsSync(join(r,'.tenon','evidence','keep')));
 assert.throws(()=>usageReport(r,{since:'2026-02-30'}));rmSync(r,{recursive:true,force:true});
});

test('500 次开关记录附加耗时中位数 <=20ms、p95 <=50ms', () => {
 const r=root();const off:number[]=[];const on:number[]=[];
 configureUsage(r,false);
 for(let i=0;i<500;i++){const t=performance.now();finishUsage(startUsage(r,input),{outcome:'success'});off.push(performance.now()-t);}
 configureUsage(r,true);
 for(let i=0;i<500;i++){const t=performance.now();finishUsage(startUsage(r,input),{outcome:'success'});on.push(performance.now()-t);}
 off.sort((a,b)=>a-b);on.sort((a,b)=>a-b);
 const median=on[249]!-off[249]!;const p95=on[474]!-off[474]!;
 assert.ok(median<=20,`median ${median}ms`);assert.ok(p95<=50,`p95 ${p95}ms`);
 rmSync(r,{recursive:true,force:true});
});
