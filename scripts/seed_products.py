CATALOG = {
    'মুদিখানা': [
        ('চাল সরু ৫ কেজি', 85, 'RICE-SM-5'),
        ('চাল ভাত ৫ কেজি', 70, 'RICE-BR-5'),
        ('আটা ১ কেজি', 45, 'FLR-AT-1'),
        ('ময়দা ১ কেজি', 60, 'FLR-MD-1'),
        ('ডাল মসুর ১ কেজি', 130, 'PLS-MR-1'),
        ('ডাল চিঁড়া ১ কেজি', 95, 'PLS-CH-1'),
        ('ডাল আঠা ১ কেজি', 110, 'PLS-AT-1'),
        ('চিনি ১ কেজি', 140, 'SUG-REF-1'),
        ('লবণ ১ কেজি', 42, 'SLT-SEA-1'),
        ('সরিষার তেল ১ লিটার', 190, 'OIL-MST-1'),
        ('সয়েবীন তেল ১ লিটার', 175, 'OIL-SOY-1'),
        ('ঘি ৫০০ গ্রাম', 620, 'GHY-500'),
        ('ডিম ১ ডজন', 145, 'EGG-DZ-12'),
        ('আলু ১ কেজি', 40, 'VEG-PT-1'),
        ('পেঁয়াজ ১ কেজি', 55, 'VEG-ON-1'),
        ('কাঁচামরিচ ১ কেজি', 60, 'VEG-CH-1'),
        ('কলা ১ কেজি', 70, 'FRT-BN-1'),
        ('আপেল ১ কেজি', 220, 'FRT-AP-1'),
    ],
    'মশলা': [
        ('হলুদ গুঁড়া ১ কেজি', 260, 'SPC-TU-1'),
        ('মরিচ গুঁড়া ১ কেজি', 420, 'SPC-CHI-1'),
        ('ধনে গুঁড়া ২০০ গ্রাম', 90, 'SPC-CN-200'),
        ('ধনিয়া গুঁড়া ২০০ গ্রাম', 110, 'SPC-CO-200'),
        ('গরম মশলা ২০০ গ্রাম', 140, 'SPC-GM-200'),
        ('কালোজিরা ১০০ গ্রাম', 45, 'SPC-CJ-100'),
        ('লাল চিলি ৫০ গ্রাম', 55, 'SPC-CHR-50'),
        ('আদা শুকনো ২০০ গ্রাম', 80, 'SPC-GG-200'),
        ('রসুন শুকনো ২০০ গ্রাম', 70, 'SPC-GR-200'),
        ('চা পাতা প্রিমিয়াম ৫০০ গ্রাম', 340, 'TEA-PR-500'),
        ('চা পাতা সাধারণ ৫০০ গ্রাম', 210, 'TEA-NR-500'),
    ],
    'প্রসাধনী ও পরিচর্যা': [
        ('লাইফবুই সাবান ১০০ গ্রাম', 32, 'SOA-LF-100'),
        ('হ্যান্ড স্যান ২৫০ মিলি', 120, 'SOA-HS-250'),
        ('শ্যাম্পু ৪০০ মিলি', 320, 'SOA-SH-400'),
        ('টুথপেস্ট ১৫০ গ্রাম', 145, 'SOA-TP-150'),
        ('টুথব্রাশ', 55, 'SOA-TB-1'),
        ('মশা স্প্রে', 110, 'SOA-MS-1'),
        ('ডিওডোরেন্ট ৫০ মিলি', 180, 'SOA-DT-50'),
        ('টিস্যু প্যাকেট', 65, 'SOA-TS-1'),
        ('ন্যাপকিন', 90, 'SOA-NP-1'),
        ('স্যানিটারি ন্যাপকিন ডিমগুলি', 110, 'SOA-SN-1'),
    ],
    'স্টেশনারি': [
        ('খাতা ১০০ পাতা', 45, 'STA-NB-100'),
        ('বলপয়েন্ট', 12, 'STA-BP-1'),
        ('পেন্সিল', 10, 'STA-PC-1'),
        ('কলম কাচা', 15, 'STA-PN-1'),
        ('ইরেজার', 18, 'STA-ER-1'),
        ('প্লাস্টিক স্কেল', 25, 'STA-SC-1'),
        ('স্ট্যাপলার', 180, 'STA-ST-1'),
        ('গ্লু স্টিক', 55, 'STA-GL-1'),
    ],
    'ব্যাটারি ও বৈদ্যুতিক': [
        ('ব্যাটারি AA প্যাক', 90, 'BAT-AA-4'),
        ('ব্যাটারি AAA প্যাক', 85, 'BAT-AAA-4'),
        ('LED টর্চ', 220, 'ELE-TORCH'),
    ],
    'প্লাস্টিক ও প্রয়োজনীয়': [
        ('প্লাস্টিক থালা ১০০ পিস', 110, 'PLT-PL-100'),
        ('প্লাস্টিক কাপ ১০০ পিস', 95, 'PLT-CP-100'),
        ('জেলাতিন ব্লেড প্যাকেট', 45, 'PLT-BL-10'),
        ('ম্যাচবক্স', 20, 'PLT-MT-1'),
        ('সেলুন ব্যাগ বড়', 8, 'PLT-BG-1'),
        ('প্লাস্টিক ব্যাগ প্যাক', 20, 'PLT-PB-10'),
    ],
}

CATEGORY = env['product.category']
TEMPLATE = env['product.template']
PRODUCT = env['product.product']
COMPANIES = env['res.company'].search([])

created_templates = 0
created_stock = 0
skipped = 0

for cat_name, items in CATALOG.items():
    categ = CATEGORY.search([('name', '=', cat_name)], limit=1)
    if not categ:
        categ = CATEGORY.create({'name': cat_name})

    for idx, (name, price, sku) in enumerate(items):
        if TEMPLATE.search_count([('default_code', '=', sku)]):
            skipped += 1
            continue

        client_uuid = 'bn-seed-%s' % sku.lower()
        template = TEMPLATE.create({
            'name': name,
            'list_price': price,
            'standard_price': round(price * 0.82, 2),
            'default_code': sku,
            'categ_id': categ.id,
            'type': 'consu',
            'sale_ok': True,
            'purchase_ok': True,
            'is_shared_catalog': True,
            'client_uuid': client_uuid,
        })

        variant = template.product_variant_id
        if not variant:
            variant = env['product.product'].search([('product_tmpl_id', '=', template.id)], limit=1)

        opening = 20 + (idx * 7) % 60
        for company in COMPANIES:
            PRODUCT.bn_apply_stock(
                client_uuid=client_uuid,
                company_id=company.id,
                mode='set',
                value=opening,
            )
            created_stock += 1

        created_templates += 1

env.cr.commit()

print('----------------------------------------------')
print('নতুন পণ্য তৈরি হয়েছে: %d' % created_templates)
print('আগের থেকে ছিল (এড়িয়ে যাওয়া): %d' % skipped)
print('মজুত লাইন তৈরি হয়েছে: %d' % created_stock)
print('কোম্পানি সংখ্যা: %d' % len(COMPANIES))
print('----------------------------------------------')