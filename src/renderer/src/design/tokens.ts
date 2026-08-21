// Design tokens live in tokens.css — that file is the source of truth.
//
// This module used to mirror every colour as a hex NUMBER and every spacing step
// as an integer, because Pixi.js cannot read CSS variables. The office floor is
// gone, and with it the only consumer: nothing outside a stylesheet needs a
// token value any more. What remains is the accent NAME type, which components
// use to key into `var(--cth-<accent>)`.

export type AccentColorName =
  | 'coral' | 'mint' | 'sky' | 'lemon' | 'lilac' | 'peach';

/** Every accent, in the order pickers should offer them. */
export const ACCENT_NAMES: readonly AccentColorName[] = [
  'coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'
];
