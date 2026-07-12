// Design tokens lifted verbatim from design/ui-spec.html — the ad, GIF and
// banners must read as the same object as the app.
export const T = {
  bg: '#0C0B0E',
  win: '#111013',
  panel: '#17161A',
  panel2: '#1D1C22',
  raise: '#211F27',
  inset: '#131217',
  line: '#26242C',
  line2: '#3B3844',
  wire: '#6B6680',
  wireHot: '#57A87B',
  wireRet: '#4A4655',
  ink: '#EFEDEA',
  mut: '#ABA9B4',
  dim: '#82808F',
  work: '#4CC38A',
  stby: '#E0A63C',
  block: '#E5534B',
  idle: '#45424F',
  accent: '#E0A63C',
  sel: '#7AA7D8',
  addInk: '#9BD8B8',
  okInk: '#7ADFA9',
  badInk: '#F08A82',
} as const;

export const SERIF = 'Fraunces, Georgia, serif';
export const MONO = '"Cascadia Code", Consolas, monospace';

// Fraunces variable-axis presets: high optical size + a little softness for
// display lines, wonk off (keep it composed, not quirky).
export const display = (weight: number) =>
  ({
    fontFamily: SERIF,
    fontWeight: weight,
    fontVariationSettings: `'opsz' 120, 'SOFT' 30, 'WONK' 0`,
    letterSpacing: '-0.015em',
  }) as const;

export const kicker = {
  fontFamily: MONO,
  fontWeight: 600,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: T.accent,
} as const;
