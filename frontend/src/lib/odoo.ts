import { DEFAULT_DB, getSettings, saveSettings } from './settings';

const ODOO_URL = import.meta.env.PUBLIC_ODOO_URL ?? '';
let uid: number | null = null;

const ADDON = 'bn_root_invoicing';

/**
 * Odoo ships the full traceback in the JSON-RPC error (`data.debug`), but the
 * message alone rarely says which record or field went wrong. Pull out one
 * `file:line function` so the sync banner can point at the actual culprit.
 */
function tracebackHint(debug: unknown): string {
  if (typeof debug !== 'string' || !debug) return '';
  const frames = debug.split('\n').filter((line) => /^\s+File "/.test(line));
  if (!frames.length) return '';

  const ours = frames.filter((line) => line.includes(ADDON));
  const pick = (ours.length ? ours : frames).pop() ?? '';

  const m = /File "([^"]+)", line (\d+), in (.+)$/.exec(pick.trim());
  if (!m) return '';
  const [, file, line, fn] = m;
  const short = file.split('/').filter(Boolean).slice(-2).join('/');
  return `${short}:${line} ${fn.replace(/\(.*\)$/, '')}`;
}

function extractMessage(data: unknown): string {
  if (!data) return 'অজানা সমস্যা';
  if (typeof data === 'string') return data;
  const d = data as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof d.message === 'string') parts.push(d.message);
  const args = d.arguments;
  if (Array.isArray(args)) {
    for (const a of args) if (typeof a === 'string') parts.push(a);
  }
  const text = parts.join(' | ') || 'অজানা সমস্যা';
  const hint = tracebackHint(d.debug);
  return hint ? `${text} (${hint})` : text;
}

async function rpc(path: string, params: unknown) {
  let res: Response;
  try {
    res = await fetch(`${ODOO_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params })
    });
  } catch {
    throw new Error('সার্ভারে পৌঁছানো যায়নি (ইন্টারনেট নেই?)');
  }

  const text = await res.text();
  let json: { result?: unknown; error?: { message?: string; data?: unknown } };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(res.ok ? 'সার্ভার থেকে সঠিক উত্তর আসেনি' : `সার্ভার ত্রুটি (HTTP ${res.status})`);
  }
  if (json.error) throw new Error(extractMessage(json.error.data) || json.error.message);
  return json.result;
}

export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /পৌঁছানো|ইন্টারনেট|Failed to fetch|সঠিক উত্তর/.test(msg);
}

export async function connect(login: string, password: string) {
  const result = (await rpc('/web/session/authenticate', {
    db: DEFAULT_DB,
    login,
    password
  })) as { uid?: number } | false;
  if (!result || typeof result !== 'object' || !result.uid) throw new Error('লগইন ব্যর্থ');
  saveSettings({ login, password });
  uid = result.uid;
  return uid;
}

export function isConnected(): boolean {
  return uid !== null;
}

export function disconnect() {
  uid = null;
  document.cookie = 'session_id=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
}

export async function ensureSession() {
  if (uid) return uid;
  const settings = getSettings();
  return connect(settings.login, settings.password);
}

export async function callKw(
  model: string,
  method: string,
  args: unknown[] = [],
  kwargs: Record<string, unknown> = {}
) {
  await ensureSession();
  return rpc('/web/dataset/call_kw', { model, method, args, kwargs });
}

/**
 * Unwrap a Binary field returned by JSON-RPC into bare base64.
 *
 * Odoo does not hand back a string for `image_128` and friends, it hands back
 * `{content, size}`. Reading it as a string silently yields nothing, which is
 * why product photos vanished every time the local cache was wiped. `false` and
 * a bare string are both still accepted, since this is the one place where the
 * shape varies between reads.
 */
export function binaryBase64(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'content' in value) {
    const content = (value as { content?: unknown }).content;
    return typeof content === 'string' ? content : '';
  }
  return '';
}

export async function searchRead(
  model: string,
  domain: unknown[] = [],
  fields: string[] = [],
  kwargs: Record<string, unknown> = {}
): Promise<Record<string, any>[]> {
  return callKw(model, 'search_read', [domain, fields], kwargs) as Promise<Record<string, any>[]>;
}

/**
 * Odoo's call_kw treats args[0] as record ids unless the method is @api.model.
 * Whether `create` counts as model-level varies per model (product.template does
 * not, res.partner does), so try the model shape first and fall back to the
 * record shape when the dispatcher rejects the arity.
 */
export async function createRecord(model: string, vals: Record<string, unknown>): Promise<number> {
  let lastError: unknown;

  for (const args of [[[vals]], [[], [vals]]]) {
    try {
      const result = (await callKw(model, 'create', args)) as number[] | number;
      const id = Array.isArray(result) ? result[0] : result;
      if (id) return id;
      lastError = new Error('রেকর্ড তৈরি হয়নি');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (!/positional argument/i.test(msg)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('রেকর্ড তৈরি হয়নি');
}

export async function companyId(): Promise<number> {
  const id = await ensureSession();
  const users = await searchRead('res.users', [['id', '=', id]], ['company_id'], { limit: 1 });
  const ref = users?.[0]?.company_id as [number, string] | number | false | undefined;
  if (!ref) throw new Error('কোম্পানি পাওয়া যায়নি');
  return Array.isArray(ref) ? ref[0] : ref;
}