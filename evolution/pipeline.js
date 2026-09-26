// 进化流水线（自主演化设计 §6）：一个需求从「写需求文档」到「提交裁决」的全过程。
//   需求文档 → 需求评审（最多 2 轮修改）→ 实施 ⇄ 自动闸门 → 三位审查员多轮评审（最多 3 轮）→ 安全终审（T2 两次）
//   → 哈希锁定 → 影子试运行（不达标可带报告重做 1 次）→ 安装到 plugins/evolved/ 并写入 verified.json（小镇服务器据此登记、开决策项）
// 需要改内核的需求（T3）只写需求文档到 data/evolution/rfcs/，交给人。
import fs from 'node:fs';
import path from 'node:path';
import { hashDir } from '../plugin-host/hash.js';
import { defaultSpec } from '../server/kernel/spec.js';
import { replay } from '../server/kernel/ops.js';
import { manifestText } from '../server/worldai/manifest.js';
import { activeDir } from '../server/timelines.js';
import { runGate } from './gate.js';
import { runShadow } from './shadow.js';
import { hostApiDoc, pluginCapabilities } from './prompts.js';
import { writeRfc, reviewRfc, implement, review, finalSecurity } from './agents.js';
import { reviewInfo } from './llm.js';
import { readJSON, writeJSON, ledger, loadJobs, saveJobs, str, setEngine } from './common.js';

const RFC_ROUNDS = 2;
const GATE_FIXES = 3;
const REVIEW_ROUNDS = 3;
const SHADOW_RETRIES = 1;
const TIER_RANK = { T0: 0, T1: 1, T2: 2, T3: 3 };

/** 当前世界规格：默认规格 + 当前时间线存档里的操作历史 */
export function currentSpec(P) {
  let specOps = [];
  try { specOps = readJSON(path.join(activeDir(P.data), 'save.json'), {})?.specOps || []; } catch { /* 没有存档 */ }
  return replay(defaultSpec(), specOps).spec;
}

function pluginList(P) {
  const reg = readJSON(P.registry, { plugins: {} }).plugins;
  return Object.entries(reg).filter(([, e]) => ['active', 'canary', 'pending', 'approved'].includes(e.status)).map(([k, e]) => `${k}（${e.title}：${e.summary}）`).join('；');
}

/** 为新插件选一个不冲突的 key（id@version） */
function allocKey(P, id, fixOf = null) {
  if (fixOf) {
    const [fid, ver] = fixOf.split('@');
    const [a, b, c] = ver.split('.').map(Number);
    let n = c + 1;
    while (fs.existsSync(path.join(P.plugins, `${fid}@${a}.${b}.${n}`))) n++;
    return `${fid}@${a}.${b}.${n}`;
  }
  const taken = (x) => fs.existsSync(P.plugins) && fs.readdirSync(P.plugins).some((d) => d.startsWith(`${x}@`));
  let base = id || 'plugin';
  let k = base;
  for (let i = 2; taken(k); i++) k = `${base.slice(0, 28)}-${i}`;
  return `${k}@1.0.0`;
}

function writeFiles(dir, files, extra = {}) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries({ ...files, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
}

const readFiles = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter((f) => /\.(js|json)$/.test(f)).map((f) => [f.split(path.sep).join('/'), fs.readFileSync(path.join(dir, f), 'utf8')]));

function rfcMarkdown(rfc, need, reviews) {
  return `# ${rfc.title}（${rfc.tier}）

> 由云溪镇进化引擎自动撰写。来源：${need.source === 'gap' ? `AI 心愿单（出现 ${need.count} 次）` : need.source === 'bugfix' ? `插件故障（${need.fixOf}）` : '进化引擎的点子'}
> 需求：${need.text}

${rfc.summary}

${rfc.rfc}

## 需求评审记录
${reviews.map((r, i) => `- 第 ${i + 1} 轮：${r.verdict}${r.issues.length ? `（${r.issues.join('；')}）` : ''}`).join('\n')}
`;
}

/**
 * 运行一个需求。ctx：{ P, llm, onStage? }；need：{ source, text, why?, count?, gapId?, fixOf?, detail? }
 * 返回 job 记录。
 */
export async function runJob(ctx, need) {
  const { P, llm } = ctx;
  const jobs = loadJobs(P);
  const job = { id: `job${Date.now().toString(36)}`, pid: process.pid, need, status: 'running', stage: 'rfc', startedAt: new Date().toISOString(), log: [] };
  jobs.push(job);
  saveJobs(P, jobs);
  const note = (text) => { job.log.push({ at: new Date().toISOString(), text: str(text, 200) }); };
  const stage = (s) => {
    job.stage = s;
    const all = loadJobs(P).filter((j) => j.id !== job.id);
    saveJobs(P, [...all, job]);
    setEngine(P, { state: 'working', job: job.id, stage: s, need: str(need.text, 60) });
    ctx.onStage?.(s, job);
  };
  const end = (status, reason = '') => {
    job.status = status;
    job.reason = str(reason, 300);
    job.finishedAt = new Date().toISOString();
    stage(status);
    ledger(P, `job-${status}`, { job: job.id, key: job.key || null, need: str(need.text, 80), reason: job.reason });
    return job;
  };
  ledger(P, 'job-start', { job: job.id, need: str(need.text, 80), source: need.source });

  try {
    const spec = currentSpec(P);
    const capabilities = `${manifestText(spec, 1)}\n\n${pluginCapabilities()}`;
    const hostDoc = hostApiDoc(spec);

    // ① 需求文档 + ② 需求评审
    let rfc = await writeRfc(llm, { need, capabilities, plugins: pluginList(P) });
    const rfcReviews = [];
    for (let round = 0; ; round++) {
      if (rfc.tier === 'T3') break;
      stage('rfc-review');
      const rv = await reviewRfc(llm, { rfc, capabilities });
      rfcReviews.push(rv);
      note(`需求评审第 ${round + 1} 轮：${rv.verdict}${rv.issues.length ? `（${rv.issues.join('；')}）` : ''}`);
      if (rv.verdict === 't3') { rfc.tier = 'T3'; break; }
      if (rv.verdict === 'reject') return end('dropped', `需求评审否决：${rv.issues.join('；')}`);
      if (rv.suggestedTier && TIER_RANK[rv.suggestedTier] < TIER_RANK[rfc.tier] && rv.verdict === 'approve') rfc.tier = rv.suggestedTier;
      if (rv.verdict === 'approve') break;
      if (round >= RFC_ROUNDS) return end('dropped', `需求文档 ${RFC_ROUNDS + 1} 轮评审后仍未通过：${rv.issues.join('；')}`);
      stage('rfc');
      const feedback = `${rv.issues.join('\n')}${rv.suggestedTier ? `\n建议级别：${rv.suggestedTier}` : ''}`;
      rfc = await writeRfc(llm, { need, capabilities, plugins: pluginList(P), feedback, previous: `级别 ${rfc.tier}\n${rfc.title}：${rfc.summary}\n${rfc.rfc}` });
      if (rv.suggestedTier && TIER_RANK[rv.suggestedTier] < TIER_RANK[rfc.tier]) rfc.tier = rv.suggestedTier;
    }
    const rfcMd = rfcMarkdown(rfc, need, rfcReviews);
    job.rfcText = rfcMd.slice(0, 4000);
    job.title = rfc.title;
    job.tier = rfc.tier;
    if (rfc.tier === 'T3') {
      fs.mkdirSync(P.rfcs, { recursive: true });
      const n = String(fs.readdirSync(P.rfcs).filter((f) => /^\d{4}-/.test(f)).length + 1).padStart(4, '0');
      const file = `${n}-${rfc.id || 'kernel'}.md`;
      fs.writeFileSync(path.join(P.rfcs, file), rfcMd);
      job.rfc = file;
      return end('t3', '需要修改内核：已写成需求文档，等待人来实现');
    }

    // ③ 实施 ⇄ 自动闸门；④ 多轮评审；⑤ 安全终审；影子试运行
    const key = allocKey(P, need.fixOf ? null : rfc.id, need.fixOf);
    job.key = key;
    const dir = path.join(P.candidates, key);
    const reviewLog = [];
    let files = null;
    let problems = null;
    if (need.fixOf) {
      try { files = readFiles(path.join(P.plugins, need.fixOf)); problems = [`上一版（${need.fixOf}）的问题：${need.text}`]; } catch { files = null; }
    }
    let gate = null;
    let shadow = null;
    let final = [];
    for (let attempt = 0; attempt <= SHADOW_RETRIES; attempt++) {
      // 实施 + 闸门（最多 GATE_FIXES 次修复）
      const build = async () => {
        for (let i = 0; i <= GATE_FIXES; i++) {
          stage(i || files ? 'fix' : 'implement');
          const out = await implement(llm, { rfc, key, hostDoc, previousFiles: files, problems });
          if (!out.files['plugin.json']) {
            note(`实施 Agent 没有给出 plugin.json（返回的键：${out.keys.join('、') || '无'}）`);
            problems = ['没有输出 plugin.json：请在 files 里用完整的文件名（plugin.json、content.json、server.js、test.js）作为键'];
            gate = { issues: problems };
            continue;
          }
          files = out.files;
          writeFiles(dir, files, { 'RFC.md': rfcMd });
          stage('gate');
          gate = await runGate(dir, spec);
          note(`自动闸门：${gate.ok ? '通过' : gate.issues.slice(0, 3).join('；')}`);
          if (gate.ok) return true;
          problems = gate.issues.slice(0, 12);
        }
        return false;
      };
      if (!(await build())) return end('dropped', `实施 ${GATE_FIXES + 1} 次仍未通过自动闸门：${gate?.issues.slice(0, 3).join('；')}`);

      // 多轮评审
      const kinds = rfc.tier === 'T2' ? ['security', 'correctness', 'world'] : ['world', 'security'];
      let pending = kinds;
      const last = {};
      let passed = false;
      for (let round = 1; round <= REVIEW_ROUNDS; round++) {
        stage(`review-${round}`);
        const results = await Promise.all(pending.map((k) => review(llm, k, { rfc, files, stripped: gate.stripped, gateReport: gate.report, previous: last[k], capabilities })));
        const failed = [];
        results.forEach((r, i) => {
          const k = pending[i];
          reviewLog.push({ round, reviewer: k, pass: r.pass, findings: r.findings });
          if (!r.pass) { failed.push(k); last[k] = r.findings.filter((f) => f.severity !== 'minor'); }
        });
        note(`评审第 ${round} 轮：${results.map((r, i) => `${pending[i]} ${r.pass ? '通过' : '不通过'}`).join('，')}`);
        if (!failed.length) {
          // 安全终审：全新上下文；T2 两次（攻击者 / 运维视角）
          if (rfc.tier !== 'T2') { passed = true; break; }
          stage('final-security');
          final = await Promise.all(['attacker', 'operator'].map((a) => finalSecurity(llm, a, { files, stripped: gate.stripped, rfcSummary: `${rfc.title}：${rfc.summary}` })));
          reviewLog.push(...final.map((r, i) => ({ round, reviewer: ['final-attacker', 'final-operator'][i], pass: r.pass, findings: r.findings })));
          note(`安全终审：${final.map((r) => (r.pass ? '通过' : '不通过')).join(' / ')}`);
          if (final.every((r) => r.pass)) { passed = true; break; }
          last.security = final.flatMap((r) => r.findings.filter((f) => f.severity !== 'minor'));
          failed.push('security');
        }
        if (round === REVIEW_ROUNDS) break;
        // 修复：只把阻断问题交给实施 Agent；之后只由提出问题的审查员复审
        problems = failed.flatMap((k) => last[k] || []).map((f) => `[${f.severity}] ${f.file}：${f.issue}${f.fix ? `（建议：${f.fix}）` : ''}`).slice(0, 16);
        if (!(await build())) return end('dropped', `修复后未通过自动闸门：${gate?.issues.slice(0, 3).join('；')}`);
        pending = [...new Set(failed)];
      }
      if (!passed) return end('dropped', `${REVIEW_ROUNDS} 轮评审后仍有阻断问题：${reviewLog.filter((r) => !r.pass).slice(-2).flatMap((r) => r.findings.map((f) => f.issue)).slice(0, 3).join('；')}`);

      // 影子试运行
      stage('shadow');
      shadow = await runShadow(P, { key, dir });
      note(`影子试运行：${shadow.passed ? '达标' : shadow.reason}`);
      if (shadow.passed) break;
      if (attempt === SHADOW_RETRIES) return end('dropped', `影子试运行不达标：${shadow.reason}`);
      problems = [`影子试运行不达标：${shadow.reason}`];
    }

    // 评审记录写进插件目录，然后锁定哈希、安装
    const info = reviewInfo();
    const reviewMd = `# 评审记录：${rfc.title}（${key}）

- 评审模型：${info.model}${info.sameModel ? '（与实施相同的模型）' : ''}${info.separateService ? '，独立服务' : ''}
- 自动闸门：${gate.report.join('；')}
- 影子试运行：${shadow.passed ? '达标' : shadow.reason}（对照 ${shadow.metrics.base.tickMs}ms / 插件 ${shadow.metrics.trial.tickMs}ms，调用 ${shadow.metrics.trial.pluginCalls} 次）

${reviewLog.map((r) => `## 第 ${r.round} 轮 · ${r.reviewer}：${r.pass ? '通过' : '不通过'}\n${r.findings.map((f) => `- [${f.severity}] ${f.file} ${f.issue}${f.fix ? ` → ${f.fix}` : ''}`).join('\n') || '- （无意见）'}`).join('\n\n')}
`;
    fs.writeFileSync(path.join(dir, 'REVIEW.md'), reviewMd);
    stage('install');
    const hash = hashDir(dir);
    const target = path.join(P.plugins, key);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(P.plugins, { recursive: true });
    fs.cpSync(dir, target, { recursive: true });
    if (hashDir(target) !== hash) return end('dropped', '安装后的内容与评审锁定的哈希不一致');
    fs.rmSync(dir, { recursive: true, force: true });
    const rounds = Math.max(...reviewLog.map((r) => r.round));
    const verified = readJSON(P.verified, {});
    verified[key] = {
      passed: true, hash, tier: rfc.tier, title: rfc.title, summary: rfc.summary, job: job.id, at: new Date().toISOString(), need: str(need.text, 120), fixOf: need.fixOf || null,
      reviewSummary: `${rounds} 轮评审，${reviewLog.length} 份意见；${rfc.tier === 'T2' ? `两次安全终审${final.every((r) => r.pass) ? '通过' : '未通过'}` : '世界观与安全审查通过'}；评审模型 ${info.model}${info.sameModel ? '（与实施相同）' : ''}`,
      reviewModel: info.model, sameModel: info.sameModel, shadow: { passed: shadow.passed, reason: shadow.reason, metrics: shadow.metrics.trial, base: shadow.metrics.base },
    };
    writeJSON(P.verified, verified);
    ledger(P, 'verified', { job: job.id, key, hash, tier: rfc.tier });
    return end('submitted', `已提交裁决（${rounds} 轮评审）`);
  } catch (e) {
    if (e.code === 'EVOLVE_BUDGET') return end('paused', e.message);
    return end('failed', e.message);
  }
}
