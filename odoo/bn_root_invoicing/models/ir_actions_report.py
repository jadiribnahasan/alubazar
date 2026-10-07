import base64
import io
import logging

from odoo import models
from odoo.exceptions import UserError

_logger = logging.getLogger(__name__)

ENGINE = 'weasyprint'

# ir.actions.report.report_name of our action: the QWeb template it renders.
# Deliberately not the same string as the action's own xml id — sharing one id
# between the record and the template makes env.ref() resolve to the view, and
# _get_report() then raises "type ir.ui.view, expected ir.actions.report".
TEMPLATE_NAME = 'bn_root_invoicing.report_invoice_wrapper'


def _weasyprint():
    """The engine module, or None when the image was built without it."""
    try:
        import weasyprint  # noqa: PLC0415  optional, its absence is not fatal
    except Exception:  # noqa: BLE001  any import failure means "not installed"
        return None
    return weasyprint


def _pypdf():
    try:
        from pypdf import PdfReader, PdfWriter  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return None, None
    return PdfReader, PdfWriter


def _fetcher_response(url, body, mime_type):
    """Build a response in whichever shape this WeasyPrint expects.

    WeasyPrint >= 66 rejects the dict form outright even though its error
    message still advertises it, so try the class first and fall back for older
    releases that only ever accepted a dict.
    """
    try:
        from weasyprint.urls import URLFetcherResponse  # noqa: PLC0415
    except ImportError:
        return {'string': body, 'mime_type': mime_type, 'redirected_url': url}
    return URLFetcherResponse(url=url, body=body, headers={'Content-Type': mime_type})


def _asset_fetcher(url, *args, **kwargs):
    """Serve inline data: URIs, refuse everything else.

    The report HTML links Odoo's web asset bundles through <base href>, which
    points at the host-published port and is not reachable from inside the
    container. Letting WeasyPrint try costs a connection error per asset on
    every single PDF, and the sheet carries its own CSS anyway.
    """
    if url.startswith('data:'):
        header, _, payload = url.partition(',')
        mime = header[5:].split(';')[0] or 'application/octet-stream'
        body = base64.b64decode(payload) if ';base64' in header else payload.encode()
        return _fetcher_response(url, body, mime)
    _logger.debug('bn: skipped external report asset %s', url)
    return _fetcher_response(url, b'', 'text/plain')


# fetch() reads this off the fetcher when it raises; we never raise, but the
# attribute has to exist for that path to be reachable at all.
_asset_fetcher._fail_on_errors = False


def _merge(chunks):
    PdfReader, PdfWriter = _pypdf()
    if not PdfWriter:
        # One record is the normal case and needs no merging.
        return chunks[0]
    writer = PdfWriter()
    for chunk in chunks:
        for page in PdfReader(io.BytesIO(chunk)).pages:
            writer.add_page(page)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


class IrActionsReport(models.Model):
    _inherit = 'ir.actions.report'

    def get_pdf_engine_state(self, engine_name):
        if engine_name != ENGINE:
            return super().get_pdf_engine_state(engine_name)
        return 'ok' if _weasyprint() else 'install'

    def _get_pdf_engine(self, report=None, default_engine='wkhtmltopdf'):
        # Only our own report moves to WeasyPrint. Everything else keeps
        # wkhtmltopdf, because Odoo's stock layouts lean on Bootstrap flexbox
        # that WeasyPrint does not implement.
        if report is not None and report.report_name == TEMPLATE_NAME:
            return ENGINE
        return super()._get_pdf_engine(report, default_engine)

    # The sheet draws its own coloured header band, so the paperformat's top
    # margin — which exists to leave room for Odoo's letterhead — is pure dead
    # space. Odoo's default carries 52mm, about a sixth of the page, so the top
    # is capped rather than trusted. The bottom is capped too: it only has to
    # hold the @page footer this stylesheet owns. The sides are floored, because
    # a 0mm margin runs the band to the paper edge where no printer can reach.
    MAX_TOP_MARGIN = 8.0
    MAX_BOTTOM_MARGIN = 14.0
    MIN_SIDE_MARGIN = 8.0

    def _bn_page_css(self, report_sudo, landscape=False, specific=None):
        """@page rules, since WeasyPrint takes the paper from CSS not flags."""
        paperformat = report_sudo.get_paperformat() if report_sudo else self.get_paperformat()
        specific = specific or {}
        if paperformat.format and paperformat.format != 'custom':
            size = paperformat.format
        else:
            size = f'{paperformat.page_width}mm {paperformat.page_height}mm'
        if landscape:
            size += ' landscape'
        top = min(float(specific.get('data-report-margin-top', paperformat.margin_top)), self.MAX_TOP_MARGIN)
        bottom = min(
            float(specific.get('data-report-margin-bottom', paperformat.margin_bottom)), self.MAX_BOTTOM_MARGIN
        )
        left = max(float(specific.get('data-report-margin-left', paperformat.margin_left)), self.MIN_SIDE_MARGIN)
        right = max(float(specific.get('data-report-margin-right', paperformat.margin_right)), self.MIN_SIDE_MARGIN)
        margin = ' '.join(f'{v:g}mm' for v in (top, right, bottom, left))
        return f'@page {{ size: {size}; margin: {margin}; }}'

    def _run_pdf_engine(self, engine_name, html, report_ref=False, landscape=False, **kwargs):
        if engine_name != ENGINE:
            return super()._run_pdf_engine(engine_name, html, report_ref, landscape, **kwargs)

        weasyprint = _weasyprint()
        if not weasyprint:
            raise UserError(
                'WeasyPrint is not installed in this container. Rebuild the image with '
                '"docker compose build --no-cache web".'
            )

        report_sudo = self._get_report(report_ref)
        # Same helper the wkhtmltopdf engine uses, so html_ids matches what
        # Odoo expects and each record stays separable.
        bodies, html_ids, _header, _footer, specific = report_sudo.with_context(
            debug=False
        )._prepare_wkhtmltopdf_html(html, report_model=report_sudo.model)

        page_css = weasyprint.CSS(string=self._bn_page_css(report_sudo, landscape, specific))
        chunks = [
            weasyprint.HTML(string=body, url_fetcher=_asset_fetcher).write_pdf(stylesheets=[page_css])
            for body in bodies
        ]
        _logger.info('bn: rendered %s with weasyprint (%s body/bodies)', report_ref, len(chunks))
        return _merge(chunks), html_ids