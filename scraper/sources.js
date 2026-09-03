// Source configuration — one entry per regulator, each with its tabs.
// This mirrors the REGULATORS config in the frontend HTML. If you add/change
// a source here, also update the matching entry in regulatory_tracker_live.html
// (used there only for labels / "Visit Source" links, not for fetching anymore).

// Shared keyword list for the NEWSLETTER sources below — matches articles about NBFCs and
// India's major banks specifically, out of each outlet's much broader general business feed.
// Extend this list any time a specific bank/NBFC needs to be tracked that isn't covered yet.
const BANK_NBFC_KEYWORDS = [
  'nbfc', 'non-banking financial', 'non banking financial',
  'rbi', 'reserve bank of india', 'monetary policy', 'repo rate',
  'state bank of india', ' sbi ', 'hdfc bank', 'hdfc ltd', 'icici bank',
  'axis bank', 'kotak mahindra bank', 'indusind bank', 'yes bank',
  'idfc first bank', 'idbi bank', 'canara bank', 'punjab national bank',
  'union bank of india', 'bank of baroda', 'bank of india', 'uco bank',
  'central bank of india', 'federal bank', 'south indian bank', 'karur vysya',
  'rbl bank', 'au small finance', 'equitas', 'ujjivan',
  'bajaj finance', 'bajaj finserv', 'muthoot finance', 'muthoot capital',
  'shriram finance', 'l&t finance', 'cholamandalam investment',
  'mahindra finance', 'tata capital', 'poonawalla fincorp',
  'aditya birla finance', 'piramal finance', 'manappuram finance',
  'housing finance', 'gold loan', 'microfinance', 'mfi sector',
  'psu bank', 'public sector bank', 'private sector bank', 'nbfc-mfi',
];

// Broader term set for GLOBAL outlets (Reuters, CNBC, Yahoo Finance, MarketWatch,
// Financial Times) — the India-specific list above will almost never match their
// coverage, since they rarely mention Indian banks/NBFCs by name. These outlets are
// still useful for macro context (global rate moves, regulatory trends, major bank
// earnings) that can indirectly affect Indian NBFC operations, so filtered on broader
// banking/finance-sector terms instead of specific Indian entity names.
const GLOBAL_BANKING_KEYWORDS = [
  'bank', 'banking', 'banks', 'lender', 'lending',
  'central bank', 'federal reserve', 'fed rate', 'interest rate', 'rate hike', 'rate cut',
  'monetary policy', 'financial regulator', 'banking regulator', 'banking crisis',
  'credit rating', 'sovereign debt', 'basel', 'capital requirement',
  'nbfc', 'non-bank lender', 'shadow bank', 'fintech lending',
  'rbi', 'reserve bank of india', 'sebi', 'indian market', 'india rate',
  'emerging market bank', 'global bank', 'bank earnings', 'bank stock',
];

// Differentiates two tabs pulling from the same TaxGuru feed: Law Updates (circulars,
// notifications, amendments, Finance Bill changes) vs Case Laws (actual tribunal/court
// rulings). TaxGuru mixes both in one feed, so we split by keyword rather than needing two
// separate source URLs.
const TAX_LAW_UPDATE_KEYWORDS = [
  'notification', 'circular', 'cbdt', 'cbic', 'amendment', 'finance bill', 'finance act',
  'gst council', 'gst rate', 'income-tax rules', 'income tax rules', 'itr form',
  'due date extended', 'clarification', 'press release', 'budget 202',
];
const TAX_CASE_LAW_KEYWORDS = [
  'itat', 'tribunal', 'high court', 'supreme court', 'hc ', ' sc ', 'judgment', 'judgement',
  'ruling', 'order', 'aar ', 'aaar', 'bench', 'appeal', 'writ petition', 'quash', 'held that',
  'deletes', 'allows', 'dismisses', 'upholds',
];

// Differentiates Indirect Tax case laws (CESTAT/customs/excise/GST tribunal rulings) from
// TaxGuru's mixed feed, the same way TAX_LAW_UPDATE/CASE_LAW keywords do for Direct Tax.
const TAX_INDIRECT_CASE_LAW_KEYWORDS = [
  'cestat', 'customs', 'excise', 'gst tribunal', 'gstat', 'aar ', 'aaar',
  'anti-profiteering', 'naa ', 'high court', 'supreme court', 'writ petition',
  'input tax credit', 'itc ', 'show cause notice', 'appellate', 'tribunal', 'ruling',
];

module.exports = {
  TAXATION: {
    tabs: [
      // ── Direct Tax (Income Tax) ──
      {
        // Confirmed directly from incometaxindia.gov.in's own official RSS subscription
        // page (/tax-feeds) — a real, dedicated department feed, not a guessed URL.
        key: 'TAXATION_0', label: 'Income Tax Circulars', cat: 'Circulars',
        rss: 'https://www.incometaxindia.gov.in/circular-rss-feed/-/asset_publisher/bxhj/rss',
        src: 'https://www.incometaxindia.gov.in/circulars',
        // Confirmed via debug HTML: this page's actual circular list is a Liferay "client
        // extension" widget that loads its content asynchronously — the standard settle
        // wait wasn't enough, resulting in an empty page shell being captured. Longer wait.
        htmlParse: 'generic', headless: true, extraWaitMs: 15000, pierceShadowDOM: true, fetchDescFromDocument: true
      },
      {
        key: 'TAXATION_1', label: 'Income Tax Notifications', cat: 'Notifications',
        rss: 'https://www.incometaxindia.gov.in/notification-rss-feed/-/asset_publisher/bxhj/rss',
        src: 'https://www.incometaxindia.gov.in/notifications',
        htmlParse: 'generic', headless: true, extraWaitMs: 15000, pierceShadowDOM: true, fetchDescFromDocument: true
      },
      {
        // itatonline.org — a well-known, long-running free resource for Indian Income Tax
        // Appellate Tribunal (ITAT) and higher-court case law. RSS URL follows the standard
        // WordPress /feed/ convention but wasn't individually confirmed — the existing
        // preferHtml-style RSS→HTML fallback in scrapeTab handles a wrong guess gracefully.
        // /archives/ turned out to be a taxonomy/browse page (court names, judge names,
        // section tags), not a judgment listing — confirmed against real captured output,
        // which was scraping "Bombay High Court" and "Abhay Ahuja J" as if they were case
        // titles. /archives/category/all-judgements/ is the real listing with actual
        // judgment content, confirmed via live search results.
        // The generic parser was still grabbing the site's persistent sidebar (court/judge/
        // section taxonomy links: /archives/court/..., /archives/judges/..., /archives/
        // section/...) instead of real judgment entries, confirmed against actual captured
        // output ("Bombay High Court", "Abhay Ahuja J..." as if they were case titles).
        // Switched to the dateless link-list parser with those exact patterns excluded.
        key: 'TAXATION_2', label: 'Direct Tax Case Laws', cat: 'Case Law',
        rss: null,
        src: 'https://itatonline.org/archives/category/all-judgements/',
        htmlParse: 'linklist', headless: true,
        linkMustExclude: ['/archives/court/', '/archives/judges/', '/archives/section/', '/archives/category/', '/archives/tag/'],
        // Confirmed against real captured output: this page also has each judgment's bench
        // members, bare dates, and "Read more"/nav links as their own separately-clickable
        // elements (e.g. "Atul Jasani", "April 24, 2021", "Read more ›" were all leaking
        // through as if they were case titles). Real case titles have a distinctive,
        // recognizable shape instead — "X vs. Y (Court Name)" — so requiring that pattern
        // directly is far more precise than trying to exclude every junk category one by one.
        titleMustMatch: /\bvs?\.?\s.+\([^)]*(court|tribunal|itat|aar|aaar)[^)]*\)/i, fetchDescFromDocument: true
      },
      // ── Indirect Tax (GST, Customs, Central Excise) ──
      {
        // cbic-gst.gov.in is CBIC's actual current GST portal domain (confirmed via live
        // content, distinct from the older cbic.gov.in used here previously) — real recent
        // circulars visible directly on this page as of research time.
        key: 'TAXATION_3', label: 'Indirect Tax Circulars', cat: 'Circulars',
        rss: null,
        src: 'https://cbic-gst.gov.in/circulars-cgst.html',
        htmlParse: 'generic', headless: true, fetchDescFromDocument: true
      },
      {
        // No confirmed direct notifications-only URL — CBIC's portal mixes notification
        // announcements into its homepage ticker. Using the homepage itself; the generic
        // parser's date-required passes should still filter to real dated items.
        key: 'TAXATION_4', label: 'Indirect Tax Notifications', cat: 'Notifications',
        rss: null,
        src: 'https://cbic-gst.gov.in/',
        htmlParse: 'generic', headless: true, fetchDescFromDocument: true
      },
      {
        // Same TaxGuru feed as Law Updates/Direct Tax Case Laws, filtered instead to
        // indirect-tax-specific tribunal/court keywords (CESTAT, customs, excise, GST AAR).
        key: 'TAXATION_5', label: 'Indirect Tax Case Laws', cat: 'Case Law',
        rss: 'https://taxguru.in/feed',
        src: 'https://taxguru.in/type/goods-and-service-tax',
        htmlParse: 'generic', keywordFilter: TAX_INDIRECT_CASE_LAW_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      // ── General ──
      {
        // Confirmed real, established RSS feed (98K+ Facebook followers, long-running site)
        // via independent RSS directory listings — taxguru.in covers day-to-day tax law
        // updates, amendments, and commentary across Income Tax, GST, and Company Law.
        key: 'TAXATION_6', label: 'Law Updates', cat: 'Law Update',
        rss: 'https://taxguru.in/feed',
        src: 'https://taxguru.in/type/income-tax',
        htmlParse: 'generic', fetchDescFromDocument: true
      },
    ]
  },
  NEWSLETTER: {
    tabs: [
      {
        // indianexpress.com/feed/ is EVERY article on the site — politics, sports,
        // entertainment, all mixed in — so on any given run almost nothing matches a
        // banking keyword purely by chance. Switched to their actual Business section feed.
        // Also hit an intermittent 403 on plain fetch (confirmed it works fine most runs —
        // 3 real rows were captured previously) — added headless fallback for resilience,
        // same pattern already proven for Business Standard's similar intermittent block.
        key: 'NEWSLETTER_0', label: 'Indian Express', cat: 'News',
        rss: 'https://indianexpress.com/section/business/feed/',
        rssHeadlessFallback: true,
        src: 'https://indianexpress.com/section/business/banking-and-finance/',
        htmlParse: 'generic', keywordFilter: BANK_NBFC_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      {
        key: 'NEWSLETTER_1', label: 'Times Now', cat: 'News',
        rss: null,
        src: 'https://www.timesnownews.com/business-economy',
        htmlParse: 'generic', headless: true, keywordFilter: BANK_NBFC_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      {
        // The .cfm "RSS" URL previously here wasn't real news content — it was silently
        // returning stock ticker/quote pages (economictimes.../hdfc-bank-ltd/stocks/...)
        // with no dates at all. Switched to a confirmed-working article listing page instead.
        key: 'NEWSLETTER_2', label: 'Economic Times', cat: 'News',
        rss: null,
        src: 'https://economictimes.indiatimes.com/news/economy/articlelist/1286551815.cms',
        htmlParse: 'generic', keywordFilter: BANK_NBFC_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      {
        // The RSS feed itself has real dates but 403s a plain HTTP fetch — confirmed it
        // opens fine in a real browser, so try it again via headless before falling back to
        // the HTML card parser (which has no dates on this site's listing page at all).
        key: 'NEWSLETTER_3', label: 'Business Standard', cat: 'News',
        rss: 'https://www.business-standard.com/rss/latest.rss',
        rssHeadlessFallback: true,
        src: 'https://www.business-standard.com/finance',
        htmlParse: 'bs_smallcard', headless: true, keywordFilter: BANK_NBFC_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      // Reuters Business removed — killed its public RSS in 2020, the Google News RSS
      // workaround was unreliable for automated traffic (401), and direct headless scraping
      // of reuters.com hit Akamai bot protection (401) too. Confirmed independently (a plain
      // fetch from an unrelated tool got the same block), so this isn't fixable without paid
      // anti-bot/residential-proxy infrastructure. Re-add if that tradeoff becomes worth it.
      //
      // CNBC Business, MarketWatch Top Stories, and Financial Times removed — all three
      // fetched successfully (no HTTP errors) on every run but consistently returned 0 rows
      // after keyword filtering across many consecutive runs, even after: fixing CNBC's feed
      // ID, switching MarketWatch to a more rate-focused feed, and broadening the global
      // keyword list twice. Unlike Indian Express/Moneycontrol (confirmed working at least
      // some of the time, just intermittently blocked), these three never produced usable
      // content, so removing rather than continuing to guess. Re-add with a fresh look if
      // ever revisited.
      {
        key: 'NEWSLETTER_4', label: 'Yahoo Finance', cat: 'News',
        rss: 'https://finance.yahoo.com/news/rssindex',
        src: 'https://finance.yahoo.com/topic/banking/',
        htmlParse: 'generic', keywordFilter: GLOBAL_BANKING_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      {
        // MCtopnews.xml turned out to be unreliable in practice (debug dump showed it
        // landing on an unrelated article page instead of real feed content). latestnews.xml
        // is confirmed across multiple independent RSS directories as the real, stable feed
        // — but has also hit an intermittent 404. Added headless fallback the same way as
        // Indian Express/Business Standard rather than hunting for yet another URL.
        // The RSS URL now returns HTTP 404 even via the headless-browser retry (not just
        // the plain fetch) — that's a different signal than the earlier intermittent
        // block, since headless replicates a real browser and still failed. Most likely
        // the URL itself has moved or been retired on Moneycontrol's end, not worth
        // continuing to guess at RSS variants. Going straight to headless HTML scraping
        // of the actual banks-news page instead, same proven approach as Business
        // Standard and ETBFSI.
        key: 'NEWSLETTER_5', label: 'Moneycontrol', cat: 'News',
        rss: null,
        src: 'https://www.moneycontrol.com/news/business/banks/',
        htmlParse: 'generic', headless: true, keywordFilter: BANK_NBFC_KEYWORDS, maxAgeDays: 5, fetchDescFromDocument: true
      },
      {
        // ETBFSI is Economic Times' dedicated Banking/Financial Services/Insurance vertical
        // — confirmed real domain via ETBFSI's own social profiles. No keyword filter here:
        // everything on this vertical is already BFSI-relevant by definition, so filtering
        // by bank-name keywords would just discard genuinely relevant coverage that happens
        // not to name a specific bank (e.g. sector-wide fintech/regulatory pieces).
        // Confirmed real, relevant articles genuinely exist here (RBI rate pause, Bajaj
        // Housing Finance coverage) — the generic date-requiring parser was rejecting all
        // of them because publish dates aren't in plain text near the article links on this
        // site. Switched to the dateless link-list parser instead; no keyword filter applies
        // here anyway, so losing date precision costs nothing relevance-wise.
        key: 'NEWSLETTER_6', label: 'ETBFSI', cat: 'News',
        rss: null,
        src: 'https://bfsi.economictimes.indiatimes.com/',
        htmlParse: 'linklist', headless: true, linkMustInclude: '/articles/',
        // The listing page has no dates at all, but each article's own page shows a real
        // "Published On ..." date (confirmed) — fetched via standard SEO metadata instead
        // of screen-scraping that exact phrase, since the visible text format may vary.
        fetchDateFromArticle: true, fetchDescFromDocument: true
      },
    ]
  },
  SEBI: {
    tabs: [
      { key: 'SEBI_0', label: 'Circulars',           cat: 'Circulars',          sebiPaginate: 12, preferHtml: true, rss: 'https://www.sebi.gov.in/sebirss.xml', linkFilter: '/legal/circulars/',        src: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=7&smid=0' , fetchDescFromDocument: true },
      { key: 'SEBI_1', label: 'Master Circulars',    cat: 'Master Circular',    sebiPaginate: 6, preferHtml: true, rss: 'https://www.sebi.gov.in/sebirss.xml', linkFilter: '/legal/master-circulars/', src: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=6&smid=0' , fetchDescFromDocument: true },
      { key: 'SEBI_2', label: 'Informal Guidance',   cat: 'Informal Guidance',  rss: null,  src: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=2&ssid=10&smid=0', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'SEBI_3', label: 'Consultation Papers', cat: 'Consultation Paper', sebiPaginate: 12, preferHtml: true, rss: 'https://www.sebi.gov.in/sebirss.xml', linkFilter: '/reports-and-statistics/', src: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=4&ssid=38&smid=35' , fetchDescFromDocument: true },
      { key: 'SEBI_4', label: "FAQ's",               cat: 'FAQ',                rss: null,  src: 'https://www.sebi.gov.in/sebiweb/other/OtherAction.do', htmlParse: 'linklist' , fetchDescFromDocument: true },
      { key: 'SEBI_5', label: 'Insider Trading',     cat: 'Insider Trading',    rss: null,  src: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=2&ssid=11&smid=0', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'SEBI_6', label: 'Orders of AO',        cat: 'Orders',             sebiPaginate: 12, preferHtml: true, rss: 'https://www.sebi.gov.in/sebirss.xml', linkFilter: '/enforcement/orders/', src: 'https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=2&ssid=9&smid=6' , fetchDescFromDocument: true },
    ], fetchDescFromDocument: true
  },
  RBI: {
    tabs: [
      { key: 'RBI_0', label: 'Notifications',       cat: 'Notifications',       preferHtml: true, htmlParse: 'rbi_dated_docs', rss: 'https://www.rbi.org.in/notifications_rss.xml', src: 'https://www.rbi.org.in/Scripts/NotificationUser.aspx' , fetchDescFromDocument: true },
      { key: 'RBI_1', label: 'Master Directions',   cat: 'Master Directions',   rss: null, src: 'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx', htmlParse: 'rbi_dated_docs' , fetchDescFromDocument: true },
      { key: 'RBI_2', label: 'Master Circulars',    cat: 'Master Circulars',    rss: null, src: 'https://www.rbi.org.in/scripts/BS_ViewMasterCirculardetails.aspx', htmlParse: 'rbi_dated_docs' , fetchDescFromDocument: true },
      { key: 'RBI_3', label: 'Draft Notifications', cat: 'Draft Notifications', rss: null, src: 'https://www.rbi.org.in/Scripts/DraftNotificationsGuildelines.aspx', htmlParse: 'rbi_dated_docs' , fetchDescFromDocument: true },
    ], fetchDescFromDocument: true
  },
  BSE: {
    tabs: [
      { key: 'BSE_0', label: 'Circulars to Listed Co.', cat: 'Circular', rss: null, src: 'https://www.bseindia.com/corporates/CirularToListedComp.html', htmlParse: 'generic', headless: true , fetchDescFromDocument: true },
    ], fetchDescFromDocument: true
  },
  NSE: {
    tabs: [
      { key: 'NSE_0', label: 'Circulars (Equity)', cat: 'Circular', rss: null, src: 'https://www.nseindia.com/companies-listing/circular-for-listed-companies-equity-market', htmlParse: 'nse_next_data' , fetchDescFromDocument: true },
    ], fetchDescFromDocument: true
  },
  IRDAI: {
    tabs: [
      { key: 'IRDAI_0', label: 'Notifications', cat: 'Notifications', rss: null, src: 'https://irdai.gov.in/notifications', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'IRDAI_1', label: 'Circulars',     cat: 'Circulars',     rss: null, src: 'https://irdai.gov.in/circulars', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'IRDAI_2', label: 'Guidelines',    cat: 'Guidelines',    rss: null, src: 'https://irdai.gov.in/guidelines', htmlParse: 'generic' , fetchDescFromDocument: true },
    ], fetchDescFromDocument: true
  },
  IEPFA: {
    tabs: [
      { key: 'IEPFA_0', label: 'Rules',              cat: 'Rules',    rss: null, src: 'https://www.iepf.gov.in/content/iepf/global/master/Home/Notifications/rules.html', htmlParse: 'generic', headless: true , fetchDescFromDocument: true },
      { key: 'IEPFA_1', label: 'Notices & Circulars',cat: 'Circular', rss: null, src: 'https://www.iepf.gov.in/content/iepf/global/master/Home/Notifications/notices-and-circulars.html', htmlParse: 'generic', headless: true , fetchDescFromDocument: true },
      { key: 'IEPFA_2', label: 'Orders 7(3)&7(7)',   cat: 'Orders',   rss: null, src: 'https://www.iepf.gov.in/content/iepf/global/master/Home/Notifications/notices-and-orders-under-rule-7-3----7-7-.html', htmlParse: 'generic', headless: true , fetchDescFromDocument: true },
    ]
  },
  MCA: {
    tabs: [
      { key: 'MCA_0', label: "What's New",           cat: 'Updates', rss: null, src: 'https://www.mca.gov.in/content/mca/global/en/home.html', htmlParse: 'mca_marquee', headless: true, warmupUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' , fetchDescFromDocument: true },
      { key: 'MCA_1', label: 'ROC Adj. Orders',      cat: 'Orders',  rss: null, src: 'https://www.mca.gov.in/content/mca/global/en/data-and-reports/rd-roc-info/roc-adjudication-orders.html', htmlParse: 'generic', headless: true, clickButtonText: 'Filter', warmupUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' , fetchDescFromDocument: true },
      { key: 'MCA_2', label: 'ROC Adj. (Off-sys)',   cat: 'Orders',  rss: null, src: 'https://www.mca.gov.in/content/mca/global/en/data-and-reports/rd-roc-info/roc-adjudication-orders/archive.html', htmlParse: 'generic', headless: true, clickButtonText: 'Filter', warmupUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' , fetchDescFromDocument: true },
      { key: 'MCA_3', label: 'RD Adj. Orders',       cat: 'Orders',  rss: null, src: 'https://www.mca.gov.in/content/mca/global/en/data-and-reports/rd-roc-info/rd-adjudication-orders.html', htmlParse: 'generic', headless: true, clickButtonText: 'Filter', warmupUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' , fetchDescFromDocument: true },
      { key: 'MCA_4', label: 'RD Adj. (Off-sys)',    cat: 'Orders',  rss: null, src: 'https://www.mca.gov.in/content/mca/global/en/data-and-reports/rd-roc-info/rd-adjudication-orders/archive.html', htmlParse: 'generic', headless: true, clickButtonText: 'Filter', warmupUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html' , fetchDescFromDocument: true },
    ], fetchDescFromDocument: true
  },
  NFRA: {
    tabs: [
      { key: 'NFRA_0', label: 'Circulars',           cat: 'Circulars',          rss: null, src: 'https://nfra.gov.in/document-category/circulars/', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'NFRA_1', label: 'Orders',              cat: 'Orders',             rss: null, src: 'https://nfra.gov.in/document-category/orders/', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'NFRA_2', label: 'Consultation Papers', cat: 'Consultation Paper', rss: null, src: 'https://nfra.gov.in/document-category/consultation-papers/', htmlParse: 'generic' , fetchDescFromDocument: true },
      { key: 'NFRA_3', label: 'Inspection Reports',  cat: 'Inspection Report',  rss: null, src: 'https://nfra.gov.in/document-category/inspection-reports/', htmlParse: 'generic' , fetchDescFromDocument: true },
    ]
  },
  PCAOB: {
    tabs: [
      { key: 'PCAOB_0', label: 'Updates & News', cat: 'News',        rss: null, src: 'https://pcaobus.org/all-updates-and-news-releases', htmlParse: 'generic', headless: true , fetchDescFromDocument: true },
      { key: 'PCAOB_1', label: 'Enforcement',    cat: 'Enforcement', rss: null, src: 'https://pcaobus.org/all-enforcement-updates', htmlParse: 'generic', headless: true , fetchDescFromDocument: true },
      { key: 'PCAOB_2', label: 'Inspection Reports', cat: 'Inspection Report', rss: null, src: 'https://pcaobus.org/docs/default-source/generated-reports/inspecton-reports-xml.xml', htmlParse: 'pcaob_xml' , fetchDescFromDocument: true },
    ]
  }
};
