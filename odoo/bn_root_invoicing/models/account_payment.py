import logging

from odoo import api, fields, models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)


class AccountPayment(models.Model):
    _inherit = 'account.payment'

    @api.model
    def _bn_cash_journal(self, company):
        """A cash journal for this company, created on first use.

        A shop provisioned straight from signup can have a chart but no cash
        journal, because nothing has needed one yet. Creating it here is what a
        chart template would have done, and it is reused after the first call.
        """
        Journal = self.env['account.journal'].sudo()
        journal = Journal.search([('type', '=', 'cash'), ('company_id', '=', company.id)], limit=1)
        if journal:
            return journal

        account = self.env['account.account'].sudo().search(
            [('account_type', '=', 'asset_cash'), ('company_ids', 'in', company.id)], limit=1
        )
        if not account:
            raise UserError(
                'এই কোম্পানির জন্য ক্যাশ অ্যাকাউন্ট নেই। প্রথমে অ্যাকাউন্টিং সেটআপ চালাতে হবে।'
            )

        journal = Journal.create({
            'name': 'Cash',
            'code': 'CSH1',
            'type': 'cash',
            'company_id': company.id,
            'default_account_id': account.id,
        })
        _logger.info('bn: created cash journal %s for company %s', journal.code, company.id)
        return journal

    @api.model
    def bn_register_cash_payment(self, move_id, amount, payment_date=None, memo=None):
        """Record cash received against a posted customer invoice.

        Cash only, by design: money handed over a shop counter is the common
        case and it needs no bank reconciliation.

        Two things are required that are easy to get wrong, both verified
        against this instance rather than assumed:

        * `invoice_ids` only *links* the invoice — Odoo describes it as
          "contains the invoice even if they don't have a journal entry and are
          not reconciled" — so on its own it settles nothing.
        * a payment credits the journal's Outstanding Receipts account, and
          reconciling that against Accounts Receivable fails with "Entries are
          not from the same account". `destination_account_id` redirects the
          credit onto the invoice's own receivable account, which is what makes
          the two lines reconcilable.

        `move_id` tolerates a single-element list because callKw forwards
        arguments verbatim and a nested id reaches this method as `[id]`.
        """
        Move = self.env['account.move'].sudo()
        move_id = move_id[0] if isinstance(move_id, (list, tuple)) and move_id else move_id
        move = Move.browse(int(move_id or 0)).exists()
        if not move:
            raise UserError('ইনভয়েস পাওয়া যায়নি')
        if move.move_type not in ('out_invoice', 'out_refund'):
            raise UserError('শুধু বিক্রয় ইনভয়েসের বিলদায় করা যায়')
        if move.state != 'posted':
            raise UserError('আগে ইনভয়েসটি পোস্ট করতে হবে')

        receivable = move.line_ids.filtered(
            lambda line: line.account_id.account_type == 'asset_receivable' and not line.reconciled
        )[:1]
        if not receivable:
            raise UserError('এই ইনভয়েসে বাকির অঙ্ক পাওয়া যায়নি')

        amount = float(amount or 0.0)
        if amount <= 0:
            raise UserError('পরিশোধের অঙ্ক শূন্যের বেশি হতে হবে')
        if amount - receivable.amount_residual > 0.005:
            raise UserError('বিলের চেয়ে বেশি পরিশোধ দেওয়া যাবে না (বাকি %.2f)' % receivable.amount_residual)

        payment = self.sudo().create({
            'payment_type': 'inbound',
            'partner_type': 'customer',
            'partner_id': move.partner_id.id,
            'amount': amount,
            'journal_id': self._bn_cash_journal(move.company_id).id,
            'company_id': move.company_id.id,
            'date': payment_date or fields.Date.context_today(self),
            'destination_account_id': receivable.account_id.id,
            'invoice_ids': [(4, move.id)],
            'memo': memo or ('Payment for %s' % (move.name or '')),
        })
        payment.action_post()

        to_reconcile = payment.move_id.line_ids.filtered(
            lambda line: line.account_id == receivable.account_id and not line.reconciled
        )
        if not to_reconcile:
            raise UserError('পরিশোধ তৈরি হয়েছে কিন্তু বিলের সাথে মেলানো যায়নি')
        (to_reconcile + receivable).reconcile()

        move.invalidate_recordset()
        _logger.info(
            'bn: cash payment %s of %.2f reconciled against invoice %s',
            payment.name, amount, move.name,
        )
        return {
            'payment_id': payment.id,
            'name': payment.name,
            'amount_residual': move.amount_residual,
            'amount_total': move.amount_total,
            'payment_state': move.payment_state,
        }

    @api.model
    def bn_invoice_payment_summary(self, move_id):
        """What has been paid on an invoice, for the app's invoice list."""
        move = self.env['account.move'].sudo().browse(int(move_id or 0)).exists()
        if not move:
            return {'paid': 0.0, 'residual': 0.0, 'payment_state': False}
        # account.payment.state is draft/paid/reconciled/canceled/rejected in
        # Odoo 20 — there is no 'posted', which silently matched nothing.
        payments = self.sudo().search([
            ('invoice_ids', 'in', move.id),
            ('state', 'in', ('paid', 'reconciled')),
        ])
        return {
            'paid': sum(payments.mapped('amount')),
            'residual': move.amount_residual,
            'amount_total': move.amount_total,
            'payment_state': move.payment_state,
        }