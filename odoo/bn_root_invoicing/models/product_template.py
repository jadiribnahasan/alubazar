from odoo import fields, models


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    client_uuid = fields.Char(string='Client UUID', index=True, copy=False)
    is_shared_catalog = fields.Boolean(string='Shared Catalog Product', default=True)

    def write(self, vals):
        if 'is_shared_catalog' in vals and vals['is_shared_catalog'] and 'company_id' in self._fields:
            vals['company_id'] = False
        if 'company_id' in vals and not vals.get('company_id'):
            vals['is_shared_catalog'] = True
        return super().write(vals)

    def create(self, vals_list):
        if isinstance(vals_list, dict):
            vals_list = [vals_list]
        for vals in vals_list:
            vals.setdefault('is_shared_catalog', True)
            if vals.get('is_shared_catalog') and 'company_id' in self._fields:
                vals['company_id'] = False
        return super().create(vals_list)
