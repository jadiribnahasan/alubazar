import { db } from '../lib/db';
import { bnDate, esc, money, num, qty, todayISO, uuid } from '../lib/format';
import { connect, disconnect } from '../lib/odoo';
import { getSettings } from '../lib/settings';
import { THEMES, applyTheme, currentMode, currentTheme, syncThemeColor } from '../lib/theme';
import { cachedCompany, fetchCompany } from '../lib/company';
import { addressLines, contactLines, loadProfile, saveProfile } from '../lib/profile';
import { adoptOwner, releaseOwner, NEW_PRODUCT_DRAFT_KEY } from '../lib/session';
import { clearFailedOps, enqueue, getState, syncNow } from '../lib/sync';
import { registerSW } from 'virtual:pwa-register';
import type { Customer, Invoice, InvoiceLine, Payment, Product, Profile, StockLevel, SyncState } from '../lib/types';

registerSW({ immediate: true });

const LOW_STOCK = 5;
const cart: InvoiceLine[] = [];
/** invoice client_uuid -> amount paid, rebuilt on every renderInvoices() */
let invoicePaid = new Map<string, number>();
const filters = { sale: '', stock: '', products: '' };

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`UI element #${id} is missing from the page`);
  return el as T;
};
const val = (id: string) => document.getElementById(id) as HTMLInputElement;
const sel = (id: string) => document.getElementById(id) as HTMLSelectElement;
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const on = (id: string, ev: string, fn: (e: Event) => void) =>
  $(id).addEventListener(ev, fn as EventListener);

/* ---------------- busy states ---------------- */

const busy = new Set<string>();

function markBusy(id: string, on: boolean) {
  const el = document.getElementById(id);
  if (!el) return;
  if (on) {
    busy.add(id);
    el.setAttribute('aria-busy', 'true');
    el.classList.add('is-busy');
    el.setAttribute('disabled', '');
  } else {
    busy.delete(id);
    el.removeAttribute('aria-busy');
    el.classList.remove('is-busy');
    el.removeAttribute('disabled');
  }
}

async function withBusy<T>(id: string, label: string, fn: () => Promise<T>): Promise<T | null> {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  const original = el?.textContent ?? null;
  markBusy(id, true);
  if (el) el.textContent = label;
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'কাজটি হয়নি', 'err');
    return null;
  } finally {
    markBusy(id, false);
    if (el && original !== null) el.textContent = original;
  }
}

let flashUuid: string | null = null;
function flash(uuid: string) {
  flashUuid = uuid;
  setTimeout(() => {
    if (flashUuid === uuid) flashUuid = null;
  }, 2000);
}

function thumb(p: Pick<Product, 'name' | 'image'>, cls = 'thumb') {
  if (p.image) return `<img class="${cls}" src="${p.image}" alt="" loading="lazy" />`;
  const initial = (p.name || '?').trim().charAt(0);
  return `<span class="${cls} ph" aria-hidden="true">${esc(initial)}</span>`;
}

function flashAttr(uuid: string) {
  return flashUuid === uuid ? ' class="flash"' : '';
}

/* ---------------- toast ---------------- */

function toast(message: string, kind: 'ok' | 'err' | '' = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ---------------- bottom sheet ---------------- */

let sheetResolve: ((v: number | null) => void) | null = null;

function closeSheet(value: number | null) {
  $('backdrop').hidden = true;
  sheetResolve?.(value);
  sheetResolve = null;
}

function askNumber(title: string, hint: string, initial = 0): Promise<number | null> {
  $('sheetTitle').textContent = title;
  $('sheetHint').textContent = hint;
  val('sheetInput').value = String(initial);
  $('backdrop').hidden = false;
  val('sheetInput').focus();
  val('sheetInput').select();
  return new Promise((resolve) => {
    sheetResolve = resolve;
  });
}

on('sheetCancel', 'click', () => closeSheet(null));
on('backdrop', 'click', (e) => {
  if (e.target === $('backdrop')) closeSheet(null);
});
on('sheetOk', 'click', () => closeSheet(num(val('sheetInput').value)));
on('sheetInput', 'keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') closeSheet(num(val('sheetInput').value));
});

/* ---------------- tabs ---------------- */

function moveThumb() {
  const active = document.querySelector<HTMLButtonElement>('.tab[aria-selected="true"]');
  const thumb = $('tabThumb');
  if (!active || !thumb) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
}

/** Which tab the shop was on; the camera round-trip can restart the page. */
const TAB_KEY = 'bn_ledger_tab';

function applyTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
    t.setAttribute('aria-selected', String(t.dataset.tab === name));
  });
  document.querySelectorAll<HTMLElement>('.panel').forEach((p) => {
    p.hidden = p.dataset.panel !== name;
  });
  moveThumb();
}

function showTab(name: string) {
  applyTab(name);
  try {
    localStorage.setItem(TAB_KEY, name);
  } catch {
    /* a blocked storage must not stop the tab switching */
  }
  if (navigator.onLine) void syncNow(true).catch(() => {});
  window.scrollTo({ top: 0 });
}

function restoreTab() {
  let name = 'sale';
  try {
    name = localStorage.getItem(TAB_KEY) || name;
  } catch {
    /* ignore */
  }
  const known = [...document.querySelectorAll<HTMLButtonElement>('.tab')].some((t) => t.dataset.tab === name);
  applyTab(known ? name : 'sale');
}

window.addEventListener('resize', moveThumb);

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => {
  t.addEventListener('click', () => showTab(t.dataset.tab!));
});

/* ---------------- connect ---------------- */

function showApp(connected: boolean) {
  $('app').hidden = !connected;
  $('connectView').hidden = connected;
}

const saved = getSettings();
val('login').value = saved.login;
val('password').value = saved.password;

showApp(Boolean(saved.password));

on('connectForm', 'submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target as HTMLFormElement);
  const status = $('connectStatus');
  status.textContent = 'যুক্ত হচ্ছে...';
  try {
    const login = String(f.get('login'));
    await connect(login, String(f.get('password')));
    await adoptOwner(login);
    status.textContent = '';
    showApp(true);
    await refresh();
    void syncNow();
  } catch (err) {
    status.textContent = err instanceof Error ? err.message : 'সংযোগ হয়নি';
  }
});

function syncNowFromBar() {
  toast('সিঙ্ক চালু হচ্ছে...');
  void syncNow(true);
}

on('logoutBtn', 'click', () => {
  void (async () => {
    await releaseOwner();
    disconnect();
    location.replace('/login');
  })();
});

on('syncBtn', 'click', syncNowFromBar);
// The pill carries the same meaning as the icon next to it, so give it the
// bigger tap target instead of making people find the 38px button.
on('syncPill', 'click', syncNowFromBar);
on('brandBtn', 'click', () => showTab('profile'));

// The bar is sticky and grows to two rows on a phone, so its height is a CSS
// variable the tab strip offsets from. Measuring beats a hardcoded 58px: it
// stays right across the wrap breakpoint and safe-area insets.
let topbarHeight = 0;
function publishTopbarHeight() {
  const h = Math.round($('topbar').getBoundingClientRect().height);
  if (!h || h === topbarHeight) return;
  topbarHeight = h;
  document.documentElement.style.setProperty('--topbar-h', `${h}px`);
}
new ResizeObserver(publishTopbarHeight).observe($('topbar'));
window.addEventListener('resize', publishTopbarHeight);

// The bar is sticky, so a shadow is the only cue that content slid under it.
window.addEventListener(
  'scroll',
  () => $('topbar').classList.toggle('is-scrolled', window.scrollY > 4),
  { passive: true }
);

on('clearFailed', 'click', async () => {
  await clearFailedOps();
  toast('সমস্যাগুলো মুছে ফেলা হয়েছে', 'ok');
  await refresh();
  void syncNow();
});

/* ---------------- data helpers ---------------- */

async function allProducts(): Promise<Product[]> {
  return db.products.orderBy('name').toArray();
}

async function stockMap(): Promise<Map<string, StockLevel>> {
  const rows = await db.stock.toArray();
  return new Map(rows.map((r) => [r.product_client_uuid, r]));
}

function matches(name: string, term: string): boolean {
  return !term.trim() || name.toLowerCase().includes(term.trim().toLowerCase());
}

function stockBadge(q: number) {
  if (q <= 0) return '<span class="badge out">ফুরিয়েছে</span>';
  if (q <= LOW_STOCK) return `<span class="badge low">কম ${qty(q)}</span>`;
  return '';
}

/* ---------------- sale tab ---------------- */

const RECENT_MAX = 8;

function cartQty(uuid: string): number {
  return cart.filter((l) => l.product_client_uuid === uuid).reduce((a, l) => a + num(l.quantity), 0);
}

function tile(p: Product, stocks: Map<string, StockLevel>) {
  const q = num(stocks.get(p.client_uuid)?.quantity);
  const inCart = cartQty(p.client_uuid);
  const badge = q <= 0 ? '<span class="badge out">শেষ</span>' : q <= LOW_STOCK ? `<span class="badge low">${qty(q)}</span>` : '';
  return `<button class="tile${inCart ? ' in-cart' : ''}"${flashAttr(p.client_uuid)} data-add="${esc(p.client_uuid)}">
    ${thumb(p)}
    <span class="tile-name">${esc(p.name)}</span>
    <span class="tile-foot"><span class="tile-price">${money(p.sale_price)}</span>${badge}</span>
    ${inCart ? `<span class="tile-qty">${qty(inCart)}</span>` : ''}
  </button>`;
}

async function renderSaleGrid(stocks: Map<string, StockLevel>) {
  const all = await allProducts();
  const term = filters.sale.trim().toLowerCase();

  const recent = all
    .filter((p) => p.last_used_at)
    .sort((x, y) => (y.last_used_at ?? 0) - (x.last_used_at ?? 0))
    .slice(0, RECENT_MAX);
  const recentIds = new Set(recent.map((p) => p.client_uuid));
  const pool = term ? all.filter((p) => p.name.toLowerCase().includes(term)) : all;
  const rest = pool.filter((p) => !recentIds.has(p.client_uuid));

  const showRecent = !term && recent.length > 0;
  $('recentGrid').hidden = !showRecent;
  $('recentLabel').hidden = !showRecent;
  if (showRecent) $('recentGrid').innerHTML = recent.map((p) => tile(p, stocks)).join('');

  $('allLabel').hidden = Boolean(term);
  $('saleGrid').innerHTML =
    rest.map((p) => tile(p, stocks)).join('') ||
    (term
      ? `<div class="empty"><span class="big">🔍</span>"${esc(term)}" পাওয়া যায়নি</div>`
      : `<div class="empty"><span class="big">🏷️</span>কোনো পণ্য নেই<br /><span class="muted">"পণ্য" ট্যাবে যোগ করুন</span></div>`);
}

async function addToCart(uuid: string) {
  const p = await db.products.where('client_uuid').equals(uuid).first();
  if (!p) return;
  const existing = cart.find((l) => l.product_client_uuid === uuid);
  if (existing) existing.quantity += 1;
  else cart.push({ product_client_uuid: p.client_uuid, name: p.name, quantity: 1, price: num(p.sale_price) });
  if (p.id) await db.products.update(p.id, { last_used_at: Date.now() });
  await loadCartImages();
  renderCart();
  await renderSaleGrid(await stockMap());
}

for (const gridId of ['saleGrid', 'recentGrid']) {
  $(gridId).addEventListener('click', (e) => {
    const tileBtn = (e.target as HTMLElement).closest('button[data-add]') as HTMLButtonElement | null;
    if (!tileBtn) return;
    void addToCart(tileBtn.dataset.add!);
  });
}

function cartCount(): number {
  return cart.reduce((a, l) => a + num(l.quantity), 0);
}

let cartImages = new Map<string, string | undefined>();

async function loadCartImages() {
  if (!cart.length) {
    cartImages = new Map();
    return;
  }
  const keys = [...new Set(cart.map((l) => l.product_client_uuid))];
  const rows = await db.products.where('client_uuid').anyOf(keys).toArray();
  cartImages = new Map(rows.map((r) => [r.client_uuid, r.image]));
}

function renderCart() {
  const total = cart.reduce((a, l) => a + num(l.quantity) * num(l.price), 0);
  const count = cartCount();
  $('cartList').innerHTML =
    cart
      .map(
        (l, i) => `<div class="cart-line">
      <div class="cart-line-top">
        ${thumb({ name: l.name, image: cartImages.get(l.product_client_uuid) })}
        <span class="name">${esc(l.name)}<span class="line-sub">${money(num(l.price))} × ${qty(l.quantity)}</span></span>
        <span class="cart-line-total">${money(num(l.quantity) * num(l.price))}</span>
        <button class="icon-btn ghost-danger" data-rm="${i}" aria-label="বাদ দিন">✕</button>
      </div>
      <div class="cart-line-controls">
        <span class="stepper">
          <button data-qty="-1" data-i="${i}" aria-label="কমান">−</button>
          <input data-qtyinput="${i}" value="${l.quantity}" inputmode="decimal" aria-label="পরিমাণ" />
          <button data-qty="1" data-i="${i}" aria-label="বাড়ান">+</button>
        </span>
        <label class="price-field">
          <span>একক মূল্য</span>
          <input data-priceinput="${i}" value="${l.price}" inputmode="decimal" aria-label="একক মূল্য" />
        </label>
      </div>
    </div>`
      )
      .join('') || `<div class="empty">
        <span class="big">🧾</span>কোনো আইটেম নেই<br />
        <span class="muted">পণ্যের তালিকা থেকে ছুঁয়ে যোগ করুন</span><br />
        <button id="cartGoBack" class="btn subtle" type="button">পণ্য বেছে নিতে যান</button>
      </div>`;

  $('cartTotal').textContent = money(total);
  $('cartTotalSheet').textContent = money(total);
  $('cartCount').textContent = String(count);
  $('cartCount').classList.toggle('has-items', count > 0);

  // The sheet can be open with nothing in it, so its header and footer have to
  // say so rather than showing a confident "০টি পণ্য · ৳ ০".
  const label = count ? `${count}টি পণ্য · ${cart.length}টি লাইন` : 'এখনো কোনো পণ্য নেই';
  $('cartCountBadge').textContent = label;
  $('cartCountBadge').classList.toggle('has-items', count > 0);
  $('footCount').textContent = count ? `${count}টি পণ্য` : 'খালি বিল';

  btn('saveInvoice').disabled = count === 0;
  btn('saveInvoiceSheet').disabled = count === 0;
  btn('clearCart').disabled = count === 0;

  const hint = $('cartDueHint');
  const entered = Math.max(0, num(val('cartPaid').value));
  const left = Math.max(0, total - entered);
  if (entered > 0) {
    hint.hidden = false;
    hint.textContent = left <= 0 ? 'পুরো বিল পরিশোধিত' : `বাকি থাকবে ${money(left)}`;
  } else {
    hint.hidden = true;
  }
}

val('cartPaid').addEventListener('input', () => renderCart());

/* ---------------- cart sheet ---------------- */

function openCart() {
  $('cartSheet').hidden = false;
  // Stop the product grid behind from scrolling under the sheet on touch.
  document.body.classList.add('sheet-open');
  // Deliberately no focus() on the name field: the soft keyboard would cover
  // the item list, which is the whole point of opening the sheet.
  void loadCartImages().then(renderCart);
}

function closeCart() {
  $('cartSheet').hidden = true;
  document.body.classList.remove('sheet-open');
}

on('openCart', 'click', openCart);
on('closeCart', 'click', closeCart);
on('cartSheet', 'click', (e) => {
  if (e.target === $('cartSheet')) closeCart();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // Innermost layer wins, so Esc leaves the dashboard rather than also
  // dismissing whatever the shopkeeper had open underneath it.
  if (!$('paymentSheet').hidden) return closePayment();
  if (!$('dashboard').hidden) return closeDashboard();
  if (!$('productDetail').hidden) return closeDetail();
  if (!$('cartSheet').hidden) closeCart();
});

$('cartList').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;

  // The empty state offers a way out; without this the only escape is ✕ or Esc.
  if (t.closest('#cartGoBack')) return closeCart();

  const rm = t.closest('button[data-rm]') as HTMLButtonElement | null;
  if (rm) {
    cart.splice(Number(rm.dataset.rm), 1);
    renderCart();
    return;
  }

  const q = t.closest('button[data-qty]') as HTMLButtonElement | null;
  if (q) {
    const i = Number(q.dataset.i);
    const next = num(cart[i].quantity) + Number(q.dataset.qty);
    if (next <= 0) cart.splice(i, 1);
    else cart[i].quantity = next;
    renderCart();
  }
});

$('cartList').addEventListener('change', (e) => {
  const t = e.target as HTMLElement;

  const qtyInput = t.closest('input[data-qtyinput]') as HTMLInputElement | null;
  if (qtyInput) {
    const i = Number(qtyInput.dataset.qtyinput);
    const next = num(qtyInput.value);
    if (next <= 0) cart.splice(i, 1);
    else cart[i].quantity = next;
    renderCart();
    return;
  }

  const priceInput = t.closest('input[data-priceinput]') as HTMLInputElement | null;
  if (priceInput) {
    const i = Number(priceInput.dataset.priceinput);
    const next = num(priceInput.value);
    if (next < 0) {
      toast('দাম ঋণাত্মক হতে পারে না', 'err');
      renderCart();
      return;
    }
    cart[i].price = next;
    renderCart();
  }
});

on('clearCart', 'click', () => {
  cart.length = 0;
  cartImages = new Map();
  renderCart();
});

on('saleSearch', 'input', async (e) => {
  filters.sale = (e.target as HTMLInputElement).value;
  await renderSaleGrid(await stockMap());
});

/* ---------------- customers ---------------- */

async function renderCustomers(customers: Customer[]) {
  const picked = val('customerUuid').value;
  $('customerChips').innerHTML = customers
    .slice(0, 10)
    .map(
      (c) =>
        `<button type="button" class="chip" data-cust="${esc(c.client_uuid)}" aria-pressed="${picked === c.client_uuid}">${esc(c.name)}</button>`
    )
    .join('');
}

$('customerChips').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-cust]') as HTMLButtonElement | null;
  if (!btn) return;
  void (async () => {
    const c = await db.customers.where('client_uuid').equals(btn.dataset.cust!).first();
    if (!c) return;
    val('customerName').value = c.name;
    val('customerPhone').value = c.phone ?? '';
    val('customerUuid').value = c.client_uuid;
    await renderCustomers(await db.customers.orderBy('name').toArray());
  })();
});

/* ---------------- save invoice ---------------- */

async function doSaveInvoice(busyId: string) {
  if (!cart.length) return toast('আগে অন্তত একটি পণ্য বেছে নিন', 'err');
  await withBusy(busyId, 'সংরক্ষণ হচ্ছে...', async () => {

  const name = val('customerName').value.trim();
  const phone = val('customerPhone').value.trim();
  let customerUuid = val('customerUuid').value;

  if (name && !customerUuid) {
    const existing = await db.customers.where('name').equalsIgnoreCase(name).first();
    if (existing?.id) {
      customerUuid = existing.client_uuid;
      if (phone && phone !== existing.phone) {
        await db.customers.update(existing.id, { phone });
        await enqueue('customer', { ...existing, phone });
      }
    } else {
      const customer: Customer = { client_uuid: uuid(), name, phone };
      const id = await db.customers.add(customer);
      customerUuid = customer.client_uuid;
      await enqueue('customer', { ...customer, id });
    }
  }

  const invoice: Invoice = {
    client_uuid: uuid(),
    customer_name: name,
    customer_client_uuid: customerUuid || undefined,
    date: todayISO(),
    total: cart.reduce((a, l) => a + num(l.quantity) * num(l.price), 0),
    lines: structuredClone(cart)
  };

  const id = await db.invoices.add(invoice);
  for (const l of cart) {
    const s = await db.stock.where('product_client_uuid').equals(l.product_client_uuid).first();
    if (s?.id) await db.stock.update(s.id, { quantity: num(s.quantity) - num(l.quantity) });
  }
  await enqueue('invoice', { ...invoice, id });

  // Cash taken across the counter becomes a payment queued straight after the
  // invoice; pushPayment waits for the invoice's odoo_id before it syncs.
  const paidNow = Math.max(0, num(val('cartPaid').value));
  if (paidNow > 0) {
    const capped = Math.min(paidNow, num(invoice.total));
    const payment: Payment = {
      client_uuid: uuid(),
      invoice_client_uuid: invoice.client_uuid,
      date: todayISO(),
      amount: capped
    };
    const payId = await db.payments.add(payment);
    await db.invoices.update(id, { paid: capped });
    await enqueue('payment', { ...payment, id: payId });
  }

  cart.length = 0;
  val('customerName').value = '';
  val('customerPhone').value = '';
  val('customerUuid').value = '';
  val('cartPaid').value = '';
  cartImages = new Map();
  renderCart();
  toast(paidNow > 0 ? 'ইনভয়েস সংরক্ষিত ও পেমেন্ট নেওয়া হয়েছে' : 'ইনভয়েস সংরক্ষিত হয়েছে', 'ok');
  closeCart();
  await refresh();
  });
}

/* ---------------- payments ---------------- */

let payInvoice: Invoice | null = null;

function renderPaymentSheet() {
  if (!payInvoice) return;
  const paid = invoicePaid.get(payInvoice.client_uuid) ?? num(payInvoice.paid);
  const left = Math.max(0, num(payInvoice.total) - paid);
  $('paySubtitle').textContent =
    `${payInvoice.customer_name || 'খুচরা গ্রাহক'} · ${bnDate(payInvoice.date)}`;
  $('payTotal').textContent = money(payInvoice.total);
  $('payDone').textContent = money(paid);
  $('payLeft').textContent = money(left);
  val('paySave').disabled = left <= 0;
  $('payStatus').textContent = payInvoice.odoo_id
    ? ''
    : 'ইনভয়েসটি এখনো সার্ভারে নেই; পেমেন্ট অনলাইন হলে সিঙ্ক হবে।';
}

async function openPayment(id: number) {
  payInvoice = (await db.invoices.get(id)) ?? null;
  if (!payInvoice) return;
  val('payAmount').value = '';
  renderPaymentSheet();
  $('paymentSheet').hidden = false;
  document.body.classList.add('sheet-open');
}

function closePayment() {
  $('paymentSheet').hidden = true;
  payInvoice = null;
  document.body.classList.remove('sheet-open');
}

on('closePayment', 'click', closePayment);
on('payCancel', 'click', closePayment);
on('paymentSheet', 'click', (e) => {
  if (e.target === $('paymentSheet')) closePayment();
});

document.querySelectorAll<HTMLButtonElement>('[data-payfill]').forEach((b) => {
  b.addEventListener('click', () => {
    if (!payInvoice) return;
    const paid = invoicePaid.get(payInvoice.client_uuid) ?? num(payInvoice.paid);
    const left = Math.max(0, num(payInvoice.total) - paid);
    val('payAmount').value = String(b.dataset.payfill === 'half' ? left / 2 : left);
  });
});

on('paySave', 'click', () => {
  void (async () => {
    if (!payInvoice) return closePayment();
    const amount = num(val('payAmount').value);
    if (amount <= 0) return toast('পরিশোধের অঙ্ক লিখুন', 'err');
    const payment: Payment = {
      client_uuid: uuid(),
      invoice_client_uuid: payInvoice.client_uuid,
      date: todayISO(),
      amount
    };
    const payId = await db.payments.add(payment);
    await enqueue('payment', { ...payment, id: payId });
    toast('পেমেন্ট সংরক্ষিত হয়েছে', 'ok');
    closePayment();
    await refresh();
    void syncNow();
  })();
});

on('saveInvoice', 'click', () => void doSaveInvoice('saveInvoice'));
on('saveInvoiceSheet', 'click', () => void doSaveInvoice('saveInvoiceSheet'));

/* ---------------- stock tab ---------------- */

async function renderStockList(stocks: Map<string, StockLevel>) {
  const products = (await allProducts()).filter((p) => matches(p.name, filters.stock));
  $('stockList').innerHTML =
    products
      .map((p) => {
        const q = num(stocks.get(p.client_uuid)?.quantity);
        return `<div class="list-item"${flashAttr(p.client_uuid)}>
        ${thumb(p)}
        <button class="grow row-link" data-detail="${esc(p.client_uuid)}">
          <span class="name">${esc(p.name)} ${stockBadge(q)}</span>
          <span class="sub">মজুত ${qty(q)} · বিস্তারিত দেখুন ›</span>
        </button>
        <button class="btn subtle" data-add="1" data-id="${esc(p.client_uuid)}" aria-label="এক বাড়ান">+</button>
        <button class="btn subtle" data-add="-1" data-id="${esc(p.client_uuid)}" aria-label="এক কমান">−</button>
      </div>`;
      })
      .join('') || `<div class="empty"><span class="big">📦</span>কোনো পণ্য নেই</div>`;
}

$('stockList').addEventListener('click', async (e) => {
  const link = (e.target as HTMLElement).closest('button[data-detail]') as HTMLButtonElement | null;
  if (link) return goDetail(link.dataset.detail!);

  const btn = (e.target as HTMLElement).closest('button[data-add]') as HTMLButtonElement | null;
  if (!btn) return;
  const id = btn.dataset.id!;
  const dir = Number(btn.dataset.add);
  const p = await db.products.where('client_uuid').equals(id).first();
  if (!p) return;
  const s = await db.stock.where('product_client_uuid').equals(id).first();
  const current = num(s?.quantity);

  const value = await askNumber(
    dir > 0 ? 'কতটি যোগ হবে?' : 'কতটি বাদ যাবে?',
    `${p.name} — বর্তমান মজুত ${qty(current)}`,
    1
  );
  if (value === null || !value) return;

  const delta = dir > 0 ? Math.abs(value) : -Math.abs(value);
  if (current + delta < 0) return toast('মজুতের চেয়ে বেশি বাদ দেওয়া যাবে না', 'err');

  if (s?.id) await db.stock.update(s.id, { quantity: current + delta });
  await enqueue('stock', {
    id: s?.id,
    client_uuid: s?.client_uuid ?? uuid(),
    product_client_uuid: p.client_uuid,
    product_name: p.name,
    mode: 'add',
    value: delta
  });
  toast('মজুত আপডেট হয়েছে', 'ok');
  await refresh();
});

on('stockSet', 'click', () => {
  void withBusy('stockSet', 'সেট হচ্ছে...', async () => {
  const p = await db.products.where('client_uuid').equals(sel('stockProduct').value).first();
  if (!p) return toast('পণ্য বেছে নিন', 'err');
  const quantity = num(val('stockQty').value);
  if (val('stockQty').value === '') return toast('পরিমাণ লিখুন', 'err');
  if (quantity < 0) return toast('মজুত ঋণাত্মক হতে পারে না', 'err');

  const s = await db.stock.where('product_client_uuid').equals(p.client_uuid).first();
  if (s?.id) await db.stock.update(s.id, { quantity });
  await enqueue('stock', {
    id: s?.id,
    client_uuid: s?.client_uuid ?? uuid(),
    product_client_uuid: p.client_uuid,
    product_name: p.name,
    mode: 'set',
    value: quantity
  });
  flash(p.client_uuid);
  await refresh();
  val('stockQty').value = '';
  toast('মজুত সেট হয়েছে', 'ok');
  });
});

on('stockSearch', 'input', async (e) => {
  filters.stock = (e.target as HTMLInputElement).value;
  await renderStockList(await stockMap());
});

/* ---------------- products tab ---------------- */

async function renderProductList(stocks: Map<string, StockLevel>) {
  const products = (await allProducts()).filter((p) => matches(p.name, filters.products));
  $('productList').innerHTML =
    products
      .map((p) => {
        const q = num(stocks.get(p.client_uuid)?.quantity);
        return `<div class="list-item">
        ${thumb(p)}
        <span class="grow">
          <span class="name">${esc(p.name)}</span>
          <span class="sub">${money(p.sale_price)} · মজুত ${qty(q)}</span>
        </span>
        <button class="btn subtle" data-price="${esc(p.client_uuid)}" style="min-height: 40px; padding: 4px 12px">দাম</button>
        <button class="btn danger" data-del="${esc(p.client_uuid)}" style="min-height: 40px; padding: 4px 12px" aria-label="মুছুন">✕</button>
      </div>`;
      })
      .join('') || `<div class="empty"><span class="big">🏷️</span>কোনো পণ্য নেই<br /><span class="muted">উপরের ফর্মে পণ্য যোগ করুন</span></div>`;
}

/** Photo staged on the new-product form; goes out with the product itself. */
let productImageDraft = '';

/**
 * Mirrors the add-product form into localStorage. Capturing a photo hands the
 * page over to the camera app, and on the shop's phone that comes back as a
 * reload or a fresh launch, either of which would drop what was just typed.
 * localStorage rather than sessionStorage because a fresh process loses that.
 */
function saveNewProductDraft() {
  try {
    const draft = {
      name: val('productName').value,
      price: val('productPrice').value,
      image: productImageDraft
    };
    if (!draft.name && !draft.price && !draft.image) localStorage.removeItem(NEW_PRODUCT_DRAFT_KEY);
    else localStorage.setItem(NEW_PRODUCT_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* a full or blocked storage must not break adding a product */
  }
}

function restoreNewProductDraft() {
  try {
    const raw = localStorage.getItem(NEW_PRODUCT_DRAFT_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw) as { name?: string; price?: string; image?: string };
    if (draft.name) val('productName').value = draft.name;
    if (draft.price) val('productPrice').value = draft.price;
    if (draft.image) productImageDraft = draft.image;
    renderProductPick();
  } catch {
    /* a corrupt draft is not worth failing the page over */
  }
}

function renderProductPick() {
  const preview = $('productPickPreview');
  preview.innerHTML = productImageDraft
    ? `<img src="${esc(productImageDraft)}" alt="" />`
    : `<span class="ph">ছবি</span>`;
  btn('productImageClear').hidden = !productImageDraft;
}

async function stageProductImage(input: HTMLInputElement) {
  const file = input.files?.[0];
  if (!file) return;
  try {
    productImageDraft = await compressImage(file);
    renderProductPick();
    saveNewProductDraft();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'ছবি পড়া যায়নি', 'err');
  } finally {
    // Cleared so picking the same file twice in a row still fires 'change'.
    input.value = '';
  }
}

on('productCamera', 'change', (e) => void stageProductImage(e.target as HTMLInputElement));
on('productImage', 'change', (e) => void stageProductImage(e.target as HTMLInputElement));
on('productImageClear', 'click', () => {
  productImageDraft = '';
  renderProductPick();
  saveNewProductDraft();
});

val('productName').addEventListener('input', saveNewProductDraft);
val('productPrice').addEventListener('input', saveNewProductDraft);

on('productAdd', 'click', () => {
  void withBusy('productAdd', 'যোগ হচ্ছে...', async () => {
  const name = val('productName').value.trim();
  const priceRaw = val('productPrice').value;
  if (!name) return toast('পণ্যের নাম লিখুন', 'err');
  if (priceRaw === '' || num(priceRaw) < 0) return toast('সঠিক দাম লিখুন', 'err');

  const product: Product = {
    client_uuid: uuid(),
    name,
    sale_price: num(priceRaw),
    ...(productImageDraft ? { image: productImageDraft } : {})
  };
  const id = await db.products.add(product);
  await db.stock.add({
    client_uuid: uuid(),
    product_client_uuid: product.client_uuid,
    product_name: product.name,
    quantity: 0
  });
  flash(product.client_uuid);
  await refresh();
  await enqueue('product', { ...product, id });
  val('productName').value = '';
  val('productPrice').value = '';
  productImageDraft = '';
  renderProductPick();
  saveNewProductDraft();
  toast('পণ্য যোগ হয়েছে — সবার জন্য দৃশ্যমান', 'ok');
  });
});

$('productList').addEventListener('click', async (e) => {
  const t = e.target as HTMLElement;
  const id = t.closest('button[data-price]')?.getAttribute('data-price') ?? '';
  const delId = t.closest('button[data-del]')?.getAttribute('data-del') ?? '';
  const uuidTarget = id || delId;
  if (!uuidTarget) return;
  const p = await db.products.where('client_uuid').equals(uuidTarget).first();
  if (!p) return;

  if (delId) {
    const value = await askNumber('মুছে ফেলবেন?', `${p.name} — টাইপ করে ১ দিন`, 0);
    if (value !== 1) return;
    await enqueue('product_delete', { ...p });
    toast('পণ্য মুছে ফেলা হয়েছে', 'ok');
  } else {
    const value = await askNumber('বিক্রয় মূল্য পরিবর্তন', p.name, p.sale_price);
    if (value === null || value < 0) return;
    await db.products.update(p.id!, { sale_price: value });
    await enqueue('product_update', { ...p, sale_price: value });
    toast('দাম আপডেট হয়েছে', 'ok');
  }
  await refresh();
});

on('productSearch', 'input', async (e) => {
  filters.products = (e.target as HTMLInputElement).value;
  await renderProductList(await stockMap());
});

/* ---------------- history tab ---------------- */

let invoiceThumbs = new Map<string, string | undefined>();

async function renderInvoices(invoices: Invoice[]) {
  const keys = [
    ...new Set(
      invoices.flatMap((i) => (i.lines ?? []).map((l) => l.product_client_uuid)).slice(0, 200)
    )
  ];
  if (keys.length) {
    const rows = await db.products.where('client_uuid').anyOf(keys).toArray();
    invoiceThumbs = new Map(rows.map((r) => [r.client_uuid, r.image]));
  }
  invoicePaid = new Map(
    (await db.payments.toArray()).map((p) => [p.invoice_client_uuid, num(p.amount)])
  );
  $('invoiceList').innerHTML =
    invoices
      .map((i) => {
        const paid = invoicePaid.get(i.client_uuid) ?? 0;
        const left = Math.max(0, num(i.total) - paid);
        const dueSuffix = paid > 0 ? ` <span class="due-tag">বাকি ${money(left)}</span>` : '';
        return `<div class="list-item inv-row">
      ${i.lines?.length ? thumb({ name: i.lines[0].name, image: invoiceThumbs.get(i.lines[0].product_client_uuid) }) : ''}
      <span class="grow">
        <span class="name">${esc(i.customer_name || 'খুচরা গ্রাহক')}</span>
        <span class="sub">${esc(i.name || 'অপেক্ষমাণ')} · ${esc(bnDate(i.date))} · ${(i.lines ?? []).length}টি আইটেম${paid > 0 ? ` · পরিশোধিত ${money(paid)}` : ''}</span>
      </span>
      <span class="amt">${money(i.total)}${dueSuffix}</span>
      ${i.odoo_id ? '<span class="badge ok">সিঙ্ক</span>' : '<span class="badge wait">পেন্ডিং</span>'}
      <span class="inv-actions">
        <button class="btn subtle sm" data-invoice="${i.id}" aria-label="ইনভয়েস দেখুন">ইনভয়েস</button>
        <button class="btn subtle sm" data-pay="${i.id}" aria-label="পেমেন্ট নিন">পেমেন্ট</button>
        <button class="btn subtle sm" data-server-pdf="${i.id}" aria-label="সার্ভার থেকে পিডিএফ ডাউনলোড">পিডিএফ</button>
      </span>
    </div>`;
      })
      .join('') || `<div class="empty"><span class="big">📄</span>এখনো কোনো ইনভয়েস নেই</div>`;
}

$('invoiceList').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;

  const server = t.closest('button[data-server-pdf]') as HTMLButtonElement | null;
  if (server) return void downloadServerPdf(Number(server.dataset.serverPdf));

  const pay = t.closest('button[data-pay]') as HTMLButtonElement | null;
  if (pay) return void openPayment(Number(pay.dataset.pay));

  const view = t.closest('button[data-invoice]') as HTMLButtonElement | null;
  if (view) return void showInvoiceDocument(Number(view.dataset.invoice));
});

/* ---------------- profile tab ---------------- */

const PROFILE_FIELDS: [id: string, key: keyof Profile][] = [
  ['pfCompanyName', 'company_name'],
  ['pfTagline', 'tagline'],
  ['pfMobile', 'mobile'],
  ['pfPhone', 'phone'],
  ['pfEmail', 'email'],
  ['pfWebsite', 'website'],
  ['pfStreet', 'street'],
  ['pfStreet2', 'street2'],
  ['pfCity', 'city'],
  ['pfZip', 'zip'],
  ['pfVat', 'vat'],
  ['pfRegistry', 'registry'],
  ['pfTerms', 'terms'],
  ['pfNote', 'note'],
  ['pfSellerLabel', 'seller_label'],
  ['pfBuyerLabel', 'buyer_label'],
  ['pfShowLogo', 'show_logo'],
  ['pfShowSignature', 'show_signature'],
  ['pfShowTerms', 'show_terms']
];

/** Staged logo: set on pick, only committed to the server on save. */
let profileLogo = '';
/** Periodic refreshes must not wipe out whatever the user is still typing. */
let profileFormLoaded = false;

function profilePlaceholder(name: string): string {
  const initial = name.trim().charAt(0) || 'দোকান';
  return `<span class="ph">${esc(initial)}</span>`;
}

function readProfileForm(): Profile {
  const draft: Record<string, unknown> = {};
  for (const [id, key] of PROFILE_FIELDS) {
    const input = val(id);
    draft[key] = input.type === 'checkbox' ? input.checked : input.value.trim();
  }
  return draft as unknown as Profile;
}

/* ============ dashboard ============ */

/** Short Bengali weekday for the 7-day chart, Sunday first. */
const BN_DAYS = ['রবি', 'সোম', 'মঙ্গল', 'বুধ', 'বৃহস', 'শুক্র', 'শনি'];

function dashEmpty(text: string): string {
  return `<div class="dash-empty">${esc(text)}</div>`;
}

/** "৳১,২০০" is too wide for a 7-column chart, so chart labels drop to thousands. */
function dashCompact(value: number): string {
  if (value >= 100000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

async function renderDashboard(): Promise<void> {
  const today = todayISO();
  const [invoices, payments, stocks, company] = await Promise.all([
    db.invoices.toArray(),
    db.payments.toArray(),
    db.stock.toArray(),
    cachedCompany()
  ]);

  /* paid per invoice: local payments first, then the server value, so an
     invoice that synced before the payments table existed still reads right */
  const paidByInvoice = new Map<string, number>();
  for (const p of payments) {
    paidByInvoice.set(
      p.invoice_client_uuid,
      num(paidByInvoice.get(p.invoice_client_uuid)) + num(p.amount)
    );
  }

  const paidOf = (inv: Invoice): number => {
    const local = paidByInvoice.get(inv.client_uuid);
    return num(local !== undefined ? local : inv.paid);
  };

  const todayInvoices = invoices.filter((i) => i.date === today);
  const todayTotal = todayInvoices.reduce((sum, i) => sum + num(i.total), 0);
  const todayPayments = payments.filter((p) => p.date === today);
  const todayPaid = todayPayments.reduce((sum, p) => sum + num(p.amount), 0);

  /* dues count an invoice once, even with several partial payments */
  let dueTotal = 0;
  let dueCount = 0;
  const dueByCustomer = new Map<string, number>();
  for (const inv of invoices) {
    const left = Math.max(0, num(inv.total) - paidOf(inv));
    if (left <= 0.005) continue;
    dueTotal += left;
    dueCount += 1;
    const who = inv.customer_name || 'খুচরা গ্রাহক';
    dueByCustomer.set(who, num(dueByCustomer.get(who)) + left);
  }

  const lowItems = stocks
    .filter((s) => num(s.quantity) <= LOW_STOCK)
    .sort((a, b) => num(a.quantity) - num(b.quantity));
  const outItems = lowItems.filter((s) => num(s.quantity) <= 0);

  $('dashShop').textContent = company?.name || '';
  $('dashTodayTotal').textContent = money(todayTotal);
  $('dashTodayCount').textContent = `${todayInvoices.length}টি বিল`;
  $('dashTodayPaid').textContent = money(todayPaid);
  $('dashTodayPaidCount').textContent = `${todayPayments.length}টি পরিশোধ`;
  $('dashDueTotal').textContent = money(dueTotal);
  $('dashDueCount').textContent = `${dueCount}টি ইনভয়েস`;
  $('dashLowStock').textContent = String(lowItems.length);
  $('dashOutStock').textContent = `${outItems.length}টি ফুরিয়ে গেছে`;

  /* last 7 days including today, oldest first, so the chart reads left to right.
     The key must come from local date parts, not toISOString(): in UTC+6 that
     turns local midnight into the previous day and the chart would start on
     the wrong weekday. */
  const localKey = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const days: { key: string; label: string; total: number; isToday: boolean }[] = [];
  for (let back = 6; back >= 0; back -= 1) {
    const d = new Date(`${today}T00:00:00`);
    d.setDate(d.getDate() - back);
    days.push({
      key: localKey(d),
      label: BN_DAYS[d.getDay()] || '',
      total: invoices
        .filter((i) => i.date === localKey(d))
        .reduce((sum, i) => sum + num(i.total), 0),
      isToday: back === 0
    });
  }
  const peak = Math.max(...days.map((d) => d.total), 1);
  $('dashChart').innerHTML = days
    .map(
      (d) => `<div class="dash-col${d.isToday ? ' is-today' : ''}${d.total ? '' : ' is-zero'}">
      <span class="dash-col-amount">${esc(dashCompact(d.total))}</span>
      <span class="dash-col-bar" style="height:${Math.max(3, Math.round((d.total / peak) * 100))}%"></span>
      <span class="dash-col-day">${esc(d.label)}</span>
    </div>`
    )
    .join('');

  const debtors = [...dueByCustomer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  $('dashDebtors').innerHTML = debtors.length
    ? debtors
        .map(
          ([who, due]) => `<div class="dash-row">
        <span class="dash-row-main"><span class="dash-row-title">${esc(who)}</span></span>
        <span class="dash-row-value due">${esc(money(due))}</span>
      </div>`
        )
        .join('')
    : dashEmpty('কারও কাছে বাকি নেই');

  $('dashLowItems').innerHTML = lowItems.length
    ? lowItems
        .slice(0, 5)
        .map(
          (s) => `<div class="dash-row">
        <span class="dash-row-main">
          <span class="dash-row-title">${esc(s.product_name)}</span>
          <span class="dash-row-sub">${num(s.quantity) <= 0 ? 'ফুরিয়ে গেছে' : 'কম মজুত'}</span>
        </span>
        <span class="dash-row-value ${num(s.quantity) <= 0 ? 'due' : ''}">${esc(qty(s.quantity))}</span>
      </div>`
        )
        .join('')
    : dashEmpty('সব পণ্যের মজুত ঠিক আছে');

  const recent = [...invoices].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  $('dashRecent').innerHTML = recent.length
    ? recent
        .map((i) => {
          const paid = paidOf(i);
          const left = Math.max(0, num(i.total) - paid);
          return `<div class="dash-row">
          <span class="dash-row-main">
            <span class="dash-row-title">${esc(i.customer_name || 'খুচরা গ্রাহক')}</span>
            <span class="dash-row-sub">${esc(bnDate(i.date))}${paid > 0 ? ` · পরিশোধিত ${esc(money(paid))}` : ''}</span>
          </span>
          <span class="dash-row-value ${left > 0.005 ? 'due' : 'ok'}">${esc(money(left > 0.005 ? left : i.total))}</span>
        </div>`;
        })
        .join('')
    : dashEmpty('এখনো কোনো বিল নেই');

  const sync = getState();
  $('dashSync').textContent = sync.online
    ? sync.pending || sync.failed
      ? `${sync.pending}টি অপেক্ষমাণ · ${sync.failed}টি ব্যর্থ`
      : 'সবকিছু সিঙ্ক হয়েছে'
    : 'অফলাইন — তালিকা সংরক্ষিত আছে';
}

function openDashboard(): void {
  $('dashboard').hidden = false;
  document.body.classList.add('sheet-open');
  void renderDashboard().catch(() => {
    toast('ড্যাশবোর্ড দেখানো গেল না', 'err');
  });
}

function closeDashboard(): void {
  $('dashboard').hidden = true;
  document.body.classList.remove('sheet-open');
}

/* ---------------- theme picker ---------------- */

function renderThemeSwatches(): void {
  const active = currentTheme();
  $('themeSwatches').innerHTML = THEMES.map(
    (t) => `<button class="swatch" type="button" role="radio" data-theme="${t.id}"
      style="background:${t.swatch}" title="${esc(t.label)}" aria-label="${esc(t.label)}"
      aria-checked="${t.id === active}"></button>`
  ).join('');
}

function renderModeSwitch(): void {
  const mode = currentMode();
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
    btn.setAttribute('aria-checked', String(btn.dataset.mode === mode));
  }
}

function initThemePicker(): void {
  const host = $('themeSwatches');
  host.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-theme]');
    if (!t?.dataset.theme) return;
    applyTheme(t.dataset.theme as never, currentMode());
    renderThemeSwatches();
    renderModeSwitch();
  });
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.mode-btn')) {
    btn.addEventListener('click', () => {
      applyTheme(currentTheme(), btn.dataset.mode as never);
      renderModeSwitch();
    });
  }
  renderThemeSwatches();
  renderModeSwitch();
}

/* An OS-level flip only matters while the shopkeeper has chosen to follow it. */
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (currentMode() !== 'system') return;
  applyTheme(currentTheme(), 'system');
  syncThemeColor();
});

async function renderProfile(refill = false): Promise<void> {
  const profile = await loadProfile();

  if (refill || !profileFormLoaded) {
    for (const [id, key] of PROFILE_FIELDS) {
      const input = val(id);
      if (input.type === 'checkbox') input.checked = profile[key] !== false;
      else input.value = String(profile[key] ?? '');
    }

    profileLogo = profile.logo ?? '';
    $('profileLogoPreview').innerHTML = profileLogo
      ? `<img src="${esc(profileLogo)}" alt="লোগো" />`
      : profilePlaceholder(String(profile.company_name ?? ''));
    btn('profileLogoClear').hidden = !profileLogo;

    $('profileStatus').textContent = profile.updated_at
      ? `সর্বশেষ সংরক্ষণ: ${bnDate(profile.updated_at.slice(0, 10))}`
      : 'এখনো কোনো তথ্য সংরক্ষণ করা হয়নি';
    profileFormLoaded = true;
  }

  renderCompany(profile.company_name || null, profile.logo ?? '');
}

on('profileLogo', 'change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  try {
    profileLogo = await compressImage(file, 512);
    $('profileLogoPreview').innerHTML = `<img src="${esc(profileLogo)}" alt="লোগো" />`;
    btn('profileLogoClear').hidden = false;
    toast('লোগো বেছে নেওয়া হয়েছে — নিচে সংরক্ষণ করুন');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'লোগো পড়া যায়নি', 'err');
  } finally {
    input.value = '';
  }
});

on('profileLogoClear', 'click', () => {
  profileLogo = '';
  $('profileLogoPreview').innerHTML = profilePlaceholder(val('pfCompanyName').value);
  btn('profileLogoClear').hidden = true;
});

on('profileSave', 'click', () => {
  void withBusy('profileSave', 'সংরক্ষণ হচ্ছে...', async () => {
    const draft = readProfileForm();
    if (!draft.company_name) return toast('কোম্পানির নাম লিখুন', 'err');
    if (draft.email && !/^\S+@\S+\.\S+$/.test(draft.email)) return toast('ইমেইল ঠিকানাটি সঠিক নয়', 'err');

    draft.logo = profileLogo;
    const stored = await saveProfile(draft);
    await enqueue('profile', { ...stored, logo: profileLogo });

    $('profileStatus').textContent = navigator.onLine
      ? 'সংরক্ষিত হয়েছে — সার্ভারে পাঠানো হচ্ছে'
      : 'সংরক্ষিত হয়েছে — অনলাইনে গেলে সার্ভারে যাবে';
    toast('প্রতিষ্ঠানের তথ্য সংরক্ষিত হয়েছে', 'ok');
    renderCompany(draft.company_name, profileLogo);
  });
});

/* ---------------- product detail ---------------- */

let detailUuid: string | null = null;
let detailToken = 0;

async function openDetail(uuid: string): Promise<boolean> {
  const token = ++detailToken;
  const product = await db.products.where('client_uuid').equals(uuid).first();
  if (!product) return false;

  const sales = (await db.invoices.toArray())
    .filter((i) => (i.lines ?? []).some((l) => l.product_client_uuid === uuid))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 8);

  if (token !== detailToken) return false;
  detailUuid = uuid;

  const stock = await db.stock.where('product_client_uuid').equals(uuid).first();
  const current = num(stock?.quantity);

  $('detailName').textContent = product.name;
  $('detailThumb').innerHTML = thumb(product, 'hero-img');
  btn('detailImageClear').hidden = !product.image;
  val('detailPrice').value = String(product.sale_price);
  $('detailQty').textContent = qty(current);
  $('detailStockHint').textContent =
    current <= 0 ? 'ফুরিয়ে গেছে' : current <= LOW_STOCK ? 'মজুত কম' : 'মজুত ঠিক আছে';
  $('detailSku').textContent = product.default_code || '—';
  $('detailOdoo').textContent = product.odoo_id ? String(product.odoo_id) : 'সিঙ্ক হয়নি';
  val('detailQtyInput').value = '';

  $('detailSales').innerHTML =
    sales
      .map((i) => {
        const sold = (i.lines ?? [])
          .filter((l) => l.product_client_uuid === uuid)
          .reduce((a, l) => a + num(l.quantity), 0);
        const revenue = (i.lines ?? [])
          .filter((l) => l.product_client_uuid === uuid)
          .reduce((a, l) => a + num(l.quantity) * num(l.price), 0);
        return `<div class="list-item">
        <span class="grow">
          <span class="name">${esc(i.customer_name || 'খুচরা গ্রাহক')}</span>
          <span class="sub">${esc(i.name || 'অপেক্ষমাণ')} · ${esc(bnDate(i.date))}</span>
        </span>
        <span class="amt">${qty(sold)} · ${money(revenue)}</span>
      </div>`;
      })
      .join('') || `<div class="empty"><span class="big">📄</span>এখনো কোনো বিক্রয় নেই</div>`;

  $('productDetail').hidden = false;
  document.body.classList.add('detail-open');
  return true;
}

function clearHash() {
  if (!location.hash.startsWith('#/product/')) return;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

function closeDetail() {
  detailToken += 1;
  $('productDetail').hidden = true;
  document.body.classList.remove('detail-open');
  detailUuid = null;
  clearHash();
}

async function applyStock(mode: 'add' | 'set', value: number) {
  if (!detailUuid) return;
  const product = await db.products.where('client_uuid').equals(detailUuid).first();
  if (!product) return;
  const stock = await db.stock.where('product_client_uuid').equals(detailUuid).first();
  const current = num(stock?.quantity);
  const next = mode === 'add' ? current + value : value;
  if (next < 0) return toast('মজুতের চেয়ে বেশি বাদ দেওয়া যাবে না', 'err');

  if (stock?.id) await db.stock.update(stock.id, { quantity: next });
  await enqueue('stock', {
    id: stock?.id,
    client_uuid: stock?.client_uuid ?? uuid(),
    product_client_uuid: product.client_uuid,
    product_name: product.name,
    mode,
    value
  });
  await openDetail(product.client_uuid);
  await refresh();
  toast('মজুত আপডেট হয়েছে', 'ok');
}

on('detailBack', 'click', closeDetail);

on('dashBtn', 'click', openDashboard);
on('dashBack', 'click', closeDashboard);

async function compressImage(file: File, max = 320): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('ছবি পড়া যায়নি'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('ছবিটি খোলা যায়নি'));
    el.src = dataUrl;
  });

  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function saveProductImage(input: HTMLInputElement) {
  const file = input.files?.[0];
  if (!file || !detailUuid) return;

  try {
    const image = await compressImage(file);
    const product = await db.products.where('client_uuid').equals(detailUuid).first();
    if (!product?.id) return;
    await db.products.update(product.id, { image });
    $('detailThumb').innerHTML = thumb({ ...product, image }, 'hero-img');
    btn('detailImageClear').hidden = false;
    await enqueue('product_image', { ...product, image });
    toast('ছবি সংরক্ষিত হয়েছে', 'ok');
    await refresh();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'ছবি সংরক্ষিত হয়নি', 'err');
  } finally {
    // Cleared so picking the same file twice in a row still fires 'change'.
    input.value = '';
  }
}

// Two inputs, one handler: `capture` sends Android straight into the camera
// and drops the file chooser, which is exactly what we want there but leaves
// no way back to an existing photo, hence the separate gallery input.
on('detailCamera', 'change', (e) => void saveProductImage(e.target as HTMLInputElement));
on('detailImage', 'change', (e) => void saveProductImage(e.target as HTMLInputElement));

on('detailImageClear', 'click', async () => {
  if (!detailUuid) return;
  const product = await db.products.where('client_uuid').equals(detailUuid).first();
  if (!product?.id) return;
  await db.products.update(product.id, { image: undefined });
  await enqueue('product_image', { ...product, image: '' });
  $('detailThumb').innerHTML = thumb({ ...product, image: undefined }, 'hero-img');
  btn('detailImageClear').hidden = true;
  toast('ছবি মুছে ফেলা হয়েছে', 'ok');
  await refresh();
});

on('detailPriceSave', 'click', async () => {
  if (!detailUuid) return;
  const product = await db.products.where('client_uuid').equals(detailUuid).first();
  if (!product?.id) return;
  const price = num(val('detailPrice').value);
  if (price < 0) return toast('দাম ঋণাত্মক হতে পারে না', 'err');
  await db.products.update(product.id, { sale_price: price });
  await enqueue('product_update', { ...product, sale_price: price });
  toast('মূল্য সংরক্ষিত হয়েছে', 'ok');
  await refresh();
});

$('productDetail').addEventListener('click', (e) => {
  const q = (e.target as HTMLElement).closest('button[data-dq]') as HTMLButtonElement | null;
  if (q) void applyStock('add', Number(q.dataset.dq));
});

on('detailQtySet', 'click', async () => {
  if (val('detailQtyInput').value === '') return toast('পরিমাণ লিখুন', 'err');
  await applyStock('set', num(val('detailQtyInput').value));
});

on('detailDelete', 'click', async () => {
  if (!detailUuid) return;
  const product = await db.products.where('client_uuid').equals(detailUuid).first();
  if (!product) return;
  const value = await askNumber('মুছে ফেলবেন?', `${product.name} — নিশ্চিত করতে ১ লিখুন`, 0);
  if (value !== 1) return;
  await enqueue('product_delete', { ...product });
  closeDetail();
  toast('পণ্য মুছে ফেলা হয়েছে', 'ok');
  await refresh();
});

function readHashDetail() {
  const m = /^#\/product\/(.+)$/.exec(location.hash);
  if (!m) return closeDetail();
  const uuid = decodeURIComponent(m[1]);
  void openDetail(uuid).then((ok) => {
    if (!ok) clearHash();
  });
}

window.addEventListener('hashchange', readHashDetail);

function goDetail(uuid: string) {
  const target = `#/product/${encodeURIComponent(uuid)}`;
  if (location.hash === target) {
    void openDetail(uuid);
    return;
  }
  location.hash = target;
}

/* ---------------- print ---------------- */

function invoiceRows(inv: Invoice): string {
  return (inv.lines ?? [])
    .map(
      (l, i) =>
        `<tr><td>${i + 1}</td><td>${esc(l.name)}</td><td>${qty(l.quantity)}</td><td>${money(l.price)}</td><td>${money(num(l.quantity) * num(l.price))}</td></tr>`
    )
    .join('');
}

function invoiceFileName(inv: Invoice): string {
  const label = (inv.name || inv.client_uuid || 'invoice').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `invoice-${label}`;
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Mirrors bn_root_invoicing/report/invoice_report.xml so print and PDF match. */
async function invoiceDoc(inv: Invoice): Promise<string> {
  const profile = await loadProfile();
  const company = profile.company_name.trim() || 'আপনার দোকান';
  const contacts = contactLines(profile);
  const address = addressLines(profile);
  const tagline = (profile.tagline ?? '').trim();
  const note = (profile.note ?? '').trim();
  const terms = (profile.terms ?? '').trim();
  const logo = profile.show_logo !== false && profile.logo;
  const seller = (profile.seller_label ?? '').trim() || 'বিক্রেতার স্বাক্ষর';
  const buyer = (profile.buyer_label ?? '').trim() || 'ক্রেতার স্বাক্ষর';

  const ident = [
    profile.vat?.trim() ? `ট্যাক্স আইডি: ${profile.vat.trim()}` : '',
    profile.registry?.trim() ? `রেজিস্ট্রেশন: ${profile.registry.trim()}` : ''
  ].filter(Boolean);

  const smallLines = (lines: string[]) => lines.map((line) => `<div>${esc(line)}</div>`).join('');

  return `<div class="sheet-doc">
    <header class="doc-head">
      <div class="doc-head-main">
        ${logo ? `<img class="doc-logo" src="${esc(profile.logo ?? '')}" alt="" />` : ''}
        <h1>${esc(company)}</h1>
        ${tagline ? `<div class="doc-tagline">${esc(tagline)}</div>` : ''}
        <div class="doc-meta">${smallLines([...contacts, ...address, ...ident])}</div>
      </div>
      <div class="doc-head-side">
        <div class="doc-title">ইনভয়েস</div>
        <div>নং: <b>${esc(inv.name || 'অপেক্ষমাণ')}</b></div>
        <div>তারিখ: <b>${esc(bnDate(inv.date))}</b></div>
        <div>গ্রাহক: <b>${esc(inv.customer_name?.trim() || 'খুচরা গ্রাহক')}</b></div>
      </div>
    </header>

    <table class="print-table">
      <thead><tr><th>ক্রম</th><th>বিবরণ</th><th>পরিমাণ</th><th>একক মূল্য</th><th>মোট</th></tr></thead>
      <tbody>${invoiceRows(inv) || '<tr><td colspan="5">বিস্তারিত অফলাইন সিঙ্কের পর দেখা যাবে</td></tr>'}</tbody>
    </table>

    <p class="grand">সর্বমোট: <b>${money(inv.total)}</b></p>

    ${profile.show_terms !== false && terms ? `<div class="doc-terms"><b>শর্তাবলী</b><div>${esc(terms)}</div></div>` : ''}
    ${profile.show_signature !== false ? `<footer><span>${esc(seller)}</span><span>${esc(buyer)}</span></footer>` : ''}
    ${note ? `<p class="doc-note">${esc(note)}</p>` : ''}
    <div class="doc-foot">${esc(company)}${contacts.length ? ` · ${esc(contacts.join(' · '))}` : ''}</div>
  </div>`;
}

/**
 * Render the invoice and hand it to the browser's print/save dialog.
 *
 * Deliberately not `/report/pdf/account.report_invoice/<id>`. That path runs
 * wkhtmltopdf (Qt WebKit), which does no complex-text shaping: it emits one
 * glyph per Unicode code point, so Bengali conjuncts (ক্ষ, the reph, যুক্তাক্ষর)
 * come apart. The browser shapes them correctly, and `invoiceDoc` mirrors the
 * server report, so this is the same sheet with readable text.
 *
 * Works with no `odoo_id`: no server round trip, no sync wait, and it functions
 * offline or for an invoice Odoo has never seen.
 */
async function showInvoiceDocument(id: number) {
  const inv = await db.invoices.get(id);
  if (!inv) return;
  $('printArea').innerHTML = await invoiceDoc(inv);
  window.print();
}

/**
 * The PDF Odoo generates and stores. Kept because the text is real and
 * selectable and the file is kept server-side, which the browser path cannot
 * offer — but its Bengali conjuncts are broken, see showInvoiceDocument.
 */
async function downloadServerPdf(id: number) {
  let inv = await db.invoices.get(id);
  if (!inv) return;

  toast('সার্ভার থেকে পিডিএফ তৈরি হচ্ছে...');

  if (!inv.odoo_id) {
    const queued = await db.queue.filter((o) => o.type === 'invoice').count();
    if (!queued) await enqueue('invoice', { ...inv, id: inv.id });
    const synced = await waitForSync(id);
    if (!synced?.odoo_id) {
      toast('ইনভয়েসটি এখনো সার্ভারে সিঙ্ক হয়নি। অনলাইন হলে আবার চেপে দিন।', 'err');
      return;
    }
    inv = synced;
  }

  try {
    saveBlob(await fetchInvoicePdf(inv), `${invoiceFileName(inv)}.pdf`);
    toast('সার্ভারের পিডিএফ ডাউনলোড হয়েছে', 'ok');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'পিডিএফ ডাউনলোড হয়নি', 'err');
  }
}

async function waitForSync(id: number, timeoutMs = 25000): Promise<Invoice | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = await db.invoices.get(id);
    if (fresh?.odoo_id) return fresh;
    if (!(await db.queue.filter((o) => o.type === 'invoice').count())) await syncNow();
    await new Promise((r) => setTimeout(r, 1500));
  }
  return (await db.invoices.get(id)) ?? null;
}

/**
 * The PDF Odoo generates and stores, rendered by our own report so it goes
 * through WeasyPrint — wkhtmltopdf cannot shape Bengali conjuncts, and
 * Odoo's own `account.report_invoice` stays on wkhtmltopdf so vendor bills and
 * the backend are unaffected. Needs the invoice to exist server-side.
 */
async function fetchInvoicePdf(inv: Invoice): Promise<Blob> {
  const res = await fetch(`/report/pdf/bn_root_invoicing.report_invoice_action/${inv.odoo_id}`, {
    credentials: 'include'
  });
  if (!res.ok) throw new Error(`পিডিএফ তৈরি হয়নি (HTTP ${res.status})`);
  const type = res.headers.get('content-type') ?? '';
  const blob = await res.blob();
  if (!type.includes('pdf') && blob.type !== 'application/pdf') {
    throw new Error('পিডিএফ পাওয়া যায়নি');
  }
  return blob;
}

/* ---------------- sync status ---------------- */

function renderCompany(name?: string | null, logo?: string | null) {
  const company = name ?? cachedCompany()?.name ?? '';
  const label = company || 'দোকানের নাম';

  const title = $('companyName');
  title.textContent = label;
  // The bar only ever shows the truncated name, so keep the full one reachable.
  title.title = label;

  const mark = $('brandMark');
  // `logo === undefined` means "only the name changed" (a refresh, or the name
  // arriving from the server) — do not wipe a logo that is already on screen.
  if (logo !== undefined) mark.innerHTML = logo ? `<img src="${esc(logo)}" alt="" />` : '';
  if (!mark.querySelector('img')) mark.textContent = Array.from(label)[0] ?? 'হ';

  document.title = company ? `${company} — হিসাব খাতা` : 'হিসাব খাতা';
}

async function refreshCompany() {
  const company = await fetchCompany();
  renderCompany(company?.name);
}

function renderSync(s: SyncState) {
  const pill = $('syncPill');
  const text = $('syncText');
  pill.className = 'pill';
  $('syncBtn').classList.toggle('spinning', s.running);

  if (s.warnings.length) {
    $('issueBar').hidden = false;
    pill.classList.add('error');
    text.textContent = 'সতর্কতা';
    $('issueTitle').textContent = 'কিছু কাজ হয়নি';
    $('syncError').textContent = s.warnings[s.warnings.length - 1];
    $('clearFailed').hidden = true;
    return;
  }
  $('clearFailed').hidden = false;

  const hasIssue = s.failed > 0 || s.dead.length > 0;
  $('issueBar').hidden = !hasIssue;

  if (hasIssue) {
    pill.classList.add('error');
    text.textContent = s.failed > 0 ? `${s.failed}টি ব্যর্থ` : `${s.dead.length}টি বাদ`;
    $('issueTitle').textContent = s.dead.length ? `${s.dead.length}টি কাজ বাদ পড়েছে` : `${s.failed}টি সিঙ্ক হচ্ছে না`;
    const detail = s.dead.length ? s.dead[s.dead.length - 1].message : s.lastError ?? '';
    $('syncError').textContent = detail ? `কারণ: ${detail}` : '';
    return;
  }

  $('syncError').textContent = '';
  $('issueTitle').textContent = 'সমস্যা';
  if (!s.online) {
    pill.classList.add('offline');
    text.textContent = `অফলাইন${s.pending ? ` · ${s.pending}` : ''}`;
    return;
  }
  if (s.running) {
    pill.classList.add('busy');
    text.textContent = 'সিঙ্ক হচ্ছে';
    return;
  }
  text.textContent = s.pending ? `${s.pending}টি বাকি` : s.lastSyncAt ? 'সিঙ্ক সম্পন্ন' : 'প্রস্তুত';
}

/* ---------------- skeleton ---------------- */

const SKELETON = `<div class="skeleton"><div style="flex:1">
  <div class="bar w1"></div><div class="bar w3"></div></div><div class="bar w2"></div></div>`;

function skeleton(id: string, rows = 4) {
  $(id).innerHTML = SKELETON.repeat(rows);
}

/* ---------------- refresh ---------------- */

async function refresh() {
  const [stocks, invoices, customers] = await Promise.all([
    db.stock.toArray(),
    db.invoices.orderBy('date').reverse().toArray(),
    db.customers.orderBy('name').toArray()
  ]);
  const sm = new Map(stocks.map((s) => [s.product_client_uuid, s]));
  const products = await allProducts();

  $('stockProduct').innerHTML = products
    .map((p) => `<option value="${esc(p.client_uuid)}">${esc(p.name)}</option>`)
    .join('');

  const today = todayISO();
  const todays = invoices.filter((i) => i.date === today);
  $('statToday').textContent = money(todays.reduce((a, i) => a + num(i.total), 0));
  $('statCount').textContent = String(todays.length);
  $('statLow').textContent = String([...sm.values()].filter((s) => num(s.quantity) <= LOW_STOCK).length);

  await renderSaleGrid(sm);
  await loadCartImages();
  renderCart();
  await renderStockList(sm);
  await renderProductList(sm);
  await renderInvoices(invoices);
  await renderCustomers(customers);
  await renderProfile();
  renderSync(getState());
}

window.addEventListener('ledger:syncstate', (e) => renderSync((e as CustomEvent<SyncState>).detail));

let syncing = false;
window.addEventListener('ledger:synced', () => {
  if (syncing) return;
  syncing = true;
  void refreshCompany().then(() =>
    refresh()
      .then(() => {
        renderSync(getState());
      })
    )
    .catch(() => {})
    .finally(() => {
      syncing = false;
    });
});

window.addEventListener('focus', () => {
  void syncNow(true).catch(() => {});
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void syncNow(true).catch(() => {});
});

setInterval(() => {
  void refresh().catch((err) => {
    console.error('refresh failed', err);
    toast(err instanceof Error ? err.message : 'স্ক্রিন রিফ্রেশ ব্যর্থ', 'err');
  });
}, 20000);

if (!saved.password) {
  skeleton('saleGrid');
  skeleton('stockList');
  skeleton('productList');
  skeleton('invoiceList');
}

void (async () => {
  if (await adoptOwner(saved.login)) location.reload();
  /* The document already carries the stored theme from the head bootstrap;
     this only reconciles state if the OS flipped mode or storage was cleared. */
  applyTheme(currentTheme(), currentMode());
  syncThemeColor();
  initThemePicker();
  renderCompany();
  await refreshCompany();
  restoreTab();
  restoreNewProductDraft();
  await refresh();
  moveThumb();
  readHashDetail();
  void syncNow();
})();