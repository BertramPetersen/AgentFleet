import { useStore } from '@/store/store';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { AgentAvatar } from './AgentAvatar';

/**
 * P0 placeholder for the main canvas, where the office floor used to live.
 * A flat roster: who exists, what they are doing, and click to select — enough
 * to drive the app while the Fleet table (P1) is built against fleet.json and
 * the telemetry collector.
 */
export function AgentRoster() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <PixelPanel variant="default" title="FLEET" noPadding>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {agents.map((a) => {
            const on = a.id === selectedId;
            return (
              <button
                key={a.id}
                onClick={() => select(a.id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '24px minmax(0,1fr) minmax(0,120px) 92px',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  textAlign: 'left',
                  border: 'none',
                  cursor: 'pointer',
                  background: on ? `var(--cth-${a.accent}-light)` : 'var(--cth-cream-100)',
                  boxShadow: 'inset 0 -1px 0 var(--cth-ink-100)'
                }}
              >
                <AgentAvatar name={a.name} accent={a.accent} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: 'var(--cth-text-display-sm)',
                    color: 'var(--cth-ink-900)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {a.name}{a.isGod ? ' · boss' : ''}
                  </span>
                  <span style={{
                    fontFamily: 'var(--cth-font-ui)',
                    fontSize: 'var(--cth-text-body-sm)',
                    color: 'var(--cth-ink-500)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {a.action || 'awaiting'}
                  </span>
                </span>
                <span style={{
                  fontFamily: 'var(--cth-font-ui)',
                  fontSize: 'var(--cth-text-body-sm)',
                  color: 'var(--cth-ink-500)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>
                  {a.project}
                </span>
                <PixelBadge status={a.status} />
              </button>
            );
          })}
        </div>
      </PixelPanel>
    </div>
  );
}
