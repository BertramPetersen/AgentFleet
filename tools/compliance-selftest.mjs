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

if (failures) { console.error(`\n${failures} assertion(s) failed`); process.exit(1); }
console.log('\ncompliance selftest: all assertions hold');
