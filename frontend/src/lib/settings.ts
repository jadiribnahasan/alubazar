export type ConnectionSettings = {
  login: string;
  password: string;
};

export const DEFAULT_DB = import.meta.env.PUBLIC_ODOO_DB ?? 'odoo';

const KEY = 'bn_ledger_connection';

export function getSettings(): ConnectionSettings {
  if (typeof localStorage === 'undefined') return { login: '', password: '' };
  const raw = localStorage.getItem(KEY);
  if (!raw) return { login: '', password: '' };
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectionSettings>;
    return { login: parsed.login ?? '', password: parsed.password ?? '' };
  } catch {
    return { login: '', password: '' };
  }
}

export function saveSettings(settings: ConnectionSettings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}