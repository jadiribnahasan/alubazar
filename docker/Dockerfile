FROM debian:bookworm-slim AS fonts

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        fontconfig \
        fonts-noto-core; \
    apt-get install -y --no-install-recommends fonts-lohit-beng-bengali \
      || apt-get install -y --no-install-recommends fonts-lohit-beng; \
    fc-cache -f; \
    fc-list :lang=bn family

FROM odoo:20.0

USER root

COPY --from=fonts /usr/share/fonts /usr/share/fonts
COPY --from=fonts /var/cache/fontconfig /var/cache/fontconfig

# WeasyPrint renders PDF through Pango + HarfBuzz, so it shapes Bengali
# conjuncts (ক্ষ, reph, যুক্তাক্ষর) that wkhtmltopdf's Qt WebKit leaves broken.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libpango-1.0-0 \
        libpangoft2-1.0-0 \
        libharfbuzz0b \
        libcairo2 \
        libgdk-pixbuf-2.0-0 \
        shared-mime-info; \
    pip install --no-cache-dir --break-system-packages weasyprint; \
    python3 -c "import weasyprint; print('weasyprint', weasyprint.__version__)"

USER odoo