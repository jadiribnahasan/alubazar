import { db } from './db';
import { binaryBase64, createRecord, isNetworkError, callKw, companyId, ensureSession, searchRead } from './odoo';
import { PROFILE_DEFAULTS, loadProfile } from './profile';
import type { Customer, Invoice, Payment, Product, Profile, QueueOp, StockLevel, SyncState } from './types';
import { num, todayISO, uuid } from './format';

const _logger = console;

const DEAD_AFTER = 3;
const PULL_INTERVAL = 20_000;

let state: SyncState = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pending: 0,
  failed: 0,
  lastSyncAt: null,
  lastError: null,
  running: false,
  dead: [],
  warnings: []
};

function emit() {
  window.dispatchEvent(new CustomEvent<SyncState>('ledger:syncstate', { detail: { ...state } }));
}

async function recount() {
  const all = await db.queue.toArray();
  state.pending = all.length;
  state.failed = all.filter((o) => Boolean(o.last_error)).length;
  emit();
}

function idOf(ref: unknown): number | null {
  if (Array.isArray(ref)) return (ref[0] as number) ?? null;
  return typeof ref === 'number' ? ref : null;
}

/* ---------------- push ---------------- */

async function pushProduct(op: QueueOp) {
  const p = op.payload as unknown as Product;
  let tmplId = idOf(
    (await searchRead('product.template', [['client_uuid', '=', p.client_uuid]], ['id'], { limit: 1 }))[0]?.id
  );

  if (!tmplId) {
    const vals: Record<string, unknown> = {
      name: p.name,
      list_price: num(p.sale_price),
      type: 'consu',
      sale_ok: true,
      purchase_ok: true,
      is_shared_catalog: true,
      client_uuid: p.client_uuid
    };
    // A photo picked on the add form travels with the create, so the catalog
    // row is born with its image instead of costing a second write. Only on
    // create: an existing template belongs to the shared catalog, and this
    // product's photo must not overwrite the one other shops see.
    const raw = String(p.image ?? '');
    if (raw) vals.image_1920 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
    tmplId = await createRecord('product.template', vals);
  }

  if (p.id && tmplId) {
    const variants = await searchRead(
      'product.product',
      [['product_tmpl_id', '=', tmplId]],
      ['id'],
      { limit: 1 }
    );
    await db.products.update(p.id, { odoo_template_id: tmplId, odoo_id: idOf(variants?.[0]?.id) ?? undefined });
  }
}

async function pushProductUpdate(op: QueueOp) {
  const p = op.payload as unknown as Product;
  if (!p.odoo_template_id) return pushProduct(op);
  await callKw('product.template', 'write', [[p.odoo_template_id], { name: p.name, list_price: num(p.sale_price) }]);
  return undefined;
}

async function pushProductDelete(op: QueueOp) {
  const p = op.payload as unknown as Product;
  if (p.odoo_template_id) {
    await callKw('product.template', 'write', [[p.odoo_template_id], { active: false }]);
  }
  if (p.id) {
    await db.products.delete(p.id);
    await db.stock.where('product_client_uuid').equals(p.client_uuid).delete();
  }
}

async function ensureServerProduct(clientUuid: string): Promise<number> {
  const product = await db.products.where('client_uuid').equals(clientUuid).first();
  if (!product) throw new Error('পণ্য পাওয়া যায়নি');

  const found = await searchRead(
    'product.template',
    [['client_uuid', '=', clientUuid]],
    ['id', 'product_variant_id'],
    { limit: 1 }
  );
  if (found?.length) {
    const variantId = idOf(found[0].product_variant_id);
    if (product.id && variantId) {
      await db.products.update(product.id, { odoo_template_id: idOf(found[0].id) ?? undefined, odoo_id: variantId });
    }
    return variantId ?? 0;
  }

  await pushProduct({
    client_uuid: clientUuid,
    type: 'product',
    payload: {
      client_uuid: clientUuid,
      name: product.name,
      sale_price: num(product.sale_price),
      id: product.id
    },
    created_at: new Date().toISOString(),
    attempts: 0
  });

  const fresh = product.id ? await db.products.get(product.id) : undefined;
  return fresh?.odoo_id ?? 0;
}

async function pushStock(op: QueueOp) {
  const s = op.payload as unknown as StockLevel & { mode?: 'set' | 'add'; value?: number };
  if (!s.product_client_uuid) throw new Error(`পণ্য পাওয়া যায়নি: ${s.product_name || '?'}`);
  await ensureServerProduct(s.product_client_uuid);
  const cid = await companyId();

  const quantity = await callKw('product.product', 'bn_apply_stock', [], {
    client_uuid: s.product_client_uuid,
    company_id: cid,
    mode: s.mode === 'add' ? 'add' : 'set',
    value: num(s.value)
  });

  if (s.id) await db.stock.update(s.id, { quantity: num(quantity) });
}

async function pushProductImage(op: QueueOp) {
  const p = op.payload as unknown as Product;
  const product = await db.products.where('client_uuid').equals(p.client_uuid).first();
  if (!product) throw new Error('পণ্য পাওয়া যায়নি');
  await ensureServerProduct(product.client_uuid);

  const fresh = product.id ? await db.products.get(product.id) : undefined;
  const tmplId = fresh?.odoo_template_id;
  if (!tmplId) throw new Error('পণ্য সিঙ্ক হয়নি');

  const raw = String(p.image ?? '');
  if (!raw) {
    await callKw('product.template', 'write', [[tmplId], { image_1920: false }]);
    return;
  }
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  await callKw('product.template', 'write', [[tmplId], { image_1920: base64 }]);
}

async function pushCustomer(op: QueueOp) {
  const c = op.payload as unknown as Customer;
  const found = await searchRead('res.partner', [['name', '=', c.name]], ['id'], { limit: 1 });
  let oid = idOf(found?.[0]?.id);
  if (!oid) {
    oid = await createRecord('res.partner', { name: c.name, phone: c.phone ?? false });
  }
  if (c.id && oid) await db.customers.update(c.id, { odoo_id: oid });
}

async function saleJournalId(company: number): Promise<number | null> {
  const journals = await searchRead(
    'account.journal',
    [['type', '=', 'sale'], ['company_id', '=', company]],
    ['id'],
    { limit: 1 }
  );
  return idOf(journals?.[0]?.id);
}

type SaleTarget = { company_id: number; journal_id: number; borrowed: boolean };

/**
 * Prefer a journal owned by the shop itself. A shop created by signup has no
 * chart of accounts, so ask the server to build one first: a borrowed journal
 * posts the move into another company, and then the shop's own user cannot read
 * it back (account.move is company-scoped). Borrowing is the last resort.
 */
async function resolveSaleTarget(): Promise<SaleTarget | null> {
  const own = await companyId();
  const ownJournal = await saleJournalId(own);
  if (ownJournal) return { company_id: own, journal_id: ownJournal, borrowed: false };

  // No journal of our own: build a chart so Odoo makes one for this company.
  try {
    await callKw('res.company', 'bn_ensure_accounting_setup', [], {
      context: { lang: SAFE_LANG }
    });
  } catch {
    // fall through to the shared-journal path below
  }
  const ownAfter = await saleJournalId(own);
  if (ownAfter) return { company_id: own, journal_id: ownAfter, borrowed: false };

  const shared = (await callKw('res.company', 'bn_sale_journal', [], {
    context: { lang: SAFE_LANG }
  })) as Partial<SaleTarget> | null;

  if (shared?.journal_id && shared?.company_id) {
    return {
      company_id: shared.company_id,
      journal_id: shared.journal_id,
      borrowed: shared.company_id !== own
    };
  }
  return null;
}

async function incomeAccountFor(productId: number, company: number): Promise<number> {
  const id = num(
    await callKw('product.product', 'bn_income_account', [productId, company], {
      context: { lang: SAFE_LANG }
    })
  );
  if (!id) throw new Error('আয় হিসেব পাওয়া যায়নি (Accounting সেটআপ করুন)');
  return id;
}

async function pushInvoice(op: QueueOp) {
  const inv = op.payload as unknown as Invoice;

  const dup = await searchRead('account.move', [['client_uuid', '=', inv.client_uuid]], ['id', 'name'], { limit: 1 });
  if (dup?.length) {
    if (inv.id) await db.invoices.update(inv.id, { odoo_id: dup[0].id, name: dup[0].name });
    return;
  }

  let customer = inv.customer_name?.trim() ? inv.customer_name.trim() : 'খুচরা গ্রাহক';
  const localCustomer = inv.customer_client_uuid
    ? await db.customers.where('client_uuid').equals(inv.customer_client_uuid).first()
    : undefined;
  if (localCustomer) customer = localCustomer.name;

  let partnerId = idOf((await searchRead('res.partner', [['name', '=', customer]], ['id'], { limit: 1 }))[0]?.id);
  if (!partnerId) {
    partnerId = await createRecord('res.partner', { name: customer });
  }
  if (!partnerId) throw new Error('গ্রাহক তৈরি হয়নি');

  const target = await resolveSaleTarget();
  if (!target) throw new Error('বিক্রয় জার্নাল নেই (Accounting সেটআপ করা যায়নি)');
  const cid = target.company_id;
  const journalId = target.journal_id;
  if (target.borrowed) {
    state.warnings = state.warnings.filter((w) => !w.startsWith('journal:'));
    state.warnings.push('journal: এই শাখার নিজস্ব জার্নাল নেই, প্রধান কোম্পানির জার্নাল ব্যবহার হচ্ছে');
  }

  const lines: unknown[] = [];
  for (const line of inv.lines ?? []) {
    const odooProductId = await ensureServerProduct(line.product_client_uuid);
    if (!odooProductId) throw new Error(`পণ্য পাওয়া যায়নি: ${line.name}`);
    const tmpl = await searchRead(
      'product.template',
      [['product_variant_ids', 'in', [odooProductId]]],
      ['uom_id'],
      { limit: 1 }
    );
    lines.push([
      0,
      0,
      {
        name: line.name,
        product_id: odooProductId,
        quantity: num(line.quantity),
        price_unit: num(line.price),
        product_uom_id: idOf(tmpl?.[0]?.uom_id) ?? false,
        account_id: await incomeAccountFor(odooProductId, cid),
        tax_ids: [[6, 0, []]]
      }
    ]);
  }

  const moveId = await createRecord('account.move', {
    move_type: 'out_invoice',
    partner_id: partnerId,
    invoice_date: inv.date || todayISO(),
    company_id: cid,
    journal_id: journalId,
    client_uuid: inv.client_uuid,
    invoice_line_ids: lines
  });

  await callKw('account.move', 'action_post', [[moveId]]);

  const posted = await searchRead('account.move', [['id', '=', moveId]], ['name'], { limit: 1 });
  if (inv.id) await db.invoices.update(inv.id, { odoo_id: moveId, name: posted?.[0]?.name });
}

async function pushPayment(op: QueueOp) {
  const pay = op.payload as unknown as Payment;
  const invoice = await db.invoices.where('client_uuid').equals(pay.invoice_client_uuid).first();
  if (!invoice) throw new Error('ইনভয়েস পাওয়া যায়নি');
  if (!invoice.odoo_id) throw new Error('ইনভয়েসটি আগে সার্ভারে সিঙ্ক হতে হবে');

  // Flat args: callKw forwards them verbatim and Odoo calls method(*args), so
  // this signature is (move_id, amount, date). Nesting the id would hand the
  // Python method a list and blow up on int().
  const result = (await callKw(
    'account.payment',
    'bn_register_cash_payment',
    [invoice.odoo_id, num(pay.amount), pay.date],
    { context: { lang: SAFE_LANG } }
  )) as { payment_id: number; name: string; amount_residual: number };

  if (pay.id) await db.payments.update(pay.id, { odoo_id: result.payment_id, odoo_name: result.name, synced: true });
  if (invoice.id) {
    await db.invoices.update(invoice.id, { paid: num(invoice.paid) + num(pay.amount) });
  }
  _logger.info('bn: payment %s synced (%s), residual %s', pay.client_uuid, result.name, result.amount_residual);
}

/**
 * A stale language on the account makes Odoo raise `Invalid language code` from
 * Environment.lang the moment a write touches anything translatable. call_kw
 * merges a `context` kwarg into the env, so pin a code that is always installed.
 */
const SAFE_LANG = 'en_US';

async function pushProfile(op: QueueOp) {
  const p = op.payload as unknown as Profile;
  // The profile keys are arbitrary, so they cannot be JSON-RPC kwargs: call_kw
  // rejects any name that is not in the Python signature. `vals` is positional.
  const result = (await callKw('res.company', 'bn_apply_invoice_profile', [p], {
    context: { lang: SAFE_LANG }
  })) as {
    company_id: number;
  };
  if (p.id && result?.company_id) await db.profiles.update(p.id, { company_id: result.company_id });
}

const HANDLERS: Record<string, (op: QueueOp) => Promise<unknown>> = {
  product: pushProduct,
  product_update: pushProductUpdate,
  product_delete: pushProductDelete,
  stock: pushStock,
  customer: pushCustomer,
  product_image: pushProductImage,
  invoice: pushInvoice,
  payment: pushPayment,
  profile: pushProfile
};

/* ---------------- pull ---------------- */

async function pullCatalog() {
  const rows = await searchRead(
    'product.template',
    [['is_shared_catalog', '=', true]],
    ['id', 'name', 'list_price', 'client_uuid', 'product_variant_id', 'default_code', 'image_128'],
    { limit: 500, order: 'id asc' }
  );
  if (!rows?.length) return;

  const [localProducts, localStocks] = await Promise.all([db.products.toArray(), db.stock.toArray()]);
  const byUuid = new Map(localProducts.map((x) => [x.client_uuid, x]));
  const byTmpl = new Map(
    localProducts.filter((x) => x.odoo_template_id).map((x) => [x.odoo_template_id, x])
  );
  const stockByProduct = new Map(localStocks.map((x) => [x.product_client_uuid, x]));

  const newProducts: Product[] = [];
  const newStocks: StockLevel[] = [];

  for (const t of rows) {
    const tmplId = num(t.id);
    const serverUuid = (t.client_uuid as string) || `odoo-tmpl-${tmplId}`;
    const variantId = idOf(t.product_variant_id);
    const serverImage = binaryBase64(t.image_128);
    const serverImageUrl = serverImage ? `data:image/png;base64,${serverImage}` : undefined;
    let local = byUuid.get(serverUuid) ?? byTmpl.get(tmplId);

    if (local?.id) {
      await db.products.update(local.id, {
        name: t.name as string,
        sale_price: num(t.list_price),
        odoo_template_id: tmplId,
        odoo_id: variantId ?? local.odoo_id,
        default_code: (t.default_code as string) || local.default_code
      });
      if (!local.image && serverImageUrl) {
        await db.products.update(local.id, { image: serverImageUrl });
        local = { ...local, image: serverImageUrl };
      }
      local = {
        ...local,
        client_uuid: serverUuid,
        name: t.name as string,
        odoo_id: variantId ?? local.odoo_id,
        default_code: (t.default_code as string) || local.default_code
      };
      byUuid.set(serverUuid, local);
    } else {
      local = {
        client_uuid: serverUuid,
        name: t.name as string,
        sale_price: num(t.list_price),
        odoo_template_id: tmplId,
        odoo_id: variantId ?? undefined,
        default_code: (t.default_code as string) || undefined,
        image: serverImageUrl
      };
      newProducts.push(local);
      byUuid.set(serverUuid, local);
    }

    if (local.odoo_id && !stockByProduct.has(local.client_uuid)) {
      const stock: StockLevel = {
        client_uuid: `stock-${local.client_uuid}`,
        product_client_uuid: local.client_uuid,
        product_name: local.name,
        quantity: 0,
        odoo_product_id: local.odoo_id
      };
      newStocks.push(stock);
      stockByProduct.set(local.client_uuid, stock);
    }
  }

  if (newProducts.length) await db.products.bulkAdd(newProducts);
  if (newStocks.length) await db.stock.bulkAdd(newStocks);
}

async function pullStock() {
  const queued = await db.queue.filter((o) => o.type === 'stock' || o.type === 'invoice').toArray();
  const pending = new Set<string>();
  for (const op of queued) {
    if (op.type === 'stock') pending.add((op.payload as StockLevel).product_client_uuid);
    else {
      const lines = (op.payload as unknown as Invoice).lines ?? [];
      for (const l of lines) pending.add(l.product_client_uuid);
    }
  }

  const cid = await companyId();
  const rows = (await callKw('product.product', 'bn_stock_map', [], { company_id: cid })) as Record<
    string,
    any
  >[];
  if (!rows?.length) return;

  const [localProducts, localStocks] = await Promise.all([db.products.toArray(), db.stock.toArray()]);
  const productByUuid = new Map(localProducts.map((x) => [x.client_uuid, x]));
  const stockByProduct = new Map(localStocks.map((x) => [x.product_client_uuid, x]));
  const adds: StockLevel[] = [];

  for (const row of rows) {
    const clientUuid = (row.client_uuid as string) || '';
    const odooProductId = num(row.product_id);
    if (!clientUuid || pending.has(clientUuid)) continue;
    const local = productByUuid.get(clientUuid);
    if (!local) continue;
    const stock = stockByProduct.get(local.client_uuid);
    if (stock?.id) {
      await db.stock.update(stock.id, { quantity: num(row.quantity), odoo_product_id: odooProductId });
    } else {
      adds.push({
        client_uuid: `stock-${local.client_uuid}`,
        product_client_uuid: local.client_uuid,
        product_name: local.name,
        quantity: num(row.quantity),
        odoo_product_id: odooProductId
      });
    }
  }
  if (adds.length) await db.stock.bulkAdd(adds);
}

async function pullInvoices() {
  const cid = await companyId();
  const rows = await searchRead(
    'account.move',
    [
      ['company_id', '=', cid],
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted']
    ],
    ['id', 'name', 'invoice_date', 'amount_total', 'partner_id', 'client_uuid'],
    { limit: 200, order: 'id desc' }
  );
  if (!rows?.length) return;

  const local = await db.invoices.toArray();
  const byOdoo = new Map(local.filter((x) => x.odoo_id).map((x) => [x.odoo_id, x]));
  const byUuid = new Map(local.map((x) => [x.client_uuid, x]));
  const adds: Invoice[] = [];

  for (const m of rows) {
    const oid = idOf(m.id);
    if (!oid) continue;
    const existing = byOdoo.get(oid) ?? (m.client_uuid ? byUuid.get(m.client_uuid as string) : undefined);
    const partnerRef = m.partner_id as [number, string] | false | undefined;
    const payload = {
      odoo_id: oid,
      name: m.name as string,
      customer_name: Array.isArray(partnerRef) ? partnerRef[1] : '',
      date: (m.invoice_date as string) || todayISO(),
      total: num(m.amount_total)
    };
    if (existing?.id) {
      await db.invoices.update(existing.id, payload);
    } else {
      const fresh: Invoice = {
        client_uuid: (m.client_uuid as string) || `odoo-move-${oid}`,
        lines: [],
        ...payload
      };
      adds.push(fresh);
      byUuid.set(fresh.client_uuid, fresh);
    }
  }
  if (adds.length) await db.invoices.bulkAdd(adds);
}

async function pullCustomers() {
  const rows = await searchRead('res.partner', [], ['id', 'name'], { limit: 300, order: 'id desc' });
  if (!rows?.length) return;

  const local = await db.customers.toArray();
  const byName = new Map(local.map((x) => [x.name.trim().toLowerCase(), x]));
  const byOdoo = new Map(local.filter((x) => x.odoo_id).map((x) => [x.odoo_id, x]));
  const adds: Customer[] = [];

  for (const r of rows) {
    const oid = idOf(r.id);
    const name = (r.name as string | undefined)?.trim();
    if (!oid || !name) continue;
    const existing = byName.get(name.toLowerCase()) ?? byOdoo.get(oid);
    if (existing?.id) {
      await db.customers.update(existing.id, { odoo_id: oid });
    } else {
      const fresh: Customer = { client_uuid: `odoo-partner-${oid}`, name, odoo_id: oid };
      adds.push(fresh);
      byName.set(name.toLowerCase(), fresh);
    }
  }
  if (adds.length) await db.customers.bulkAdd(adds);
}

async function pullProfile() {
  if (await db.queue.filter((o) => o.type === 'profile').count()) return;

  const remote = (await callKw('res.company', 'bn_invoice_profile', [], {
    context: { lang: SAFE_LANG }
  })) as Record<string, unknown> | null;
  if (!remote?.company_id) return;

  const local = await loadProfile();
  const logoB64 = typeof remote.logo_b64 === 'string' ? remote.logo_b64 : '';
  const logo = local.logo ?? (logoB64 ? `data:image/png;base64,${logoB64}` : '');
  delete remote.logo_b64;

  const merged = { ...PROFILE_DEFAULTS, ...local, ...remote, logo } as Profile;
  const stored = (await db.profiles.toArray())[0];
  if (stored?.id) {
    const { id: _localId, ...fields } = merged;
    await db.profiles.update(stored.id, fields as Profile);
  } else {
    await db.profiles.add(merged);
  }
}

/* ---------------- driver ---------------- */

export function getState(): SyncState {
  return { ...state };
}

export async function syncNow(force = false): Promise<void> {
  if (state.running) return;
  state.running = true;
  state.online = navigator.onLine;
  emit();

  if (!navigator.onLine) {
    state.running = false;
    await recount();
    return;
  }

  try {
    await ensureSession();
    state.lastError = null;
    state.warnings = [];

    const ops = await db.queue.orderBy('created_at').toArray();
    let pushed = 0;
    let networkFailed = false;

    for (const op of ops) {
      const handler = HANDLERS[op.type];
      if (!handler) {
        await db.queue.delete(op.id!);
        continue;
      }
      try {
        await handler(op);
        await db.queue.delete(op.id!);
        pushed += 1;
        state.lastError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'অজানা সমস্যা';
        state.lastError = msg;

        if (isNetworkError(err)) {
          networkFailed = true;
          await db.queue.update(op.id!, { attempts: num(op.attempts) + 1, last_error: '' });
          break;
        }

        const attempts = num(op.attempts) + 1;
        if (attempts >= DEAD_AFTER) {
          await db.queue.delete(op.id!);
          state.dead.push({ type: op.type, message: msg });
          if (state.dead.length > 10) state.dead.shift();
        } else {
          await db.queue.update(op.id!, { attempts, last_error: msg });
        }
      }
    }

    const stale = !state.lastSyncAt || Date.now() - Date.parse(state.lastSyncAt) > PULL_INTERVAL;
    if (!networkFailed && (force || pushed > 0 || stale)) {
      const pulls: [string, () => Promise<void>][] = [
        ['catalog', pullCatalog],
        ['stock', pullStock],
        ['invoices', pullInvoices],
        ['customers', pullCustomers],
        ['profile', pullProfile]
      ];
      for (const [label, fn] of pulls) {
        try {
          await fn();
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'অজানা সমস্যা';
          if (/not allowed to access|No group currently allows/i.test(msg)) {
            state.warnings.push(`${label}: সার্ভারে অনুমতি নেই — ./scripts/grant_access.sh চালান`);
          } else {
            state.warnings.push(`${label}: ${msg}`);
          }
        }
      }
      state.lastSyncAt = new Date().toISOString();
      window.dispatchEvent(new CustomEvent('ledger:synced'));
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : 'সিঙ্ক ব্যর্থ';
  } finally {
    state.running = false;
    await recount();
  }
}

export async function clearFailedOps() {
  const bad = await db.queue.filter((o) => Boolean(o.last_error)).toArray();
  for (const op of bad) await db.queue.delete(op.id!);
  state.dead = [];
  state.warnings = [];
  state.lastError = null;
  await recount();
}

let syncTimer: number | undefined;

function scheduleSync(delay = 400) {
  if (syncTimer) window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined;
    void syncNow().catch(() => {});
  }, delay);
}

export async function enqueue(type: QueueOp['type'], payload: Record<string, unknown>) {
  const op: QueueOp = {
    client_uuid: uuid(),
    type,
    payload,
    created_at: new Date().toISOString(),
    attempts: 0
  };
  await db.queue.add(op);
  await recount();
  scheduleSync();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    state.online = true;
    emit();
    void syncNow();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    emit();
  });
  setInterval(() => {
    void syncNow().catch(() => {});
  }, 30000);
  void syncNow();
}