import Dexie, { type Table } from 'dexie';
import type { Customer, Invoice, Payment, Product, Profile, QueueOp, StockLevel } from './types';

export class BanglaLedgerDB extends Dexie {
  products!: Table<Product, number>;
  stock!: Table<StockLevel, number>;
  invoices!: Table<Invoice, number>;
  customers!: Table<Customer, number>;
  profiles!: Table<Profile, number>;
  queue!: Table<QueueOp, number>;
  payments!: Table<Payment, number>;

  constructor() {
    super('banglaLedger');
    this.version(1).stores({
      products: '++id, &client_uuid, name, odoo_id',
      stock: '++id, &client_uuid, product_client_uuid, product_name, odoo_product_id',
      invoices: '++id, &client_uuid, date, odoo_id',
      queue: '++id, &client_uuid, type, created_at'
    });
    this.version(2).stores({
      products: '++id, &client_uuid, name, odoo_id, odoo_template_id',
      stock: '++id, &client_uuid, product_client_uuid, product_name, odoo_product_id',
      invoices: '++id, &client_uuid, date, odoo_id, name',
      queue: '++id, &client_uuid, type, created_at'
    });
    this.version(3).stores({
      products: '++id, &client_uuid, name, odoo_id, odoo_template_id',
      stock: '++id, &client_uuid, product_client_uuid, product_name, odoo_product_id',
      invoices: '++id, &client_uuid, date, odoo_id, name',
      customers: '++id, &client_uuid, name, odoo_id',
      queue: '++id, &client_uuid, type, created_at, attempts'
    });
    this.version(4).stores({
      products: '++id, &client_uuid, name, odoo_id, odoo_template_id, last_used_at',
      stock: '++id, &client_uuid, product_client_uuid, product_name, odoo_product_id',
      invoices: '++id, &client_uuid, date, odoo_id, name',
      customers: '++id, &client_uuid, name, odoo_id',
      queue: '++id, &client_uuid, type, created_at, attempts'
    });
    this.version(5).stores({
      products: '++id, &client_uuid, name, odoo_id, odoo_template_id, last_used_at',
      stock: '++id, &client_uuid, product_client_uuid, product_name, odoo_product_id',
      invoices: '++id, &client_uuid, date, odoo_id, name',
      customers: '++id, &client_uuid, name, odoo_id',
      profiles: '++id, company_name, company_id',
      queue: '++id, &client_uuid, type, created_at, attempts'
    });
    this.version(6).stores({
      products: '++id, &client_uuid, name, odoo_id, odoo_template_id, last_used_at',
      stock: '++id, &client_uuid, product_client_uuid, product_name, odoo_product_id',
      invoices: '++id, &client_uuid, date, odoo_id, name',
      customers: '++id, &client_uuid, name, odoo_id',
      profiles: '++id, company_name, company_id',
      queue: '++id, &client_uuid, type, created_at, attempts',
      payments: '++id, &client_uuid, invoice_client_uuid, date, odoo_id'
    });
  }
}

export const db = new BanglaLedgerDB();