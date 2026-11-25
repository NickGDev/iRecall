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

async function capture(reason: string): Promise<void> {
  if (!location.protocol.startsWith('http')) return;
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  const host = location.hostname;
  if (hostMatches(host, cfg.blockedDomains) && !hostMatches(host, cfg.allowedDomains)) {
    await chrome.runtime.sendMessage({ type: 'state', state: 'skipped', host, reason: 'blocked' });
    return;
  }
  if (document.querySelector('input[type=password]')) {
    // Login form heuristic: skip capture, mark tab. ponytail: false-positive
    // ceiling = pages with hidden password fields; upgrade = visibility check.
    await chrome.runtime.sendMessage({ type: 'state', state: 'skipped', host, reason: 'password' });
    return;
  }
  // Readability on a fresh clone of the live DOM (isolated world — scripts in
  // the clone never run). Only article.textContent leaves the page; DOMPurify
  // was dropped here: it throws on Document input (importNode), and sanitize
  // added nothing — the server stores plain text and every render sink is
  // textContent.
  const article = new Readability(document.cloneNode(true) as Document).parse();
  if (!article || (article.textContent?.length ?? 0) < MIN_CHARS) {
    // Tell the worker so the badge + popup can say why nothing was kept.
    await chrome.runtime.sendMessage({ type: 'state', state: 'skipped', host, reason: 'thin' });
    return;
  }
  try {
    await chrome.runtime.sendMessage({
      type: 'capture',
      page: {
        url: location.href,
        title: article.title ?? document.title ?? null,
        content: article.textContent ?? '',
        excerpt: article.excerpt ?? null,
        byline: article.byline ?? null,
        dwellMs: Math.round(performance.now() - viewStart),
        capturedAt: Date.now(),
        reason,
      },
    });
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

document.addEventListener('recall:nav', scheduleNavCapture);
window.addEventListener('pageshow', (e) => {
  if ((e as PageTransitionEvent).persisted) capture('bfcache');
});

capture('load');
