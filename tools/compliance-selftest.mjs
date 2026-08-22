#!/usr/bin/env node
/**
 * Behavioral spec for the Compliance Department's intake (src/main/prWatcher.ts),
 * driven with injected `gh`/`git` so it runs anywhere, networkless, in CI.
 * `npm run compliance:selftest` — exits non-zero when any assertion fails.
 *
 * The D2 contract under test: a new open PR becomes a review card labeled
 * [compliance] with a full dispatch contract; the author's doing-card on the
 * PR's head branch flips to 'review' (the author returns to the hive); drafts
 * are skipped; the whole thing is idempotent across ticks and restarts.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = await import(pathToFileURL(join(repoRoot, 'node_modules', 'esbuild', 'lib', 'main.js')).href);
const tmp = mkdtempSync(join(tmpdir(), 'compliance-selftest-'));
const bundled = esbuild.buildSync({
  entryPoints: [join(repoRoot, 'src', 'main', 'prWatcher.ts')],
  bundle: true, format: 'esm', platform: 'node', write: false
});
const mod = join(tmp, 'prWatcher.mjs');
writeFileSync(mod, bundled.outputFiles[0].text);
const { PrWatcher, reviewCardId } = await import(pathToFileURL(mod).href);

const loadTs = async (name) => {
  const b = esbuild.buildSync({
    entryPoints: [join(repoRoot, 'src', 'main', `${name}.ts`)],
    bundle: true, format: 'esm', platform: 'node', write: false
  });
  const f = join(tmp, `${name}.mjs`);
  writeFileSync(f, b.outputFiles[0].text);
  return import(pathToFileURL(f).href);
};
const { PreferenceStore, CONFIDENCE_FLOOR } = await loadTs('preferences');
const { parseFindingsReport, FindingsHarvester } = await loadTs('findingsHarvester');
const { CorrectionMiner, mineCardId } = await loadTs('correctionMiner');
const { AssignmentEngine } = await loadTs('assignmentEngine');

// ── an in-memory hive, shaped like the structural deps ──────────────────────
const state = {
  tasks: [
    { id: 'w-1', title: 'Build the thing', status: 'doing', assignee: 'impl-1', dependsOn: [], priority: 0, createdAt: 't', projectId: 'alpha' },
    { id: 'w-2', title: 'Unrelated work', status: 'doing', assignee: 'impl-2', dependsOn: [], priority: 0, createdAt: 't', projectId: 'alpha' }
  ],
  log: []
};
const hive = {
  enabled: () => true,
  tasks: () => ({ tasks: state.tasks }),
  addTask: (t) => {
    if (state.tasks.some((x) => x.id === t.id)) return false;
    state.tasks.push(t);
    return true;
  },
  patchTask: (id, patch) => {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return false;
    Object.assign(t, patch);
    return true;
  },
  appendLog: (e) => state.log.push(e),
  registry: () => ({
    agents: {
      'impl-1': { id: 'impl-1', cwd: '/wt/impl-1' },
      'impl-2': { id: 'impl-2', cwd: '/wt/impl-2' }
    }
  })
};
const projects = { list: () => [{ id: 'alpha', repoPath: '/repos/alpha' }] };

const prs = [
  { number: 7, title: 'Add the widget', url: 'https://github.com/x/alpha/pull/7', headRefName: 'feat/widget', isDraft: false },
  { number: 8, title: 'WIP thing', url: 'https://github.com/x/alpha/pull/8', headRefName: 'wip/thing', isDraft: true }
];
const watcher = new PrWatcher({
  hive,
  projects,
  listOpenPrs: async () => prs,
  branchOf: async (dir) => (dir === '/wt/impl-1' ? 'feat/widget' : 'main')
});

let failures = 0;
const expect = (cond, what) => {
  if (cond) { console.log(`ok   ${what}`); return; }
  console.error(`FAIL ${what}`);
  failures++;
};

const created = await watcher.tick();
const rev = state.tasks.find((t) => t.id === reviewCardId('alpha', 7));

expect(created.length === 1 && !!rev, 'one review card created for the one open non-draft PR');
expect(!state.tasks.some((t) => t.id === reviewCardId('alpha', 8)), 'draft PRs are skipped');
expect((rev?.labels ?? []).includes('compliance'), 'the review card carries the compliance label');
expect(!!rev?.contract?.objective?.includes('pull/7') && !!rev?.contract?.output?.includes('"findings"'),
  'the contract names the PR and demands the findings schema');
expect(rev?.review?.headRef === 'feat/widget', 'the card records the PR head for verdict-time matching');
expect(state.tasks.find((t) => t.id === 'w-1')?.status === 'review',
  "the author's work card on the PR branch flipped to 'review'");
expect(state.tasks.find((t) => t.id === 'w-2')?.status === 'doing',
  'unrelated doing-cards are untouched');
expect(state.log.some((e) => e.kind === 'pr-review-card') && state.log.some((e) => e.kind === 'pr-handoff'),
  'both the intake and the handoff hit the audit log');

const again = await watcher.tick();
expect(again.length === 0 && state.tasks.filter((t) => t.id === reviewCardId('alpha', 7)).length === 1,
  'a second tick is a no-op — intake is idempotent');

// ── the preference ledger (C2) ──────────────────────────────────────────────
import('node:fs').then(() => {});
const { mkdirSync } = await import('node:fs');
const prefHiveRoot = join(tmp, 'pref-hive');
mkdirSync(prefHiveRoot, { recursive: true });
let commits = 0;
const prefHive = { root: () => prefHiveRoot, ensureHive: () => {}, commit: () => { commits++; } };
const store = new PreferenceStore(prefHive);

const learned = store.recordAnswer({ taskId: 'rev-x-1', question: 'Tabs or spaces?', answer: 'No reflexive doc comments — comments only for non-obvious WHY' });
expect(learned && learned.scope === 'global' && learned.confidence === 0.6 && learned.evidence.includes('rev-x-1'),
  'an answer on a review card becomes a global, evidence-backed preference');
const strengthened = store.recordAnswer({ taskId: 'rev-x-2', question: 'Again?', answer: 'no reflexive doc comments — comments only for non-obvious why' });
expect(strengthened.id === learned.id && strengthened.confidence > 0.6 && strengthened.evidence.length === 2,
  're-answering the same text strengthens the same entry, never duplicates');

store.upsert({ rule: 'Alpha-only convention', scope: 'alpha', confidence: 0.9, rationale: 't', evidence: [] });
store.upsert({ rule: 'A retired rule', confidence: CONFIDENCE_FLOOR - 0.1, rationale: 't', evidence: [] });
const alphaDigest = store.digest('alpha');
const betaDigest = store.digest('beta');
expect(alphaDigest.includes('Alpha-only convention') && !betaDigest.includes('Alpha-only convention'),
  'project-overlay entries ride only their own project (D3)');
expect(!alphaDigest.includes('A retired rule'),
  'entries below the confidence floor stop being injected');

store.markApplied([learned.id]);
expect(store.list().find((x) => x.id === learned.id)?.applied === 1,
  'markApplied counts exposure');

// ── the dispatch carries the ledger ─────────────────────────────────────────
const sent = [];
const engineState = {
  tasks: [{ id: 'rev-alpha-9', title: 'Review PR #9', status: 'todo', dependsOn: [], priority: 1, createdAt: 't',
            projectId: 'alpha', labels: ['compliance'],
            contract: { objective: 'review it', output: 'verdict' } }]
};
const engineHive = {
  enabled: () => true,
  tasks: () => ({ tasks: engineState.tasks }),
  patchTask: (id, patch) => { Object.assign(engineState.tasks.find((t) => t.id === id), patch); return true; },
  send: (msg) => { sent.push(msg); return msg; },
  registry: () => ({ godId: 'god', agents: {
    'compl-1': { id: 'compl-1', cwd: '/office', role: 'compliance reviewer', capabilities: ['compliance'] }
  } }),
  appendLog: () => {}
};
const engine = new AssignmentEngine({
  hive: engineHive,
  projects: { list: () => [{ id: 'alpha', repoPath: '/repos/alpha' }] },
  idleAgents: () => new Set(['compl-1']),
  preferences: store
});
engine.tick();
expect(sent.length === 1 && sent[0].body.includes('HOUSE PREFERENCES') && sent[0].body.includes('No reflexive doc comments'),
  'a compliance dispatch carries the house preferences');
expect(store.list().find((x) => x.id === learned.id)?.applied === 2,
  'injection counts as exposure');

// ── decay (C3) ──────────────────────────────────────────────────────────────
const decaying = store.upsert({ rule: 'A rule the human keeps rejecting', confidence: 0.4, rationale: 't', evidence: [] });
store.override(decaying.id);
const afterOne = store.list().find((x) => x.id === decaying.id);
store.override(decaying.id);
const afterTwo = store.list().find((x) => x.id === decaying.id);
expect(afterOne.confidence === 0.25 && afterOne.overridden === 1,
  'an override decays confidence and counts');
expect(afterTwo.confidence < CONFIDENCE_FLOOR && !store.digest().includes('keeps rejecting'),
  'repeated overrides sink a rule below the floor — it stops riding dispatches on its own');
store.boost(decaying.id);
expect(store.list().find((x) => x.id === decaying.id).confidence === 0.2,
  'boost climbs back — nothing is ever deleted');

// ── findings harvester (C3) ─────────────────────────────────────────────────
const report = parseFindingsReport(
  'Verdict: REQUEST_CHANGES on rev-alpha-7.\n' +
  'Here are my findings:\n```json\n{"findings":[{"id":"missing-guard","severity":"error","file":"src/a.ts","line":12,"description":"no traversal guard","action":"fix"},{"id":"bad","description":"kept despite junk severity","severity":"catastrophic"}]}\n```\nthanks'
);
expect(report && report.reviewCardId === 'rev-alpha-7' && report.verdict === 'REQUEST_CHANGES',
  'harvester finds the card id and the verdict in prose');
expect(report.findings.length === 2 && report.findings[0].file === 'src/a.ts' && report.findings[1].severity === 'info',
  'findings parse out of fenced JSON; junk severities coerce to info');
expect(parseFindingsReport('just chatting about rev-alpha-7 with no verdict or findings') === null,
  'plain chatter mentioning a card harvests nothing');

const harvestState = { tasks: [{ id: 'rev-alpha-7', title: 'r', status: 'doing', dependsOn: [], priority: 1, createdAt: 't' }], log: [] };
const harvester = new FindingsHarvester({
  hive: {
    tasks: () => ({ tasks: harvestState.tasks }),
    patchTask: (id, patch) => { Object.assign(harvestState.tasks.find((t) => t.id === id), patch); return true; },
    appendLog: (e) => harvestState.log.push(e)
  },
  isComplianceAgent: (id) => id === 'compl-1'
});
harvester.onRouted({ from: 'impl-1', subject: 's', body: 'APPROVE rev-alpha-7 {"findings":[]}' });
expect(!harvestState.tasks[0].verdict, 'reports from non-compliance agents are ignored');
harvester.onRouted({ from: 'compl-1', subject: 'review done', body: 'APPROVE rev-alpha-7. {"findings":[{"id":"x","description":"minor","severity":"info"}]}' });
expect(harvestState.tasks[0].verdict === 'APPROVE' && harvestState.tasks[0].findings.length === 1 && harvestState.tasks[0].reviewedBy === 'compl-1',
  "a compliance agent's report lands on the card: verdict, findings, reviewer");

// ── correction miner (C3) ───────────────────────────────────────────────────
const mineState = {
  tasks: [{ id: 'rev-beta-4', title: 'Review PR #4', status: 'done', dependsOn: [], priority: 1, createdAt: 't',
            projectId: 'beta', labels: ['compliance'], review: { url: 'https://x/pull/4', number: 4, headRef: 'f' } }],
  log: []
};
const miner = new CorrectionMiner({
  hive: {
    enabled: () => true,
    tasks: () => ({ tasks: mineState.tasks }),
    addTask: (t) => { if (mineState.tasks.some((x) => x.id === t.id)) return false; mineState.tasks.push(t); return true; },
    patchTask: (id, patch) => { Object.assign(mineState.tasks.find((t) => t.id === id), patch); return true; },
    appendLog: (e) => mineState.log.push(e)
  },
  projects: { list: () => [{ id: 'beta', repoPath: '/repos/beta' }] },
  prInfo: async () => ({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', files: ['src/x.ts'] }),
  humanCommits: async () => ['abc1234']
});
const mined = await miner.tick();
const mineCard = mineState.tasks.find((t) => t.id === mineCardId('rev-beta-4'));
expect(mined.length === 1 && !!mineCard && mineCard.labels.includes('compliance'),
  'a post-merge human correction becomes a compliance mine-card');
expect(mineCard.contract.output.includes('humanQA') && mineCard.contract.boundaries.includes('Never write the ledger'),
  'the mine contract proposes via humanQA and forbids direct ledger writes');
expect(mineState.tasks.find((t) => t.id === 'rev-beta-4').mined.commits.includes('abc1234'),
  'the review card is stamped mined');
const minedAgain = await miner.tick();
expect(minedAgain.length === 0, 'mining is idempotent — a stamped review is never re-mined');

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\ncompliance selftest: all assertions hold');
