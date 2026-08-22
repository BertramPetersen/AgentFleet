#!/usr/bin/env node
/**
 * Review eval — score harvested review findings against post-merge reality.
 *
 * no-mistakes' lesson, applied to the Compliance Department: the gold label
 * for a review is what happened AFTER the merge. A finding whose file the
 * human later corrected is a confirmed hit; a human correction in a file no
 * finding named is a candidate miss. Run this BEFORE changing the review
 * contract or the reviewer prompt — same reason the assignment rules have
 * `npm run replay`.
 *
 * Reads only what the department already records: review cards' harvested
 * `findings`/`verdict` (findingsHarvester) and the `mined.commits` stamps
 * (correctionMiner), resolving each correction commit's files via git.
 *
 * Usage: npm run review:eval -- <hive-root>
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const hive = process.argv[2];
if (!hive) {
  console.error('usage: review-eval.mjs <hive-root>');
  process.exit(2);
}

const read = (f) => {
  const p = join(hive, f);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};

const tasks = read('tasks.json')?.tasks ?? [];
const projects = new Map((read('projects.json')?.projects ?? []).map((p) => [p.id, p]));

const reviews = tasks.filter((t) => typeof t?.id === 'string' && t.id.startsWith('rev-'));
const scored = [];
let confirmed = 0;
let candidateMisses = 0;

for (const card of reviews) {
  const findings = Array.isArray(card.findings) ? card.findings : [];
  const commits = card.mined?.commits ?? [];
  const repo = projects.get(card.projectId)?.repoPath;
  const correctedFiles = new Set();
  if (repo && commits.length) {
    for (const sha of commits) {
      try {
        execFileSync('git', ['-C', repo, 'show', '--name-only', '--format=', sha], { encoding: 'utf8', timeout: 10_000 })
          .split('\n').filter(Boolean).forEach((f) => correctedFiles.add(f));
      } catch { /* commit gone (rebase) — skip */ }
    }
  }
  const findingFiles = new Set(findings.map((f) => f.file).filter(Boolean));
  const hits = [...findingFiles].filter((f) => correctedFiles.has(f));
  const misses = [...correctedFiles].filter((f) => !findingFiles.has(f));
  confirmed += hits.length;
  candidateMisses += misses.length;
  scored.push({
    card: card.id,
    verdict: card.verdict ?? '—',
    findings: findings.length,
    corrections: commits.length,
    hitFiles: hits,
    missFiles: misses
  });
}

for (const r of scored) {
  console.log(`${r.card}  verdict:${r.verdict}  findings:${r.findings}  corrections:${r.corrections}`
    + (r.hitFiles.length ? `  ✓ confirmed: ${r.hitFiles.join(', ')}` : '')
    + (r.missFiles.length ? `  ⚠ human corrected unflagged: ${r.missFiles.join(', ')}` : ''));
}

const withFindings = scored.filter((r) => r.findings > 0).length;
const withCorrections = scored.filter((r) => r.corrections > 0).length;
console.log(`\n${reviews.length} review card(s) · ${withFindings} with harvested findings · ${withCorrections} followed by human corrections`);
console.log(`confirmed finding-files ${confirmed} · candidate miss-files ${candidateMisses}`);
if (candidateMisses > 0) {
  console.log('\n⚠ candidate misses are false-negative gold: the human fixed something no finding named.');
  console.log('  Feed them into the reviewer contract/preferences BEFORE tuning anything else.');
}
