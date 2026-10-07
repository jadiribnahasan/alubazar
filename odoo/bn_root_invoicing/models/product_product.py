from odoo import api, fields, models
from odoo.exceptions import UserError


class ProductProduct(models.Model):
    _inherit = 'product.product'

    bn_stock = fields.Float(
        string='মজুত',
        company_dependent=True,
        default=0.0,
        help='প্রতিটি কোম্পানির আলাদা মজুত।',
    )

    @api.model
    def bn_resolve_id(self, client_uuid):
        template = self.env['product.template'].sudo().search(
            [('client_uuid', '=', client_uuid)], limit=1
        )
        if not template:
            return 0
        variant = template.product_variant_id
        if not variant:
            variant = self.sudo().search([('product_tmpl_id', '=', template.id)], limit=1)
        return variant.id if variant else 0

    @api.model
    def bn_apply_stock(self, client_uuid, company_id, mode='set', value=0.0):
        product_id = self.bn_resolve_id(client_uuid)
        if not product_id:
            raise UserError('পণ্য পাওয়া যায়নি (%s)' % (client_uuid or '?'))
        rec = self.sudo().browse(product_id).with_company(int(company_id))
        if mode == 'add':
            rec.bn_stock = rec.bn_stock + float(value or 0.0)
        else:
            rec.bn_stock = float(value or 0.0)
        return rec.bn_stock

    @api.model
    def bn_stock_map(self, company_id):
        templates = self.env['product.template'].sudo().search(
            [('is_shared_catalog', '=', True), ('client_uuid', '!=', False)]
        )
        result = []
        for template in templates:
            variant = template.product_variant_id
            if not variant:
                variant = self.sudo().search([('product_tmpl_id', '=', template.id)], limit=1)
            if not variant:
                continue
            result.append(
                {
                    'client_uuid': template.client_uuid,
                    'product_id': variant.id,
                    'quantity': variant.with_company(int(company_id)).bn_stock or 0.0,
                }
            )
        return result

    @api.model
    def bn_shift_stock(self, product_id, company_id, delta):
        """delta is signed: negative consumes stock, positive restores it."""
        template = self.sudo().browse(int(product_id)).product_tmpl_id
        if not template:
            raise UserError('পণ্য পাওয়া যায়নি')
        return self.bn_apply_stock(
            template.client_uuid, company_id, mode='add', value=float(delta or 0.0)
        )

    @api.model
    def bn_income_account(self, product_id, company_id=None):
        """A usable income account id, or 0.

        Resolved server-side under sudo: when a branch posts into the main
        company's journal, the branch user's record rule hides the main
        company's accounts, so this cannot be read from the browser.
        """
        Product = self.env['product.product'].sudo()
        product = Product.browse(int(product_id or 0))
        if not product.exists():
            return 0

        company = int(company_id or 0) or self.env.company.id
        product = product.with_company(company)
        for account in (product.categ_id.property_account_income_categ_id,
                        product.property_account_income_id):
            if account:
                return account.id

        # account.account lost `deprecated` in Odoo 19; archiving is `active`
        # now. Scoped to the company as well, because in Odoo 20 an account is
        # shared across companies and an account belonging only to another one
        # is rejected by check_company when the invoice is posted.
        accounts = self.env['account.account'].sudo().search(
            [('account_type', '=', 'income'), ('active', '=', True), ('company_ids', 'in', company)],
            limit=1)
        return accounts.id if accounts else 0