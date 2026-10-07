import json
import logging
import re

from odoo import http
from odoo.exceptions import UserError
from odoo.http import request

_logger = logging.getLogger(__name__)

LOGIN_RE = re.compile(r'^[a-zA-Z0-9._-]{3,60}$')

# Each signup account is a full Odoo administrator of its own company:
# `base.group_system` is what makes res.users.role read "Administrator", it is
# not implied by the accounting group. Anyone who can reach the public signup
# route gets it, so the route has to stay behind bn_root_invoicing.allow_signup.
GROUPS = (
    'base.group_user',
    'base.group_system',
    'account.group_account_manager',
    'stock.group_stock_user',
)

# A signed-up shop is a standalone company, not a branch of base.main_company, so
# nothing is inherited from the root. Pin the two values Odoo would otherwise
# take from the parent, otherwise the new company lands on the instance default.
COUNTRY_XMLID = 'base.bd'
CURRENCY_XMLID = 'base.BDT'

# Models signup touches, and whose computed fields have to be known before any
# flush can recompute them.
SIGNUP_MODELS = ('res.company', 'res.partner', 'res.users')


class BnAuth(http.Controller):

    def _json(self, payload, status=200):
        return request.make_response(
            json.dumps(payload, ensure_ascii=False),
            headers=[('Content-Type', 'application/json')],
            status=status,
        )

    @staticmethod
    def _repair_field_computed(env):
        """Rebuild the registry's computed-field map if it went stale.

        `Registry.field_computed` is a cached_property. When it is built before a
        computed field reaches the model (an incrementally re-setup model gets a
        brand new Field object), the pending field is not a key of that map and
        the next `flush_all()` dies inside `Field.compute_value` with
        `KeyError: 'res.partner.image_1024'`. Creating a company and a user
        flushes several times, so check before, not after: the field only becomes
        pending halfway through `res.users.create()`.
        """
        registry = env.registry
        known = registry.field_computed
        stale = [
            field
            for name in SIGNUP_MODELS
            for field in env[name]._fields.values()
            if field.compute and field not in known
        ]
        if not stale:
            return

        _logger.warning('bn signup: stale field_computed, rebuilding for %s', stale)
        registry.__dict__.pop('field_computed', None)
        # A field that is still absent after the rebuild belongs to no model any
        # more, so it has no compute to run: forget it instead of crashing.
        for field in [f for f in stale if f not in registry.field_computed]:
            env.transaction.tocompute.pop(field, None)

    @http.route('/bn/auth/signup', type='http', auth='public', methods=['POST'], csrf=False)
    def signup(self):
        allowed = (
            request.env['ir.config_parameter']
            .sudo()
            .get_str('bn_root_invoicing.allow_signup', '1')
        )
        if allowed != '1':
            return self._json({'error': 'নতুন অ্যাকাউন্ট খোলা বন্ধ আছে'}, 403)

        try:
            body = json.loads(request.httprequest.get_data() or '{}')
        except ValueError:
            return self._json({'error': 'অনুরোধটি বোঝা গেল না'}, 400)

        company_name = str(body.get('company_name') or '').strip()
        login = str(body.get('login') or '').strip().lower()
        password = str(body.get('password') or '')
        lang = str(body.get('lang') or '').strip()

        if not company_name or len(company_name) > 120:
            return self._json({'error': 'দোকানের নাম লিখুন'}, 400)
        if not LOGIN_RE.match(login):
            return self._json({'error': 'লগইনে ৩-৬০টি অক্ষর, সংখ্যা, . _ - ব্যবহার করুন'}, 400)
        if len(password) < 6:
            return self._json({'error': 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হবে'}, 400)

        env = request.env(su=True)
        Users = env['res.users']
        if Users.search_count([('login', '=', login)]):
            return self._json({'error': 'এই লগইনটি আগে থেকেই আছে'}, 409)

        country = env.ref(COUNTRY_XMLID, raise_if_not_found=False)
        if not country:
            country = env['res.country'].sudo().search([('code', '=', 'BD')], limit=1)
        currency = env.ref(CURRENCY_XMLID, raise_if_not_found=False)
        if not currency:
            currency = env['res.currency'].sudo().search([('name', '=', 'BDT')], limit=1)
        if not country or not currency:
            _logger.error('bn signup: missing Bangladesh country/currency, aborting')
            return self._json({'error': 'সার্ভারে কোম্পানির দেশ/মুদ্রা সেট করা নেই'}, 500)

        company = env['res.company'].create({
            'name': company_name,
            'country_id': country.id,
            'currency_id': currency.id,
        })
        env.flush_all()

        self._repair_field_computed(env)

        groups = {xid: env.ref(xid, raise_if_not_found=False) for xid in GROUPS}
        missing = sorted(xid for xid, group in groups.items() if not group)
        if missing:
            # Silently dropping an xmlid is how a signup ends up with no admin
            # role and nobody notices, so refuse instead.
            _logger.error('bn signup: missing groups %s, aborting', missing)
            request.env.cr.rollback()
            return self._json({'error': 'সার্ভারে গ্রুপ সেট করা নেই'}, 500)

        user_vals = {
            'login': login,
            'password': password,
            'name': str(body.get('name') or company_name).strip()[:120] or company_name,
            'company_id': company.id,
            # standalone company: nothing above it to grant, and no shared journal
            'company_ids': [(6, 0, [company.id])],
            'group_ids': [(6, 0, [group.id for group in groups.values()])],
        }
        user_lang = self._resolve_lang(env, lang)
        if user_lang:
            user_vals['lang'] = user_lang

        try:
            user = Users.create(user_vals)
        except UserError as exc:
            _logger.warning('bn signup user failed: %s', exc)
            request.env.cr.rollback()
            return self._json({'error': 'অ্যাকাউন্ট তৈরি করা যায়নি'}, 400)
        except Exception:  # noqa: BLE001 - the PWA must see json, not a traceback
            _logger.exception('bn signup crashed while creating the user')
            # Nothing is re-raised, so Odoo would commit a half-built company and
            # user unless we drop the transaction ourselves.
            request.env.cr.rollback()
            return self._json({'error': 'অ্যাকাউন্ট তৈরি করা যায়নি'}, 500)

        env.cr.commit()
        _logger.info(
            'bn signup created company %s and user %s (groups: %s, role: %s)',
            company.id, user.id, user.all_group_ids.mapped('full_name'), user.role)

        # Invoices need a chart of accounts, and Odoo skips `generic_coa` during
        # company creation, so without this the first invoice has no journal.
        ready = False
        try:
            ready = bool(env['res.company'].browse(company.id).bn_ensure_accounting_setup(company.id))
        except Exception:  # noqa: BLE001 - the account is still usable without it
            _logger.exception('bn signup could not set up accounting for %s', company.id)
        if not ready:
            _logger.warning('bn signup: company %s has no sale journal yet', company.id)

        return self._json(
            {
                'ok': True,
                'login': login,
                'company_id': company.id,
                'company_name': company.name,
                'lang': user.partner_id.lang or '',
                'accounting_ready': ready,
            }
        )

    @staticmethod
    def _resolve_lang(env, code):
        """Only ever hand back a code Odoo actually has active.

        A user whose lang is not an active res.lang bricks every later request:
        Environment.lang raises `Invalid language code: <code>` as soon as
        anything reads env.lang. Activating on demand keeps the Bengali UI
        without trusting whatever the client sent (Odoo ships bn_IN, not bn_BD).
        """
        code = str(code or '').strip()
        if not code:
            return False

        Lang = env['res.lang']
        known = Lang.with_context(active_test=False).search([('code', '=', code)], limit=1)
        if not known:
            _logger.warning('bn signup ignoring unknown language %r', code)
            return False

        if not known.active:
            try:
                Lang._activate_lang(code)
            except Exception:  # noqa: BLE001 - never block signup on translations
                _logger.warning('bn signup could not activate language %r', code, exc_info=True)
                return False
        return code
