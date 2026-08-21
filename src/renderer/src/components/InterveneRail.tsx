import { useEffect, useMemo, useState } from 'react';
import { PixelButton } from './PixelButton';
import { useAgentSpans } from '@/hooks/useTelemetry';

/**
 * INTERVENE — helping an agent without derailing it.
 *
 * None of these levers type into the agent's terminal. They ride Claude Code's
 * own hook-return protocol (see src/main/control.ts): pause and tool gates come
 * back as `permissionDecision:'deny'` from PreToolUse, guidance as
 * `additionalContext`, a clean stop as `{continue:false}`. So the agent is never
 * interrupted mid-thought and nothing ever lands on a half-written prompt.
 *
 * That indirection is exactly why the UI has to SAY so. Guidance is queued and
 * arrives at the next hook boundary, which can be seconds away — and a lever
 * that looks like it did nothing reads as broken. Pending steers were already
 * counted in the control snapshot and never shown anywhere.
 *
 * Auto-delivery is deliberately absent: it is one floor-wide switch in the
 * orchestrator's Command Center, not a per-agent toggle. Its state is surfaced
 * here read-only so a held queue is never mistaken for a stuck agent.
 */

interface Snapshot {
  paused: boolean;
  halted: boolean;
  autoDeliveryPaused: boolean;
  gatedTools: string[];
  pendingSteers: number;
}

/** Tools worth offering as gate candidates: the destructive-ish ones first, then
 *  whatever this agent has actually reached for. */
const COMMON_TOOLS = ['Bash', 'Write', 'Edit', 'WebFetch'];

export function InterveneRail({ agentId, live }: { agentId: string; live: boolean }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [steer, setSteer] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const spans = useAgentSpans(agentId);

  useEffect(() => {
    let alive = true;
    const read = () => {
      window.cth.controlSnapshot(agentId)
        .then((s) => { if (alive && s) setSnap(s); })
        .catch(() => { /* no control state yet */ });
    };
    read();
    // The snapshot also moves on its own — the breaker can arm a gate, and a
    // queued steer is consumed by the agent's next hook. Poll so the rail does
    // not sit there claiming a steer is still pending after it landed.
    const t = setInterval(read, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [agentId]);

  const flash = (m: string): void => {
    setNote(m);
    setTimeout(() => setNote((cur) => (cur === m ? null : cur)), 2600);
  };

  const run = async (fn: () => Promise<Snapshot | null>, msg: string): Promise<void> => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) setSnap(s);
      flash(msg);
    } finally {
      setBusy(false);
    }
  };

  const gateCandidates = useMemo(() => {
    const seen = spans.map((s) => s.tool);
    return [...new Set([...COMMON_TOOLS, ...seen])].slice(0, 10);
  }, [spans]);

  const gated = new Set(snap?.gatedTools ?? []);

  const sendSteer = async (): Promise<void> => {
    const text = steer.trim();
    if (!text) return;
    await run(() => window.cth.controlSteer(agentId, text), 'guidance queued — arrives at the next hook boundary');
    setSteer('');
  };

  if (!live) {
    return (
      <Section title="Intervene">
        <p style={hint}>This agent has no live process, so there is nothing to steer.</p>
      </Section>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Section title="Guide this agent">
        <textarea
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendSteer(); }}
          rows={4}
          placeholder="What should it do differently? Injected as context on its next turn — no keystrokes, no interrupt."
          style={{
            width: '100%', resize: 'vertical', padding: '7px 9px',
            borderRadius: 'var(--cth-radius-sm)',
            background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
            color: 'var(--cth-ink-900)', outline: 'none'
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <PixelButton variant="primary" size="sm" onClick={() => void sendSteer()} disabled={!steer.trim() || busy}>
            inject as guidance
          </PixelButton>
          <span style={hint}>⌘↵</span>
        </div>
        {!!snap?.pendingSteers && (
          <div style={{
            marginTop: 8, padding: '4px 8px',
            borderRadius: 'var(--cth-radius-sm)',
            background: 'var(--cth-status-thinking-bg)',
            boxShadow: 'inset 0 0 0 1px var(--cth-status-thinking-bd)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 'var(--cth-text-body-sm)',
            color: 'var(--cth-status-thinking)'
          }}>
            {snap.pendingSteers} pending — waiting for this agent's next hook boundary
          </div>
        )}
      </Section>

      <Section title="Constrain">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <PixelButton
            variant={snap?.paused ? 'primary' : 'secondary'}
            size="sm"
            disabled={busy}
            onClick={() => void run(
              () => (snap?.paused ? window.cth.controlResume(agentId) : window.cth.controlPause(agentId, true)),
              snap?.paused ? 'resumed — tool calls allowed again' : 'paused — every tool call is denied from the next one on'
            )}
          >
            <span title={snap?.paused
              ? 'Resume — allow tool calls again. The session is untouched, so it picks up where it stopped.'
              : 'Pause — deny every tool call from the next one onward. It keeps thinking and talking but cannot read, write or run anything. Immediate and reversible.'}>
              {snap?.paused ? 'resume' : 'pause tool use'}
            </span>
          </PixelButton>
          <PixelButton
            variant="destructive"
            size="sm"
            disabled={busy || snap?.halted}
            onClick={() => void run(() => window.cth.controlHalt(agentId), 'stop requested — it will finish the current step first')}
          >
            <span title="Stop cleanly — ask it to stop at its next hook boundary instead of killing the process. The session survives, so Restart & Continue can resume it.">
              {snap?.halted ? 'stopping…' : 'stop cleanly'}
            </span>
          </PixelButton>
        </div>

        <div style={{ marginTop: 10 }}>
          <div style={{ ...label, marginBottom: 4 }}>gate a tool</div>
          <p style={{ ...hint, margin: '0 0 6px' }}>
            Deny one tool and leave the rest working — narrower than a pause.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {gateCandidates.map((tool) => {
              const on = gated.has(tool);
              return (
                <button
                  key={tool}
                  disabled={busy}
                  onClick={() => void run(
                    () => window.cth.controlGateTool(agentId, tool, !on),
                    on ? `${tool} allowed again` : `${tool} gated — calls to it will be denied`
                  )}
                  title={on ? `Allow ${tool} again` : `Deny every ${tool} call from the next one on`}
                  style={{
                    padding: '2px 8px', cursor: busy ? 'default' : 'pointer', border: 'none',
                    borderRadius: 'var(--cth-radius-sm)',
                    fontFamily: 'var(--cth-font-mono)', fontSize: 'var(--cth-text-mono-sm)',
                    background: on ? 'var(--cth-status-blocked-bg)' : 'var(--cth-paper-100)',
                    boxShadow: on
                      ? 'inset 0 0 0 1px var(--cth-status-blocked-bd)'
                      : 'inset 0 0 0 1px var(--cth-ink-300)',
                    color: on ? 'var(--cth-status-blocked)' : 'var(--cth-ink-900)',
                    textDecoration: on ? 'line-through' : 'none'
                  }}
                >
                  {tool}
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      {(snap?.autoDeliveryPaused || note) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {snap?.autoDeliveryPaused && (
            <div style={{ ...hint, color: 'var(--cth-status-waiting)' }}>
              Message delivery is paused floor-wide — queued messages are waiting, not lost.
            </div>
          )}
          {note && <div style={{ ...hint, color: 'var(--cth-ink-700)' }}>{note}</div>}
        </div>
      )}
    </div>
  );
}

const label: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 'var(--cth-text-display-sm)',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'var(--cth-ink-500)'
};

const hint: React.CSSProperties = {
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 'var(--cth-text-body-sm)',
  color: 'var(--cth-ink-500)',
  lineHeight: 1.45
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ ...label, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
