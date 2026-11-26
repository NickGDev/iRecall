// Isolated-world content script: gates, extracts main content, sends to the
// service worker for buffering + ingest.
import { Readability } from '@mozilla/readability';

const MIN_CHARS = 250;
const NAV_DEBOUNCE_MS = 1500;

interface ExtConfig {
  enabled: boolean;
  blockedDomains: string[];
  allowedDomains: string[];
}
const DEFAULT_CONFIG: ExtConfig = { enabled: true, blockedDomains: [] as string[], allowedDomains: [] as string[] };

async function getConfig(): Promise<ExtConfig> {
  // storage.get returns ONE object keyed by the requested keys — not an array.
  const got = (await chrome.storage.local.get(['config', 'filterlist', 'blocked'])) as {
    config?: Partial<ExtConfig>;
    filterlist?: { domains?: unknown };
    blocked?: { domains?: unknown };
  };
  const cfg: ExtConfig = { ...DEFAULT_CONFIG, ...(got.config ?? {}) };
  // Server-derived lists merged into the local gate: `filterlist` holds domains
  // the focus filter keeps rejecting (see /api/filterlist); `blocked` mirrors
  // the user blocklist (see /api/blocked, editable from popup + dashboard).
  // User's allowedDomains still override both.
  const serverDomains = Array.isArray(got.filterlist?.domains)
    ? (got.filterlist!.domains as string[])
    : [];
  const blockedDomains = Array.isArray(got.blocked?.domains) ? (got.blocked!.domains as string[]) : [];
  return { ...cfg, blockedDomains: [...cfg.blockedDomains, ...serverDomains, ...blockedDomains] };
}

function hostMatches(host: string, list: string[]): boolean {
  return list.some((d) => host === d || host.endsWith('.' + d));
}

let navTimer: ReturnType<typeof setTimeout> | undefined;
let viewStart = performance.now();

interface ExtractedPage {
  url: string;
  title: string | null;
  content: string;
  excerpt: string | null;
  byline: string | null;
  dwellMs: number;
  capturedAt: number;
}

function extractPage(): ExtractedPage | null {
  // Readability on a fresh clone of the live DOM (isolated world — scripts in
  // the clone never run). Only article.textContent leaves the page; DOMPurify
  // was dropped here: it throws on Document input (importNode), and sanitize
  // added nothing — the server stores plain text and every render sink is
  // textContent.
  const article = new Readability(document.cloneNode(true) as Document).parse();
  if (!article || !article.textContent) return null;
  return {
    url: location.href,
    title: article.title ?? document.title ?? null,
    content: article.textContent,
    excerpt: article.excerpt ?? null,
    byline: article.byline ?? null,
    dwellMs: Math.round(performance.now() - viewStart),
    capturedAt: Date.now(),
  };
}

// Scroll coverage: SPA feeds (LinkedIn etc.) never navigate — the URL stays
// and readable text grows as you scroll. Periodic growth-only re-captures
// turn long scroll sessions into a chain of evolving snapshots; the server
// dedups identical content and inserts same-day changed content as new
// (superseded-linked) rows.
const GROWTH_POLL_MS = 60_000;
const GROWTH_MIN_CHARS = 1500;
let lastCapturedLen = 0;

async function capture(reason: string, opts: { growth?: boolean } = {}): Promise<void> {
  if (!location.protocol.startsWith('http')) return;
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  const host = location.hostname;
  const blocked = hostMatches(host, cfg.blockedDomains) && !hostMatches(host, cfg.allowedDomains);
  // Growth polls stay silent on the skip paths — no badge flapping while you
  // sit on a login/blocked page for minutes.
  if (blocked) {
    if (!opts.growth) {
      await chrome.runtime.sendMessage({ type: 'state', state: 'skipped', host, reason: 'blocked' });
    }
    return;
  }
  if (document.querySelector('input[type=password]')) {
    // Login form heuristic: skip capture, mark tab. ponytail: false-positive
    // ceiling = pages with hidden password fields; upgrade = visibility check.
    if (!opts.growth) {
      await chrome.runtime.sendMessage({ type: 'state', state: 'skipped', host, reason: 'password' });
    }
    return;
  }
  const page = extractPage();
  if (!page || page.content.length < MIN_CHARS) {
    // Tell the worker so the badge + popup can say why nothing was kept.
    if (!opts.growth) {
      await chrome.runtime.sendMessage({ type: 'state', state: 'skipped', host, reason: 'thin' });
    }
    return;
  }
  if (opts.growth && page.content.length < lastCapturedLen + GROWTH_MIN_CHARS) return;
  try {
    await chrome.runtime.sendMessage({ type: 'capture', page: { ...page, reason } });
    lastCapturedLen = page.content.length;
  } catch {
    // worker unreachable: nothing buffered here, next page retries
  }
}

function scheduleNavCapture(): void {
  if (navTimer) clearTimeout(navTimer);
  navTimer = setTimeout(() => {
    viewStart = performance.now();
    capture('nav');
  }, NAV_DEBOUNCE_MS);
}

document.addEventListener('irecall:nav', scheduleNavCapture);
window.addEventListener('pageshow', (e) => {
  if ((e as PageTransitionEvent).persisted) capture('bfcache');
});

// Popup "teach this page": re-extract on demand; the popup POSTs the payload
// as an exemplar. Same extraction as capture but without its gates — explicit
// user intent outranks the thin/blocked heuristics.
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
  if (msg?.type !== 'teach') return;
  const page = extractPage();
  if (page && page.content.length > 0) {
    sendResponse(page);
    return;
  }
  // Readability loses on app-shell pages (LinkedIn feed after scroll, etc.).
  // Explicit user intent: fall back to raw visible text rather than refuse.
  const text = (document.body?.innerText ?? '').trim();
  sendResponse(
    text.length > 0
      ? {
          url: location.href,
          title: document.title || null,
          content: text,
          excerpt: null,
          byline: null,
          dwellMs: Math.round(performance.now() - viewStart),
          capturedAt: Date.now(),
        }
      : null
  );
});

capture('load');

// Growth poll — visible tabs only; doubles as a missed-nav safety net since
// it always captures at the current location.href.
setInterval(() => {
  if (document.hidden) return;
  if (!location.protocol.startsWith('http')) return;
  if (document.querySelector('input[type=password]')) return;
  void capture('growth', { growth: true });
}, GROWTH_POLL_MS);
