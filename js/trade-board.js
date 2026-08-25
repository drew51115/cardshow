// js/trade-board.js
// Venue monitor view for trade-board.html — read-only, no auth required
// (trade_posts/trade_zone_shows are both publicly SELECTable per RLS).
// Auto-paginates a large-type feed of open posts and highlights new ones
// as they arrive via Realtime.
//
// Also serves as the Phase 6 organizer report when loaded with ?report=1
// — a simple aggregate view (trade count, most-traded cards, share count)
// for the resolved show. Same page, so the venue doesn't need a second
// deploy target for something an organizer will only glance at.

const TB = {
  show: null,
  posts: [],       // all non-expired posts for this show, newest first
  page: 0,
  pageSize: 6,
  paginateTimer: null,
  newPostIds: new Set(),
};

async function tbInit() {
  const params = new URLSearchParams(location.search);
  const isReport = params.get('report') === '1';

  try {
    await tbResolveShow(params.get('show'));
    document.getElementById('tbShowName').textContent = TB.show.name;
    document.getElementById('tbShowLocation').textContent = TB.show.location || '';

    if (isReport) {
      document.getElementById('tbBoardCounts').style.display = 'none';
      document.getElementById('tbBoardView').style.display = 'none';
      document.getElementById('tbReportView').style.display = 'block';
      await tbRenderReport();
    } else {
      document.getElementById('tbReportView').style.display = 'none';
      document.getElementById('tbBoardView').style.display = 'block';
      await tbFetchPosts();
      tbRenderCounts();
      tbStartPagination();
      tbWireRealtime();
    }
  } catch (err) {
    console.error('[trade-board] init failed:', err);
    document.getElementById('tbFatalError').textContent = err.message;
    document.getElementById('tbFatalError').style.display = 'block';
  }
}

async function tbResolveShow(explicitId) {
  const { data: shows, error } = await db
    .from('trade_zone_shows')
    .select('*')
    .order('starts_at', { ascending: true });
  if (error) throw new Error('Could not load shows: ' + error.message);
  if (!shows || !shows.length) throw new Error('No Trade Zone shows are set up yet.');

  if (explicitId) {
    const match = shows.find(s => s.id === explicitId);
    if (match) { TB.show = match; return; }
  }

  const now = Date.now();
  TB.show = shows.find(s => now >= new Date(s.starts_at).getTime() && now <= new Date(s.ends_at).getTime())
    || shows.filter(s => new Date(s.starts_at).getTime() > now).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0]
    || shows[shows.length - 1];
}

// ─────────────────────────────────────────────────────────
// BOARD MODE
// ─────────────────────────────────────────────────────────

async function tbFetchPosts() {
  const { data, error } = await db
    .from('trade_posts')
    .select('*')
    .eq('show_id', TB.show.id)
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) { console.warn('[trade-board] fetch posts failed:', error.message); return; }
  TB.posts = data || [];
  tbRenderPage();
}

async function tbRenderCounts() {
  const { count: postCount } = await db
    .from('trade_posts')
    .select('id', { count: 'exact', head: true })
    .eq('show_id', TB.show.id);

  const { count: tradeCount } = await db
    .from('trades')
    .select('id', { count: 'exact', head: true })
    .eq('show_id', TB.show.id)
    .not('confirmed_at', 'is', null);

  document.getElementById('tbPostCount').textContent = postCount ?? 0;
  document.getElementById('tbTradeCount').textContent = tradeCount ?? 0;
}

function tbWireRealtime() {
  db.channel(`tb_trade_posts_${TB.show.id}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'trade_posts', filter: `show_id=eq.${TB.show.id}` },
      (payload) => {
        TB.posts.unshift(payload.new);
        TB.newPostIds.add(payload.new.id);
        TB.page = 0;
        tbRenderPage();
        tbRenderCounts();
        setTimeout(() => TB.newPostIds.delete(payload.new.id), 4000);
      })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'trade_posts', filter: `show_id=eq.${TB.show.id}` },
      (payload) => {
        const idx = TB.posts.findIndex(p => p.id === payload.new.id);
        if (idx !== -1) TB.posts[idx] = payload.new;
        tbRenderPage();
      })
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'trades', filter: `show_id=eq.${TB.show.id}` },
      () => tbRenderCounts())
    .subscribe();
}

function tbStartPagination() {
  clearInterval(TB.paginateTimer);
  TB.paginateTimer = setInterval(() => {
    const totalPages = Math.max(1, Math.ceil(tbActivePosts().length / TB.pageSize));
    TB.page = (TB.page + 1) % totalPages;
    tbRenderPage();
  }, 8000);
}

function tbActivePosts() {
  return TB.posts.filter(p => p.status !== 'expired');
}

const TB_CONDITION_LABELS = { raw: 'Raw', psa10: 'PSA 10', psa9: 'PSA 9', bgs: 'BGS', other: 'Other' };

function tbRenderPage() {
  const active = tbActivePosts();
  const grid = document.getElementById('tbBoardGrid');
  if (!active.length) {
    grid.innerHTML = `<div class="tb-empty">No posts yet — waiting on the first card…</div>`;
    return;
  }
  const start = TB.page * TB.pageSize;
  const slice = active.slice(start, start + TB.pageSize);

  grid.innerHTML = slice.map(p => `
    <div class="tb-card ${TB.newPostIds.has(p.id) ? 'tb-card-new' : ''}">
      <img class="tb-card-img" src="${p.thumb_url}" alt="">
      <div class="tb-card-body">
        <div class="tb-card-name">${tbEsc(p.card_name)}</div>
        <div class="tb-card-meta">
          ${TB_CONDITION_LABELS[p.condition] ? `<span class="tb-badge">${TB_CONDITION_LABELS[p.condition]}</span>` : ''}
          <span class="tb-badge tb-status-${p.status}">${p.status}</span>
        </div>
        ${p.looking_for ? `<div class="tb-card-looking">Wants: ${tbEsc(p.looking_for)}</div>` : ''}
      </div>
    </div>
  `).join('');

  const totalPages = Math.max(1, Math.ceil(active.length / TB.pageSize));
  document.getElementById('tbPageIndicator').textContent = totalPages > 1 ? `${TB.page + 1} / ${totalPages}` : '';
}

function tbEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─────────────────────────────────────────────────────────
// REPORT MODE (Phase 6 — organizer reporting)
// ─────────────────────────────────────────────────────────

async function tbRenderReport() {
  const [{ data: posts }, { data: trades }] = await Promise.all([
    db.from('trade_posts').select('card_name, status').eq('show_id', TB.show.id),
    db.from('trades').select('id, confirmed_at').eq('show_id', TB.show.id),
  ]);

  const allPosts = posts || [];
  const allTrades = trades || [];
  const confirmedTrades = allTrades.filter(t => t.confirmed_at);

  document.getElementById('tbRptPostCount').textContent = allPosts.length;
  document.getElementById('tbRptTradeCount').textContent = confirmedTrades.length;

  let shareCount = 0;
  if (allTrades.length) {
    const { count } = await db
      .from('share_events')
      .select('id', { count: 'exact', head: true })
      .in('trade_id', allTrades.map(t => t.id));
    shareCount = count ?? 0;
  }
  document.getElementById('tbRptShareCount').textContent = shareCount;

  // Most-traded cards: group traded posts by normalized card_name.
  const counts = {};
  allPosts.filter(p => p.status === 'traded').forEach(p => {
    const key = String(p.card_name || '').trim().toLowerCase();
    if (!key) return;
    counts[key] = (counts[key] || 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const listEl = document.getElementById('tbRptTopCards');
  listEl.innerHTML = top.length
    ? top.map(([name, n]) => `<li><span>${tbEsc(name)}</span><span class="tb-rpt-count">${n}×</span></li>`).join('')
    : '<li class="tb-empty">No completed trades yet</li>';
}

document.addEventListener('DOMContentLoaded', tbInit);
