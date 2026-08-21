/**
 * Literal surface colours for the canvas-based editors.
 *
 * xterm.js and CodeMirror take literal colours — neither can read a CSS custom
 * property. Before this module, each carried its own copy of the palette and
 * they drifted; the restatement happens ONCE, here, and consumers map these
 * into whatever shape their library wants. Keep in step with tokens.css;
 * syntax hues and ANSI slots stay with their consumers, because those are
 * tuned per renderer.
 *
 * One palette. The design of record (.lavish/fork-plan.html) is dark-only.
 */

export interface SurfacePalette {
  /** Editor ground. Mirrors --cth-cream-100 (the mock's --bg). */
  bg: string;
  /** Terminal ground — the mock's terminal sits a step below the page. */
  termBg: string;
  /** Gutters, widgets, alternate rows. Mirrors --cth-cream-200 (--s1). */
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
  /** Caret — the brand accent. */
  cursor: string;
  /** Current-line wash. Must stay barely-there over `bg`. */
  activeLine: string;
}

export const surfaces: SurfacePalette = {
  bg: '#0D1117',
  termBg: '#080B0F',
  bgAlt: '#141A21',
  fg: '#E7EBF0',
  fgDim: '#95A2B3',
  fgFaint: '#6D7A89',
  border: '#3A4654',
  divider: '#2A3441',
  selection: '#2D3B4F',
  selectionFg: '#E7EBF0',
  cursor: '#F4D35E',
  activeLine: 'rgba(231, 235, 240, 0.04)'
};
