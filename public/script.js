// ── State ─────────────────────────────────────────────────────────────────────
const API = '';
let _token    = localStorage.getItem('pulsar_token')    || '';
let _username = localStorage.getItem('pulsar_username') || '';
let _isAdmin  = localStorage.getItem('pulsar_admin') === 'true';
let _coinsData     = [];
let _portfolioData = null;
let _currentTab    = 'market';
let _refreshTimer  = null;
let _watchlist     = [];
let _activePf      = 'default';
let _portfolioNames = ['default'];
let _currency = localStorage.getItem('pulsar_currency') || 'USD';
let _nokRate  = 10.5;

const COLOR = {
  green:  '#2E6F4F',
  red:    '#C0392B',
  yellow: '#B07A12',
  accent: '#B4471F',
};

// ── Auth helpers ──────────────────────────────────────────────────────────────
function authHdrs() {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_token}` };
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, opts);
  if (res.status === 401) { doLogout(); return null; }
  return res;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, ok = true) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.background = ok ? COLOR.green : COLOR.red;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Login / Logout ────────────────────────────────────────────────────────────
async function doLogin() {
  const user = document.getElementById('loginUser').value.trim();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  try {
    const res = await fetch(API + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    if (!res.ok) {
      errEl.textContent = 'Invalid username or password.';
      errEl.classList.remove('hidden');
      return;
    }
    const data = await res.json();
    _token    = data.access_token;
    _username = data.username;
    _isAdmin  = data.is_admin;
    localStorage.setItem('pulsar_token',    _token);
    localStorage.setItem('pulsar_username', _username);
    localStorage.setItem('pulsar_admin',    _isAdmin);
    showApp();
  } catch {
    errEl.textContent = 'Cannot reach the server.';
    errEl.classList.remove('hidden');
  }
}

document.getElementById('loginPass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function doLogout() {
  _token = ''; _username = ''; _isAdmin = false;
  localStorage.removeItem('pulsar_token');
  localStorage.removeItem('pulsar_username');
  localStorage.removeItem('pulsar_admin');
  clearInterval(_refreshTimer);
  document.getElementById('app').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
}

// ── Account: self-service password change ──────────────────────────────────────
function openPasswordModal() {
  document.getElementById('curPass').value = '';
  document.getElementById('newPass2').value = '';
  const msg = document.getElementById('passwordMsg');
  msg.classList.add('hidden');
  document.getElementById('passwordModal').classList.remove('hidden');
}

function closePasswordModal() {
  document.getElementById('passwordModal').classList.add('hidden');
}

async function changePassword() {
  const current_password = document.getElementById('curPass').value;
  const new_password = document.getElementById('newPass2').value;
  const msg = document.getElementById('passwordMsg');
  if (!new_password) {
    msg.textContent = 'New password cannot be empty.';
    msg.className = 'err-msg';
    return;
  }
  // Raw fetch (not apiFetch): a wrong current password returns 401, which we
  // surface inline instead of force-logging-out the user.
  const res = await fetch(API + '/api/auth/password', {
    method: 'POST',
    headers: authHdrs(),
    body: JSON.stringify({ current_password, new_password }),
  });
  if (res && res.ok) {
    msg.textContent = 'Password updated.';
    msg.className = 'ok-msg';
    setTimeout(closePasswordModal, 1000);
  } else {
    msg.textContent = 'Current password is incorrect.';
    msg.className = 'err-msg';
  }
}

// ── App bootstrap ─────────────────────────────────────────────────────────────
function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('navUser').textContent = _username;
  document.getElementById('navUser').classList.remove('hidden');
  if (_isAdmin) {
    document.getElementById('navAdmin').classList.remove('hidden');
    document.getElementById('adminTab').style.display = '';
  }
  loadMarket();
  loadFearGreed();
  loadCoins();
  loadWatchlist();
  loadPortfolioNames();
  loadPortfolio();
  _refreshTimer = setInterval(() => {
    loadCoins();
    loadFearGreed();
    loadMarket();
    if (_currentTab === 'portfolio') loadPortfolio();
    if (_currentTab === 'signals')   loadSignals();
    if (_currentTab === 'admin')     loadUsers();
    if (_currentTab === 'news')      loadNews();
  }, 60_000);
}

if (_token) showApp();

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  _currentTab = name;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  ['market','signals','portfolio','news','admin'].forEach(t =>
    document.getElementById(`tab-${t}`).classList.toggle('hidden', t !== name)
  );
  if (name === 'signals')   loadSignals();
  if (name === 'portfolio') loadPortfolio();
  if (name === 'news')      loadNews();
  if (name === 'admin')     loadUsers();
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtPrice(n) {
  if (n >= 1000) return '$' + n.toLocaleString('en', { maximumFractionDigits: 0 });
  if (n >= 1)    return '$' + n.toFixed(2);
  return '$' + n.toFixed(6);
}
function fmtPct(n) {
  const cls = n >= 0 ? 'pos' : 'neg';
  return `<span class="${cls}">${n >= 0 ? '+' : ''}${n.toFixed(2)}%</span>`;
}
function fmtUsd(n) {
  return '$' + n.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtNok(n) {
  return 'kr ' + Math.round(n).toLocaleString('nb-NO');
}
function fmtVal(usd, nok) {
  return _currency === 'NOK' ? fmtNok(nok ?? (usd * _nokRate)) : fmtUsd(usd);
}
function toggleCurrency() {
  _currency = _currency === 'USD' ? 'NOK' : 'USD';
  localStorage.setItem('pulsar_currency', _currency);
  const btn = document.getElementById('currencyToggle');
  if (btn) btn.textContent = _currency === 'NOK' ? 'Show in USD' : 'Show in NOK';
  renderPortfolio();
}
function fmtLarge(n) {
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(1) + 'M';
  return '$' + n.toFixed(0);
}
function signalTag(sig) {
  const map = {
    strong_buy: ['tag-strong-buy', 'STRONG BUY'],
    buy:        ['tag-buy',        'BUY'],
    neutral:    ['tag-neutral',    'NEUTRAL'],
    caution:    ['tag-caution',    'CAUTION'],
    sell:       ['tag-sell',       'SELL'],
    hold:       ['tag-hold',       'HOLD'],
  };
  const [cls, label] = map[sig] || ['tag-neutral', sig.toUpperCase()];
  return `<span class="tag ${cls}">${label}</span>`;
}

function sparkline(prices, w = 64, h = 28) {
  if (!prices || prices.length < 2) return '';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * w;
    const y = h - ((p - min) / range) * (h - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = prices[prices.length - 1] >= prices[0];
  const stroke = up ? COLOR.green : COLOR.red;
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="display:block">` +
    `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5" ` +
    `stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function historyChart(points, w = 600, h = 80) {
  if (!points || points.length < 2) return '<div class="bt-none">Not enough history yet.</div>';
  const vals = points.map(p => p.total_value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * (w - 4) + 2;
    const y = h - ((v - min) / range) * (h - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = vals[vals.length - 1] >= vals[0];
  const stroke = up ? COLOR.green : COLOR.red;
  const first = points[0].date;
  const last = points[points.length - 1].date;
  const curVal = vals[vals.length - 1];
  return `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px">
      <polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="chart-foot">
      <span>${first}</span>
      <span class="${up ? 'pos' : 'neg'}" style="font-weight:700">${fmtUsd(curVal)}</span>
      <span>${last}</span>
    </div>`;
}

// ── Plain-language indicator helpers ─────────────────────────────────────────
function rsiLabel(v) {
  if (v == null) return '—';
  if (v < 30) return `Oversold (${v.toFixed(0)})`;
  if (v < 45) return `Below average (${v.toFixed(0)})`;
  if (v < 55) return `Neutral (${v.toFixed(0)})`;
  if (v < 70) return `Healthy (${v.toFixed(0)})`;
  return `Overbought (${v.toFixed(0)})`;
}
function macdLabel(v) {
  if (v == null) return '—';
  if (v > 50)  return 'Strong uptrend';
  if (v > 0)   return 'Mild uptrend';
  if (v > -50) return 'Mild downtrend';
  return 'Strong downtrend';
}
function bbLabel(v) {
  if (v == null) return '—';
  const p = v * 100;
  if (p < 20) return `Near support (${p.toFixed(0)}%)`;
  if (p < 40) return `Lower range (${p.toFixed(0)}%)`;
  if (p < 60) return `Mid-range (${p.toFixed(0)}%)`;
  if (p < 80) return `Upper range (${p.toFixed(0)}%)`;
  return `Near resistance (${p.toFixed(0)}%)`;
}
function indicatorColor(label) {
  if (!label || label === '—') return '';
  const l = label.toLowerCase();
  if (l.includes('oversold') || l.includes('strong up') || l.includes('near support') || l.includes('healthy')) return 'pos';
  if (l.includes('overbought') || l.includes('strong down') || l.includes('near resistance')) return 'neg';
  if (l.includes('mild up') || l.includes('lower range')) return 'pos';
  if (l.includes('mild down')) return 'neg';
  return '';
}

// ── Watchlist ─────────────────────────────────────────────────────────────────
async function loadWatchlist() {
  const res = await apiFetch('/api/watchlist', { headers: authHdrs() });
  if (!res || !res.ok) return;
  _watchlist = await res.json();
  renderCoinStars();
}

function renderCoinStars() {
  document.querySelectorAll('.star-btn[data-coin]').forEach(btn => {
    const id = btn.dataset.coin;
    btn.textContent = _watchlist.includes(id) ? '★' : '☆';
    btn.classList.toggle('watched', _watchlist.includes(id));
  });
}

async function toggleWatchlist(coinId) {
  const watched = _watchlist.includes(coinId);
  const method = watched ? 'DELETE' : 'POST';
  const res = await apiFetch(`/api/watchlist/${coinId}`, { method, headers: authHdrs() });
  if (!res || !res.ok) return;
  _watchlist = await res.json();
  renderCoinStars();
  toast(watched ? `Removed ${coinId} from watchlist` : `Added ${coinId} to watchlist`);
}

// ── Market tab ────────────────────────────────────────────────────────────────
async function loadMarket() {
  const res = await apiFetch('/api/market');
  if (!res || !res.ok) return;
  const d = await res.json();
  document.getElementById('marketStats').innerHTML = `
    <div>
      <div class="stat-label">Market Cap</div>
      <div class="stat-val">${fmtLarge(d.total_market_cap)}</div>
    </div>
    <div>
      <div class="stat-label">24h Volume</div>
      <div class="stat-val">${fmtLarge(d.total_volume_24h)}</div>
    </div>
    <div>
      <div class="stat-label">BTC Dom</div>
      <div class="stat-val">${d.btc_dominance}%</div>
    </div>
    <div>
      <div class="stat-label">Advancing / Declining</div>
      <div><span class="pos" style="font-weight:700">${d.advancing}</span><span style="color:var(--ink-3)"> / </span><span class="neg" style="font-weight:700">${d.declining}</span></div>
    </div>
  `;
}

async function loadFearGreed() {
  const res = await apiFetch('/api/feargreed');
  if (!res || !res.ok) return;
  const d = await res.json();
  const v = d.value;
  const colour = v < 25 ? COLOR.red : v < 50 ? COLOR.accent : v < 75 ? COLOR.yellow : COLOR.green;
  const offset = Math.round(220 - (v / 100) * 220);
  document.getElementById('fgGauge').innerHTML = `
    <svg viewBox="0 0 160 90" style="width:12rem">
      <path d="M10,80 A70,70 0 0,1 150,80" fill="none" stroke="var(--line-soft)" stroke-width="12" stroke-linecap="round"/>
      <path d="M10,80 A70,70 0 0,1 150,80" fill="none" stroke="${colour}" stroke-width="12" stroke-linecap="round"
            stroke-dasharray="220" stroke-dashoffset="${offset}" style="transition:stroke-dashoffset 0.6s ease"/>
    </svg>
    <div class="gauge-val" style="color:${colour}">${v}</div>
    <div class="gauge-label" style="color:${colour}">${d.classification}</div>
    <div class="gauge-interp">${d.interpretation}</div>
    <div class="gauge-sub">
      <div class="gauge-sub-item"><div class="l">Yesterday</div><div class="v">${d.yesterday}</div></div>
      <div class="gauge-sub-item"><div class="l">Last week</div><div class="v">${d.last_week}</div></div>
    </div>
    <div style="margin-top:1rem; width:100%">
      <div class="stat-label" style="margin-bottom:0.5rem">Market Score</div>
      <div class="score-bar-row">
        <div class="score-bar"><div class="score-bar-fill" style="width:${d.market_score.score}%"></div></div>
        <span class="score-val">${d.market_score.score}</span>
        ${signalTag(d.market_score.verdict)}
      </div>
      <ul class="score-reasons">
        ${d.market_score.reasons.map(r => `<li>· ${r}</li>`).join('')}
      </ul>
    </div>
  `;
}

async function loadCoins() {
  const res = await apiFetch('/api/coins');
  if (!res || !res.ok) return;
  const d = await res.json();
  _coinsData = d.coins;

  const sel = document.getElementById('tradeCoin');
  if (sel) {
    const prev = sel.value;
    sel.innerHTML = d.coins
      .map(c => `<option value="${c.id}">${c.name} (${c.symbol.toUpperCase()})</option>`)
      .join('');
    if (prev) sel.value = prev;
  }

  const bSel = document.getElementById('backtestCoin');
  if (bSel) {
    const prev = bSel.value;
    bSel.innerHTML = d.coins
      .map(c => `<option value="${c.id}">${c.name} (${c.symbol.toUpperCase()})</option>`)
      .join('');
    if (prev) bSel.value = prev;
  }

  document.getElementById('coinList').innerHTML = d.coins.map(c => {
    const ind    = c.indicators || {};
    const rsiLbl = rsiLabel(ind.rsi);
    const macdLbl= macdLabel(ind.macd_histogram);
    const bbLbl  = bbLabel(ind.bb_position);
    const isWatched = _watchlist.includes(c.id);
    return `
      <div class="card coin-card">
        <div class="coin-card-top">
          <div class="coin-id">
            ${c.image ? `<img src="${c.image}" class="coin-icon" alt="${c.symbol}" />` : ''}
            <div>
              <div><span class="coin-name">${c.name}</span> <span class="coin-sym">${c.symbol.toUpperCase()}</span></div>
              <div class="coin-price">${fmtPrice(c.price)}</div>
            </div>
          </div>
          <div class="coin-right">
            ${sparkline(c.price_history_7d)}
            ${signalTag(c.signal)}
            <span style="font-size:0.75rem">${fmtPct(c.change_24h)}</span>
            <button class="star-btn ${isWatched ? 'watched' : ''}" data-coin="${c.id}"
              onclick="toggleWatchlist('${c.id}')" title="${isWatched ? 'Remove from watchlist' : 'Add to watchlist'}">
              ${isWatched ? '★' : '☆'}
            </button>
          </div>
        </div>
        <div class="ind-grid">
          <div class="ind-box">
            <div class="ind-box-label">Momentum</div>
            <div class="ind-box-val ${indicatorColor(rsiLbl)}">${rsiLbl}</div>
          </div>
          <div class="ind-box">
            <div class="ind-box-label">Trend</div>
            <div class="ind-box-val ${indicatorColor(macdLbl)}">${macdLbl}</div>
          </div>
          <div class="ind-box">
            <div class="ind-box-label">Price Range</div>
            <div class="ind-box-val ${indicatorColor(bbLbl)}">${bbLbl}</div>
          </div>
        </div>
        <div class="coin-meta">
          7d ${fmtPct(c.change_7d)} &nbsp;·&nbsp; Cap ${fmtLarge(c.market_cap)} &nbsp;·&nbsp; Vol ${fmtLarge(c.volume_24h)}
        </div>
      </div>`;
  }).join('');
}

// ── Signals tab ───────────────────────────────────────────────────────────────
async function loadSignals() {
  const el = document.getElementById('signalsTable');
  el.innerHTML = '<div class="spinner-row"><div class="spinner"></div><span>Loading…</span></div>';
  const res = await apiFetch('/api/signals');
  if (!res || !res.ok) {
    el.innerHTML = '<div class="card-pad neg">Failed to load signals.</div>';
    return;
  }
  const d = await res.json();
  el.innerHTML = `
    <table class="tbl">
      <thead>
        <tr>
          <th>Coin</th>
          <th>Signal</th>
          <th>Score</th>
          <th title="Per-coin Ridge regression. Experimental — not a forecast.">AI Score <span class="muted-cell">(experimental)</span></th>
          <th>Overall</th>
          <th>Why?</th>
        </tr>
      </thead>
      <tbody>
        ${d.signals.map(s => `
          <tr>
            <td style="font-weight:700">${s.symbol.toUpperCase()}</td>
            <td>${signalTag(s.signal)}</td>
            <td class="num">${s.signal_score.toFixed(0)}</td>
            <td class="num muted-cell">${s.ml_score != null ? s.ml_score.toFixed(0) : '—'}${s.ml_quality != null ? `<span class="muted-cell" title="In-sample directional hit-rate"> (${s.ml_quality.toFixed(0)}%)</span>` : ''}</td>
            <td>${signalTag(s.composite_verdict)} <span class="num muted-cell">${s.composite_score.toFixed(0)}</span></td>
            <td class="muted-cell" style="font-size:0.72rem">${(s.reasons || []).join(' · ')}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <div class="tbl-foot">Updated ${new Date(d.updated_at).toLocaleTimeString()}</div>
  `;
}

async function runBacktest() {
  const coinId = document.getElementById('backtestCoin').value;
  if (!coinId) return;
  const el = document.getElementById('backtestResult');
  el.innerHTML = '<div class="spinner-row"><div class="spinner"></div><span>Running…</span></div>';
  const res = await apiFetch(`/api/backtest/${coinId}`);
  if (!res || !res.ok) {
    el.innerHTML = '<div class="neg" style="font-size:0.85rem">Backtest failed — no OHLC data available.</div>';
    return;
  }
  const d = await res.json();
  function statCard(label, stats) {
    if (!stats || stats.count === 0) return `<div class="bt-stat"><div class="bt-stat-head">${label}</div><div class="bt-none">No signals</div></div>`;
    const wr = stats.win_rate;
    const wrCls = wr >= 55 ? 'pos' : wr < 45 ? 'neg' : '';
    const ar = stats.avg_return;
    const arCls = ar >= 0 ? 'pos' : 'neg';
    return `
      <div class="bt-stat">
        <div class="bt-stat-head">${label}</div>
        <div class="bt-stat-row">
          <div><div class="l">Signals</div><div class="v">${stats.count}</div></div>
          <div><div class="l">Win rate</div><div class="v ${wrCls}">${wr != null ? wr.toFixed(1) + '%' : '—'}</div></div>
          <div><div class="l">Avg return</div><div class="v ${arCls}">${ar != null ? (ar >= 0 ? '+' : '') + ar.toFixed(2) + '%' : '—'}</div></div>
        </div>
      </div>`;
  }
  el.innerHTML = `
    <div class="bt-meta">${d.total_signals} total signals · ${d.forward_days}-day forward window</div>
    <div class="bt-grid">
      ${statCard('Buy signals', d.buy)}
      ${statCard('Hold signals', d.hold)}
      ${statCard('Sell signals', d.sell)}
    </div>
    ${d.recent.length > 0 ? `
    <div class="bt-recent-head">Recent signals</div>
    <div class="bt-recent-wrap">
      <table class="tbl">
        <thead><tr><th>Date</th><th>Signal</th><th>Score</th><th>Entry</th><th>${d.forward_days}d return</th></tr></thead>
        <tbody>
          ${d.recent.slice().reverse().map(r => `
            <tr>
              <td class="muted-cell" style="font-size:0.72rem">${r.date}</td>
              <td>${signalTag(r.signal)}</td>
              <td class="num">${r.signal_score.toFixed(0)}</td>
              <td class="num">${fmtPrice(r.entry_price)}</td>
              <td class="num ${r.fwd_return >= 0 ? 'pos' : 'neg'}">${r.fwd_return >= 0 ? '+' : ''}${r.fwd_return.toFixed(2)}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}
  `;
}

// ── Portfolio tab ─────────────────────────────────────────────────────────────
async function loadPortfolioNames() {
  const res = await apiFetch('/api/portfolios', { headers: authHdrs() });
  if (!res || !res.ok) return;
  _portfolioNames = await res.json();
  renderPfSelector();
}

function renderPfSelector() {
  const sel = document.getElementById('pfSelector');
  if (!sel) return;
  sel.innerHTML = _portfolioNames.map(n =>
    `<option value="${n}" ${n === _activePf ? 'selected' : ''}>${n}</option>`
  ).join('');
  const deleteBtn = document.getElementById('deletePfBtn');
  if (deleteBtn) deleteBtn.disabled = _activePf === 'default';
}

async function switchPortfolio(name) {
  _activePf = name;
  renderPfSelector();
  await loadPortfolio();
}

async function createPortfolio() {
  const nameEl = document.getElementById('newPfName');
  const name = nameEl.value.trim().toLowerCase();
  if (!name) { toast('Enter a portfolio name', false); return; }
  const res = await apiFetch('/api/portfolios', {
    method: 'POST', headers: authHdrs(), body: JSON.stringify({ name }),
  });
  if (!res) return;
  if (!res.ok) { const err = await res.json(); toast(err.detail, false); return; }
  nameEl.value = '';
  _portfolioNames = await (await apiFetch('/api/portfolios', { headers: authHdrs() })).json();
  _activePf = name;
  renderPfSelector();
  await loadPortfolio();
  toast(`Portfolio "${name}" created`);
}

async function deletePortfolio() {
  if (_activePf === 'default') { toast('Cannot delete the default portfolio', false); return; }
  if (!confirm(`Delete portfolio "${_activePf}"? All data will be lost.`)) return;
  const res = await apiFetch(`/api/portfolios/${_activePf}`, { method: 'DELETE', headers: authHdrs() });
  if (!res || !res.ok) { toast('Failed to delete portfolio', false); return; }
  _activePf = 'default';
  _portfolioNames = await (await apiFetch('/api/portfolios', { headers: authHdrs() })).json();
  renderPfSelector();
  await loadPortfolio();
  toast(`Portfolio deleted`);
}

async function loadPortfolio() {
  const res = await apiFetch(`/api/portfolio?portfolio=${_activePf}`, { headers: authHdrs() });
  if (!res || !res.ok) return;
  _portfolioData = await res.json();
  if (_portfolioData.nok_rate) _nokRate = _portfolioData.nok_rate;
  const btn = document.getElementById('currencyToggle');
  if (btn) btn.textContent = _currency === 'NOK' ? 'Show in USD' : 'Show in NOK';
  renderPortfolio();
  loadRecommendations();
  loadPortfolioHistory();
}

async function loadPortfolioHistory() {
  const res = await apiFetch(`/api/portfolio/history?portfolio=${_activePf}`, { headers: authHdrs() });
  if (!res || !res.ok) return;
  const history = await res.json();
  document.getElementById('pfHistoryChart').innerHTML = historyChart(history);
}

function renderPortfolio() {
  if (!_portfolioData) return;
  const p = _portfolioData;
  const pnlCls = p.total_pnl >= 0 ? 'pos' : 'neg';
  const isCurrNok = _currency === 'NOK';

  document.getElementById('pfHero').innerHTML = `
    <div>
      <div class="stat-label">Total Value</div>
      <div class="stat-val-lg">${fmtVal(p.total_value, p.total_value_nok)}</div>
      ${isCurrNok ? '' : `<div class="stat-sub">${fmtNok(p.total_value_nok)}</div>`}
    </div>
    <div>
      <div class="stat-label">Cash Available</div>
      <div class="stat-val">${fmtVal(p.cash, p.cash_nok)}</div>
      ${isCurrNok ? '' : `<div class="stat-sub">${fmtNok(p.cash_nok)}</div>`}
    </div>
    <div>
      <div class="stat-label">Net Invested</div>
      <div class="stat-val">${fmtVal(p.net_invested, p.net_invested * _nokRate)}</div>
    </div>
    <div>
      <div class="stat-label">Profit / Loss</div>
      <div class="stat-val ${pnlCls}">${fmtVal(p.total_pnl, p.total_pnl_nok)} (${p.total_pnl_pct.toFixed(2)}%)</div>
    </div>
  `;

  if (p.holdings.length === 0) {
    document.getElementById('holdingsTable').innerHTML =
      '<div class="card-pad-lg bt-none">No holdings yet. Use the Trade panel to get started.</div>';
  } else {
    document.getElementById('holdingsTable').innerHTML = `
      <table class="tbl">
        <thead>
          <tr><th>Coin</th><th>Amount</th><th>You Paid</th><th>Current</th><th>Value</th><th>Profit/Loss</th></tr>
        </thead>
        <tbody>
          ${p.holdings.map(h => `
            <tr>
              <td>
                <div style="display:flex; align-items:center; gap:0.5rem">
                  ${h.image ? `<img src="${h.image}" style="width:20px;height:20px;border-radius:50%" />` : ''}
                  <span>${h.symbol.toUpperCase()}</span>
                </div>
              </td>
              <td class="num">${parseFloat(h.amount).toFixed(6)}</td>
              <td class="num">${fmtPrice(h.avg_buy_price)}</td>
              <td class="num">${fmtPrice(h.current_price)}</td>
              <td class="num">
                ${fmtVal(h.value, h.value_nok)}
                ${_currency === 'USD' ? `<div class="muted-cell" style="font-size:0.68rem">${fmtNok(h.value_nok)}</div>` : ''}
              </td>
              <td class="num ${h.pnl >= 0 ? 'pos' : 'neg'}">${fmtVal(h.pnl, h.pnl_nok)} (${h.pnl_pct.toFixed(2)}%)</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  if (p.transactions.length === 0) {
    document.getElementById('txnTable').innerHTML =
      '<div class="card-pad-lg bt-none">No transactions yet.</div>';
  } else {
    const txnTypeHtml = {
      buy:        '<span class="pos" style="font-weight:700">BUY</span>',
      sell:       '<span class="neg" style="font-weight:700">SELL</span>',
      deposit:    '<span style="color:var(--blue);font-weight:700">DEPOSIT</span>',
      withdrawal: '<span style="color:var(--yellow);font-weight:700">WITHDRAWAL</span>',
    };
    document.getElementById('txnTable').innerHTML = `
      <table class="tbl">
        <thead>
          <tr><th>ID</th><th>Type</th><th>Coin</th><th>Amount</th><th>Price</th><th>Total</th><th>Time</th></tr>
        </thead>
        <tbody>
          ${p.transactions.map(t => {
            const isTrade = t.type === 'buy' || t.type === 'sell';
            return `
            <tr>
              <td class="muted-cell" style="font-size:0.72rem">${t.id}</td>
              <td>${txnTypeHtml[t.type] || t.type.toUpperCase()}</td>
              <td>${isTrade ? t.coin_id.toUpperCase() : '<span class="muted-cell">—</span>'}</td>
              <td class="num">${isTrade ? parseFloat(t.amount).toFixed(6) : '<span class="muted-cell">—</span>'}</td>
              <td class="num">${isTrade ? fmtPrice(t.price) : '<span class="muted-cell">—</span>'}</td>
              <td class="num">${fmtUsd(t.total)}</td>
              <td class="muted-cell" style="font-size:0.72rem">${new Date(t.timestamp).toLocaleString()}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
  }
}

async function doTrade(type) {
  const coin_id    = document.getElementById('tradeCoin').value;
  const usd_amount = parseFloat(document.getElementById('tradeAmount').value);
  const msgEl      = document.getElementById('tradeMsg');
  if (!coin_id || isNaN(usd_amount) || usd_amount < 1) {
    msgEl.innerHTML = '<span class="neg">Enter a valid USD amount (min $1).</span>';
    return;
  }
  const res = await apiFetch(`/api/portfolio/${type}`, {
    method: 'POST',
    headers: authHdrs(),
    body: JSON.stringify({ coin_id, usd_amount, portfolio: _activePf }),
  });
  if (!res) return;
  if (!res.ok) {
    const err = await res.json();
    msgEl.innerHTML = `<span class="neg">${err.detail}</span>`;
    return;
  }
  _portfolioData = await res.json();
  if (_portfolioData.nok_rate) _nokRate = _portfolioData.nok_rate;
  renderPortfolio();
  loadPortfolioHistory();
  document.getElementById('tradeAmount').value = '';
  const verb = type === 'buy' ? 'Bought' : 'Sold';
  msgEl.innerHTML = `<span class="pos">&#x2713; ${verb} ${fmtUsd(usd_amount)} of ${coin_id.toUpperCase()}</span>`;
  toast(`${verb} ${fmtUsd(usd_amount)} of ${coin_id.toUpperCase()}`);
}

async function doFund(type) {
  const amount = parseFloat(document.getElementById('fundAmount').value);
  const msgEl  = document.getElementById('fundMsg');
  if (!amount || amount <= 0) {
    msgEl.innerHTML = '<span class="neg">Enter a positive amount.</span>';
    return;
  }
  const endpoint = type === 'deposit' ? '/api/portfolio/deposit' : '/api/portfolio/withdraw';
  const res = await apiFetch(endpoint, {
    method: 'POST',
    headers: authHdrs(),
    body: JSON.stringify({ amount, portfolio: _activePf }),
  });
  if (!res) return;
  if (!res.ok) {
    const err = await res.json();
    msgEl.innerHTML = `<span class="neg">${err.detail}</span>`;
    return;
  }
  _portfolioData = await res.json();
  if (_portfolioData.nok_rate) _nokRate = _portfolioData.nok_rate;
  renderPortfolio();
  loadPortfolioHistory();
  document.getElementById('fundAmount').value = '';
  const verb = type === 'deposit' ? 'Deposited' : 'Withdrew';
  msgEl.innerHTML = `<span class="pos">&#x2713; ${verb} ${fmtUsd(amount)}</span>`;
  toast(`${verb} ${fmtUsd(amount)}`);
}

async function resetPortfolio() {
  if (!confirm('Reset portfolio to $0? All holdings and transactions will be cleared. This cannot be undone.')) return;
  const res = await apiFetch(`/api/portfolio/reset?portfolio=${_activePf}`, {
    method: 'POST', headers: authHdrs(),
  });
  if (!res || !res.ok) return;
  _portfolioData = await res.json();
  if (_portfolioData.nok_rate) _nokRate = _portfolioData.nok_rate;
  renderPortfolio();
  loadPortfolioHistory();
  toast('Portfolio reset to $0');
}

function exportCsv() {
  if (!_portfolioData || !_portfolioData.transactions.length) {
    toast('No transactions to export.', false);
    return;
  }
  const rows = [['ID', 'Type', 'Coin', 'Amount', 'Price', 'Total', 'Timestamp']];
  for (const t of _portfolioData.transactions) {
    rows.push([t.id, t.type, t.coin_id, t.amount, t.price, t.total, t.timestamp]);
  }
  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `pulsar_portfolio_${_username}_${_activePf}.csv`;
  a.click();
}

// ── Recommendations ───────────────────────────────────────────────────────────
async function loadRecommendations() {
  const el = document.getElementById('pfRecommendations');
  if (!el) return;
  const res = await apiFetch(`/api/portfolio/recommendation?portfolio=${_activePf}`, { headers: authHdrs() });
  if (!res || !res.ok) {
    el.innerHTML = '<div class="sec-head" style="margin-bottom:0.75rem">What should I do?</div><div class="bt-none">Could not load advice.</div>';
    return;
  }
  const d = await res.json();
  const actionMap = {
    buy:  ['tag-buy',  'BUY'],
    sell: ['tag-sell', 'SELL'],
    hold: ['tag-hold', 'HOLD'],
  };
  const recCards = d.recommendations.length === 0
    ? '<div class="bt-none">No positions to review — signals are quiet right now.</div>'
    : d.recommendations.map(r => {
        const [tagCls, tagLabel] = actionMap[r.action] || ['tag-neutral', r.action.toUpperCase()];
        const btn = (r.action === 'buy' || r.action === 'sell') && r.suggested_usd
          ? `<button class="btn btn-ghost btn-xs"
               onclick="prefillTrade('${r.coin_id}','${r.action}',${r.suggested_usd})">
               Pre-fill ${r.action} $${r.suggested_usd.toLocaleString('en',{maximumFractionDigits:0})}
             </button>`
          : '';
        return `
          <div class="rec-card">
            <div class="rec-top">
              <div class="rec-coin">${r.name} <span class="sym">${r.symbol}</span></div>
              <div class="rec-actions">${'<span class="tag ' + tagCls + '">' + tagLabel + '</span>'}${btn}</div>
            </div>
            <div class="rec-plain">${r.plain}</div>
            <div class="rec-detail">${r.detail}</div>
          </div>`;
      }).join('');
  el.innerHTML = `
    <div class="sec-head" style="margin-bottom:0.75rem">What should I do?</div>
    <p class="rec-summary">${d.summary}</p>
    <div class="rec-list">${recCards}</div>
  `;
}

function prefillTrade(coinId, action, amount) {
  switchTab('portfolio');
  const sel = document.getElementById('tradeCoin');
  if (sel) sel.value = coinId;
  const amtEl = document.getElementById('tradeAmount');
  if (amtEl) { amtEl.value = amount; amtEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  toast(`Pre-filled: ${action} $${Number(amount).toLocaleString('en',{maximumFractionDigits:0})} of ${coinId.toUpperCase()}`);
}

// ── News tab ──────────────────────────────────────────────────────────────────
async function loadNews() {
  const el = document.getElementById('newsList');
  if (!el) return;
  el.innerHTML = '<div class="spinner-row"><div class="spinner"></div><span>Loading news…</span></div>';
  const res = await apiFetch('/api/news');
  if (!res || !res.ok) {
    el.innerHTML = '<div class="card card-pad-lg neg" style="font-size:0.85rem">Could not load news.</div>';
    return;
  }
  const d = await res.json();
  if (!d.news || d.news.length === 0) {
    el.innerHTML = '<div class="card card-pad-lg bt-none">No news available right now.</div>';
    return;
  }
  el.innerHTML = d.news.map(item => {
    const date = item.published_at ? new Date(item.published_at).toLocaleString() : '';
    const thumb = item.thumb
      ? `<img src="${item.thumb}" class="news-thumb" alt="" onerror="this.style.display='none'" />`
      : '';
    return `
      <a href="${item.url}" target="_blank" rel="noopener" class="card news-card">
        ${thumb}
        <div style="flex:1; min-width:0">
          <div class="news-title">${item.title || 'No title'}</div>
          ${item.description ? `<div class="news-desc">${item.description}</div>` : ''}
          <div class="news-meta">${item.author || ''} ${date ? '· ' + date : ''}</div>
        </div>
      </a>`;
  }).join('');
}

// ── Admin tab ─────────────────────────────────────────────────────────────────
async function loadUsers() {
  const el = document.getElementById('userTable');
  el.innerHTML = '<div class="card-pad bt-none">Loading…</div>';
  const res = await apiFetch('/api/auth/users', { headers: authHdrs() });
  if (!res || !res.ok) {
    el.innerHTML = '<div class="card-pad neg">Not authorised.</div>';
    return;
  }
  const users = await res.json();
  if (!users.length) {
    el.innerHTML = '<div class="card-pad-lg bt-none">No users found.</div>';
    return;
  }
  el.innerHTML = `
    <table class="tbl">
      <thead>
        <tr><th>Username</th><th>Role</th><th>Created</th><th>Created by</th><th></th></tr>
      </thead>
      <tbody>
        ${users.map(u => `
          <tr>
            <td style="font-weight:700">${u.username}</td>
            <td>${u.is_admin
              ? '<span class="tag tag-buy">ADMIN</span>'
              : '<span class="tag tag-neutral">USER</span>'}</td>
            <td class="muted-cell" style="font-size:0.72rem">${new Date(u.created_at).toLocaleDateString()}</td>
            <td class="muted-cell" style="font-size:0.72rem">${u.created_by || '—'}</td>
            <td>${!u.is_admin
              ? `<button class="btn btn-danger btn-xs" onclick="deleteUser('${u.username}')">Delete</button>`
              : ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

async function createUser() {
  const username = document.getElementById('newUser').value.trim();
  const password = document.getElementById('newPass').value;
  const msgEl    = document.getElementById('createMsg');
  msgEl.classList.add('hidden');
  if (!username || !password) {
    msgEl.textContent = 'Username and password are required.';
    msgEl.className   = 'err-msg';
    return;
  }
  const res = await apiFetch('/api/auth/users', {
    method: 'POST',
    headers: authHdrs(),
    body: JSON.stringify({ username, password }),
  });
  if (!res) return;
  if (!res.ok) {
    const err     = await res.json();
    msgEl.textContent = err.detail;
    msgEl.className   = 'err-msg';
    msgEl.classList.remove('hidden');
    return;
  }
  document.getElementById('newUser').value = '';
  document.getElementById('newPass').value = '';
  msgEl.textContent = `User "${username}" created.`;
  msgEl.className   = 'ok-msg';
  msgEl.classList.remove('hidden');
  toast(`User "${username}" created`);
  loadUsers();
}

async function deleteUser(username) {
  if (!confirm(`Delete user "${username}"? They will no longer be able to sign in.`)) return;
  const res = await apiFetch(`/api/auth/users/${username}`, {
    method: 'DELETE', headers: authHdrs(),
  });
  if (!res || !res.ok) { toast('Failed to delete user.', false); return; }
  toast(`User "${username}" deleted`);
  loadUsers();
}
