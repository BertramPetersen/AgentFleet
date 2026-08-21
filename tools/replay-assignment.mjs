#!/usr/bin/env node
/**
 * Replay the deterministic assignment rules over a RECORDED hive.
 *
 * The hive is a git repo whose single committer (Electron main) commits every
 * tasks.json / registry.json / projects.json write — so its history IS the
 * event log of what the dispatcher actually did. This harness walks that
 * history, runs `decideAssignments` (src/main/assignment.ts, bundled on the
 * fly with esbuild so replay and live share ONE implementation) at every
 * point where the ledger changed, and compares the rules' answer with what
 * actually happened next.
 *
 * This exists because the plan's highest risk is "the orchestration logic is
 * a prompt, not code": before the rules act on live agents — and before the
 * dispatcher prompt is retuned — every change to either can be replayed here
 * against reality.
 *
 * Usage:
 *   npm run replay -- <hive-root> [--jsonl <out>] [--strict-idle] [--verbose]
 *
 * Outcome classes per rule decision:
 *   AGREE           rules dispatched card→X, history shows card→X
 *   DIFFER          rules dispatched card→X, history assigned card→Y
 *   RULES-EARLIER   rules would have dispatched; history left it unassigned
 *   DISPATCHER-DID  rules held (with reason); history assigned it anyway
 *   HOLD            rules held and history agreed (nothing happened)
 *
 * DISPATCHER-DID on a `no-contract` hold is the interesting class: it counts
 * how often work left the floor without a contract — the behaviour the
 * retuned dispatcher prompt is meant to end.
 *
 * Idleness is unknowable from history (telemetry is not committed), so replay
 * marks every eligible agent idle — idle-pull decisions are an UPPER bound.
 * `--strict-idle` marks none idle, isolating the explicit-assignee rule.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--jsonl');
const jsonlOut = flags.has('--jsonl') ? args[args.indexOf('--jsonl') + 1] : null;
const strictIdle = flags.has('--strict-idle');
const verbose = flags.has('--verbose');

const hive = positional[0];
if (!hive) {
  console.error('usage: replay-assignment.mjs <hive-root> [--jsonl <out>] [--strict-idle] [--verbose]');
  process.exit(2);
}

const git = (...a) => execFileSync('git', ['-C', hive, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

// ── load the rules (same TS the live tick uses) ────────────────────────────
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = await import(pathToFileURL(join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
const tmp = mkdtempSync(join(tmpdir(), 'replay-rules-'));
const loadTs = async (name) => {
  const bundled = esbuild.buildSync({
    entryPoints: [join(repoRoot, 'src', 'main', `${name}.ts`)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false
  });
  const file = join(tmp, `${name}.mjs`);
  writeFileSync(file, bundled.outputFiles[0].text);
  return import(pathToFileURL(file).href);
};
const { decideAssignments } = await loadTs('assignment');
const { ledgerSpendByAgent, projectSpend } = await loadTs('budget');

// Budget context. The ledger is not committed to the hive repo, so historical
// spend cannot be reconstructed — replay applies TODAY's ledger to every
// decision point, which makes over-budget holds an approximation there (and
// exact in fixtures that write the ledger alongside the history).
const spendByAgent = ledgerSpendByAgent(join(hive, 'cost-ledger.jsonl'));

// ── walk the hive history ──────────────────────────────────────────────────
const TRACKED = ['tasks.json', 'registry.json', 'projects.json'];
const commits = git('log', '--reverse', '--format=%H%x09%ct%x09%s')
  .trim().split('\n').filter(Boolean)
  .map((l) => { const [sha, ct, ...s] = l.split('\t'); return { sha, ts: Number(ct) * 1000, subject: s.join('\t') }; });

const showAt = (sha, file) => {
  try { return JSON.parse(git('show', `${sha}:${file}`)); } catch { return null; }
};

const parseTasks = (raw) => (raw && Array.isArray(raw.tasks) ? raw.tasks.filter((t) => t && typeof t.id === 'string') : []);
const parseAgents = (raw) => (raw && raw.agents ? Object.values(raw.agents) : []);
const parseProjects = (raw) => (raw && Array.isArray(raw.projects) ? raw.projects : []);

// Rolling state + the decision points (each commit that changed tasks.json).
let cur = { tasks: [], agents: [], projects: [] };
const points = [];
for (const c of commits) {
  let changed;
  try { changed = git('diff-tree', '--root', '--no-commit-id', '--name-only', '-r', c.sha).trim().split('\n'); } catch { changed = []; }
  const touched = changed.filter((f) => TRACKED.includes(f));
  if (touched.length === 0) continue;
  for (const f of touched) {
    const raw = showAt(c.sha, f);
    if (f === 'tasks.json') cur = { ...cur, tasks: parseTasks(raw) };
    if (f === 'registry.json') cur = { ...cur, agents: parseAgents(raw) };
    if (f === 'projects.json') cur = { ...cur, projects: parseProjects(raw) };
  }
  if (touched.includes('tasks.json')) points.push({ ...c, state: cur });
}

if (points.length === 0) {
  console.log(`no tasks.json history in ${hive} — nothing to replay`);
  process.exit(0);
}

// ── replay each decision point against what actually happened next ─────────
const classes = { AGREE: 0, DIFFER: 0, 'RULES-EARLIER': 0, 'DISPATCHER-DID': 0, HOLD: 0 };
const perRule = {};
const trace = [];

for (let i = 0; i < points.length; i++) {
  const here = points[i];
  const next = points[i + 1] ?? null;
  const agents = here.state.agents.map((a) => ({ ...a, idle: strictIdle ? false : !a.archived }));
  const spend = projectSpend(here.state.projects, agents, spendByAgent);
  const state = {
    tasks: here.state.tasks,
    projects: here.state.projects.map((p) => ({ ...p, spentUsd: spend.get(p.id) ?? 0 })),
    agents
  };
  const decisions = decideAssignments(state);

  const nextById = new Map((next ? next.state.tasks : []).map((t) => [t.id, t]));
  const hereById = new Map(here.state.tasks.map((t) => [t.id, t]));

  for (const d of decisions) {
    const before = hereById.get(d.taskId);
    const after = nextById.get(d.taskId);
    const actuallyAssigned = next && after && after.assignee && after.assignee !== (before?.assignee ?? undefined)
      ? after.assignee
      : (before?.assignee && d.rule === 'explicit-assignee' ? before.assignee : null);

    let outcome;
    if (d.action === 'dispatch') {
      if (d.rule === 'explicit-assignee') outcome = 'AGREE'; // honoring what history already recorded
      else if (actuallyAssigned && actuallyAssigned === d.assignee) outcome = 'AGREE';
      else if (actuallyAssigned) outcome = 'DIFFER';
      else outcome = 'RULES-EARLIER';
    } else {
      outcome = (next && after && after.assignee && after.assignee !== (before?.assignee ?? undefined))
        ? 'DISPATCHER-DID'
        : 'HOLD';
    }

    classes[outcome]++;
    perRule[d.rule] = (perRule[d.rule] ?? 0) + 1;
    const row = {
      at: new Date(here.ts).toISOString(),
      sha: here.sha.slice(0, 7),
      task: d.taskId.slice(-8),
      title: (before?.title ?? '').slice(0, 48),
      rule: d.rule,
      decision: d.action === 'dispatch' ? `dispatch→${d.assignee}` : `hold (${d.reason})`,
      outcome
    };
    trace.push(row);
    if (verbose || outcome === 'DIFFER' || outcome === 'DISPATCHER-DID') {
      console.log(`${row.at}  ${row.sha}  ${row.task}  [${row.rule}] ${row.decision}  → ${outcome}${row.title ? `  "${row.title}"` : ''}`);
    }
  }
}

if (jsonlOut) {
  writeFileSync(jsonlOut, trace.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`\ntrace: ${trace.length} decisions → ${jsonlOut}`);
}

console.log(`\nreplayed ${points.length} ledger commits from ${hive}${strictIdle ? ' (strict idle: pull rule disabled)' : ' (all live agents assumed idle: pulls are an upper bound)'}`);
console.log('outcomes:', Object.entries(classes).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log('by rule: ', Object.entries(perRule).map(([k, v]) => `${k} ${v}`).join(' · ') || '(none)');
const leaks = trace.filter((r) => r.outcome === 'DISPATCHER-DID' && r.rule === 'no-contract').length;
if (leaks) console.log(`\n⚠ ${leaks} card(s) left the floor WITHOUT a contract — the retuned dispatcher prompt is meant to end this.`);
