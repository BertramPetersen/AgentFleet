import { useEffect, useState } from 'react';

/**
 * HOUSE RULES — the preference ledger, visible and correctable.
 *
 * "Continually learn my preferences" only deserves trust if the human can SEE
 * what was learned, where it came from, and push back. Every entry shows its
 * rule, provenance (rationale + evidence count), scope, confidence, and the
 * applied/overridden exposure counters. Three levers, all audit-logged as
 * hive commits: boost (vouch, +0.1), override (push back, −0.15 — repeated
 * overrides sink a rule below the injection floor on their own), retire
 * (confidence to zero; the entry stays, because the ledger is history).
 */

const POLL_MS = 5000;
const FLOOR = 0.2; // mirrors CONFIDENCE_FLOOR in main/preferences.ts

interface Pref {
  id: string;
  rule: string;
  rationale: string;
  evidence: string[];
  scope: string;
  confidence: number;
  applied: number;
  overridden: number;
}

export function HouseRulesView() {
  const [prefs, setPrefs] = useState<Pref[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = (): void => {
    window.cth.compliancePrefs?.().then((p) => setPrefs(p ?? [])).catch(() => { /* hive off */ });
  };
  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, []);

  const act = async (id: string, action: 'boost' | 'override' | 'retire'): Promise<void> => {
    setBusy(id);
    try { await window.cth.compliancePatchPref?.(id, action); load(); } finally { setBusy(null); }
  };

  const live = prefs.filter((p) => p.confidence >= FLOOR).sort((a, b) => b.confidence - a.confidence);
  const retired = prefs.filter((p) => p.confidence < FLOOR).sort((a, b) => b.confidence - a.confidence);

  return (
    <div style={{
      height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)', boxShadow: 'var(--cth-panel-border)'
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
        borderBottom: '1px solid var(--cth-ink-100)'
      }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-md)',
          color: 'var(--cth-ink-900)'
        }}>House rules</span>
        <span style={{
          fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
          color: 'var(--cth-ink-500)'
        }}>
          {live.length === 0 ? 'nothing learned yet' : `${live.length} active · injected into every review dispatch`}
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {prefs.length === 0 && (
          <div style={{
            padding: '32px 16px', textAlign: 'center',
            fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-500)'
          }}>
            <div style={{ fontSize: 'var(--cth-text-body-md)', marginBottom: 6 }}>
              The ledger is empty.
            </div>
            <div style={{ fontSize: 'var(--cth-text-body-sm)', maxWidth: 460, margin: '0 auto', lineHeight: 1.5 }}>
              It learns two ways: answers you give on review cards in Needs-you, and
              proposals mined from your own post-merge corrections. Everything shows
              up here with its evidence, and nothing is learned silently.
            </div>
          </div>
        )}

        {live.map((p) => (
          <RuleCard key={p.id} pref={p} busy={busy === p.id} onAct={(a) => void act(p.id, a)} />
        ))}

        {retired.length > 0 && (
          <>
            <div style={{
              marginTop: 8, fontFamily: 'var(--cth-font-display)',
              fontSize: 'var(--cth-text-display-sm)', textTransform: 'uppercase',
              letterSpacing: '0.12em', color: 'var(--cth-ink-500)'
            }}>Retired — kept as history, never injected</div>
            {retired.map((p) => (
              <RuleCard key={p.id} pref={p} busy={busy === p.id} retired onAct={(a) => void act(p.id, a)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function RuleCard({ pref, busy, retired, onAct }: {
  pref: Pref;
  busy: boolean;
  retired?: boolean;
  onAct: (action: 'boost' | 'override' | 'retire') => void;
}) {
  const pct = Math.round(pref.confidence * 100);
  return (
    <div style={{
      boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
      borderRadius: 'var(--cth-radius-md)',
      background: 'var(--cth-cream-200)',
      padding: '11px 14px',
      opacity: retired ? 0.6 : 1
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-ui)',
          fontSize: 'var(--cth-text-body-md)', color: 'var(--cth-ink-900)', lineHeight: 1.5
        }}>{pref.rule}</span>
        <span style={{
          fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
          color: 'var(--cth-ink-500)', whiteSpace: 'nowrap'
        }}>{pref.id}</span>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap',
        fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-500)'
      }}>
        <span style={{
          padding: '0 7px', borderRadius: 'var(--cth-radius-pill)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
          fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
          color: 'var(--cth-ink-700)'
        }}>{pref.scope}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            width: 72, height: 4, borderRadius: 2, background: 'var(--cth-cream-300)', overflow: 'hidden', display: 'inline-block'
          }}>
            <span style={{
              display: 'block', height: '100%', width: `${pct}%`, borderRadius: 2,
              background: pref.confidence >= 0.6 ? 'var(--cth-status-success)'
                : pref.confidence >= FLOOR ? 'var(--cth-status-working)' : 'var(--cth-status-blocked)'
            }} />
          </span>
          {pct}%
        </span>
        <span title="times this rule rode a review dispatch">applied {pref.applied}</span>
        <span title="times you pushed back on it">overridden {pref.overridden}</span>
        <span title={pref.rationale}>{pref.evidence.length} evidence · <span style={{ fontStyle: 'italic' }}>{pref.rationale.slice(0, 60)}{pref.rationale.length > 60 ? '…' : ''}</span></span>

        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 5 }}>
          <ActionChip label="boost" title="Vouch for this rule (+0.10 confidence)" disabled={busy || pref.confidence >= 1} onClick={() => onAct('boost')} />
          <ActionChip label="override" title="Push back (−0.15 confidence — repeated overrides retire it)" disabled={busy} onClick={() => onAct('override')} />
          {!retired && <ActionChip label="retire" title="Stop injecting it — the entry stays as history" tone="danger" disabled={busy} onClick={() => onAct('retire')} />}
        </span>
      </div>
    </div>
  );
}

function ActionChip({ label, title, onClick, disabled, tone }: {
  label: string; title: string; onClick: () => void; disabled?: boolean; tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '1px 8px', border: 'none', cursor: disabled ? 'default' : 'pointer',
        borderRadius: 'var(--cth-radius-sm)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
        background: 'var(--cth-paper-100)',
        boxShadow: `inset 0 0 0 1px ${tone === 'danger' ? 'var(--cth-status-blocked-bd)' : 'var(--cth-ink-300)'}`,
        color: disabled ? 'var(--cth-ink-500)' : tone === 'danger' ? 'var(--cth-coral)' : 'var(--cth-ink-900)'
      }}
    >{label}</button>
  );
}
