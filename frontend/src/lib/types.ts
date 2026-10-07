export type Product = {
  id?: number;
  client_uuid: string;
  name: string;
  sale_price: number;
  odoo_id?: number;
  odoo_template_id?: number;
  last_used_at?: number;
  default_code?: string;
  image?: string;
};

export type StockLevel = {
  id?: number;
  client_uuid: string;
  product_client_uuid: string;
  product_name: string;
  quantity: number;
  odoo_product_id?: number;
};

export type Customer = {
  id?: number;
  client_uuid: string;
  name: string;
  phone?: string;
  odoo_id?: number;
};

export type InvoiceLine = {
  product_client_uuid: string;
  name: string;
  quantity: number;
  price: number;
};

export type Payment = {
  id?: number;
  client_uuid: string;
  invoice_client_uuid: string;
  date: string;
  amount: number;
  odoo_id?: number;
  odoo_name?: string;
  synced?: boolean;
};

export type Invoice = {
  id?: number;
  client_uuid: string;
  name?: string;
  customer_name?: string;
  customer_client_uuid?: string;
  date: string;
  total: number;
  lines: InvoiceLine[];
  odoo_id?: number;
  /** Mirrors the server, for when the invoice has not reached Odoo yet. */
  paid?: number;
};

export type QueueType =
  | 'product'
  | 'product_update'
  | 'product_delete'
  | 'product_image'
  | 'stock'
  | 'customer'
  | 'invoice'
  | 'payment'
  | 'profile';

export type StockOp = {
  mode: 'set' | 'add';
  value: number;
};

/** Business profile printed on the invoice sheet. Mirrors res.company. */
export type Profile = {
  id?: number;
  company_id?: number;
  company_name: string;
  tagline?: string;
  mobile?: string;
  phone?: string;
  email?: string;
  website?: string;
  street?: string;
  street2?: string;
  city?: string;
  zip?: string;
  vat?: string;
  registry?: string;
  terms?: string;
  note?: string;
  seller_label?: string;
  buyer_label?: string;
  show_logo?: boolean;
  show_signature?: boolean;
  show_terms?: boolean;
  /** data: URL, kept locally because the PWA renders it offline */
  logo?: string;
  updated_at?: string;
};

export type QueueOp = {
  id?: number;
  client_uuid: string;
  type: QueueType;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
  last_error?: string;
};

export type SyncState = {
  online: boolean;
  pending: number;
  failed: number;
  lastSyncAt: string | null;
  lastError: string | null;
  running: boolean;
  dead: { type: string; message: string }[];
  warnings: string[];
};