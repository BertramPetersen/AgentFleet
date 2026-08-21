import { CSSProperties, ReactNode, useState } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'destructive';
type Size = 'sm' | 'md' | 'lg';

export interface PixelButtonProps {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: CSSProperties;
  title?: string;
}

const heightBySize: Record<Size, number> = { sm: 22, md: 28, lg: 34 };
const padBySize: Record<Size, string> = { sm: '0 9px', md: '0 11px', lg: '0 14px' };

/* The mock's button set (.mk-btn): 6px radius, 1px border, s2 fill. Primary is
   the accent fill with near-black text; ghost drops fill and border entirely;
   destructive is the quiet red outline ("Stop cleanly" in mock C), because a
   solid red button next to a terminal reads as an alarm, not a control. */
export function PixelButton({
  variant = 'primary',
  size = 'md',
  children,
  onClick,
  disabled = false,
  fullWidth = false,
  style,
  title
}: PixelButtonProps) {
  const [pressed, setPressed] = useState(false);
  const [hover, setHover] = useState(false);

  const disabledText = 'var(--cth-ink-500)';

  const palette = (() => {
    switch (variant) {
      case 'primary':
        return {
          fill:   disabled ? 'var(--cth-cream-300)' : (hover ? '#F7DD7E' : 'var(--cth-lemon)'),
          text:   disabled ? disabledText : 'var(--cth-on-accent)',
          border: disabled ? 'var(--cth-ink-100)' : 'var(--cth-lemon)',
          weight: 650
        };
      case 'secondary':
        return {
          fill:   disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-paper-200)' : 'var(--cth-paper-100)'),
          text:   disabled ? disabledText : 'var(--cth-ink-900)',
          border: 'var(--cth-ink-300)',
          weight: 500
        };
      case 'ghost':
        return {
          fill:   hover && !disabled ? 'var(--cth-paper-100)' : 'transparent',
          text:   disabled ? disabledText : 'var(--cth-ink-700)',
          border: 'transparent',
          weight: 500
        };
      case 'destructive':
        return {
          fill:   disabled ? 'var(--cth-cream-300)' : (hover ? 'var(--cth-status-blocked-bg)' : 'var(--cth-paper-100)'),
          text:   disabled ? disabledText : 'var(--cth-coral)',
          border: disabled ? 'var(--cth-ink-100)' : 'var(--cth-status-blocked-bd)',
          weight: 500
        };
    }
  })();

  return (
    <button
      title={title}
      onClick={disabled ? undefined : onClick}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => { setPressed(false); setHover(false); }}
      onMouseEnter={() => setHover(true)}
      disabled={disabled}
      style={{
        height: heightBySize[size],
        padding: padBySize[size],
        background: palette.fill,
        color: palette.text,
        border: 'none',
        borderRadius: 'var(--cth-radius-sm)',
        boxShadow: `inset 0 0 0 1px ${palette.border}`,
        transform: pressed && !disabled ? 'translateY(1px)' : 'none',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: size === 'lg' ? 'var(--cth-text-body-md)' : 'var(--cth-text-body-sm)',
        fontWeight: palette.weight,
        cursor: disabled ? 'not-allowed' : 'pointer',
        width: fullWidth ? '100%' : 'auto',
        userSelect: 'none',
        // Height is fixed by the size variant above, so a label that wraps does
        // not make the button taller — the extra line simply prints through the
        // bottom border. Every label here is a short phrase ("Check for updates",
        // "reset & start over"), so wrapping is always a layout bug rather than a
        // wanted behaviour. Callers that genuinely want a multi-line button can
        // still override, since `style` spreads after this.
        whiteSpace: 'nowrap',
        ...style
      }}
    >
      {children}
    </button>
  );
}
