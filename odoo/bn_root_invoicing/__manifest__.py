{
    'name': 'Bangla Root Invoicing',
    'version': '20.0.2.0.1',
    'category': 'Invoicing',
    'summary': 'Simple company-isolated invoicing and stock with shared product catalog',
    # l10n_bd carries the Bangladesh chart of accounts. Without it
    # bn_ensure_accounting_setup() falls back to generic_coa, which loads no
    # journals, so a shop created at signup has nowhere to post an invoice.
    'depends': ['account', 'stock', 'web', 'l10n_bd'],
    'data': ['report/invoice_report.xml'],
    'installable': True,
    'application': True,
    'auto_install': False,
    'license': 'LGPL-3',
}