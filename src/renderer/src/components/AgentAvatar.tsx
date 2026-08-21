import type { AccentColorName } from '@/design/tokens';

/** Width/height of a scale-1 avatar, in px. Callers that reserve layout space
 *  for an avatar (headers, strips) size against this. */
export const AVATAR_UNIT = 24;

const ACCENT_VAR: Record<AccentColorName, string> = {
  coral: 'var(--cth-coral)',
  mint: 'var(--cth-mint)',
  sky: 'var(--cth-sky)',
  lemon: 'var(--cth-lemon)',
  lilac: 'var(--cth-lilac)',
  peach: 'var(--cth-peach)'
};

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function AgentAvatar({
  name,
  accent = 'sky',
  scale = 1
}: {
  name: string;
  accent?: AccentColorName;
  scale?: number;
}) {
  const size = AVATAR_UNIT * scale;
  return (
    <div
      aria-label={name}
      title={name}
      style={{
        width: size,
        height: size,
        flex: `0 0 ${size}px`,
        display: 'grid',
        placeItems: 'center',
        background: ACCENT_VAR[accent] ?? ACCENT_VAR.sky,
        color: 'var(--cth-ink-900)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: Math.max(10, Math.round(size * 0.42)),
        lineHeight: 1,
        letterSpacing: 0,
        userSelect: 'none'
      }}
    >
      {initials(name)}
    </div>
  );
}
