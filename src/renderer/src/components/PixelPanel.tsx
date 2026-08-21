import { CSSProperties, ReactNode } from 'react';
import { AccentColorName } from '@/design/tokens';

type Variant = 'default' | 'inset' | 'active' | 'terminal' | 'dialog';

export interface PixelPanelProps {
  variant?: Variant;
  title?: string;
  accent?: AccentColorName;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
  noPadding?: boolean;
}

const borderByVariant: Record<Variant, string> = {
  default:  'var(--cth-panel-border)',
  inset:    'var(--cth-panel-border-inset)',
  active:   'var(--cth-panel-border)',  // accent overlay added separately
  terminal: 'var(--cth-panel-border-terminal)',
  dialog:   'var(--cth-panel-border-dialog)'
};

const fillByVariant: Record<Variant, string> = {
  default:  'var(--cth-cream-100)',
  inset:    'var(--cth-cream-200)',
  active:   'var(--cth-cream-100)',
  terminal: 'var(--cth-paper-100)',
  dialog:   'var(--cth-cream-200)'
};

export function PixelPanel({
  variant = 'default',
  title,
  accent,
  children,
  style,
  className,
  noPadding = false
}: PixelPanelProps) {
  const baseStyle: CSSProperties = {
    background: fillByVariant[variant],
    boxShadow: borderByVariant[variant],
    borderRadius: 'var(--cth-radius-md)',
    padding: noPadding ? 0 : 'var(--cth-space-3)',
    position: 'relative',
    overflow: 'hidden',
    ...style
  };

  // Active variant: the mock's selection language — a 2px accent stripe on the
  // left edge, not a ring around the whole panel.
  if (variant === 'active' && accent) {
    baseStyle.boxShadow = `
      inset 0 0 0 1px var(--cth-ink-100),
      inset 3px 0 0 var(--cth-${accent})`;
  }

  return (
    <div className={className} style={baseStyle}>
      {title && (
        <div
          style={{
            margin: noPadding ? 0 : '-12px -12px 12px',
            padding: '6px 12px 5px',
            display: 'flex', alignItems: 'center', gap: 7,
            background: 'var(--cth-cream-200)',
            color: 'var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-display)',
            fontSize: 'var(--cth-text-display-md)',
            lineHeight: 'var(--cth-lh-display-md)',
            boxShadow: 'inset 0 -1px 0 var(--cth-ink-100)'
          }}
        >
          {accent && (
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: `var(--cth-${accent})`, flex: '0 0 7px'
            }} />
          )}
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
