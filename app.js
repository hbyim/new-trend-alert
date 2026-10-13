// 바이낸스 공개 시세 API (지역 차단 대비 순서대로 시도)
const API_BASES = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api-gcp.binance.com',
];

const RULES = [
  { key: 'btc', symbol: 'BTCUSDT', period: 120 },
  { key: 'eth', symbol: 'ETHUSDT', period: 50 },
];

const STATE_KEY = 'coinTrendAlert.lastState';
const LOG_KEY = 'coinTrendAlert.log';

let timer = null;

async function fetchJson(path) {
  let lastErr;
  for (const base of API_BASES) {
    try {
      const res = await fetch(base + path, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${base} 응답 ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// 마감된 일봉 종가 N개의 단순이동평균. 마지막 캔들은 진행 중이므로 제외한다.
function closedSma(klines, period, now = Date.now()) {
  const closed = klines.filter(k => k[6] < now);
  if (closed.length < period) throw new Error(`일봉 데이터 부족 (${closed.length}/${period})`);
  const closes = closed.slice(-period).map(k => parseFloat(k[4]));
  return closes.reduce((a, b) => a + b, 0) / period;
}

async function checkSymbol({ symbol, period }) {
  const [klines, ticker] = await Promise.all([
    fetchJson(`/api/v3/klines?symbol=${symbol}&interval=1d&limit=${period + 1}`),
    fetchJson(`/api/v3/ticker/price?symbol=${symbol}`),
  ]);
  const ma = closedSma(klines, period);
  const price = parseFloat(ticker.price);
  return { price, ma, above: price > ma };
}

// --- UI ---------------------------------------------------------------

const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
const nowStr = () => new Date().toLocaleString('ko-KR');

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function renderSymbol(key, r) {
  $(key + 'Price').textContent = '$' + fmt(r.price);
  $(key + 'Ma').textContent = '$' + fmt(r.ma);
  const diff = (r.price / r.ma - 1) * 100;
  $(key + 'Diff').textContent = (diff >= 0 ? '+' : '') + diff.toFixed(2) + '%';
  const pill = $(key + 'Pill');
  pill.textContent = r.above ? '위' : '아래';
  pill.className = 'pill ' + (r.above ? 'ok' : 'no');
}

function renderStatus(met) {
  $('status').className = 'status ' + (met ? 'ok' : 'no');
  $('statusText').textContent = met ? '조건 충족: 상승 추세' : '조건 미충족';
  $('statusSub').textContent = met
    ? 'BTC > 120일선, ETH > 50일선'
    : '두 조건 중 하나 이상이 이평선 아래입니다';
}

function renderLog() {
  const items = load(LOG_KEY, []);
  const ul = $('log');
  ul.innerHTML = '';
  if (!items.length) { ul.innerHTML = '<li class="muted">아직 기록이 없습니다.</li>'; return; }
  for (const it of items) {
    const li = document.createElement('li');
    li.textContent = `${it.time} · ${it.text}`;
    ul.appendChild(li);
  }
}

function addLog(text) {
  const items = load(LOG_KEY, []);
  items.unshift({ time: nowStr(), text });
  save(LOG_KEY, items.slice(0, 50));
  renderLog();
}

function beep() {
  if (!$('sound').checked) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.6);
  } catch {}
}

function alertUser(met, detail) {
  const title = met ? '✅ 추세 조건 충족' : '⚠️ 추세 조건 이탈';
  const body = met
    ? `BTC가 120일선 위, ETH가 50일선 위에 있습니다.\n${detail}`
    : `조건을 벗어났습니다.\n${detail}`;

  $('modal').className = 'modal ' + (met ? 'ok' : 'no');
  $('modalTitle').textContent = title;
  $('modalBody').textContent = body;
  $('modalBg').classList.add('show');

  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, tag: 'coin-trend-alert', requireInteraction: true }); } catch {}
  }
  beep();
  addLog(`${title} (${detail.replace(/\n/g, ', ')})`);
}

async function check() {
  $('err').textContent = '';
  try {
    const [btc, eth] = await Promise.all(RULES.map(checkSymbol));
    renderSymbol('btc', btc);
    renderSymbol('eth', eth);
    const met = btc.above && eth.above;
    renderStatus(met);
    $('updated').textContent = '마지막 확인: ' + nowStr();

    const prev = load(STATE_KEY, null);
    if (prev !== met) {
      const detail = `BTC $${fmt(btc.price)} (120일선 $${fmt(btc.ma)})\nETH $${fmt(eth.price)} (50일선 $${fmt(eth.ma)})`;
      // 첫 실행이면서 조건 미충족이면 기록만 남기고 팝업은 띄우지 않는다.
      if (prev === null && !met) addLog('모니터링 시작: 현재 조건 미충족');
      else alertUser(met, detail);
      save(STATE_KEY, met);
    }
  } catch (e) {
    $('err').textContent = '시세를 불러오지 못했습니다: ' + e.message + ' (다음 주기에 다시 시도합니다)';
  }
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(check, parseInt($('interval').value, 10) * 1000);
}

function updateNotifyBtn() {
  const btn = $('notifyBtn');
  if (!('Notification' in window)) { btn.textContent = '브라우저 알림 미지원'; btn.disabled = true; return; }
  if (Notification.permission === 'granted') { btn.textContent = '브라우저 알림 켜짐'; btn.disabled = true; }
  else if (Notification.permission === 'denied') { btn.textContent = '알림 차단됨 (브라우저 설정에서 허용)'; btn.disabled = true; }
}

function init() {
  $('interval').value = load('coinTrendAlert.interval', '60');
  $('sound').checked = load('coinTrendAlert.sound', true);
  $('interval').addEventListener('change', () => { save('coinTrendAlert.interval', $('interval').value); schedule(); });
  $('sound').addEventListener('change', () => save('coinTrendAlert.sound', $('sound').checked));
  $('refreshBtn').addEventListener('click', check);
  $('notifyBtn').addEventListener('click', async () => {
    if ('Notification' in window) await Notification.requestPermission();
    updateNotifyBtn();
  });
  $('modalClose').addEventListener('click', () => $('modalBg').classList.remove('show'));
  updateNotifyBtn();
  renderLog();
  check();
  schedule();
}

if (typeof document !== 'undefined') init();
if (typeof module !== 'undefined') module.exports = { closedSma };
