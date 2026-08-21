/**
 * Literal surface colours for the canvas-based editors.
 *
 * xterm.js, Monaco and CodeMirror all take literal colours — none of them can
 * read a CSS custom property. Before this module, each one carried its own copy
 * of the palette, and PtyTerminalView's own comment recorded the consequence:
 * "these values are RE-STATED rather than referenced, and drift the moment the
 * tokens move." They had drifted. When tokens.css moved off the parchment ramp,
 * every terminal and editor kept painting #FCFAF0 — the largest surfaces in the
 * app were still the old theme.
 *
 * So the restatement happens ONCE, here, and consumers map these into whatever
 * shape their library wants. Keep in step with tokens.css; syntax hues and ANSI
 * slots stay with their consumers, because those are tuned per renderer.
 */

export interface SurfacePalette {
  /** Editor/terminal ground. Mirrors --cth-paper-100. */
  bg: string;
  /** Gutters, widgets, alternate rows. Mirrors --cth-paper-200. */
  bgAlt: string;
  /** Primary text. Mirrors --cth-ink-900. */
  fg: string;
  /** Secondary text, line numbers. Mirrors --cth-ink-700. */
  fgDim: string;
  /** Tertiary text, inactive line numbers. Mirrors --cth-ink-500. */
  fgFaint: string;
  /** Structural 1px lines. Mirrors --cth-ink-300. */
  border: string;
  /** Dividers that should recede. Mirrors --cth-ink-100. */
  divider: string;
  /** Selection fill — neutral, so selecting text is not a colour event. */
  selection: string;
  /** Text on top of `selection`. */
  selectionFg: string;
  /** Caret. The one place a warm accent still earns its keep. */
  cursor: string;
  /** Current-line wash. Must stay barely-there over `bg`. */
  activeLine: string;
}

export const lightSurfaces: SurfacePalette = {
  bg: '#FFFFFF',
  bgAlt: '#F8F9FB',
  fg: '#15181D',
  fgDim: '#414852',
  fgFaint: '#6C7480',
  border: '#949BA5',
  divider: '#E4E7EB',
  selection: '#D7DEE6',
  selectionFg: '#15181D',
  cursor: '#D96A62',
  activeLine: 'rgba(21, 24, 29, 0.035)'
};

export const darkSurfaces: SurfacePalette = {
  bg: '#171A1F',
  bgAlt: '#1F232A',
  fg: '#DCDFE4',
  fgDim: '#ACB2BB',
  fgFaint: '#8B929C',
  border: '#6E757F',
  divider: '#333941',
  selection: '#2E333B',
  selectionFg: '#DCDFE4',
  cursor: '#E08C82',
  activeLine: 'rgba(220, 223, 228, 0.05)'
};

export function surfacesFor(theme: 'light' | 'dark'): SurfacePalette {
  return theme === 'dark' ? darkSurfaces : lightSurfaces;
}
