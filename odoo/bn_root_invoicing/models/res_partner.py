import logging

from odoo import models

from .res_company import address_lines, contact_lines

_logger = logging.getLogger(__name__)


class ResPartner(models.Model):
    _inherit = 'res.partner'

    def bn_invoice_address_lines(self):
        self.ensure_one()
        return address_lines(self)

    def bn_invoice_contact_lines(self):
        self.ensure_one()
        return contact_lines(self)

    def _bn_active_lang_codes(self):
        """Codes that actually resolve in res.lang, read with plain ORM so it
        works on any Odoo version."""
        return set(self.env['res.lang'].search([]).mapped('code'))

    def bn_repair_dangling_lang(self):
        """Clear lang codes that have no active res.lang.

        Environment.lang raises `Invalid language code: <code>` for any code
        missing from res.lang, so one bad row breaks every later request for
        that user. Called on every login so old accounts heal on their own.
        """
        active = self._bn_active_lang_codes()
        broken = self.filtered(lambda p: p.lang and p.lang not in active)
        for partner in broken:
            _logger.warning(
                'bn: clearing unusable language %r on partner %s (id %s)',
                partner.lang, partner.login or partner.name, partner.id,
            )
        if broken:
            broken.sudo().write({'lang': False})
        return len(broken)

    def write(self, vals):
        # Odoo's own UI can only assign an active language, so a value with no
        # res.lang row can only arrive from our own code. Drop it rather than
        # storing a code that will break the next request.
        if vals.get('lang'):
            if vals['lang'] not in self._bn_active_lang_codes():
                _logger.warning('bn: ignoring unknown language %r', vals['lang'])
                vals = {k: v for k, v in vals.items() if k != 'lang'}
        return super().write(vals)