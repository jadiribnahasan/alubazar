import { ensureSession, searchRead } from './odoo';

const KEY = 'bn_ledger_company';

export type CompanyInfo = { id: number; name: string };

export function cachedCompany(): CompanyInfo | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CompanyInfo) : null;
  } catch {
    return null;
  }
}

export function cacheCompany(company: CompanyInfo | null) {
  if (!company) {
    localStorage.removeItem(KEY);
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(company));
}

export async function fetchCompany(): Promise<CompanyInfo | null> {
  const cached = cachedCompany();
  try {
    const uid = await ensureSession();
    const users = await searchRead('res.users', [['id', '=', uid]], ['company_id'], { limit: 1 });
    const ref = users?.[0]?.company_id as [number, string] | number | false | undefined;
    if (!ref) return cached;
    if (Array.isArray(ref)) return { id: ref[0], name: ref[1] };

    const rows = await searchRead('res.company', [['id', '=', ref]], ['name'], { limit: 1 });
    if (!rows?.length) return cached;
    const company = { id: num(rows[0].id), name: String(rows[0].name ?? '') };
    cacheCompany(company);
    return company;
  } catch {
    return cached;
  }
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}