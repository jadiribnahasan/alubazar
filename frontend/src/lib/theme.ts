export type ThemeName = 'teal' | 'indigo' | 'emerald' | 'rose' | 'amber' | 'blue';
export type ThemeMode = 'light' | 'dark';

/**
 * `swatch` duplicates the brand hex from the CSS palette. Kept here as well so a
 * swatch can be painted without flipping the document theme to read a custom
 * property, which would visibly strobe the whole UI on every render.
 */
export const THEMES: { id: ThemeName; label: string; swatch: string }[] = [
  { id: 'teal', label: 'সবুজাভ', swatch: '#0d9488' },
  { id: 'indigo', label: 'নীল', swatch: '#4f46e5' },
  { id: 'emerald', label: 'পান্তি', swatch: '#059669' },
  { id: 'rose', label: 'গোলাপি', swatch: '#e11d48' },
  { id: 'amber', label: 'হলুদ', swatch: '#d97706' },
  { id: 'blue', label: 'আকাশি', swatch: '#2563eb' }
];

const THEME_KEY = 'bn_ledger_theme';
const MODE_KEY = 'bn_ledger_mode';

/** Read by the inline bootstrap in the document head. Keep in sync with this module. */
const BOOTSTRAP = `(function(){try{
var t=localStorage.getItem('${THEME_KEY}')||'teal';
var m=localStorage.getItem('${MODE_KEY}')||'light';
if(m!=='dark'&&window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)m='dark';
var e=document.documentElement;e.dataset.theme=t;e.dataset.mode=m;
}catch(err){}})();`;

export function themeBootstrap(): string {
  return BOOTSTRAP;
}

function read(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export function currentTheme(): ThemeName {
  const raw = read(THEME_KEY, 'teal') as ThemeName;
  return THEMES.some((t) => t.id === raw) ? raw : 'teal';
}

/**
 * 'system' resolves against the OS preference, so a phone that flips to dark at
 * sunset carries the app with it without the shopkeeper touching anything.
 */
export function currentMode(): ThemeMode | 'system' {
  const raw = read(MODE_KEY, 'light');
  return raw === 'dark' || raw === 'light' || raw === 'system' ? raw : 'light';
}

export function resolvedMode(mode: ThemeMode | 'system'): ThemeMode {
  if (mode === 'system') {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return mode;
}

export function applyTheme(theme: ThemeName, mode: ThemeMode | 'system'): void {
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.mode = resolvedMode(mode);
  try {
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* a blocked storage only costs the preference, not the theme */
  }
  syncThemeColor();
}

/** Keeps the browser/OS chrome in step with the brand, which drives the topbar. */
export function syncThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const brand = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  if (brand) meta.content = brand;
}
