from odoo import fields, models


class AccountMove(models.Model):
    _inherit = 'account.move'

    client_uuid = fields.Char(string='Client UUID', index=True, copy=False)
    stock_applied = fields.Boolean(string='Stock Applied', copy=False, default=False)

    def _bn_apply_invoice_stock(self, direction):
        # direction -1 consumes stock on post, +1 restores it on draft
        Product = self.env['product.product'].sudo()
        for move in self:
            if move.move_type != 'out_invoice':
                continue
            if direction < 0 and move.stock_applied:
                continue
            if direction > 0 and not move.stock_applied:
                continue
            for line in move.invoice_line_ids:
                if line.product_id and line.quantity:
                    Product.bn_shift_stock(
                        product_id=line.product_id.id,
                        company_id=move.company_id.id,
                        delta=line.quantity * direction,
                    )
            move.sudo().write({'stock_applied': direction < 0})

    def action_post(self):
        res = super().action_post()
        self._bn_apply_invoice_stock(-1)
        return res

    def button_draft(self):
        res = super().button_draft()
        self._bn_apply_invoice_stock(1)
        return res