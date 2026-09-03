/**
 * Scrapes regulator sources server-side (no browser CORS/proxy involved) and writes
 * a consolidated JSON file that the frontend simply reads. Run manually with:
 *   node scraper.js
 * or on a schedule via the GitHub Actions workflow in .github/workflows/scrape.yml
 */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const { XMLParser } = require('fast-xml-parser');
const REGULATORS = require('./sources');

const OUT_PATH = path.join(__dirname, '..', 'data', 'regulatory_data.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Previously these parsers had hard-coded caps of 40/50/60 rows scattered across every pass,
// independent of how much real content a page actually had — meaning a source with 300 genuine
// dated items on one page was silently truncated to 40-60 regardless. Centralized here as one
// configurable default (overridable per-tab via `tab.maxRows` in sources.js) instead.
const DEFAULT_MAX_ROWS = 300;
// A generic [A-Za-z]{3,9} month-token match will happily glue onto the tail of an unrelated
// adjacent word when cheerio's .text() concatenates separate DOM text nodes without a space
// between them (confirmed against real scraped output: "Notes" + "Jul 27, 2026" extracted as
// one continuous "NotesJul 27, 2026" match, since "NotesJul" itself satisfies {3,9} letters).
// Requiring an actual month name prevents the regex from ever starting its match mid-word.
const MONTH_RE = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DATE_RE = new RegExp(
  `\\d{1,2}(?:st|nd|rd|th)?[\\-\\/\\s]${MONTH_RE}[\\-\\/\\s,]+\\d{4}` +
  `|${MONTH_RE}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}` +
  `|\\d{1,2}[\\-\\/]\\d{1,2}[\\-\\/]\\d{4}` +
  `|\\d{4}-\\d{2}-\\d{2}`,
  'i'
);

function tryParseDate(s) {
  if (!s) return '';
  s = String(s).trim().replace(/(\d{1,2})(st|nd|rd|th)\b/i, '$1');

  // Check numeric DD-MM-YYYY / DD/MM/YYYY / DD.MM.YYYY FIRST. Indian government sites
  // overwhelmingly publish dates in day-first format, but JavaScript's built-in Date
  // parser silently assumes US month-first format for this exact ambiguous shape —
  // confirmed directly: new Date("08-04-2026") returns August 4th, not April 8th, with
  // no error or warning. Checking this pattern explicitly (and building the date from
  // numeric year/month/day rather than re-handing a string to the ambiguous parser)
  // avoids that trap entirely, instead of relying on it failing loudly enough to fall
  // through to a "correct" second attempt — for day ≤ 12 it never fails, it just lies.
  const dmy = s.match(/^(\d{1,2})[\-\/\.](\d{1,2})[\-\/\.](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]), month = Number(dmy[2]), year = Number(dmy[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const d = new Date(year, month - 1, day);
      if (!isNaN(d.getTime())) return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }
  }

  // Everything else — named months ("08 April 2026", "April 8, 2026"), ISO ("2026-04-08") —
  // is unambiguous, so the generic parser is safe to use here.
  let d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1990) {
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return '';
}
function extractYear(s) {
  if (!s) return null;
  const m = String(s).match(/\b(20\d{2}|19\d{2})\b/);
  return m ? Number(m[0]) : null;
}
function resolveLink(href, base) {
  if (!href || href.startsWith('javascript')) return '';
  try { return new URL(href, base).href; } catch { return href || ''; }
}

async function fetchText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': new URL(url).origin + '/',
        'Cache-Control': 'no-cache',
      }
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchWithRetry(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchText(url); }
    catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 + i * 1500)); // 1.5s, 3s, 4.5s backoff
    }
  }
  throw lastErr;
}

/* ── RSS/Atom parsing ── */
function parseRSS(xmlText, cat, linkFilter, maxRows = DEFAULT_MAX_ROWS) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const xml = parser.parse(xmlText);
  let items = xml?.rss?.channel?.item || xml?.feed?.entry || [];
  if (!Array.isArray(items)) items = [items].filter(Boolean);

  return items
    .map(item => {
      const title = (item.title?.['#text'] ?? item.title ?? 'Untitled').toString().trim();
      let link = item.link;
      if (typeof link === 'object') link = link?.['@_href'] || link?.['#text'] || '';
      link = (link || '').toString().trim();
      // Try every date-ish field the feed might use before giving up
      const pubDateRaw = item.pubDate || item.published || item.updated || item.date
        || item['dc:date'] || item.pubdate || '';
      const desc = (item.description ?? item.summary ?? '').toString().replace(/<[^>]*>/g, '').trim();
      return { title, link, pubDateRaw, desc };
    })
    .filter(it => !linkFilter || it.link.includes(linkFilter))
    .slice(0, maxRows)
    .map((it, i) => {
      let d = it.pubDateRaw ? new Date(it.pubDateRaw) : null;
      let isValid = d && !isNaN(d.getTime());
      // Fallback: many gov sites put month-year in the URL slug itself, e.g.
      // .../legal/circulars/jul-2026/some-title_12345.html — extract that if the
      // feed's own date field is missing or unparseable. Gives month+year precision
      // even without an exact day.
      if (!isValid) {
        const slugMatch = it.link.match(/\/([a-z]{3,4})-(\d{4})\//i);
        if (slugMatch) {
          const monthGuess = new Date(`01 ${slugMatch[1]} ${slugMatch[2]}`);
          if (!isNaN(monthGuess.getTime())) { d = monthGuess; isValid = true; }
        }
      }
      return {
        sr: i + 1,
        date: isValid ? d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
        year: isValid ? d.getFullYear() : null,
        cat, title: it.title, desc: it.desc.substring(0, 200), link: it.link
      };
    });
}

/* ── Generic table/list HTML parser (works across most gov/exchange sites) ──
   Key fixes vs the naive version:
   1. Strip nav/header/footer/menu chrome FIRST — this is what was causing menu items
      ("About Us", "Option Chain", "Holidays") to be scraped as if they were documents.
   2. Score ALL tables and pick the best one (most rows with valid dates), instead of
      just taking whichever table appears first in the HTML — the first table on a page
      is often a small unrelated widget, not the actual data table.
*/
const NAV_WORDS = new Set([
  'home', 'login', 'logout', 'sitemap', 'contact', 'contact us', 'about', 'about us',
  'search', 'back', 'top', 'next', 'prev', 'previous', 'skip', 'menu', 'download',
  'subscribe', 'register', 'careers', 'tenders', 'rti', 'faqs', "faq's", 'faq',
  'press releases', 'annual report', 'organisation & functions', 'organisation and functions',
  'notifications', 'circulars', 'guidelines', 'master directions', 'master circulars',
  'draft notifications', 'publications', 'statistics', 'what\'s new', 'whats new',
  'terms of use', 'privacy policy', 'disclaimer', 'feedback', 'sitemap', 'help',
  'option chain', 'market turnover', 'listings', 'daily report', 'holidays',
  'selected', 'skip to main content', 'accessibility', 'screen reader',
  'organisation structure', 'departments', 'offices', 'training establishment',
  'governors', 'deputy governors', 'executive directors',
  'all months', 'back to previous page', 'previous page', 'go back'
]);

// Social-share and pagination chrome is extremely common CMS boilerplate across many
// government sites, and worth excluding explicitly regardless of date proximity — it
// often sits directly next to a genuine date by design (post metadata blocks).
const SHARE_OR_PAGING_RE = /^(share (on|of) |tweet|pin it|next\b|previous\b|«|»|prev\b)/i;

// Real headlines are never raw URLs — some pages have "quick link" widgets whose visible
// text literally is their own href (e.g. <a href="...">http://mca.gov.in/XBRL/</a>), which
// otherwise passes every other content-quality check. Reject these explicitly.
const IS_URL_RE = /^(https?:\/\/|www\.)/i;

function stripChrome($) {
  $('nav, header, footer, .nav, .navbar, .menu, .breadcrumb, .breadcrumbs, #menu, #nav, #header, #footer, .sidebar, .footer, .header').remove();
  return $;
}

const GENERIC_LINK_WORDS = new Set(['view', 'download', 'view/download', 'click here', 'open', 'pdf', 'details', 'more', 'read more', 'view pdf', 'download pdf']);

// Boilerplate download-link filler text (e.g. NFRA's "Accessible Version : View(2 MB)") that
// must never be picked as a title, regardless of length — confirmed against real data where
// this text was LONGER than several genuine (short) titles, defeating the length heuristic.
const DOWNLOAD_BOILERPLATE_RE = /accessible version|^view\s*\(|\(\s*[\d,.]+\s*(kb|mb)\s*\)\s*$/i;

function pickTitleFromCells(cellTexts) {
  // Prefer the longest cell that isn't a date and isn't a generic link label like "View" —
  // government sites often put the real title in a plain-text column and reserve the anchor
  // for a throwaway "View"/"Download" link in a different column.
  let best = '';
  for (const t of cellTexts) {
    if (t.length < 8) continue;
    if (DATE_RE.test(t) && t.length < 20) continue; // skip pure-date cells
    if (GENERIC_LINK_WORDS.has(t.toLowerCase())) continue;
    if (DOWNLOAD_BOILERPLATE_RE.test(t)) continue;
    if (t.length > best.length) best = t;
  }
  return best;
}

function scoreTable($, tbl, base, cat) {
  const trs = $(tbl).find('tr');
  if (trs.length < 2) return null;
  const candidateRows = [];
  trs.each((i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 2) return;
    const cellTexts = tds.toArray().map(td => $(td).text().trim());
    const title = pickTitleFromCells(cellTexts);
    if (!title || NAV_WORDS.has(title.toLowerCase()) || IS_URL_RE.test(title)) return;
    // Link: prefer an anchor within the cell that actually contains the title text;
    // fall back to the first anchor in the row otherwise.
    let link = '';
    tds.each((_, td) => {
      if (link) return;
      if ($(td).text().trim() === title) {
        const a = $(td).find('a[href]').first();
        if (a.length) link = a.attr('href') || '';
      }
    });
    if (!link) link = $(tr).find('a[href]').first().attr('href') || '';
    link = resolveLink(link, base);
    const dateText = cellTexts.find(t => DATE_RE.test(t) && t !== title) || '';
    const d = tryParseDate(dateText);
    candidateRows.push({ sr: 0, date: d || dateText || '—', year: extractYear(d || dateText), cat, title, desc: '', link });
  });
  if (candidateRows.length < 2) return null;
  const withDate = candidateRows.filter(r => r.date !== '—').length;
  // Score favors: more rows overall, and a higher proportion having real dates
  const score = candidateRows.length + withDate * 2;
  return { rows: candidateRows, score };
}

function parseGenericHTML(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = stripChrome(cheerio.load(html));
  const rows = [];

  // Pass 1: score every table on the page, keep the best-scoring one
  let best = null;
  $('table').each((_, tbl) => {
    const result = scoreTable($, tbl, base, cat);
    if (result && (!best || result.score > best.score)) best = result;
  });
  if (best) {
    return best.rows.slice(0, maxRows).map((r, i) => ({ ...r, sr: i + 1 }));
  }

  // Pass 1.5: "card grid" layout — common on modern news/press-release pages (e.g. PCAOB).
  // Each item is a container (article/div/li) with a short standalone date badge, a
  // headline that is NOT itself a link, and a separate generic "Read more" link elsewhere
  // in the same container. Earlier passes only look for text INSIDE an anchor, which can
  // never find these headlines — this pass looks for date badges first, then pulls the
  // headline and link from the same small container independently.
  const DATE_ONLY_RE = /^[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}$/i;
  const dateBadges = [];
  $('*').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0) return; // only leaf-ish elements as date-badge candidates
    const ownText = $el.text().trim();
    if (ownText.length > 0 && ownText.length < 25 && DATE_ONLY_RE.test(ownText)) {
      dateBadges.push({ el, text: ownText });
    }
  });
  if (dateBadges.length >= 2) {
    const seenLinks = new Set();
    for (const { el, text: dateText } of dateBadges) {
      if (rows.length >= maxRows) break;
      // Walk up a few levels to find a container that plausibly wraps just this one card:
      // small enough to be a single item, but big enough to contain a headline + link too.
      let container = $(el);
      let card = null;
      for (let depth = 0; depth < 5; depth++) {
        container = container.parent();
        if (!container.length) break;
        const txt = container.text().trim();
        if (txt.length >= dateText.length + 15 && txt.length < 600) { card = container; break; }
      }
      if (!card) continue;

      // The whole card is often wrapped in a single ancestor <a> (PCAOB does this — date,
      // title, and "Read more" all sit inside one enclosing link, with the actual card
      // content in a sibling div that has no anchor of its own). Check for that first.
      let link = '';
      const wrappingAnchor = card.closest('a[href]');
      if (wrappingAnchor.length) {
        link = wrappingAnchor.attr('href') || '';
      } else {
        const links = card.find('a[href]');
        if (!links.length) continue;
        links.each((_, a) => {
          if (link) return;
          const href = $(a).attr('href') || '';
          const linkText = $(a).text().trim();
          if (!href || SHARE_OR_PAGING_RE.test(linkText)) return;
          link = href;
        });
        if (!link) link = links.first().attr('href') || '';
      }
      if (!link) continue;
      const resolvedLink = resolveLink(link, base);
      if (seenLinks.has(resolvedLink)) continue;

      // Headline = longest text block in the card that isn't the date and isn't a
      // generic link label ("read more", "about the pcaob", etc.)
      let title = '';
      card.find('*').addBack().each((_, node) => {
        const $node = $(node);
        if ($node.children().length > 0) return;
        const t = $node.text().trim().replace(/\s+/g, ' ');
        if (t === dateText || t.length < 20) return;
        if (NAV_WORDS.has(t.toLowerCase()) || SHARE_OR_PAGING_RE.test(t) || IS_URL_RE.test(t)) return;
        if (/^(about the|read more|learn more)/i.test(t)) return;
        if (t.length > title.length) title = t;
      });
      if (!title) continue;

      seenLinks.add(resolvedLink);
      const d = tryParseDate(dateText);
      rows.push({ sr: rows.length + 1, date: d || dateText, year: extractYear(d || dateText), cat, title, desc: '', link: resolvedLink });
    }
  }
  if (rows.length >= 2) return rows;
  rows.length = 0; // fewer than 2 found — not confident this was really a card grid, reset

  // Pass 2: list items with anchors — require a real nearby date, same reasoning as Pass 3
  // below. Without this, share-widget links ("Share on Facebook") and sidebar nav items
  // (which are also <li><a>...) get scraped as if they were real documents.
  $('ul li, ol li').each((_, li) => {
    if (rows.length >= maxRows) return;
    const a = $(li).find('a[href]').first();
    if (!a.length) return;
    const t = a.text().trim().replace(/\s+/g, ' ');
    if (t.length < 10 || NAV_WORDS.has(t.toLowerCase()) || SHARE_OR_PAGING_RE.test(t) || IS_URL_RE.test(t)) return;
    const dateMatch = $(li).text().match(DATE_RE);
    if (!dateMatch) return; // no date nearby — skip rather than guess
    const d = tryParseDate(dateMatch[0]);
    rows.push({ sr: rows.length + 1, date: d || dateMatch[0], year: extractYear(d || dateMatch[0]), cat, title: t, desc: '', link: resolveLink(a.attr('href') || '', base) });
  });
  if (rows.length) return rows;

  // Pass 3: last resort — meaningful anchors, but ONLY keep ones with a real nearby date.
  // Date lookup is purely position-based (search text immediately after, then before, the
  // anchor's own position in the page) rather than via closest('div') — an earlier version
  // used closest() with a text-length cutoff to avoid matching giant wrapper divs, but that
  // heuristic breaks down on pages with only a few items, where even a "whole section"
  // wrapper is short enough to look like a single item. Position-based search doesn't have
  // this failure mode since it always respects the actual order of content on the page.
  const seen = new Set();
  const fullText = $('body').text();
  $('a[href]').each((_, a) => {
    if (rows.length >= maxRows) return;
    const t = $(a).text().trim().replace(/\s+/g, ' ');
    if (t.length < 10 || t.length > 300 || seen.has(t) || NAV_WORDS.has(t.toLowerCase()) || IS_URL_RE.test(t)) return;
    if (SHARE_OR_PAGING_RE.test(t)) return;
    seen.add(t);

    let dateText = '';
    const pos = fullText.indexOf(t);
    if (pos !== -1) {
      // Prefer a date immediately AFTER the title (typical of article/card layouts where
      // metadata follows the heading) before falling back to searching BEFORE it (typical
      // of table rows where a date column precedes the title column).
      const afterTxt = fullText.substring(pos + t.length, pos + t.length + 100);
      const beforeTxt = fullText.substring(Math.max(0, pos - 100), pos);
      dateText = afterTxt.match(DATE_RE)?.[0] || beforeTxt.match(DATE_RE)?.[0] || '';
    }
    if (!dateText) return; // no date nearby — most likely nav/chrome, skip it
    const d = tryParseDate(dateText);
    rows.push({ sr: rows.length + 1, date: d || dateText, year: extractYear(d || dateText), cat, title: t, desc: '', link: resolveLink($(a).attr('href') || '', base) });
  });
  return rows;
}

/* ── Card-feed parser (e.g. PCAOB: repeating "date / heading / Read more" blocks,
   not a table and not a <ul> list — common in modern CMS-driven news feeds) ── */
function parseCardFeed(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = stripChrome(cheerio.load(html));
  const rows = [];
  $('h2, h3, h4').each((_, h) => {
    if (rows.length >= maxRows) return;
    const title = $(h).text().trim();
    if (title.length < 15 || NAV_WORDS.has(title.toLowerCase())) return;

    // Date usually appears as a text sibling shortly before the heading
    let dateText = '';
    let prev = $(h).prev();
    for (let hops = 0; prev.length && hops < 3 && !dateText; hops++) {
      const m = prev.text().trim().match(DATE_RE);
      if (m) dateText = m[0];
      prev = prev.prev();
    }
    if (!dateText) {
      const m = $(h).parent().text().match(DATE_RE);
      if (m) dateText = m[0];
    }
    if (!dateText) return; // no date found nearby — likely not a real feed item

    // Link usually appears as a "Read more"-style anchor shortly after the heading
    let link = '';
    let next = $(h).next();
    for (let hops = 0; next.length && hops < 3 && !link; hops++) {
      const a = next.is('a[href]') ? next : next.find('a[href]').first();
      if (a.length) link = a.attr('href') || '';
      next = next.next();
    }
    if (!link) {
      const a = $(h).parent().find('a[href]').first();
      if (a.length) link = a.attr('href') || '';
    }

    const d = tryParseDate(dateText);
    rows.push({ sr: rows.length + 1, date: d || dateText, year: extractYear(d || dateText), cat, title, desc: '', link: resolveLink(link, base) });
  });
  return rows;
}

/* ── Link-list parser (SEBI FAQ style — no dates by nature) ── */
function parseLinkList(html, base, cat, maxRows = DEFAULT_MAX_ROWS, linkMustInclude = null, linkMustExclude = null, titleMustMatch = null) {
  const $ = stripChrome(cheerio.load(html));
  const rows = [];
  const seen = new Set();
  $('a[href]').each((_, a) => {
    if (rows.length >= maxRows) return;
    const t = $(a).text().trim();
    if (t.length < 10 || seen.has(t) || NAV_WORDS.has(t.toLowerCase()) || IS_URL_RE.test(t)) return;
    const href = $(a).attr('href') || '';
    if (linkMustInclude && !href.includes(linkMustInclude)) return;
    if (linkMustExclude && linkMustExclude.some(pat => href.includes(pat))) return;
    if (titleMustMatch && !titleMustMatch.test(t)) return;
    seen.add(t);
    rows.push({ sr: rows.length + 1, date: '—', year: null, cat, title: t, desc: '', link: resolveLink(href, base) });
  });
  return rows;
}

/* ── RBI-style category navigation tree (Master Directions / Master Circulars) ──
   These pages have NO actual dated document list — the real content area is empty,
   and the "list" is a subject-category sidebar (e.g. #lblNavData: "Commercial Banks",
   "Foreign Exchange Management", ...) where each link leads to a further page with the
   real dated documents. Confirmed against the real page HTML — this isn't a parsing
   failure to fix, it's genuinely dateless category index content, same situation as
   SEBI's FAQ page. Scoped to #lblNavData specifically so it doesn't also pick up the
   unrelated year-archive sidebar or other page furniture. */
/* ── MCA homepage marquee/news-ticker parser ──
   MCA's "What's New" content isn't a list at all — it's one giant scrolling text blob
   (.marquee-container) with announcements separated by "||", most with no individual
   link, occasional inline links, and dates written as ordinals ("7th July 2026"). No
   generic table/list/card pass can handle this shape — confirmed against the real page,
   this needed a bespoke parser. */
/* ── NFRA-style ".bt-content" list layout ──
   NFRA's Inspection Reports page renders what looks like a table but is actually
   div/span-based (title in <span class="bt-content">), so scoreTable() — built for real
   <table><tr><td> markup — never finds it, and the row falls through to a weaker fallback
   pass that grabs the wrong text. Confirmed against the real page: walk up from each
   .bt-content title span to find the nearest date and link in the same row. */
function parseBtContentRows(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('.bt-content').each((_, el) => {
    if (rows.length >= maxRows) return;
    const title = $(el).text().trim().replace(/\s+/g, ' ');
    if (title.length < 8 || seen.has(title) || NAV_WORDS.has(title.toLowerCase()) || IS_URL_RE.test(title)) return;

    // Walk up a bounded number of ancestors looking for the row container that also
    // holds this row's date and link — capped so we don't grab a huge unrelated scope.
    let $row = $(el);
    let dateText = '', link = '';
    for (let hops = 0; hops < 6; hops++) {
      $row = $row.parent();
      if (!$row.length) break;
      const rowText = $row.text();
      const m = rowText.match(DATE_RE);
      if (m) dateText = m[0];
      const anchors = $row.find('a[href]');
      let a = anchors.filter((_, a) => !GENERIC_LINK_WORDS.has($(a).text().trim().toLowerCase())).first();
      if (!a.length) a = anchors.first();
      if (a.length) link = resolveLink(a.attr('href') || '', base);
      if (dateText && link) break;
    }

    seen.add(title);
    const d = tryParseDate(dateText);
    rows.push({ sr: rows.length + 1, date: d || dateText, year: extractYear(d || dateText), cat, title, desc: '', link: link || base });
  });
  return rows;
}

function parseMCAMarquee(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = cheerio.load(html);
  const container = $('.marquee-container').first();
  if (!container.length) return [];

  const innerHtml = container.html() || '';
  // Split on the "||" separators (rendered with &nbsp; padding around them in the source)
  const segments = innerHtml.split(/(?:&nbsp;|\u00a0|\s)*\|\|(?:&nbsp;|\u00a0|\s)*/i);

  const rows = [];
  for (const seg of segments) {
    if (rows.length >= maxRows) break;
    const $seg = cheerio.load(seg);
    const text = $seg.root().text().trim().replace(/\s+/g, ' ');
    if (text.length < 15) continue;

    const dateMatch = text.match(DATE_RE);
    if (!dateMatch) continue; // ticker items without a date are usually evergreen notices, not "updates"

    const d = tryParseDate(dateMatch[0]);
    const link = $seg('a[href]').first();
    const href = link.length ? resolveLink(link.attr('href') || '', base) : base;

    rows.push({
      sr: rows.length + 1,
      date: d || dateMatch[0],
      year: extractYear(d || dateMatch[0]),
      cat, title: text.substring(0, 300), desc: '', link: href
    });
  }
  return rows;
}

/* ── PCAOB structured XML inspection-reports feed ──
   PCAOB publishes an official XML data feed (Company/InspectionReportDate/PdfInspectionReport
   per report) that's more reliable than scraping the rendered search-tool page — confirmed
   against the real feed content, already sorted newest-first. */
function parsePcaobXmlReports(xml, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const rows = [];
  $('InspectionReport').each((_, el) => {
    if (rows.length >= maxRows) return;
    const company = $(el).find('Company').first().text().trim();
    const country = $(el).find('Country').first().text().trim();
    const dateText = $(el).find('InspectionReportDate').first().text().trim();
    const pdf = $(el).find('PdfInspectionReport').first().text().trim();
    if (!company || !pdf) return;
    const d = tryParseDate(dateText);
    const title = country && country !== 'United States' ? `${company} (${country})` : company;
    rows.push({ sr: rows.length + 1, date: d || dateText, year: extractYear(d || dateText), cat, title, desc: '', link: pdf });
  });
  return rows;
}

/* ── RBI dated-document listing (Master Directions / Master Circulars / Draft Notifications) ──
   These pages group real documents under repeating "Category" then "Date" header rows rather
   than putting a date on each row — confirmed against the real live pages (previous "no dates
   available" conclusion was wrong; it was diagnosed from a bad URL, not a genuine JS-rendering
   requirement). This walks the DOM in document order, tracking the most recently seen date
   header, and attaches it to every real document link that follows. Each document appears
   twice in the source (a "view page" link and a "PDF - <title>" direct-download link) — we
   dedupe by normalized title and keep the first (view-page) link, which is a stable target. */
function parseRBIDatedDocs(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const rows = [];
  const seen = new Set();

  // Strip shared header/nav/footer chrome first — otherwise RBI's standard site navigation
  // ("Skip to main content", "About Us", "Departments", ...), which appears before the real
  // content in the raw markup, fills up the row cap before any real document is reached.
  const $ = stripChrome(cheerio.load(html));
  const cleanedHtml = $.html();

  // Find every "bare date" position: a date that is the ENTIRE trimmed content between two
  // tag boundaries (>Jul 03, 2018<). This holds true as a section-header pattern regardless
  // of which specific tag RBI wraps it in (div/td/span/b/strong/etc.) — working on the raw
  // markup text avoids needing to guess the exact DOM shape.
  const dateHeaderRe = />\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})\s*</g;
  const dateEvents = [];
  let dm;
  while ((dm = dateHeaderRe.exec(cleanedHtml))) dateEvents.push({ index: dm.index, date: dm[1].trim() });

  // Find every document anchor with its position and inner text (tags stripped).
  const anchorRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const anchorEvents = [];
  let am;
  while ((am = anchorRe.exec(cleanedHtml))) {
    const innerText = am[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, '\u2019').replace(/\s+/g, ' ').trim();
    anchorEvents.push({ index: am.index, href: am[1], text: innerText });
  }

  let dateIdx = 0;
  let currentDate = '';
  for (const a of anchorEvents) {
    if (rows.length >= maxRows) break;
    // Advance to the most recent date header that occurs before this anchor's position
    while (dateIdx < dateEvents.length && dateEvents[dateIdx].index < a.index) {
      currentDate = dateEvents[dateIdx].date;
      dateIdx++;
    }
    // Anything before the FIRST date header on the page is always leftover sub-navigation
    // (confirmed against real output: "Master Circulars", "Draft Directions (RE-wise)",
    // "Index to RBI Circulars" were leaking through here with blank dates) — real content
    // never appears before the first dated section on these RBI listing pages.
    if (!currentDate) continue;
    const normalized = a.text.replace(/^pdf\s*-\s*/i, '').trim();
    if (
      normalized.length >= 10 && normalized.length < 300 &&
      !seen.has(normalized) && !IS_URL_RE.test(normalized) &&
      !GENERIC_LINK_WORDS.has(normalized.toLowerCase()) && !NAV_WORDS.has(normalized.toLowerCase())
    ) {
      seen.add(normalized);
      const d = tryParseDate(currentDate);
      rows.push({
        sr: rows.length + 1, date: d || currentDate, year: extractYear(d || currentDate),
        cat, title: normalized, desc: '', link: resolveLink(a.href, base)
      });
    }
  }
  return rows;
}

function parseRBINavTree(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = cheerio.load(html);
  const scope = $('#lblNavData');
  const root = scope.length ? scope : stripChrome($('body'));
  const rows = [];
  const seen = new Set();
  root.find('a[href]').each((_, a) => {
    if (rows.length >= maxRows) return;
    const t = $(a).text().trim().replace(/\s+/g, ' ');
    if (t.length < 4 || seen.has(t) || NAV_WORDS.has(t.toLowerCase()) || IS_URL_RE.test(t)) return;
    seen.add(t);
    rows.push({ sr: rows.length + 1, date: '—', year: null, cat, title: t, desc: '', link: resolveLink($(a).attr('href') || '', base) });
  });
  return rows;
}

/* ── NSE __NEXT_DATA__ parser ── */
function parseNSENextData(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = cheerio.load(html);
  const script = $('#__NEXT_DATA__').html();
  if (script) {
    try {
      const json = JSON.parse(script);
      const props = json?.props?.pageProps;
      const list = props?.circularList || props?.data || props?.circulars || [];
      if (Array.isArray(list) && list.length) {
        return list.slice(0, maxRows).map((item, i) => {
          const title = item.subject || item.title || item.circularTitle || item.name || 'NSE Circular';
          const dateStr = item.date || item.circularDate || item.createdDate || '';
          const d = dateStr ? tryParseDate(dateStr) : '';
          const href = item.fileUrl || item.url || item.pdfUrl || item.link || '';
          return { sr: i + 1, date: d || dateStr || '—', year: extractYear(d || dateStr), cat, title, desc: '', link: href ? resolveLink(href, base) : '' };
        });
      }
    } catch (e) { /* fall through to generic */ }
  }
  return parseGenericHTML(html, base, cat, maxRows);
}

const DEBUG_DIR = path.join(__dirname, '..', 'data', 'debug');
function dumpDebugHtml(key, html) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filePath = path.join(DEBUG_DIR, `${key}.html`);
    // Cap size so the repo doesn't bloat unreasonably — but large enough that heavy
    // shared-template sites (MCA's mega-menu alone can approach 150KB) don't get cut off
    // before we reach the actual page-specific content beneath the shared header/nav.
    fs.writeFileSync(filePath, html.slice(0, 500000));
    console.log(`  [debug] wrote ${filePath} (${html.length} bytes total, saved first ${Math.min(html.length,150000)})`);
  } catch (e) {
    console.log(`  [debug] FAILED to write debug HTML for ${key}: ${e.message}`);
  }
}

/* ── SEBI multi-page listing fetch ──
   SEBI's category listing pages (Circulars, Master Circulars, Consultation Papers, Orders)
   show 25 records per page, with further pages loaded via a JS function call rather than a
   plain URL — confirmed against the real page: the "2"/"3"/... pagination links call
   searchFormNewsList('n', String(pageNumber - 1)) directly (e.g. page 2 → arg '1', page 3 →
   arg '2'), which we can invoke ourselves via page.evaluate() instead of needing to locate
   and click the actual link element. Each call re-renders just the results table via AJAX,
   which we scrape same as the first page. Capped at a modest page count — this is a
   recent-updates tracker, not a full historical archive, and each extra page costs a real
   network round-trip during the scheduled run. */
async function fetchSebiPaginated(url, cat, base, maxPages = 20, maxRows = DEFAULT_MAX_ROWS) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const allRows = [];
  const seenLinks = new Set();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 1500));

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      if (allRows.length >= maxRows) break;
      if (pageNum > 1) {
        const hasFn = await page.evaluate(() => typeof searchFormNewsList === 'function').catch(() => false);
        if (!hasFn) break; // page structure changed since this was last verified — stop rather than guess
        await page.evaluate((arg) => { searchFormNewsList('n', String(arg)); }, pageNum - 1);
        await page.waitForNetworkIdle({ idleTime: 800, timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1200));
      }
      const html = await page.content();
      const rows = parseGenericHTML(html, base, cat, maxRows);
      if (!rows.length) break; // ran out of real pages (e.g. hit the end of results)
      let addedAny = false;
      for (const r of rows) {
        if (r.link && seenLinks.has(r.link)) continue;
        if (r.link) seenLinks.add(r.link);
        allRows.push(r);
        addedAny = true;
      }
      if (!addedAny) break; // this "page" returned nothing new — pagination likely looped or stalled
    }
  } finally {
    await page.close();
  }
  return allRows.slice(0, maxRows).map((r, i) => ({ ...r, sr: i + 1 }));
}

async function scrapeTab(tab, cat) {
  if (tab.sebiPaginate) {
    try {
      const rows = await fetchSebiPaginated(tab.src, cat, tab.src, tab.sebiPaginate, tab.maxRows || DEFAULT_MAX_ROWS);
      if (rows.length) return rows;
      throw new Error('Paginated SEBI fetch returned 0 rows');
    } catch (e) {
      console.warn(`  Paginated SEBI fetch failed (${e.message}), falling back...`);
      // fall through to the normal preferHtml/RSS logic below
    }
  }

  // Some tabs' "real" listing page is a plain, un-paginated-by-JS HTML page that already
  // contains far more items than the RSS feed we were defaulting to (confirmed against the
  // live pages: RBI's NotificationUser.aspx and SEBI's HomeAction.do listings both render
  // 25-60+ real dated rows server-side, with no headless browser needed — while RBI's RSS
  // feed caps at ~10, and SEBI's combined all-categories RSS feed leaves only a handful
  // once filtered down to one category). For these, try the richer HTML page FIRST and
  // only fall back to RSS if the HTML path fails outright or comes back suspiciously thin
  // (which would suggest the page structure changed since this was last verified).
  const MIN_ACCEPTABLE_HTML_ROWS = 8;
  if (tab.preferHtml && tab.src) {
    try {
      const html = await (tab.headless
        ? fetchViaHeadlessBrowser(tab.src, 45000, { clickButtonText: tab.clickButtonText, warmupUrl: tab.warmupUrl, extraWaitMs: tab.extraWaitMs, pierceShadowDOM: tab.pierceShadowDOM })
        : fetchWithRetry(tab.src));
      const rows = runHtmlParser(tab, html, cat);
      if (rows.length >= MIN_ACCEPTABLE_HTML_ROWS) return rows;
      console.warn(`  HTML path only returned ${rows.length} rows (< ${MIN_ACCEPTABLE_HTML_ROWS}), trying RSS as fallback...`);
      if (tab.rss) {
        try {
          const xml = await fetchWithRetry(tab.rss);
          const rssRows = parseRSS(xml, cat, tab.linkFilter, tab.maxRows || DEFAULT_MAX_ROWS);
          // Prefer whichever source actually got more rows — don't discard a working
          // HTML result just because it dipped below the threshold on a slow news day.
          if (rssRows.length > rows.length) return rssRows;
        } catch (e) { console.warn(`  RSS fallback also failed: ${e.message}`); }
      }
      if (rows.length) return rows; // still better than nothing
      throw new Error('Both HTML and RSS paths returned 0 rows');
    } catch (e) {
      console.warn(`  Preferred HTML path failed (${e.message}), trying RSS...`);
      if (!tab.rss) throw e;
      const xml = await fetchWithRetry(tab.rss);
      const rows = parseRSS(xml, cat, tab.linkFilter, tab.maxRows || DEFAULT_MAX_ROWS);
      if (rows.length) return rows;
      throw new Error('RSS parsed to 0 rows');
    }
  }

  if (tab.rss) {
    try {
      const xml = await fetchWithRetry(tab.rss);
      const rows = parseRSS(xml, cat, tab.linkFilter, tab.maxRows || DEFAULT_MAX_ROWS);
      if (rows.length) return rows;
      throw new Error('RSS parsed to 0 rows');
    } catch (e) {
      console.warn(`  RSS failed (${tab.rss}): ${e.message}`);
      // Some feeds 403 a plain HTTP client but allow real-browser traffic (confirmed:
      // Business Standard's RSS opens fine manually) — worth a headless retry before
      // giving up on having real dates and falling to a weaker HTML-only parse.
      if (tab.rssHeadlessFallback) {
        try {
          const xml = await fetchRssViaHeadless(tab.rss);
          const rows = parseRSS(xml, cat, tab.linkFilter, tab.maxRows || DEFAULT_MAX_ROWS);
          if (rows.length) return rows;
        } catch (e2) {
          console.warn(`  Headless RSS retry also failed: ${e2.message}`);
        }
      }
      if (!tab.src) throw e;
      // fall through to HTML parse below
    }
  }

  const html = tab.headless
    ? await fetchViaHeadlessBrowser(tab.src, 45000, { clickButtonText: tab.clickButtonText, warmupUrl: tab.warmupUrl, extraWaitMs: tab.extraWaitMs, pierceShadowDOM: tab.pierceShadowDOM })
    : await fetchWithRetry(tab.src);
  const rows = runHtmlParser(tab, html, cat);
  if (rows.length < 3) dumpDebugHtml(tab.key, html);
  return rows;
}

/* ── Business Standard "smallcard-title" article listing ──
   Confirmed against the real rendered page (Angular SSR app): article links use
   class="smallcard-title", and critically the listing view genuinely does NOT show a
   publish date at all — only a "X min read" estimate. Every other parser here requires a
   nearby date to accept a row (to reject nav/chrome junk), which meant 100% of real articles
   were being silently rejected. This parser accepts date-less rows for this specific site,
   the same way SEBI's FAQ listing (also genuinely dateless) is already handled. */
function parseBusinessStandardCards(html, base, cat, maxRows = DEFAULT_MAX_ROWS) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('a.smallcard-title[href]').each((_, a) => {
    if (rows.length >= maxRows) return;
    const title = $(a).text().trim().replace(/\s+/g, ' ');
    const href = $(a).attr('href') || '';
    // The nav link "Finance" (pointing at the section root, not an article) uses this same
    // class — exclude anything whose title is just the section label or too short to be real.
    if (title.length < 15 || seen.has(title) || NAV_WORDS.has(title.toLowerCase())) return;
    if (!/-\d+_\d+\.html?$/.test(href)) return; // real BS articles end in an ID like -126072801430_1.html
    seen.add(title);
    rows.push({ sr: rows.length + 1, date: '—', year: null, cat, title, desc: '', link: resolveLink(href, base) });
  });
  return rows;
}

function runHtmlParser(tab, html, cat) {
  const maxRows = tab.maxRows || DEFAULT_MAX_ROWS;
  let rows;
  switch (tab.htmlParse) {
    case 'linklist':      rows = parseLinkList(html, tab.src, cat, maxRows, tab.linkMustInclude, tab.linkMustExclude, tab.titleMustMatch); break;
    case 'nse_next_data': rows = parseNSENextData(html, tab.src, cat, maxRows); break;
    case 'rbi_nav_tree':  rows = parseRBINavTree(html, tab.src, cat, maxRows); break;
    case 'mca_marquee':   rows = parseMCAMarquee(html, tab.src, cat, maxRows); break;
    case 'bt_content_rows': rows = parseBtContentRows(html, tab.src, cat, maxRows); break;
    case 'pcaob_xml': rows = parsePcaobXmlReports(html, tab.src, cat, maxRows); break;
    case 'rbi_dated_docs': rows = parseRBIDatedDocs(html, tab.src, cat, maxRows); break;
    case 'bs_smallcard': rows = parseBusinessStandardCards(html, tab.src, cat, maxRows); break;
    default:               rows = parseGenericHTML(html, tab.src, cat, maxRows);
  }
  if (rows.length < 3) dumpDebugHtml(tab.key, html);
  return rows;
}

/* ── Headless browser fetch (Puppeteer) — for sites that render their content list
   via JavaScript after page load (BSE, PCAOB), where a plain HTTP fetch just sees an
   empty shell. One browser instance is reused across all headless-required tabs to
   avoid the overhead of launching Chromium repeatedly. ── */
let _browserPromise = null;
function getBrowser() {
  if (!_browserPromise) {
    const puppeteer = require('puppeteer');
    _browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return _browserPromise;
}

async function closeBrowser() {
  if (_browserPromise) {
    const browser = await _browserPromise;
    await browser.close();
    _browserPromise = null;
  }
}

/* ── Fetch an RSS/XML feed via headless browser ──
   For feeds that 403 a plain HTTP fetch but allow real-browser traffic (confirmed: Business
   Standard's RSS feed works fine when opened manually in a browser). Uses the navigation
   response's own .text() rather than page.content(), since Chrome renders XML documents
   through its own syntax-highlighted viewer UI — reading document.body after that renders
   would give back a reformatted DOM, not the raw feed text. The response object's .text()
   returns the actual bytes the server sent, before Chrome does anything with them. */
async function fetchRssViaHeadless(url, timeoutMs = 30000) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (!response || !response.ok()) throw new Error('HTTP ' + (response ? response.status() : 'no response'));
    return await response.text();
  } finally {
    await page.close();
  }
}

async function fetchViaHeadlessBrowserOnce(url, timeoutMs, opts = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 900 });
    // Basic anti-bot-detection patches — headless Chrome is detectable via several simple
    // signals (navigator.webdriver=true, missing navigator.plugins, no window.chrome object)
    // that some sites check before deciding whether to serve real content. This won't defeat
    // sophisticated fingerprinting, but covers the common cheap checks.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });

    const dismissAnyModal = async () => {
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('[data-dismiss="modal"], .modal button, .modal-close, .close'));
        for (const el of els) { try { el.click(); } catch (e) {} }
      }).catch(() => {});
    };

    // Some AEM-based gov sites (confirmed: MCA) redirect a cold direct navigation straight to
    // their homepage — deep links only work once a session/cookie has been established by
    // visiting the site "normally" first. Confirmed via debug HTML: a direct goto() to the
    // Adjudication Orders URL landed on a page whose own <title> was "HOME". Doing a throwaway
    // warm-up visit to the homepage first (dismissing its interstitial modal) fixes this.
    if (opts.warmupUrl) {
      await page.goto(opts.warmupUrl, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(() => {});
      await new Promise(r => setTimeout(r, 1500));
      await dismissAnyModal();
      await new Promise(r => setTimeout(r, 500));
    }

    const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs });
    if (response && !response.ok()) throw new Error('HTTP ' + response.status());
    await dismissAnyModal();
    // Give client-side rendering a moment to settle after the network goes idle —
    // some sites still run a final render pass (e.g. React hydration) after their
    // last network request completes. Some sites (confirmed: incometaxindia.gov.in's
    // Liferay "client extension" widgets) load their actual content via a slower,
    // separate async call well after networkidle2 fires — those pass a longer
    // opts.extraWaitMs to give the widget time to actually populate.
    await new Promise(r => setTimeout(r, opts.extraWaitMs || 2500));

    // Verify we actually landed on (roughly) the intended page rather than being bounced
    // elsewhere (e.g. redirected to the homepage) — if the path looks wrong, try navigating
    // directly one more time now that a warm-up visit (if any) has established a session.
    try {
      const targetPath = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      const currentPath = new URL(page.url()).pathname;
      if (targetPath && !currentPath.includes(targetPath.replace(/\.html$/, ''))) {
        console.warn(`  [headless] landed on unexpected page (${page.url()}), retrying direct nav...`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs }).catch(() => {});
        await dismissAnyModal();
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) { /* URL parsing edge case — not worth failing the whole fetch over */ }

    // Some pages (e.g. MCA's Adjudication Order search tools) show "No results found"
    // until a filter form is actually submitted, even with "All" pre-selected — there's
    // no default browsable list, just an unsubmitted search form. Click the button so the
    // AJAX call that populates real results actually fires.
    if (opts.clickButtonText) {
      const clicked = await page.evaluate((text) => {
        const els = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
        const target = els.find(el => (el.textContent || el.value || '').trim().toLowerCase() === text.toLowerCase());
        if (target) { target.click(); return true; }
        return false;
      }, opts.clickButtonText);
      if (clicked) {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
      } else {
        console.warn(`  [headless] clickButtonText "${opts.clickButtonText}" not found on page`);
      }
    }

    if (opts.pierceShadowDOM) {
      // Some widgets (suspected: incometaxindia.gov.in's Liferay "client extension" —
      // page size grew substantially with a longer wait, confirming content DOES load,
      // yet the parser still found nothing, which rules out a plain timing issue) render
      // their actual content inside a Shadow DOM. That's invisible to page.content()
      // entirely, no matter how long you wait — it's a different DOM tree, not slow
      // content. This walks the full tree, and for any element with a shadow root, clones
      // that shadow content into a plain visible wrapper appended as a normal child, so it
      // shows up in the eventual page.content() call.
      await page.evaluate(() => {
        function pierce(root) {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
          let node = walker.currentNode;
          do {
            if (node.shadowRoot) {
              const wrapper = document.createElement('div');
              wrapper.setAttribute('data-shadow-extracted', 'true');
              wrapper.innerHTML = node.shadowRoot.innerHTML;
              node.appendChild(wrapper);
              pierce(node.shadowRoot);
            }
          } while ((node = walker.nextNode()));
        }
        pierce(document.body);
      }).catch(() => {});
    }

    return await page.content();
  } finally {
    await page.close();
  }
}

async function fetchViaHeadlessBrowser(url, timeoutMs = 45000, opts = {}) {
  try {
    return await fetchViaHeadlessBrowserOnce(url, timeoutMs, opts);
  } catch (e) {
    // "Execution context was destroyed" fires when the page navigates or reloads mid-read —
    // confirmed happening on JS-heavy filterable list pages (e.g. MCA's adjudication order
    // pages, which load via AJAX after an initial redirect-ish render). This is a timing
    // flake, not a real failure — one retry with a fresh page resolves it in practice.
    if (/execution context was destroyed|navigation/i.test(e.message || '')) {
      await new Promise(r => setTimeout(r, 2000));
      return await fetchViaHeadlessBrowserOnce(url, timeoutMs, opts);
    }
    throw e;
  }
}

/* ── Keyword filtering (e.g. NEWSLETTER sources) ──
   General news RSS feeds (Indian Express, Economic Times, etc.) aren't scoped to banking —
   they cover everything. Rather than needing a perfectly-targeted "banking section" RSS URL
   for every single outlet (which not all publishers even offer), pull from each outlet's
   broader business/finance feed and filter down to rows whose title or description mentions
   a bank/NBFC-relevant keyword. Applied once, generically, after whichever fetch path
   (RSS or HTML) succeeded — rather than duplicated inside every individual parser. */
function applyKeywordFilter(rows, keywords) {
  if (!keywords || !keywords.length) return rows;
  const lc = keywords.map(k => k.toLowerCase());
  return rows
    .filter(r => {
      const text = ((r.title || '') + ' ' + (r.desc || '')).toLowerCase();
      return lc.some(k => text.includes(k));
    })
    .map((r, i) => ({ ...r, sr: i + 1 }));
}

/* ── New-item detection + email notification ──
   Compares this run's rows against the previous run's rows (already loaded above) to find
   genuinely new items, then emails a digest if any were found. Only diffs a tab when BOTH
   the previous and current run succeeded with real rows — this avoids a false "everything
   is new" flood after a transient scrape failure wipes a tab down to 0 rows and it recovers
   the next run (a real failure mode we hit repeatedly while building this scraper). */
// sources.js regulator entries only carry `tabs`, not a display name — that's exactly why
// email section headers were rendering as literal "undefined". Proper names for email/display
// purposes live here instead, decoupled from the scraping config.
const REGULATOR_DISPLAY_NAMES = {
  NEWSLETTER: 'Newsletter — Bank & NBFC News',
  SEBI: 'Securities & Exchange Board of India (SEBI)',
  RBI: 'Reserve Bank of India (RBI)',
  BSE: 'Bombay Stock Exchange (BSE)',
  NSE: 'National Stock Exchange (NSE)',
  IRDAI: 'Insurance Regulatory & Development Authority (IRDAI)',
  IEPFA: 'Investor Education & Protection Fund Authority (IEPFA)',
  MCA: 'Ministry of Corporate Affairs (MCA)',
  NFRA: 'National Financial Reporting Authority (NFRA)',
  PCAOB: 'Public Company Accounting Oversight Board (PCAOB)',
};

// Only alert on items actually dated today (with a short grace window for scheduling/timezone
// gaps around midnight) — otherwise a tab that's empty for a while and then successfully
// scrapes again floods the email with everything it finds, including weeks-old items that are
// merely new TO US, not new in reality. maxDaysOld=1 means "today or yesterday" so a run just
// after midnight IST doesn't miss something published late the previous day.
function isRecentDate(dateStr, maxDaysOld = 1) {
  if (!dateStr || dateStr === '—') return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const diffDays = (now.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / 86400000;
  return diffDays >= 0 && diffDays <= maxDaysOld;
}

/* ── Retention filter (e.g. Newsletter sources) ──
   Keeps only rows dated within the last N days — a news tab has no reason to accumulate
   months of old headlines the way a regulatory-filing archive might. Rows with no date at
   all (e.g. Business Standard's HTML fallback, which genuinely doesn't expose a publish
   date) are kept rather than dropped, since we have no way to judge whether they're actually
   old or not — better to show an undated-but-real item than silently hide it. */
function applyRetentionFilter(rows, maxAgeDays) {
  if (!maxAgeDays) return rows;
  return rows
    .filter(r => !r.date || r.date === '—' || isRecentDate(r.date, maxAgeDays))
    .map((r, i) => ({ ...r, sr: i + 1 }));
}

function findNewItems(previous, output) {
  const newByRegulator = {};
  for (const [regKey, reg] of Object.entries(REGULATORS)) {
    for (const tab of reg.tabs) {
      const cur = output[tab.key];
      const prev = previous[tab.key];
      if (!cur || !cur.ok || !cur.rows.length) continue;

      // Default to 0 — set below only when a fresh-item count is actually meaningful.
      cur.newCount = 0;

      if (!prev || !prev.ok || !prev.rows.length) continue; // no reliable baseline — skip, don't flood

      const prevKeys = new Set(prev.rows.map(r => r.link || `${r.title}|${r.date}`));
      const freshKeys = new Set();
      const fresh = cur.rows
        .filter(r => !prevKeys.has(r.link || `${r.title}|${r.date}`))
        .filter(r => isRecentDate(r.date)); // new-to-us AND actually dated today/yesterday

      for (const r of fresh) freshKeys.add(r.link || `${r.title}|${r.date}`);
      // Tag the actual rows so the frontend can (optionally) highlight them individually,
      // not just show a count — e.g. a "NEW" badge next to the row in the table.
      for (const r of cur.rows) r.isNew = freshKeys.has(r.link || `${r.title}|${r.date}`);
      cur.newCount = fresh.length;

      if (fresh.length) {
        if (!newByRegulator[regKey]) newByRegulator[regKey] = { name: REGULATOR_DISPLAY_NAMES[regKey] || regKey, tabs: {} };
        newByRegulator[regKey].tabs[tab.label] = fresh;
      }
    }
  }
  return newByRegulator;
}

async function sendNotificationEmail(newByRegulator) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_RECIPIENTS, TRACKER_URL } = process.env;
  if (!SMTP_USER || !SMTP_PASS || !NOTIFY_RECIPIENTS) {
    console.log('  [notify] Skipping email — SMTP_USER / SMTP_PASS / NOTIFY_RECIPIENTS not set as secrets.');
    return;
  }

  const totalCount = Object.values(newByRegulator).reduce(
    (sum, reg) => sum + Object.values(reg.tabs).reduce((s, rows) => s + rows.length, 0), 0
  );
  const todayStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });

  // Table-based layout with inline styles throughout — Outlook's rendering engine (Word, not
  // a browser engine) ignores most CSS classes, flexbox, and external/embedded stylesheets,
  // so every style has to be inline on the element itself to render consistently, matching
  // what the actual recipients will open this in (confirmed from the screenshot: Outlook desktop).
  const FONT = "font-family:Segoe UI,Arial,Helvetica,sans-serif;";
  const INK = '#1a2030', MUTED = '#5a6474', BORDER = '#e2e6ea', DEEP = '#1a56db', BG = '#f7f8fa';

  let sectionsHtml = '';
  for (const [regKey, reg] of Object.entries(newByRegulator)) {
    let rowsHtml = '';
    for (const [tabLabel, rows] of Object.entries(reg.tabs)) {
      for (const r of rows) {
        rowsHtml += `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid ${BORDER};vertical-align:top;width:90px;${FONT}font-size:12px;color:${MUTED};white-space:nowrap;">${esc(r.date || '')}</td>
            <td style="padding:10px 0 10px 14px;border-bottom:1px solid ${BORDER};vertical-align:top;">
              <span style="display:inline-block;${FONT}font-size:10.5px;font-weight:600;color:${DEEP};background:#eaf1fd;border-radius:4px;padding:2px 7px;margin-bottom:4px;">${esc(tabLabel)}</span><br/>
              <a href="${esc(r.link || '#')}" style="${FONT}font-size:14px;color:${INK};text-decoration:none;font-weight:500;">${esc(r.title)}</a>
            </td>
          </tr>`;
      }
    }
    sectionsHtml += `
      <tr><td style="padding:22px 0 8px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="${FONT}font-size:15px;font-weight:700;color:${INK};border-left:3px solid ${DEEP};padding-left:10px;">${esc(reg.name)}</td></tr>
        </table>
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>
      </td></tr>`;
  }

  const trackerButton = TRACKER_URL ? `
    <tr><td style="padding:28px 0 4px;">
      <a href="${esc(TRACKER_URL)}" style="${FONT}display:inline-block;background:${DEEP};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;padding:10px 22px;border-radius:6px;">Open Full Tracker →</a>
    </td></tr>` : '';

  const bodyHtml = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BG};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid ${BORDER};border-radius:8px;overflow:hidden;">
        <tr><td style="background:#0f2d52;padding:22px 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="${FONT}font-size:11px;font-weight:700;letter-spacing:1.5px;color:#a9c6f0;text-transform:uppercase;">Bajaj Finserv — Secretarial</td>
          </tr><tr>
            <td style="${FONT}font-size:19px;font-weight:700;color:#ffffff;padding-top:4px;">Regulatory Updates Tracker</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:22px 28px 6px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
            <td style="${FONT}font-size:13px;color:${MUTED};">${todayStr}</td>
            <td align="right" style="${FONT}font-size:13px;color:${DEEP};font-weight:700;">${totalCount} new item${totalCount === 1 ? '' : 's'}</td>
          </tr></table>
        </td></tr>
        <tr><td style="padding:0 28px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${sectionsHtml}</table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${trackerButton}</table>
        </td></tr>
        <tr><td style="padding:24px 28px;border-top:1px solid ${BORDER};margin-top:20px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
            <span style="${FONT}font-size:11px;color:${MUTED};">This is an automated notification from the Regulatory Updates Tracker. Items are matched against each source's official publication date — historical or backlog items are not included.</span>
          </td></tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>`;

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST || 'smtp.office365.com',
    port: Number(SMTP_PORT) || 587,
    secure: false, // STARTTLS on port 587
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });

  try {
    await transporter.sendMail({
      from: SMTP_USER,
      to: SMTP_USER, // most SMTP servers want a visible To — recipients go in bcc instead so they don't see each other's addresses
      bcc: NOTIFY_RECIPIENTS, // comma-separated list
      subject: `Regulatory Updates — ${totalCount} new item${totalCount === 1 ? '' : 's'} (${new Date().toLocaleDateString('en-IN')})`,
      html: bodyHtml
    });
    console.log(`  [notify] Email sent to ${NOTIFY_RECIPIENTS} (${totalCount} new items).`);
  } catch (e) {
    // Never fail the whole scrape run just because email delivery had a problem —

    // the data itself is still valid and should still be committed.
    console.log(`  [notify] FAILED to send email: ${e.message}`);
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/* ── AI Summary generation ──
   Deliberately NOT done here. Azure OpenAI's network firewall only allows calls from a
   specific whitelisted IP, and GitHub Actions runners use different, constantly-changing
   IPs that can never be added to that allowlist — every attempt from here fails with
   HTTP 403, confirmed repeatedly. AI summaries are instead generated by a separate script
   (ai-summary-updater.js) running on a VM whose IP IS whitelisted; it pulls this repo's
   data.json, fills in "summary" fields locally, and pushes the result back. This scraper's
   only related job is enrichThinDescriptions() below — giving that VM script richer content
   to summarize from, since fetching PDFs/articles needs open internet access (which this
   GitHub Actions runner has, and that VM does not). */

/* ── Fetch real dates from individual article pages ──
   Some sites (confirmed: ETBFSI) don't show a publish date on the listing page at all, but
   DO show one on each article's own page — e.g. "Published On Aug 20, 2026 at 02:52 PM IST".
   Rather than a fragile text-search for that exact phrase (which varies by site/template),
   this looks for the standard SEO metadata almost every modern news site embeds regardless
   of what it shows visually: the Open Graph article:published_time meta tag, or the
   schema.org datePublished field in JSON-LD structured data. Uses a plain (non-headless)
   fetch per article — much cheaper than a full headless page load, and most sites that
   block scraping at the listing level still allow individual article pages through, since
   those are what search engines and social-media link previews need to access. */
async function fetchArticleDate(url) {
  try {
    const html = await fetchText(url, 10000);
    // Open Graph / standard meta tag
    let m = html.match(/<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i);
    if (m) return m[1];
    m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i);
    if (m) return m[1];
    // schema.org JSON-LD
    m = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
    if (m) return m[1];
    return null;
  } catch (e) {
    return null;
  }
}

/* Fills in real dates for rows that came back dateless, capped per run to control cost
   (each one is an extra network request) — carries the same spirit as the AI summary cap:
   an hourly job doesn't need to re-check hundreds of already-seen dateless rows every run,
   just the newly-added ones each time. */
/* ── Enrich thin/empty descriptions with real document content ──
   Many tabs — confirmed from real output: NFRA, PCAOB, IEPFA circulars especially — link
   directly to a PDF with only a bare filename-like title and no description at all. That
   leaves nothing for downstream AI summarization to work with beyond the title. This runs
   here (as part of the GitHub Actions scrape, which has full unrestricted internet access)
   rather than on the VM that generates AI summaries, since that VM has no general internet
   access of its own — only a whitelisted path to Azure OpenAI. Splitting it this way means
   each machine only does what its own network access actually permits: this step fetches
   and stores real content in data.json here, and the VM later just reads that already-rich
   desc field locally with no fetch of its own required. */
async function fetchDocumentDesc(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': UA },
    });
    if (!resp.ok) return null;

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const isPdf = contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      const buffer = Buffer.from(await resp.arrayBuffer());
      const parsed = await pdfParse(buffer);
      return (parsed.text || '').replace(/\s+/g, ' ').trim().substring(0, 1500) || null;
    } else {
      const html = await resp.text();
      const $ = cheerio.load(html);
      $('script, style, nav, header, footer, .nav, .navbar, .menu, .sidebar').remove();
      const text = $('article').text() || $('main').text() || $('body').text();
      return text.replace(/\s+/g, ' ').trim().substring(0, 1500) || null;
    }
  } catch (e) {
    return null; // silent — this is a best-effort enrichment, not a required step
  }
}

async function enrichThinDescriptions(output) {
  const optedInKeys = new Set();
  for (const reg of Object.values(REGULATORS)) {
    for (const tab of reg.tabs) {
      if (tab.fetchDescFromDocument) optedInKeys.add(tab.key);
    }
  }
  const MAX_PER_RUN = 100; // each one is a real network fetch (and PDF parse, which is slower) — raised now that this covers all tabs, not just 3
  let fetched = 0;
  for (const [tabKey, entry] of Object.entries(output)) {
    if (!optedInKeys.has(tabKey)) continue;
    if (!entry.ok || !entry.rows.length) continue;
    for (const row of entry.rows) {
      // Confirmed against real data: a 60-char threshold was far too low — RSS/feed
      // excerpts routinely clear that bar while still being a thin, mid-sentence-truncated
      // snippet (e.g. "...detention-waiver certificates bind CCSPsThe post Customs Detention
      // Waiver Certificates Bind CCSPs" — WordPress's auto-appended "The post ... appeared
      // first on" boilerplate cut off partway through). Raised the bar substantially, and
      // also explicitly re-fetch anything that looks like a truncated RSS excerpt
      // regardless of length, since those are never the real document content.
      const looksLikeThinExcerpt = /the post\s.{0,80}$/i.test(row.desc || '') || /\[…\]|\.\.\.$/i.test((row.desc || '').trim());
      if (row.desc && row.desc.length >= 400 && !looksLikeThinExcerpt) continue; // already has real, substantial content
      if (!row.link) continue;
      if (fetched >= MAX_PER_RUN) return;
      const desc = await fetchDocumentDesc(row.link);
      if (desc) row.desc = desc;
      fetched++;
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

async function enrichDatelessRows(output) {
  const MAX_DATE_LOOKUPS_PER_RUN = 40;
  let fetched = 0;
  const optedInKeys = new Set();
  for (const reg of Object.values(REGULATORS)) {
    for (const tab of reg.tabs) {
      if (tab.fetchDateFromArticle) optedInKeys.add(tab.key);
    }
  }
  for (const [tabKey, entry] of Object.entries(output)) {
    if (!optedInKeys.has(tabKey)) continue;
    if (!entry.ok || !entry.rows.length) continue;
    for (const row of entry.rows) {
      if (row.date && row.date !== '—') continue;
      if (!row.link) continue;
      if (fetched >= MAX_DATE_LOOKUPS_PER_RUN) return;
      const rawDate = await fetchArticleDate(row.link);
      if (rawDate) {
        const d = tryParseDate(rawDate);
        if (d) { row.date = d; row.year = extractYear(d); }
      }
      fetched++;
      await new Promise(r => setTimeout(r, 200));
    }
  }
}

async function main() {
  // Load previous output so a source that fails this run doesn't wipe out
  // the last good data — we keep serving stale-but-real data over nothing.
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')).data || {}; } catch (e) { /* first run, ignore */ }

  const output = {};
  for (const [regKey, reg] of Object.entries(REGULATORS)) {
    for (const tab of reg.tabs) {
      process.stdout.write(`Scraping ${tab.key} (${tab.label})... `);
      try {
        let rows = await scrapeTab(tab, tab.cat);
        if (tab.keywordFilter || tab.maxAgeDays) {
          const rawCount = rows.length;
          if (tab.keywordFilter) rows = applyKeywordFilter(rows, tab.keywordFilter);
          const afterKeyword = rows.length;
          if (tab.maxAgeDays) rows = applyRetentionFilter(rows, tab.maxAgeDays);
          const afterAge = rows.length;
          if (afterAge < rawCount) {
            console.log(`  [filter] ${tab.key}: fetched ${rawCount} → ${afterKeyword} after keyword filter → ${afterAge} after ${tab.maxAgeDays || 0}-day retention`);
          }
        }
        output[tab.key] = { rows, ts: Date.now(), ok: true };
        console.log(`OK (${rows.length} rows)`);
      } catch (e) {
        console.log(`FAILED: ${e.message}`);
        if (previous[tab.key]) {
          output[tab.key] = { ...previous[tab.key], ok: false, error: e.message };
          console.log(`  → kept previous data (${previous[tab.key].rows.length} rows)`);
        } else {
          output[tab.key] = { rows: [], ts: Date.now(), ok: false, error: e.message };
        }
      }
      // Be polite / avoid tripping rate limits — small delay between requests
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  console.log('\nEnriching thin descriptions with real document content...');
  await enrichThinDescriptions(output);

  console.log('\nFetching real dates for dateless articles...');
  await enrichDatelessRows(output);

  const newByRegulator = findNewItems(previous, output);
  const newCount = Object.values(newByRegulator).reduce(
    (sum, reg) => sum + Object.values(reg.tabs).reduce((s, rows) => s + rows.length, 0), 0
  );
  if (newCount > 0) {
    console.log(`\nFound ${newCount} new item(s) since last run.`);
    await sendNotificationEmail(newByRegulator);
  } else {
    console.log('\nNo new items since last run — skipping notification email.');
  }

  const final = { generatedAt: new Date().toISOString(), data: output };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(final, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);

  await closeBrowser();
}

main().catch(async e => { console.error(e); await closeBrowser(); process.exit(1); });
