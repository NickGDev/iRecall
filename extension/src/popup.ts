const SERVER = 'http://127.0.0.1:8787';

interface ExtConfig {
  enabled: boolean;
  blockedDomains: string[];
  allowedDomains: string[];
}

interface LogEntry {
  ts: number;
  kind: string;
  detail: string;
}

interface BlockedDomain {
  domain: string;
  pages: number;
}

const els = {
  toggle: document.getElementById('toggle') as HTMLButtonElement,
  stats: document.getElementById('stats') as HTMLParagraphElement,
  logs: document.getElementById('logs') as HTMLDivElement,
  clearLogs: document.getElementById('clear-logs') as HTMLButtonElement,
  pageStatus: document.getElementById('page-status') as HTMLParagraphElement,
  pageHost: document.getElementById('page-host') as HTMLParagraphElement,
  pageNote: document.getElementById('page-note') as HTMLParagraphElement,
  teachBtn: document.getElementById('teach-btn') as HTMLButtonElement,
  blockBtn: document.getElementById('block-btn') as HTMLButtonElement,
  deleteBtn: document.getElementById('delete-pages-btn') as HTMLButtonElement,
  dashboard: document.getElementById('dashboard-link') as HTMLAnchorElement,
};

const KIND_LABEL: Record<string, string> = {
  capture: 'captured',
  sync: 'sync',
  skip: 'skip',
  error: 'error',
  paused: 'paused',
  resumed: 'resumed',
  config: 'config',
};

function kindClass(kind: string): string {
  if (KIND_LABEL[kind] === undefined) return 'kind-other';
  if (kind === 'capture') return 'kind-capture';
  if (kind === 'sync') return 'kind-sync';
  if (kind === 'skip') return 'kind-skip';
  if (kind === 'error') return 'kind-error';
  return 'kind-other';
}

function renderLogs(entries: LogEntry[]): void {
  els.logs.textContent = '';
  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'no activity yet';
    els.logs.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'log-row';
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const kind = document.createElement('span');
    kind.className = `log-kind ${kindClass(entry.kind)}`;
    kind.textContent = KIND_LABEL[entry.kind] ?? entry.kind;
    const detail = document.createElement('span');
    detail.className = 'log-detail';
    detail.textContent = entry.detail;
    detail.title = entry.detail;
    row.append(time, kind, detail);
    els.logs.appendChild(row);
  }
}

async function loadStats(token: string): Promise<void> {
  try {
    const res = await fetch(`${SERVER}/stats`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(String(res.status));
    const stats = (await res.json()) as { pages: number; domains: number; dbBytes: number };
    els.stats.textContent = `${stats.pages.toLocaleString()} pages, ${stats.domains} sites, ${(
      stats.dbBytes / 1048576
    ).toFixed(1)} MB`;
  } catch {
    els.stats.textContent = '';
    const err = document.createElement('span');
    err.className = 'err';
    err.textContent = 'server not reachable';
    els.stats.append(err, document.createTextNode(', start it with npm run dev'));
  }
}

// --- current page status -----------------------------------------------------

let currentHost: string | null = null;

function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function blockedList(): Promise<string[]> {
  const { blocked } = (await chrome.storage.local.get('blocked')) as {
    blocked?: { domains?: string[] };
  };
  const list = blocked?.domains;
  return Array.isArray(list) ? list : [];
}

// Notes are sticky: action feedback must survive the re-render that our own
// storage write triggers (storage.onChanged → render). Only a context change
// (server/pause) replaces the note.
let noteCtx = '';

async function renderPagePanel(token: string | undefined, enabled: boolean): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(tab?.url);
  currentHost = host;
  els.pageHost.textContent = host ?? 'not a web page';

  let status: string;
  let note = '';
  let blocked = false;

  if (!token) {
    status = 'Server not connected';
    note = 'start the server, then reopen this popup';
  } else if (!enabled) {
    status = 'Recording paused';
  } else if (tab?.id != null) {
    const { tabState } = (await chrome.storage.session.get('tabState')) as {
      tabState?: Record<string, { status?: string }>;
    };
    const st = tabState?.[String(tab.id)];
    const list = await blockedList();
    blocked = host !== null && list.includes(host);
    if (st?.status === 'saved') {
      status = 'Saved to iRecall';
    } else if (st?.status === 'blocked') {
      status = 'Site blocked';
      blocked = true;
    } else if (st?.status === 'password') {
      status = 'Login page, skipped';
    } else if (st?.status === 'thin') {
      status = 'Too little readable text';
    } else if (st?.status === 'filtered') {
      status = 'Off-focus, not stored';
      note = 'captured, but the focus filter kept it out. Use "Keep pages like this" to teach the filter.';
    } else if (blocked) {
      status = 'Site blocked';
    } else {
      status = 'Not captured';
      note = 'very short pages and non-web pages are never captured';
    }
  } else {
    status = 'Not captured';
  }

  els.pageStatus.textContent = status;
  const ctx = `${token ? 1 : 0}|${enabled ? 1 : 0}`;
  if (ctx !== noteCtx) {
    els.pageNote.textContent = note;
    els.pageNote.classList.remove('warn');
    noteCtx = ctx;
  }

  const canManage = host !== null && token !== undefined;
  els.teachBtn.hidden = !canManage;
  els.blockBtn.hidden = !canManage;
  if (canManage) {
    const list = await blockedList();
    const isBlocked = list.includes(host as string);
    els.blockBtn.textContent = isBlocked ? 'Unblock site' : 'Block site';
    els.blockBtn.classList.toggle('btn-primary', !isBlocked);
  }
  els.deleteBtn.hidden = true;
}

// --- actions -----------------------------------------------------------------

async function withBtn(btn: HTMLButtonElement, label: string, fn: () => Promise<void>): Promise<void> {
  btn.disabled = true;
  const before = btn.textContent;
  btn.textContent = label;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    if (before !== null) btn.textContent = before;
  }
}

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const { token } = (await chrome.storage.local.get('token')) as { token?: string };
  const res = await fetch(`${SERVER}${path}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()) as T;
}

async function putBlockList(domains: string[]): Promise<BlockedDomain[]> {
  const out = await api<{ domains: BlockedDomain[] }>('/api/blocked', {
    method: 'PUT',
    body: JSON.stringify({ domains }),
  });
  // Optimistic mirror; the hourly sync repairs any divergence.
  await chrome.storage.local.set({ blocked: { domains: out.domains.map((d) => d.domain) } });
  return out.domains;
}

els.teachBtn.addEventListener('click', () => {
  void withBtn(els.teachBtn, 'teaching…', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id == null) return;
    let page: { url?: unknown; content?: unknown } | null = null;
    try {
      page = (await chrome.tabs.sendMessage(tab.id, { type: 'teach' })) as {
        url?: unknown;
        content?: unknown;
      } | null;
    } catch {
      // no content script (non-web page or unloaded tab)
    }
    if (!page || typeof page.url !== 'string' || typeof page.content !== 'string' || page.content.length === 0) {
      els.pageNote.textContent = 'could not read this page, nothing taught';
      els.pageNote.classList.add('warn');
      return;
    }
    try {
      await api('/api/exemplars', { method: 'POST', body: JSON.stringify(page) });
      els.pageNote.textContent = 'taught — pages like this will be kept';
      els.pageNote.classList.remove('warn');
    } catch {
      els.pageNote.textContent = 'teach failed, server error';
      els.pageNote.classList.add('warn');
    }
  });
});

els.blockBtn.addEventListener('click', () => {
  void withBtn(els.blockBtn, 'working…', async () => {
    if (!currentHost) return;
    const list = await blockedList();
    const wasBlocked = list.includes(currentHost);
    const next = wasBlocked ? list.filter((d) => d !== currentHost) : [...list, currentHost];
    try {
      const out = await putBlockList(next);
      if (wasBlocked) {
        els.blockBtn.textContent = 'Block site';
        els.blockBtn.classList.add('btn-primary');
        els.pageNote.textContent = `unblocked ${currentHost}`;
        els.pageNote.classList.remove('warn');
      } else {
        els.blockBtn.textContent = 'Unblock site';
        els.blockBtn.classList.remove('btn-primary');
        els.pageNote.textContent = `blocked ${currentHost}, future pages on it are skipped`;
        els.pageNote.classList.remove('warn');
        const hit = out.find((d) => d.domain === currentHost);
        if (hit && hit.pages > 0) {
          els.deleteBtn.textContent = `Delete ${hit.pages} stored page${hit.pages === 1 ? '' : 's'}`;
          els.deleteBtn.hidden = false;
        }
      }
    } catch {
      els.pageNote.textContent = 'server unreachable, nothing changed';
      els.pageNote.classList.add('warn');
    }
  });
});

els.deleteBtn.addEventListener('click', () => {
  void withBtn(els.deleteBtn, 'deleting…', async () => {
    if (!currentHost) return;
    try {
      const out = await api<{ deleted: number }>(`/pages?domain=${encodeURIComponent(currentHost)}`, {
        method: 'DELETE',
      });
      els.deleteBtn.hidden = true;
      els.pageNote.textContent = `deleted ${out.deleted} stored page${out.deleted === 1 ? '' : 's'}`;
    } catch {
      els.pageNote.textContent = 'delete failed, server error';
      els.pageNote.classList.add('warn');
    }
  });
});

els.toggle.addEventListener('click', () => {
  void withBtn(els.toggle, '…', async () => {
    const { config, token } = (await chrome.storage.local.get(['config', 'token'])) as {
      config?: ExtConfig;
      token?: string;
    };
    const next = !(config?.enabled !== false);
    if (token) {
      try {
        await fetch(`${SERVER}/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ recording: next }),
        });
      } catch {
        // server unreachable: keep the old state, say so, the server is the
        // gate at ingest, so a local-only flip would lie about recording.
        els.pageNote.textContent = 'server unreachable, still in the previous state';
        els.pageNote.classList.add('warn');
        return;
      }
    }
    await chrome.storage.local.set({ config: { ...config, enabled: next } });
    await render();
  });
});

els.clearLogs.addEventListener('click', async () => {
  await chrome.storage.local.set({ logs: [] });
  await render();
});

// A plain <a href> click just closes the popup — nothing opens. Hand the URL
// to a real tab instead; href stays as the no-JS fallback.
els.dashboard.addEventListener('click', (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: els.dashboard.href });
});

// --- render ------------------------------------------------------------------

async function render(): Promise<void> {
  const { config, token, logs } = (await chrome.storage.local.get(['config', 'token', 'logs'])) as {
    config?: ExtConfig;
    token?: string;
    logs?: LogEntry[];
  };
  const enabled = config?.enabled !== false;
  els.toggle.textContent = enabled ? 'Recording' : 'Paused';
  els.toggle.className = `pill ${enabled ? 'on' : 'off'}`;
  els.toggle.setAttribute('aria-pressed', String(enabled));
  renderLogs(logs ?? []);
  await renderPagePanel(token, enabled);
  if (!token) {
    els.stats.textContent = 'server not connected';
    return;
  }
  await loadStats(token);
}

// Live: captures, skips and config flips arrive while the popup is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.logs || changes.config || changes.blocked || changes.token) void render();
});

render();

export {};
