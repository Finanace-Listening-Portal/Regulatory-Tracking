/**
 * enrich-descriptions-once.js
 * ----------------------------------------------------------------------------
 * ONE-TIME backlog-clearing run for the "desc" field across every tab — NOT part of the
 * regular hourly scraper. The regular scraper (scraper.js) keeps a modest per-run cap on
 * this same enrichment step specifically so a normal scheduled run can't blow past its
 * workflow timeout; this script has no cap at all, and instead checkpoints progress
 * periodically (commit + push every CHECKPOINT_EVERY rows) so an interruption partway
 * through doesn't lose everything back to the start.
 *
 * INTENDED USE: run this ONCE (or occasionally, if you want to force another full pass)
 * via its own GitHub Actions workflow with a long timeout — NOT on a schedule, and NOT on
 * the VM (which has no general internet access, only a whitelisted path to Azure OpenAI).
 * After this clears the backlog, the regular scraper.js naturally only has new rows left
 * to enrich each hour, since already-enriched rows are skipped.
 *
 * Uses the exact same extraction logic as scraper.js (fetchDocumentDesc, cleanExtractedText,
 * extractPdfText, stripChrome) — kept in sync so results are identical regardless of which
 * script actually did the fetching.
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const REGULATORS = require('./sources');

const DATA_PATH = path.join(__dirname, '..', 'data', 'regulatory_data.json');
const CHECKPOINT_EVERY = 100;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const NAV_WORDS = new Set([
  'home', 'login', 'logout', 'sitemap', 'contact', 'contact us', 'about', 'about us',
  'search', 'back', 'top', 'next', 'prev', 'previous', 'skip', 'menu', 'download',
]);

function stripChrome($) {
  $('nav, header, footer, .nav, .navbar, .menu, .breadcrumb, .breadcrumbs, #menu, #nav, #header, #footer, .sidebar, .footer, .header').remove();
  return $;
}

function resolveLink(href, base) {
  if (!href || href.startsWith('javascript')) return '';
  try { return new URL(href, base).href; } catch { return href || ''; }
}

function run(cmd) {
  console.log('> ' + cmd);
  execSync(cmd, { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
}

/* ── Identical to scraper.js — kept in sync ── */
function cleanExtractedText(raw) {
  let text = (raw || '').replace(/[\u0900-\u097F]+/g, ' ').replace(/\s+/g, ' ').trim();
  const refMatch = text.match(/\b[A-Z]{2,10}\/\d{4}-\d{2}\/\d+/);
  if (refMatch && refMatch.index < text.length / 2) {
    text = text.substring(refMatch.index);
  }
  return text;
}

async function extractPdfText(arrayBuffer) {
  const BENIGN_PDF_WARNING_PATTERNS = [
    /ran out of space in font private use area/i,
    /TT: (undefined function|invalid function id)/i,
  ];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    const msg = args.join(' ');
    if (BENIGN_PDF_WARNING_PATTERNS.some(p => p.test(msg))) return;
    originalWarn(...args);
  };
  try {
    const buffer = Buffer.from(arrayBuffer);
    const parsed = await pdfParse(buffer);
    return cleanExtractedText(parsed.text).substring(0, 1500) || null;
  } catch (e) {
    return null;
  } finally {
    console.warn = originalWarn;
  }
}

async function fetchDocumentDesc(url) {
  if (!url) return null;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA } });
    if (!resp.ok) return null;

    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
    const isPdf = contentType.includes('pdf') || url.toLowerCase().endsWith('.pdf');
    if (isPdf) return await extractPdfText(await resp.arrayBuffer());

    const html = await resp.text();
    const $ = stripChrome(cheerio.load(html));
    $('.sidebar, .promo, .banner, .advertisement, .widget, .related-posts, .comments, aside').remove();

    const pdfHref = $('a[href$=".pdf" i], a[href*=".pdf?" i]').first().attr('href');
    if (pdfHref) {
      const pdfUrl = resolveLink(pdfHref, url);
      try {
        const pdfResp = await fetch(pdfUrl, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': UA } });
        if (pdfResp.ok) {
          const pdfText = await extractPdfText(await pdfResp.arrayBuffer());
          if (pdfText && pdfText.length >= 200) return pdfText;
        }
      } catch (e) { /* fall through */ }
    }

    let bestBlock = null, bestScore = 0;
    $('div, td, section, article, main').each((_, el) => {
      const elText = $(el).text().trim();
      if (elText.length < 300) return;
      const linkText = $(el).find('a').text().length;
      const linkDensity = elText.length > 0 ? linkText / elText.length : 1;
      const score = elText.length * (1 - linkDensity);
      if (score > bestScore) { bestScore = score; bestBlock = el; }
    });
    if (!bestBlock) bestBlock = $('body').get(0);

    let text = bestBlock ? $(bestBlock).text() : $('body').text();
    text = text.replace(/\s+/g, ' ').trim();
    return cleanExtractedText(text).substring(0, 1500) || null;
  } catch (e) {
    return null;
  }
}

/* ── Main ── */
async function main() {
  console.log('=== One-time description backlog clear — ' + new Date().toISOString() + ' ===');
  run('git pull');

  const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  const optedInKeys = new Set();
  for (const reg of Object.values(REGULATORS)) {
    for (const tab of reg.tabs) {
      if (tab.fetchDescFromDocument) optedInKeys.add(tab.key);
    }
  }

  function needsDesc(row) {
    if (!row.link) return false;
    const looksLikeThinExcerpt = /the post\s.{0,80}$/i.test(row.desc || '') || /\[…\]|\.\.\.$/i.test((row.desc || '').trim());
    const looksLikeNavBoilerplate = /skip to main content|only the latest.{0,40}updates|off on books|no results found/i.test(row.desc || '');
    return !row.desc || row.desc.length < 400 || looksLikeThinExcerpt || looksLikeNavBoilerplate;
  }

  function parseRowDate(row) {
    const d = new Date(row.date);
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  const tabEntries = Object.entries(raw.data)
    .filter(([k]) => optedInKeys.has(k))
    .map(([, e]) => e)
    .filter(e => e.ok && e.rows && e.rows.length)
    .map(e => ({ entry: e, order: e.rows.map((_, i) => i).sort((a, b) => parseRowDate(e.rows[b]) - parseRowDate(e.rows[a])) }));

  let candidates = 0;
  for (const { entry, order } of tabEntries) {
    for (const idx of order) if (needsDesc(entry.rows[idx])) candidates++;
  }
  console.log(`\nFound ${candidates} row(s) needing real content. Processing all of them (no cap, this is the one-time catch-up run)...\n`);

  let fetched = 0;
  let sinceLastCheckpoint = 0;

  function checkpoint(reason) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(raw, null, 2));
    try {
      run('git add data/regulatory_data.json');
      run(`git commit -m "One-time description backlog clear — checkpoint (${reason}, ${new Date().toISOString()})"`);
      // Discard any uncommitted changes to files OTHER than the one we explicitly staged —
      // confirmed root cause of every checkpoint failing all run long: npm install modifies
      // package-lock.json, which was never staged/committed, and git pull --rebase refuses
      // to run at all with ANY unstaged changes present, not just conflicting ones. Without
      // this, that one incidental file change silently blocked saving progress for the
      // entire run, even though the script kept reporting apparent success.
      run('git checkout -- . || true');
      run('git pull --rebase');
      run('git push');
      console.log(`  [checkpoint] Saved and pushed at ${fetched} total.\n`);
    } catch (e) {
      console.warn(`  [checkpoint] FAILED to sync (${e.message.split('\n')[0]}) — continuing, will retry at next checkpoint.`);
      try { run('git rebase --abort'); } catch (e2) { /* nothing to abort, fine */ }
    }
    sinceLastCheckpoint = 0;
  }

  const tabCursors = new Map(tabEntries.map(t => [t, 0]));
  let anyRemaining = true;
  while (anyRemaining) {
    anyRemaining = false;
    for (const t of tabEntries) {
      let pos = tabCursors.get(t);
      while (pos < t.order.length && !needsDesc(t.entry.rows[t.order[pos]])) pos++;
      if (pos >= t.order.length) { tabCursors.set(t, pos); continue; }
      anyRemaining = true;

      const row = t.entry.rows[t.order[pos]];
      const desc = await fetchDocumentDesc(row.link);
      if (desc) row.desc = desc;
      fetched++;
      sinceLastCheckpoint++;
      console.log(`  [${fetched}/${candidates}] ${desc ? 'OK' : 'no content found'}: ${row.title.substring(0, 60)}...`);
      tabCursors.set(t, pos + 1);
      await new Promise(r => setTimeout(r, 200));

      if (sinceLastCheckpoint >= CHECKPOINT_EVERY) checkpoint('progress');
    }
  }

  console.log(`\nDone. Processed ${fetched} rows total.`);
  if (sinceLastCheckpoint > 0) checkpoint('final');
  else console.log('Nothing new since last checkpoint — nothing further to commit.');
}

main().catch(e => { console.error('FATAL ERROR:', e); process.exit(1); });
