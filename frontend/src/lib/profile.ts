import { db } from './db';
import type { Profile } from './types';

export const PROFILE_DEFAULTS: Profile = {
  company_name: '',
  tagline: '',
  mobile: '',
  phone: '',
  email: '',
  website: '',
  street: '',
  street2: '',
  city: '',
  zip: '',
  vat: '',
  registry: '',
  terms: '',
  note: '',
  seller_label: 'বিক্রেতার স্বাক্ষর',
  buyer_label: 'ক্রেতার স্বাক্ষর',
  show_logo: true,
  show_signature: true,
  show_terms: true
};

const BOOLEAN_KEYS: readonly string[] = ['show_logo', 'show_signature', 'show_terms'];

/**
 * Odoo hands back `false` for an empty field, and `String(false)` is "false",
 * so coerce at the boundary instead of letting that reach an input or a print.
 */
function normalize(raw: Partial<Profile>): Profile {
  const merged = { ...PROFILE_DEFAULTS, ...raw } as Record<string, unknown>;
  const out: Record<string, unknown> = { ...merged };
  for (const [key, value] of Object.entries(merged)) {
    if (BOOLEAN_KEYS.includes(key)) out[key] = value !== false && value !== null && value !== undefined;
    else out[key] = value === false || value === null || value === undefined ? '' : String(value);
  }
  return out as unknown as Profile;
}

/** The single local profile row; Dexie keys it by its own autoincrement id. */
export async function loadProfile(): Promise<Profile> {
  return normalize((await db.profiles.toArray())[0] ?? {});
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const stored = (await db.profiles.toArray())[0];
  const { id: _localId, ...fields } = normalize(profile);
  const record = { ...fields, updated_at: new Date().toISOString() } as Profile;

  if (stored?.id) await db.profiles.update(stored.id, record);
  else await db.profiles.add(record);

  return { ...record, id: stored?.id };
}

/** Mirrors res_company.address_lines() so both renderings print the same. */
export function addressLines(p: Profile): string[] {
  const tail = [(p.city ?? '').trim(), (p.zip ?? '').trim()].filter(Boolean).join(', ');
  return [p.street, p.street2, tail].map((line) => (line ?? '').trim()).filter(Boolean);
}

export function contactLines(p: Profile): string[] {
  return [p.mobile, p.phone, p.email, p.website]
    .map((value) => (value ?? '').trim())
    .filter(Boolean);
}