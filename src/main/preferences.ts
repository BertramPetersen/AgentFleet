/**
 * The preference ledger — how the human likes code written, as durable,
 * evidence-backed data (Compliance C2, decision D3: one global ledger with
 * per-project overlay entries).
 *
 * Lives at `<hive>/compliance/preferences.jsonl`, written only by main and
 * committed by the hive's single committer, so every learned preference has
 * an audit trail. Nothing is learned silently: every entry cites its
 * evidence (the review card and question it came from), and the Needs-you
 * surface says out loud that answers on review cards land here.
 *
 * Entries carry applied/overridden counters. `applied` increments every time
 * an entry rides a review dispatch — it measures exposure, so a rule that has
 * been applied many times and never contradicted is load-bearing. Confidence
 * decays when `overridden` grows (C3's implicit-learning loop will drive
 * that); an entry whose confidence falls below the floor stops being injected
 * but is never deleted — the ledger is history, retirement is a state.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface Preference {
  id: string;
  /** The rule itself, phrased as an instruction a reviewer can apply. */
  rule: string;
  /** Where it came from — never invented. */
  rationale: string;
  /** Card ids, PR refs, commit shas — the trail. */
  evidence: string[];
  /** 'global' or a project id (D3 overlay). */
  scope: string;
  /** 0..1. Injection stops below CONFIDENCE_FLOOR; never deleted. */
  confidence: number;
  applied: number;
  overridden: number;
  createdAt: string;
  updatedAt: string;
}

export const CONFIDENCE_FLOOR = 0.2;
/** How many rules ride one dispatch — the strongest first, never the firehose. */
const DIGEST_LIMIT = 12;

export interface PreferenceHive {
  root(): string | null;
  ensureHive(): void;
  commit(message: string): void;
}

function slug(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 10);
}

export class PreferenceStore {
  constructor(private hive: PreferenceHive) {}

  private file(): string | null {
    const root = this.hive.root();
    return root ? join(root, 'compliance', 'preferences.jsonl') : null;
  }

  list(): Preference[] {
    const path = this.file();
    if (!path || !existsSync(path)) return [];
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as Preference; } catch { return null; } })
        .filter((p): p is Preference => !!p && typeof p.id === 'string' && typeof p.rule === 'string');
    } catch {
      return [];
    }
  }

  private write(prefs: Preference[], message: string): void {
    const path = this.file();
    if (!path) return;
    this.hive.ensureHive();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, prefs.map((p) => JSON.stringify(p)).join('\n') + (prefs.length ? '\n' : ''), 'utf8');
    renameSync(tmp, path);
    this.hive.commit(message);
  }

  upsert(patch: Partial<Preference> & { rule: string }): Preference {
    const prefs = this.list();
    const id = patch.id ?? slug(patch.rule);
    const now = new Date().toISOString();
    const existing = prefs.find((p) => p.id === id);
    const next: Preference = existing
      ? {
          ...existing,
          ...patch,
          id,
          evidence: [...new Set([...existing.evidence, ...(patch.evidence ?? [])])],
          updatedAt: now
        }
      : {
          id,
          rule: patch.rule,
          rationale: patch.rationale ?? '',
          evidence: patch.evidence ?? [],
          scope: patch.scope ?? 'global',
          confidence: patch.confidence ?? 0.6,
          applied: 0,
          overridden: 0,
          createdAt: now,
          updatedAt: now
        };
    this.write([...prefs.filter((p) => p.id !== id), next], `hive: preference ${existing ? 'updated' : 'learned'} (${id})`);
    return next;
  }

  /** The explicit learning loop: a human answer on a review card's ask IS
   *  feedback on how they want the work judged. Recorded verbatim with the
   *  question as rationale — generalizing it into a crisper rule is C3's
   *  judgment work, not this function's. Re-answering the same text
   *  strengthens the same entry instead of duplicating it. */
  recordAnswer(input: { taskId: string; question: string; answer: string; projectId?: string }): Preference | null {
    const rule = input.answer.trim();
    if (!rule) return null;
    const prefs = this.list();
    const id = slug(rule.toLowerCase());
    const existing = prefs.find((p) => p.id === id);
    if (existing) {
      return this.upsert({
        id,
        rule: existing.rule,
        evidence: [input.taskId],
        confidence: Math.min(1, existing.confidence + 0.1)
      });
    }
    return this.upsert({
      id, // normalized (lowercased) so a re-answer with different casing strengthens, not duplicates
      rule,
      rationale: `human override on review ask: "${input.question}"`,
      evidence: [input.taskId],
      scope: 'global',
      confidence: 0.6
    });
  }

  /** The rules that should ride a dispatch into `projectId`: live entries,
   *  global scope plus the project's overlay, strongest first. */
  active(projectId?: string): Preference[] {
    return this.list()
      .filter((p) => p.confidence >= CONFIDENCE_FLOOR)
      .filter((p) => p.scope === 'global' || (projectId && p.scope === projectId))
      .sort((a, b) => b.confidence - a.confidence || b.applied - a.applied)
      .slice(0, DIGEST_LIMIT);
  }

  /** Markdown block for the review dispatch — empty string when nothing lives. */
  digest(projectId?: string): string {
    const rules = this.active(projectId);
    if (rules.length === 0) return '';
    return [
      'HOUSE PREFERENCES (learned from the human — review against these, cite the id when a finding rests on one):',
      ...rules.map((p) => `- [${p.id}] ${p.rule}`)
    ].join('\n');
  }

  /** The human pushed back on a rule (C3): confidence decays, and an entry
   *  that keeps being overridden sinks below the floor and stops riding
   *  dispatches on its own — the ledger converges on how the human actually
   *  reviews, not on what it once guessed. */
  override(id: string): Preference | null {
    const prefs = this.list();
    const p = prefs.find((x) => x.id === id);
    if (!p) return null;
    p.overridden += 1;
    p.confidence = Math.max(0, Number((p.confidence - 0.15).toFixed(2)));
    p.updatedAt = new Date().toISOString();
    this.write(prefs, `hive: preference overridden (${id})`);
    return p;
  }

  /** The human vouched for a rule: confidence climbs. */
  boost(id: string): Preference | null {
    const prefs = this.list();
    const p = prefs.find((x) => x.id === id);
    if (!p) return null;
    p.confidence = Math.min(1, Number((p.confidence + 0.1).toFixed(2)));
    p.updatedAt = new Date().toISOString();
    this.write(prefs, `hive: preference boosted (${id})`);
    return p;
  }

  /** Retirement is a state, not a deletion: confidence to zero, entry stays. */
  retire(id: string): Preference | null {
    const prefs = this.list();
    const p = prefs.find((x) => x.id === id);
    if (!p) return null;
    p.confidence = 0;
    p.updatedAt = new Date().toISOString();
    this.write(prefs, `hive: preference retired (${id})`);
    return p;
  }

  /** Exposure accounting for the entries that just rode a dispatch. */
  markApplied(ids: string[]): void {
    if (ids.length === 0) return;
    const wanted = new Set(ids);
    const prefs = this.list();
    let touched = false;
    for (const p of prefs) {
      if (wanted.has(p.id)) { p.applied += 1; p.updatedAt = new Date().toISOString(); touched = true; }
    }
    if (touched) this.write(prefs, 'hive: preferences applied on dispatch');
  }
}
