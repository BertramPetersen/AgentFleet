#!/usr/bin/env node
/**
 * Behavioral spec for the assignment rules, run through the REAL replay
 * harness — not unit tests around the function, but a synthesized hive
 * history driven through the same git-walking path a recorded hive takes.
 * `npm run replay:selftest` — exits non-zero when any assertion fails, so it
 * can gate CI the same way typecheck does.
 *
 * The scenario (two ledger commits):
 *   T0  pe-1 contracted, unassigned            → idle-pull to impl-1
 *       pe-2 contracted, labels ["tests"]      → idle-pull to test-1 (capability)
 *       pe-3 NO contract, unassigned           → hold
 *       it-1 contracted, explicit docs-1       → explicit-assignee dispatch
 *       x-1  contracted, NO project            → hold (unfiled)
 *   T1  "what the dispatcher actually did":
 *       pe-1 → impl-1 (AGREE)   pe-2 → impl-1 (DIFFER — rules wanted test-1)
 *       pe-3 → test-1 (DISPATCHER-DID on a no-contract hold — the leak the
 *       retuned prompt is meant to end)   it-1, x-1 untouched
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hive = mkdtempSync(join(tmpdir(), 'replay-fixture-'));
const git = (...a) => execFileSync('git', ['-C', hive, ...a], { encoding: 'utf8' });

git('init', '-q');
git('config', 'user.name', 'Hive');
git('config', 'user.email', 'hive@local');

const REPO = '/repos/pricing-engine';
const DOCS = '/repos/internal-tools';
const CAPPED = '/repos/budget-engine';

const write = (name, obj) => writeFileSync(join(hive, name), JSON.stringify(obj, null, 2));
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); };

write('registry.json', {
  godId: 'god',
  agents: {
    god: { id: 'god', name: 'Orchestrator', cwd: '/hive', isGod: true, role: 'orchestrator (god)', status: 'idle', lastSeen: 1 },
    'impl-1': { id: 'impl-1', name: 'impl-1', cwd: REPO, role: 'implementation', capabilities: ['backend'], status: 'idle', lastSeen: 1 },
    'test-1': { id: 'test-1', name: 'test-1', cwd: `${REPO}/agent/test-1`, role: 'tests', status: 'idle', lastSeen: 1 },
    'docs-1': { id: 'docs-1', name: 'docs-1', cwd: DOCS, role: 'docs', status: 'idle', lastSeen: 1 },
    'spend-1': { id: 'spend-1', name: 'spend-1', cwd: CAPPED, role: 'implementation', status: 'idle', lastSeen: 1 },
    'compl-1': { id: 'compl-1', name: 'compl-1', cwd: '/office/compliance', role: 'compliance reviewer', capabilities: ['compliance'], status: 'idle', lastSeen: 1 }
  }
});
write('projects.json', {
  projects: [
    { id: 'pricing-engine', name: 'pricing-engine', repoPath: REPO, isolation: 'worktree-per-agent', members: [], createdAt: 't' },
    { id: 'internal-tools', name: 'internal-tools', repoPath: DOCS, isolation: 'shared', members: [], createdAt: 't' },
    { id: 'budget-engine', name: 'budget-engine', repoPath: CAPPED, isolation: 'shared', members: [], budgetUsd: 5, createdAt: 't' }
  ]
});
// The durable ledger: cumulative per-session snapshots — spend is the
// per-session MAX, so these two rows are $6 total, not $10 (over the $5 cap).
writeFileSync(join(hive, 'cost-ledger.jsonl'), [
  JSON.stringify({ agent_id: 'spend-1', session_id: 's1', ts: 1, usd: 4 }),
  JSON.stringify({ agent_id: 'spend-1', session_id: 's1', ts: 2, usd: 6 })
].join('\n') + '\n');
commit('hive: register fleet');

const contract = { objective: 'do the thing', output: 'the thing, done' };
const t0 = [
  { id: 'pe-1', title: 'Backfill curves', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-01', projectId: 'pricing-engine', rank: '000010', contract },
  { id: 'pe-2', title: 'Property-test the kernel', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-02', projectId: 'pricing-engine', rank: '000020', labels: ['tests'], contract },
  { id: 'pe-3', title: 'Cache the vol surface', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-03', projectId: 'pricing-engine', rank: '000030' },
  { id: 'it-1', title: 'Document the API', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-04', projectId: 'internal-tools', rank: '000010', assignee: 'docs-1', contract },
  { id: 'x-1', title: 'A card with no home', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-05', contract },
  { id: 'be-1', title: 'More work for a capped project', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-06', projectId: 'budget-engine', rank: '000010', contract },
  { id: 'be-2', title: 'Explicitly assigned into the cap', status: 'todo', dependsOn: [], priority: 0, createdAt: '2026-01-07', projectId: 'budget-engine', rank: '000020', assignee: 'spend-1', contract },
  { id: 'rev-pe-9', title: 'Review PR #9', status: 'todo', dependsOn: [], priority: 1, createdAt: '2026-01-08', projectId: 'pricing-engine', labels: ['compliance'], contract },
  { id: 'rev-be-3', title: 'Review PR #3 in the capped project', status: 'todo', dependsOn: [], priority: 1, createdAt: '2026-01-09', projectId: 'budget-engine', labels: ['compliance'], contract },
  { id: 'pe-9', title: 'Old work now under review', status: 'review', dependsOn: [], priority: 0, createdAt: '2026-01-01', projectId: 'pricing-engine', assignee: 'impl-1', contract }
];
write('tasks.json', { tasks: t0 });
commit('hive: tasks (5)');

const t1 = t0.map((t) => {
  if (t.id === 'pe-1') return { ...t, assignee: 'impl-1', status: 'doing' };
  if (t.id === 'pe-2') return { ...t, assignee: 'impl-1' };            // dispatcher disagreed with the capability match
  if (t.id === 'pe-3') return { ...t, assignee: 'test-1' };            // dispatched WITHOUT a contract
  return t;
});
write('tasks.json', { tasks: t1 });
commit('hive: tasks (5)');

// ── run the real harness over it ────────────────────────────────────────────
const traceFile = join(hive, 'trace.jsonl');
execFileSync('node', [join(repoRoot, 'tools', 'replay-assignment.mjs'), hive, '--jsonl', traceFile], { encoding: 'utf8' });
const trace = readFileSync(traceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const strictOut = execFileSync('node', [join(repoRoot, 'tools', 'replay-assignment.mjs'), hive, '--strict-idle'], { encoding: 'utf8' });

let failures = 0;
const expect = (cond, what) => {
  if (cond) { console.log(`ok   ${what}`); return; }
  console.error(`FAIL ${what}`);
  failures++;
};

const at = (task, rule) => trace.filter((r) => r.task.endsWith(task) && r.rule === rule);

expect(at('pe-1', 'idle-pull').some((r) => r.decision === 'dispatch→impl-1' && r.outcome === 'AGREE'),
  'pe-1: idle-pull to impl-1, history agrees');
expect(at('pe-2', 'idle-pull').some((r) => r.decision === 'dispatch→test-1' && r.outcome === 'DIFFER'),
  'pe-2: capability match picks test-1, dispatcher differed');
expect(at('pe-3', 'no-contract').some((r) => r.outcome === 'DISPATCHER-DID'),
  'pe-3: contract-less dispatch is caught as DISPATCHER-DID');
expect(at('it-1', 'explicit-assignee').some((r) => r.decision === 'dispatch→docs-1'),
  'it-1: explicit assignee honored');
expect(trace.filter((r) => r.task.endsWith('x-1')).every((r) => r.rule === 'unfiled' && r.outcome === 'HOLD'),
  'x-1: unfiled card is always held for the dispatcher');
expect(trace.every((r) => !(r.decision.startsWith('dispatch→') && r.decision.includes('→god'))),
  'the orchestrator never pulls backlog cards');
expect(!/idle-pull/.test(strictOut),
  '--strict-idle disables the pull rule entirely');
expect(at('be-1', 'over-budget').length > 0 && at('be-1', 'over-budget').every((r) => r.outcome === 'HOLD'),
  'be-1: a capped project dispatches nothing ($6 spent of $5 — per-session max, not row sum)');
expect(at('be-2', 'over-budget').length > 0,
  'be-2: even an explicit assignee is held while the project is over budget');
expect(at('rev-pe-9', 'idle-pull').some((r) => r.decision === 'dispatch→compl-1'),
  'rev-pe-9: compliance card routes cross-project to the compliance agent');
expect(at('rev-be-3', 'over-budget').length === 0
    && trace.some((r) => r.task.endsWith('rev-be-3') && (r.rule === 'idle-pull' || r.rule === 'no-idle-member')),
  'rev-be-3: a review in a capped project is never budget-held — only reviewer scarcity holds it');
expect(trace.every((r) => r.decision !== 'dispatch→compl-1' || r.task.startsWith('rev-')),
  'compliance agents never receive non-review work');
expect(at('pe-1', 'idle-pull').some((r) => r.decision === 'dispatch→impl-1'),
  'pe-9 in review does not busy impl-1 — the author is back in the hive');

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\nreplay selftest: all assertions hold');
