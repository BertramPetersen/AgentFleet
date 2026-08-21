import { useEffect, useRef, useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import type { HarnessConfig } from '@/store/config';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';

/**
 * The one restore-team control, rehomed from the retired agent dock to the
 * fleet toolbar — the first screen after a restart is exactly where "bring my
 * team back" belongs. Renders nothing when there is nothing to restore and no
 * restore in flight; while the BOOT auto-restore runs it collapses to a single
 * disabled "restoring your team…" so the automatic run never reads as a click
 * you don't remember making.
 */
export function RestoreTeamButton({ config }: { config?: HarnessConfig | null }) {
  const restorableAgents = useStore((s) => s.restorableAgents);
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  const busy = restoring || autoRestoring;
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (restorableAgents.length === 0 || busy) setOpen(false);
  }, [restorableAgents.length, busy]);

  if (restorableAgents.length === 0 && !busy) return null;

  return (
    <span
      ref={anchorRef}
      style={{ position: 'relative', flexShrink: 0 }}
      title={busy
        ? "Your previous session's agents are being respawned with their original ids, so memory and inboxes reattach."
        : `Previous session: ${restorableAgents.map((a: Agent) => a.name).join(', ')}`}
    >
      <PixelButton
        variant="primary"
        size="sm"
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <Icon name="play" />
          {busy ? 'restoring your team…' : `restore team (${restorableAgents.length}) ▾`}
        </span>
      </PixelButton>

      {open && restorableAgents.length > 0 && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 349, background: 'transparent' }}
          />
          <div style={{
            position: 'absolute', right: 0, top: 'calc(100% + 6px)',
            zIndex: 350, minWidth: 260, maxHeight: '50vh', overflowY: 'auto',
            background: 'var(--cth-cream-200)',
            borderRadius: 'var(--cth-radius-md)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-100), var(--cth-shadow-hard)',
            padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
            fontFamily: 'var(--cth-font-ui)'
          }}>
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 'var(--cth-text-display-sm)',
              lineHeight: '14px', letterSpacing: '0.12em',
              color: 'var(--cth-ink-500)', textTransform: 'uppercase'
            }}>
              previous session
            </span>
            {/* Per-agent dismiss wires straight to removeRestorableAgent
                (filters + persists), so a dismissed agent never reappears
                after reload. */}
            {restorableAgents.map((a: Agent) => (
              <span
                key={a.id}
                title={`${a.name} — restorable from last session`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  height: 26, padding: '0 4px 0 8px',
                  fontSize: 'var(--cth-text-body-sm)', color: 'var(--cth-ink-900)',
                  background: 'var(--cth-paper-100)',
                  borderRadius: 'var(--cth-radius-sm)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)'
                }}
              >
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.name}
                </span>
                <span style={{ fontSize: 'var(--cth-text-mono-sm)', color: 'var(--cth-ink-500)', whiteSpace: 'nowrap' }}>
                  {a.description ? a.description.slice(0, 24) : ''}
                </span>
                <button
                  onClick={() => useStore.getState().removeRestorableAgent(a.id)}
                  title={`Dismiss ${a.name} — remove permanently from the restore list`}
                  aria-label={`Dismiss ${a.name}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 18, height: 18, padding: 0, lineHeight: 1,
                    fontSize: 12, color: 'var(--cth-ink-500)',
                    background: 'transparent', border: 'none', cursor: 'pointer'
                  }}
                >✕</button>
              </span>
            ))}
            <PixelButton
              variant="primary"
              size="sm"
              onClick={() => { setOpen(false); void restoreTeam(); }}
            >
              <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', whiteSpace: 'nowrap' }}>
                <Icon name="play" /> restore all ({restorableAgents.length})
              </span>
            </PixelButton>
          </div>
        </>
      )}
    </span>
  );
}
