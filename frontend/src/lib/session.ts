import { db } from './db';

const OWNER_KEY = 'bn_ledger_owner';
const CONNECTION_KEY = 'bn_ledger_connection';

/** Unsent "new product" form contents; see app.ts. */
export const NEW_PRODUCT_DRAFT_KEY = 'bn_ledger_new_product';

export function localOwner(): string | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(OWNER_KEY);
}

export async function wipeLocalData() {
  try {
    localStorage.removeItem(NEW_PRODUCT_DRAFT_KEY);
  } catch {
    /* nothing to drop */
  }
  try {
    if (db.isOpen()) db.close();
    await db.delete();
    await db.open();
  } catch {
    /* a failed purge must never leave the previous user's data readable */
    try {
      await Promise.all([db.products.clear(), db.stock.clear(), db.invoices.clear(), db.customers.clear(), db.profiles.clear(), db.payments.clear(), db.queue.clear()]);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Local caches hold stock and invoices, which are private per shop. If the
 * connected login is not the one that owns this device's cache, drop it all.
 * Returns true when data was discarded.
 */
export async function adoptOwner(login: string): Promise<boolean> {
  const previous = localOwner();
  if (previous === login) return false;
  await wipeLocalData();
  localStorage.setItem(OWNER_KEY, login);
  return previous !== null;
}

export async function releaseOwner() {
  await wipeLocalData();
  localStorage.removeItem(OWNER_KEY);
  localStorage.removeItem(CONNECTION_KEY);
  localStorage.removeItem('bn_ledger_company');
}