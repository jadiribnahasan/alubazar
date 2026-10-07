import logging

from odoo import models

_logger = logging.getLogger(__name__)


class ResUsers(models.Model):
    _inherit = 'res.users'

    def _check_credentials(self, credential, env):
        result = super()._check_credentials(credential, env)
        # A usable language has to be true before any RPC works for this user,
        # and it is cheapest to guarantee at the one point every session passes
        # through.
        try:
            self.partner_id.bn_repair_dangling_lang()
        except Exception:  # noqa: BLE001 - never block a login on housekeeping
            _logger.warning('bn: could not check languages on login', exc_info=True)
        return result