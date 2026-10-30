// Built-in values of Obsidian's default theme (core.md 3.6), used when a vault has no
// community theme and underneath any theme. Data on the extension side, not a stylesheet
// (core.md 6). Pure.
//
// Sources:
// - Public documentation (docs.obsidian.md > CSS variables > Foundations > Colors and
//   Radiuses): base colours, accent H/S/L, extended colours, mono-0/100, radii. These are
//   the documented default values.
// - Written for Notewell: which base colour each semantic variable uses and every derived
//   value below (accent shades, hover, highlight, tag, scrollbar tints). The documentation
//   only says semantic colours derive from the base palette; this mapping is our own
//   reconstruction, expressed with color-mix() (the docs deprecate the -rgb variables).
import type { ThemeScheme, ThemeVariables } from './theme-css.ts';

type Values = Readonly<Record<string, string>>;

const BASE: Readonly<Record<ThemeScheme, Values>> = {
  dark: {
    '--color-base-00': '#1c1c1c',
    '--color-base-05': '#212121',
    '--color-base-10': '#232323',
    '--color-base-20': '#282828',
    '--color-base-25': '#2e2e2e',
    '--color-base-30': '#333333',
    '--color-base-35': '#3f3f3f',
    '--color-base-40': '#555555',
    '--color-base-50': '#666666',
    '--color-base-60': '#999999',
    '--color-base-70': '#b3b3b3',
    '--color-base-100': '#dadada',
    '--mono-0': 'black',
    '--mono-100': 'white',
    '--color-red': '#fb464c',
    '--color-orange': '#e9973f',
    '--color-yellow': '#e0de71',
    '--color-green': '#44cf6e',
    '--color-cyan': '#53dfdd',
    '--color-blue': '#027aff',
    '--color-purple': '#a882ff',
    '--color-pink': '#fa99cd',
    '--background-modifier-form-field': 'var(--color-base-25)',
    // Accent shades for hover/active: mixed toward white in dark mode.
    '--color-accent-1': 'color-mix(in srgb, var(--color-accent) 85%, white)',
    '--color-accent-2': 'color-mix(in srgb, var(--color-accent) 70%, white)',
  },
  light: {
    '--color-base-00': '#ffffff',
    '--color-base-05': '#fcfcfc',
    '--color-base-10': '#fafafa',
    '--color-base-20': '#f6f6f6',
    '--color-base-25': '#efefef',
    '--color-base-30': '#e4e4e4',
    '--color-base-35': '#dadada',
    '--color-base-40': '#bdbdbd',
    '--color-base-50': '#ababab',
    '--color-base-60': '#707070',
    '--color-base-70': '#5c5c5c',
    '--color-base-100': '#222222',
    '--mono-0': 'white',
    '--mono-100': 'black',
    '--color-red': '#e93147',
    '--color-orange': '#ec7500',
    '--color-yellow': '#e0ac00',
    '--color-green': '#08b94e',
    '--color-cyan': '#00bfbc',
    '--color-blue': '#086ddd',
    '--color-purple': '#7852ee',
    '--color-pink': '#d53984',
    '--background-modifier-form-field': 'var(--color-base-00)',
    // Accent shades for hover/active: mixed toward black in light mode.
    '--color-accent-1': 'color-mix(in srgb, var(--color-accent) 88%, black)',
    '--color-accent-2': 'color-mix(in srgb, var(--color-accent) 76%, black)',
  },
};

/** Variables the same in both schemes (values refer to the scheme's base palette). */
const SHARED: Values = {
  '--accent-h': '258',
  '--accent-s': '88%',
  '--accent-l': '66%',
  '--color-accent': 'hsl(var(--accent-h), var(--accent-s), var(--accent-l))',
  '--radius-s': '4px',
  '--radius-m': '8px',
  '--radius-l': '12px',
  '--background-primary': 'var(--color-base-00)',
  '--background-primary-alt': 'var(--color-base-10)',
  '--background-secondary': 'var(--color-base-20)',
  '--background-modifier-border': 'var(--color-base-30)',
  '--background-modifier-border-hover': 'var(--color-base-35)',
  '--background-modifier-hover': 'color-mix(in srgb, var(--mono-100) 7.5%, transparent)',
  '--text-normal': 'var(--color-base-100)',
  '--text-muted': 'var(--color-base-70)',
  '--text-faint': 'var(--color-base-50)',
  '--text-error': 'var(--color-red)',
  '--text-warning': 'var(--color-orange)',
  '--text-on-accent': 'white',
  '--text-highlight-bg': 'color-mix(in srgb, #ffd000 40%, transparent)',
  '--interactive-accent': 'var(--color-accent)',
  '--interactive-accent-hover': 'var(--color-accent-1)',
  '--text-accent': 'var(--color-accent)',
  '--text-accent-hover': 'var(--color-accent-2)',
  '--tag-background': 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
  '--tag-color': 'var(--text-accent)',
  '--code-background': 'var(--background-primary-alt)',
  '--scrollbar-thumb-bg': 'color-mix(in srgb, var(--mono-100) 10%, transparent)',
  '--scrollbar-active-thumb-bg': 'color-mix(in srgb, var(--mono-100) 20%, transparent)',
};

/** `#rgb`, `#rrggbb` (alpha ignored) -> hue (deg), saturation and lightness (%), rounded. */
export function hexToHsl(hex: string): { h: number; s: number; l: number } | undefined {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (match === null) return undefined;
  let digits = match[1]!;
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  const round = (n: number): number => Math.round(n * 10) / 10;
  return { h: round((h + 360) % 360), s: round(s * 100), l: round(l * 100) };
}

/**
 * Default theme values for both schemes, with `var()` still unresolved (the cascade
 * resolves them together with theme and snippet values). `accentColor` from
 * appearance.json replaces the accent: a hex colour sets --accent-h/s/l, so every derived
 * accent variable follows; another colour form sets the accent colours directly.
 */
export function obsidianDefaultTheme(accentColor?: string): ThemeVariables {
  const build = (scheme: ThemeScheme): Map<string, string> => {
    const values = new Map(Object.entries({ ...SHARED, ...BASE[scheme] }));
    if (accentColor !== undefined) {
      const hsl = hexToHsl(accentColor);
      if (hsl !== undefined) {
        values.set('--accent-h', String(hsl.h));
        values.set('--accent-s', `${hsl.s}%`);
        values.set('--accent-l', `${hsl.l}%`);
      } else {
        for (const name of ['--color-accent', '--color-accent-1', '--color-accent-2']) values.set(name, accentColor);
      }
    }
    return values;
  };
  return { dark: build('dark'), light: build('light') };
}
