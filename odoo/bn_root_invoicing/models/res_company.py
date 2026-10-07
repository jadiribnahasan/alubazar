import base64
import logging

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

_logger = logging.getLogger(__name__)

# Odoo has no `mobile`/`company_registry` on res.company, so the invoice sheet
# keeps them in dedicated fields instead of guessing at related ones.
CONTACT_FIELDS = (
    ('mobile', 'মোবাইল'),
    ('phone', 'ফোন'),
    ('email', 'ইমেইল'),
    ('website', 'ওয়েবসাইট'),
)

BOOLEAN_PROFILE_FIELDS = (
    'show_logo',
    'show_signature',
    'show_terms',
)

PROFILE_FIELDS = {
    'company_name': 'name',
    'tagline': 'bn_invoice_tagline',
    'mobile': 'bn_invoice_mobile',
    'phone': 'phone',
    'email': 'email',
    'website': 'website',
    'street': 'street',
    'street2': 'street2',
    'city': 'city',
    'zip': 'zip',
    'vat': 'vat',
    'registry': 'bn_invoice_registry',
    'terms': 'bn_invoice_terms',
    'note': 'bn_invoice_note',
    'seller_label': 'bn_invoice_seller_label',
    'buyer_label': 'bn_invoice_buyer_label',
    'show_logo': 'bn_invoice_show_logo',
    'show_signature': 'bn_invoice_show_signature',
    'show_terms': 'bn_invoice_show_terms',
}

PROFILE_DEFAULTS = {
    'seller_label': 'বিক্রেতার স্বাক্ষর',
    'buyer_label': 'ক্রেতার স্বাক্ষর',
    'show_logo': True,
    'show_signature': True,
    'show_terms': True,
}


def binary_base64(value):
    """base64 of a Binary field, whichever way this Odoo version hands it back."""
    if not value:
        return ''
    if hasattr(value, 'to_base64'):
        return value.to_base64()
    return base64.b64encode(bytes(value)).decode()


def safe_lang(env):
    """A language code that is actually installed, without reading env.lang.

    Environment.lang raises `Invalid language code: <code>` whenever a poisoned
    context reaches it, and writing res.company translates things (field labels,
    constraint messages) so it hits that path where a plain read does not.
    _lang_get only consults cached res.lang rows, so it is safe to call here.
    """
    Lang = env['res.lang']
    for code in ('bn_IN', 'en_US'):
        if Lang._lang_get(code):
            return code
    return 'en_US'


def _text_lines(values):
    return [value for value in values if value]


def address_lines(record):
    """Address split into printable lines, shared by the company and the customer."""
    city = record.city
    state = record.state_id.name
    # "সিলেট, সিলেট" reads badly, so drop the state when it repeats the city.
    if state and state == city:
        state = False
    city_line = ', '.join(_text_lines([city, state]))
    tail = ', '.join(_text_lines([city_line, record.zip]))
    return _text_lines([record.street, record.street2, tail, record.country_id.name])


def contact_lines(record, overrides=None):
    """(label, value) pairs for mobile / phone / email / website."""
    lines = []
    for field_name, label in CONTACT_FIELDS:
        if overrides and field_name in overrides:
            value = overrides[field_name]
        else:
            field = record._fields.get(field_name)
            value = record[field_name] if field else False
        if value:
            lines.append((label, value))
    return lines


class ResCompany(models.Model):
    _inherit = 'res.company'

    bn_invoice_mobile = fields.Char(string='মোবাইল', help='ইনভয়েসে দেখানো মোবাইল নম্বর।')
    bn_invoice_registry = fields.Char(string='রেজিস্ট্রেশন নং', help='ট্রেড লাইসেন্স বা রেজিস্ট্রেশন নম্বর।')
    bn_invoice_tagline = fields.Char(
        string='ইনভয়েস ট্যাগলাইন',
        translate=True,
        help='লোগোর নিচে বা নামের পাশে ছোট করে দেখানো লাইন।',
    )
    bn_invoice_terms = fields.Text(
        string='ইনভয়েস শর্তাবলী',
        help='ইনভয়েসের নিচে ছোট করে দেখানো শর্তাবলি।',
    )
    bn_invoice_note = fields.Text(
        string='ইনভয়েস নোট',
        help='ইনভয়েসের একদম নিচে দেখানো নোট (যেমন: ধন্যবাদ)।',
    )
    bn_invoice_seller_label = fields.Char(
        string='বিক্রেতার লেবেল',
        default=PROFILE_DEFAULTS['seller_label'],
    )
    bn_invoice_buyer_label = fields.Char(
        string='ক্রেতার লেবেল',
        default=PROFILE_DEFAULTS['buyer_label'],
    )
    bn_invoice_show_logo = fields.Boolean(
        string='লোগো দেখান',
        default=PROFILE_DEFAULTS['show_logo'],
    )
    bn_invoice_show_signature = fields.Boolean(
        string='স্বাক্ষর ব্লক দেখান',
        default=PROFILE_DEFAULTS['show_signature'],
    )
    bn_invoice_show_terms = fields.Boolean(
        string='শর্তাবলী দেখান',
        default=PROFILE_DEFAULTS['show_terms'],
    )

    def bn_invoice_address_lines(self):
        self.ensure_one()
        return address_lines(self)

    def bn_invoice_contact_lines(self):
        self.ensure_one()
        return contact_lines(self, overrides={'mobile': self.bn_invoice_mobile})

    @api.model
    def bn_invoice_profile(self):
        """Values the PWA profile form is seeded from."""
        self = self.with_context(lang=safe_lang(self.env))
        company = self.env.user.company_id
        if not company:
            raise UserError('কোম্পানি পাওয়া যায়নি')
        company = company.sudo()

        profile = {
            'company_id': company.id,
            'company_name': company.name,
            'has_logo': bool(company.logo),
            'logo_b64': binary_base64(company.logo),
        }
        for key, field_name in PROFILE_FIELDS.items():
            profile[key] = company[field_name] if field_name in company._fields else False
        return profile

    @api.model
    def bn_apply_invoice_profile(self, vals):
        """Persist the profile edited in the PWA.

        Keys are the ones the PWA stores locally; they are mapped onto res.company
        so the invoice report can read them without extra plumbing. Only submitted
        keys are written, and blank text is left out entirely rather than stored as
        False, so saving a half-filled form never wipes what is already on file.
        """
        self = self.with_context(lang=safe_lang(self.env))
        company = self.env.user.company_id
        if not company:
            raise UserError('কোম্পানি পাওয়া যায়নি')

        payload = vals or {}
        values = {}

        for key, field_name in PROFILE_FIELDS.items():
            if key not in payload or field_name not in company._fields:
                continue
            if key in BOOLEAN_PROFILE_FIELDS:
                values[field_name] = bool(payload[key])
                continue
            value = '' if payload[key] is None else str(payload[key]).strip()
            if value:
                values[field_name] = value

        if not values.get('name'):
            raise UserError('কোম্পানির নাম লিখুন')

        if payload.get('logo'):
            raw = str(payload['logo'])
            values['logo'] = raw.split(',', 1)[1] if raw.startswith('data:') else raw
        elif payload.get('logo') == '':
            # an explicit "লোগো মুছুন" tap
            values['logo'] = False

        company = company.sudo()
        try:
            company.write(values)
        except ValidationError as exc:
            raise UserError('ট্যাক্স আইডি বা ঠিকানা সঠিক নয়: %s' % exc.args[0]) from exc

        return {'company_id': company.id, 'has_logo': bool(company.logo)}

    @api.model
    def bn_ensure_accounting_setup(self, company_id=None):
        """Give the company a chart of accounts so invoices have journals.

        res.company.install_l10n_modules() explicitly skips `generic_coa`, so a
        company created without a country localisation ends up with no accounts
        and no sale/purchase journals, and every invoice then fails to pick one.
        Idempotent: returns True when a sale journal already exists.
        """
        self = self.with_context(lang=safe_lang(self.env))
        if company_id:
            company = self.env['res.company'].browse(int(company_id)).sudo()
        else:
            company = self.env.user.company_id.sudo()
        if not company:
            raise UserError('কোম্পানি পাওয়া যায়নি')

        journals = company.env['account.journal']
        if journals.search_count([('type', '=', 'sale'), ('company_id', '=', company.id)], limit=1):
            return True

        chart = company.env['account.chart.template'].sudo()
        root = company.parent_ids[:1]
        # Mirror account's own rule for branches (res.company.create): they
        # inherit the root company's template. Self-registered shops are
        # standalone, so there is no parent to read and we fall back to the
        # instance root. Without a template we land on generic_coa, which Odoo
        # refuses to auto-load.
        code = (
            company.chart_template
            or (root and root.chart_template)
            or self._default_chart_template_code()
            or chart._guess_chart_template(company.country_id)
            or 'generic_coa'
        )
        try:
            chart.try_loading(code, company, install_demo=False)
        except Exception:  # noqa: BLE001 - report failure, never break the caller
            _logger.exception('bn: could not load chart %r for company %s', code, company.id)
            return False

        ready = bool(journals.search_count(
            [('type', '=', 'sale'), ('company_id', '=', company.id)], limit=1))
        _logger.info('bn: accounting setup for company %s via %r -> %s', company.id, code, ready)
        return ready

    @api.model
    def _default_chart_template_code(self):
        """Chart template already loaded on the instance's root company.

        A company with no parent (self-registered shops, or the root itself)
        has nothing to inherit from, so reuse whatever the root loaded rather
        than guessing per country. False when the root has no template either.
        """
        root = self.sudo().search([('parent_id', '=', False)], order='id', limit=1)
        return root.chart_template or False

    @api.model
    def bn_setup_all_companies(self):
        """Give every company its own sale journal. Administrator only.

        The root company goes first: account's res.company.create copies the
        root's chart_template into each new branch, so once the root has a chart
        every future branch is provisioned with its own accounts and journals
        automatically. Existing branches are loaded the same way.
        """
        if not self.env.is_system():
            raise UserError('শুধু প্রশাসকই এটি করতে পারবেন')
        Companies = self.sudo().with_context(active_test=False)
        root = Companies.search([('parent_id', '=', False)], order='id', limit=1)

        done, failed = [], []
        if root:
            if self.sudo().bn_ensure_accounting_setup(root.id):
                done.append(root.name)
            else:
                failed.append(root.name)

        for company in Companies.search([]):
            if root and company.id == root.id:
                continue
            if self.sudo().bn_ensure_accounting_setup(company.id):
                done.append(company.name)
            else:
                failed.append(company.name)

        _logger.info('bn: accounting setup done for %s, failed for %s', done, failed)
        return {'done': done, 'failed': failed}

    @api.model
    def bn_sale_journal(self):
        """Where to post invoices for the current user's company.

        Branch companies often have no chart of accounts, and a journal cannot be
        borrowed directly because account.move.journal_id is check_company=True.
        So walk up to the parent that owns a sale journal and post there; the
        caller gets both ids and must use them together.
        """
        self = self.with_context(lang=safe_lang(self.env))
        start = self.env.user.company_id
        if not start:
            raise UserError('কোম্পানি পাওয়া যায়নি')

        Journals = self.env['account.journal']
        seen = set()
        company = start.sudo()
        while company and company.id not in seen:
            seen.add(company.id)
            journal = company.env['account.journal'].sudo().search(
                [('type', '=', 'sale'), ('company_id', '=', company.id)], limit=1)
            if journal:
                return {
                    'company_id': company.id,
                    'company_name': company.name,
                    'journal_id': journal.id,
                    'borrowed': company.id != start.id,
                }
            company = company.parent_id.sudo()

        # last resort: any active sale journal, so a fresh database still works
        journal = Journals.sudo().search([('type', '=', 'sale')], limit=1)
        if journal:
            return {
                'company_id': journal.company_id.id or start.id,
                'company_name': journal.company_id.name or start.name,
                'journal_id': journal.id,
                'borrowed': True,
            }
        return {}