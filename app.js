'use strict';
/* せーので一致 — 親（部屋を作った人）のスマホが部屋の役をし、PeerJSで参加者とつながる */

const PREFIX = 'seeno-icchi-v1-';
const MAX_PLAYERS = 12;
const REVEAL_MS = 1500;
const KANA = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりれろわ'];
const THEMES = [
  '食べ物', 'お菓子', '果物', '野菜', '飲み物', '動物', '海の生き物', '国の名前', '都道府県', '駅の名前',
  'スポーツ', '楽器', '乗り物', '職業', '家にあるもの', '学校にあるもの', 'コンビニで買うもの', '旅行のお土産',
  '夏といえば', '冬といえば', '言われて嬉しい言葉', '言われたらムカつくこと', 'ちょっと苦手なこと', 'かっこいい言葉',
  '有名な漫画', '名作映画', 'アニメのキャラクター', '遊び', '体の部分', '色', 'お店の名前', '朝ごはんに食べるもの',
  'デートで行きたい場所', '誕生日にほしいもの', 'お弁当に入っているもの', '昔はやったもの',
];

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* 保存できなくても遊べる */ } },
};
const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const myId = store.get('si-id') || (() => { const v = rid(); store.set('si-id', v); return v; })();
let myName = store.get('si-name') || '';

// ひらがな・カタカナ・全角半角・大文字小文字・空白の違いは同じ答えとみなす
function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s、。,.!！?？・「」『』"'〜~]/g, '');
}
const randTopic = () => ({ kana: pick(KANA), theme: pick(THEMES) });
const topicText = (t) => (t.custom ? t.custom : `「${t.kana}」から始まる${t.theme}`);
function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}時間${m}分` : m ? `${m}分${sec}秒` : `${sec}秒`;
}

/* ---------- 画面の状態 ---------- */
let mode = 'home';        // home | connecting | game | error
let S = null;              // 親から届いた最新の状態
let errMsg = '';
let peer = null, hostConn = null, isHost = false;
let lastKey = '', myText = '', myDone = false, myRound = '', localDeadline = 0, sendTimer = null;
const COUNTS = [3, 5, 10, 15, 20];
const ui = { count: 5, limit: 60 };

/* ---------- 親（部屋）の処理 ---------- */
let H = null;
const conns = new Map();
let writeTimer = null, revealTimer = null;

function hostCreate() {
  mode = 'connecting'; render();
  const room = String(Math.floor(1000 + Math.random() * 9000));
  peer = new Peer(PREFIX + room);
  peer.on('open', () => {
    isHost = true;
    H = {
      room, players: [{ id: myId, name: myName, online: true }], phase: 'lobby', round: 0,
      topic: null, limit: 60, deadline: 0, answers: {}, submitted: {}, order: [], opened: [],
      result: null, startedAt: 0, endedAt: 0, log: [], qTotal: 0, used: [], usedThemes: [],
    };
    mode = 'game';
    keepAwake();
    sync();
  });
  peer.on('connection', (c) => {
    c.on('data', (m) => {
      if (!m || typeof m !== 'object') return;
      if (m.t === 'join') {
        c.pid = String(m.id || '').slice(0, 24);
        const old = conns.get(c.pid);
        if (old && old !== c) { try { old.close(); } catch (e) { /* noop */ } }
        conns.set(c.pid, c);
      }
      if (c.pid) hostHandle(c.pid, m, c);
    });
    c.on('close', () => {
      if (!c.pid || conns.get(c.pid) !== c) return;
      conns.delete(c.pid);
      const p = H.players.find((x) => x.id === c.pid);
      if (p) p.online = false;
      checkAllSubmitted();
      sync();
    });
  });
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* noop */ } });
  peer.on('error', (e) => {
    if (e.type === 'unavailable-id' && !H) { peer.destroy(); hostCreate(); return; }
    if (!H) fail('部屋を作れませんでした（' + e.type + '）。通信環境を確かめて、もう一度お試しください。');
  });
}

// 親のスマホの画面が消えないようにする（消えると部屋が終わるため）。
// 別のアプリから戻った時は消える設定に戻っているので、もう一度お願いする
let wakeLock = null;
async function keepAwake() {
  try {
    if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    if (wakeLock && !wakeLock.released) return;
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* 対応していない端末では何もしない */ }
}
document.addEventListener('visibilitychange', () => { if (isHost && !leaving) keepAwake(); });

function hostHandle(pid, m, c) {
  if (m.t === 'join') {
    const name = String(m.name || '').trim().slice(0, 12) || '名なし';
    const p = H.players.find((x) => x.id === pid);
    if (p) { p.name = name; p.online = true; p.left = false; }
    else {
      if (H.players.filter((x) => !x.left).length >= MAX_PLAYERS) { if (c) c.send({ t: 'full' }); return; }
      H.players.push({ id: pid, name, online: true });
    }
    sync();
  } else if (m.t === 'leave') {
    // 参加者が退出した。準備中・おしまいの画面なら一覧から消し、ゲーム中なら名前を残して外す
    if (H.phase === 'lobby' || H.phase === 'end') H.players = H.players.filter((x) => x.id !== pid);
    else { const p = H.players.find((x) => x.id === pid); if (p) { p.online = false; p.left = true; } }
    conns.delete(pid);
    if (c) setTimeout(() => { try { c.close(); } catch (e) { /* noop */ } }, 200);
    if (!checkAllSubmitted()) sync();
  } else if (m.t === 'answer') {
    if (H.phase !== 'writing') return;
    H.answers[pid] = String(m.text || '').slice(0, 40);
    const was = !!H.submitted[pid];
    H.submitted[pid] = !!m.done;
    if (was !== H.submitted[pid]) { if (!checkAllSubmitted()) sync(); }
  }
}

function checkAllSubmitted() {
  if (!H || H.phase !== 'writing') return false;
  const on = H.players.filter((p) => p.online);
  if (on.length && on.every((p) => H.submitted[p.id])) { lockWriting('all'); return true; }
  return false;
}

function clearTimers() {
  clearTimeout(writeTimer); writeTimer = null;
  clearTimeout(revealTimer); revealTimer = null;
}

function startRound(topic, limit) {
  clearTimers();
  H.round += 1; H.phase = 'writing'; H.topic = topic; H.limit = limit;
  H.answers = {}; H.submitted = {}; H.result = null; H.order = []; H.opened = [];
  H.deadline = Date.now() + limit * 1000; H.barLimit = limit;
  if (!H.startedAt) H.startedAt = Date.now();
  writeTimer = setTimeout(() => lockWriting('time'), limit * 1000 + 400);
  sync();
}

// 同じゲームの中で、同じ頭文字・同じテーマが続けて出ないようにランダムで選ぶ
function newTopic() {
  for (let i = 0; i < 200; i++) {
    const t = randTopic();
    if (!H.used.includes(t.kana) && !H.usedThemes.includes(t.theme)) { H.used.push(t.kana); H.usedThemes.push(t.theme); return t; }
    if (H.used.length >= KANA.length) H.used = [];
    if (H.usedThemes.length >= THEMES.length) H.usedThemes = [];
  }
  return randTopic();
}

function startGame() {
  if (!H || H.phase !== 'lobby') return;
  H.qTotal = ui.count; H.used = []; H.usedThemes = [];
  startRound(newTopic(), ui.limit);
}

// 答えにくいお題を引き直す。問題数は増やさず、同じ問題番号のまま新しいお題にする
function passTopic() {
  if (!H || H.phase !== 'writing') return;
  H.round -= 1;
  startRound(newTopic(), H.limit);
}

function nextQuestion() {
  if (!H || H.phase !== 'result' || H.round >= H.qTotal) return;
  startRound(newTopic(), H.limit);
}

// 書くのを締め切る。開くのは親の「せーので オープン」を待つ
function lockWriting(reason) {
  if (!H || H.phase !== 'writing') return;
  clearTimers();
  H.phase = 'locked';
  H.lockReason = reason;
  sync();
}

// 時間切れのあと、親が時間を足す。書いていた答えは残したまま、書く画面に戻す
function extendTime(sec) {
  if (!H || H.phase !== 'locked' || H.lockReason !== 'time') return;
  clearTimers();
  H.phase = 'writing';
  H.deadline = Date.now() + sec * 1000; H.barLimit = sec;
  writeTimer = setTimeout(() => lockWriting('time'), sec * 1000 + 400);
  sync();
}

// 答えのカードを全部裏向きで並べる。めくる順番は親がタップして決める
function openAnswers() {
  if (!H || H.phase !== 'locked') return;
  clearTimers();
  H.phase = 'reveal';
  H.order = H.players.filter((p) => p.online || p.id in H.answers).map((p) => p.id);
  H.opened = [];
  if (!H.order.length) { finish(); return; }
  sync();
}

// 親がタップしたカードを1枚めくる。全部めくったら少し間をおいて結果へ
function flipCard(id) {
  if (!H || H.phase !== 'reveal' || !H.order.includes(id) || H.opened.includes(id)) return;
  H.opened.push(id);
  sync();
  if (H.opened.length >= H.order.length) revealTimer = setTimeout(finish, REVEAL_MS);
}

function finish() {
  clearTimers();
  const texts = H.order.map((id) => norm(H.answers[id]));
  const match = texts.length > 0 && texts.every((t) => t && t === texts[0]);
  H.result = { match };
  H.phase = 'result';
  H.log.unshift({
    round: H.round, topic: topicText(H.topic), match,
    answers: H.order.map((id) => ({ name: nameOf(id), text: H.answers[id] || '' })),
  });
  sync();
}

function forceMatch() {
  if (!H.result || H.result.match) return;
  H.result.match = true; H.result.forced = true;
  if (H.log[0]) H.log[0].match = true;
  sync();
}

// 最終結果（最後の問題のあと、または親が「途中で終わる」を押した時）
function endGame() {
  if (!H || H.phase !== 'result') return;
  clearTimers();
  H.phase = 'end';
  H.endedAt = Date.now();
  sync();
}

function resetGame() {
  clearTimers();
  H.players = H.players.filter((p) => !p.left);
  Object.assign(H, { phase: 'lobby', round: 0, topic: null, answers: {}, submitted: {}, order: [], opened: [], result: null, startedAt: 0, endedAt: 0, log: [], qTotal: 0, used: [], usedThemes: [] });
  sync();
}

function kick(id) {
  if (id === myId) return;
  H.players = H.players.filter((p) => p.id !== id);
  const c = conns.get(id);
  if (c) { try { c.send({ t: 'kicked' }); setTimeout(() => c.close(), 300); } catch (e) { /* noop */ } }
  conns.delete(id);
  sync();
}

const nameOf = (id) => { const p = H.players.find((x) => x.id === id); return p ? p.name : '？'; };

function view() {
  const showAll = H.phase === 'result';
  return {
    room: H.room, phase: H.phase, round: H.round, host: myId, startedAt: H.startedAt,
    topic: H.topic ? topicText(H.topic) : '', limit: H.barLimit || H.limit, deadline: H.deadline,
    remaining: Math.max(0, H.deadline - Date.now()),
    players: H.players.filter((p) => !p.left).map((p) => ({ id: p.id, name: p.name, online: p.online, submitted: !!H.submitted[p.id] })),
    reveal: H.order.map((id) => ({ id, name: nameOf(id), text: (showAll || H.opened.includes(id)) ? (H.answers[id] || '') : null })),
    shown: H.opened.length, lastOpened: H.opened[H.opened.length - 1] || '', result: H.result, lockReason: H.lockReason || '',
    elapsed: H.startedAt ? (H.endedAt || Date.now()) - H.startedAt : 0,
    matches: H.log.filter((l) => l.match).length, total: H.log.length, qTotal: H.qTotal,
    log: H.log.slice(0, 40),
  };
}

function sync() {
  const v = view();
  conns.forEach((c) => { if (c.open) { try { c.send({ t: 'state', s: v }); } catch (e) { /* noop */ } } });
  S = v;
  render();
}

/* ---------- 子（参加者）の処理 ---------- */
let retry = 0, joinRoom = '';
function clientJoin(room) {
  joinRoom = room;
  mode = 'connecting'; render();
  peer = new Peer();
  peer.on('open', () => connectHost());
  peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* noop */ } });
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') fail(S ? '親との接続が切れました。親の画面が閉じていないか確かめてください。' : `部屋「${room}」が見つかりません。番号を確かめてください。`);
    else if (!S) fail('つながりませんでした（' + e.type + '）。通信環境を確かめて、もう一度お試しください。');
  });
}
function connectHost() {
  const c = peer.connect(PREFIX + joinRoom, { reliable: true });
  hostConn = c;
  c.on('open', () => {
    retry = 0; banner('');
    c.send({ t: 'join', id: myId, name: myName });
    if (myText && S && S.phase === 'writing') c.send({ t: 'answer', text: myText, done: myDone });
  });
  c.on('data', (m) => {
    if (!m) return;
    if (m.t === 'state') { S = m.s; mode = 'game'; render(); }
    else if (m.t === 'full') fail('部屋がいっぱいです（最大' + MAX_PLAYERS + '人）。');
    else if (m.t === 'kicked') { hostConn = null; fail('親が部屋から外しました。'); }
    else if (m.t === 'closed') { hostConn = null; fail('親が退出したので、部屋が終わりました。'); }
  });
  c.on('close', () => {
    if (hostConn !== c || mode === 'error') return;
    if (retry++ < 8) { banner('つなぎ直しています…'); setTimeout(connectHost, 2000); }
    else fail('親との接続が切れました。');
  });
}

function sendAnswer(done) {
  const m = { t: 'answer', text: myText, done };
  if (isHost) hostHandle(myId, m);
  else if (hostConn && hostConn.open) hostConn.send(m);
}

/* ---------- 退出（1回目で警告、5秒以内にもう一度押すと退出） ---------- */
let leaveArmed = false, leaveTimer = null, leaving = false;
function leaveHTML() {
  const warn = isHost
    ? '親が退出すると部屋が終わり、全員の接続が切れます。本当に退出しますか？'
    : '本当に退出しますか？';
  return `<div class="leave">
    <p id="leaveWarn" class="err" ${leaveArmed ? '' : 'hidden'}>${warn}</p>
    <button id="leaveBtn" class="btn ${leaveArmed ? 'danger' : 'ghost'}" data-act="leave">${leaveArmed ? 'もう一度押すと退出します' : '退出する'}</button>
  </div>`;
}
function setLeaveArmed(on) {
  leaveArmed = on;
  clearTimeout(leaveTimer);
  if (on) leaveTimer = setTimeout(() => setLeaveArmed(false), 5000);
  const box = document.querySelector('.leave');
  if (box) box.outerHTML = leaveHTML();
}
function doLeave() {
  leaving = true;
  clearTimeout(leaveTimer);
  if (isHost) {
    conns.forEach((c) => { try { if (c.open) c.send({ t: 'closed' }); } catch (e) { /* noop */ } });
  } else {
    const c = hostConn; hostConn = null;
    try { if (c && c.open) c.send({ t: 'leave' }); } catch (e) { /* noop */ }
  }
  setTimeout(() => { try { peer.destroy(); } catch (e) { /* noop */ } location.href = location.pathname; }, 300);
}

/* ---------- 音（お題が出た時の「デデン」。この場で作る音） ---------- */
let actx = null;
let muted = (() => { try { return localStorage.getItem('si-mute') === '1'; } catch (e) { return false; } })();
function unlockAudio() {
  try {
    if (!actx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; actx = new AC(); }
    if (actx.state === 'suspended') actx.resume();
    const src = actx.createBufferSource(); src.buffer = actx.createBuffer(1, 1, 22050); src.connect(actx.destination); src.start(0);
  } catch (e) { /* 音が出せなくても遊べる */ }
}
function hit(t, f, d, vol) {
  const out = actx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, t + d);
  const lp = actx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.setValueAtTime(2600, t); lp.frequency.exponentialRampToValueAtTime(450, t + d);
  lp.connect(out); out.connect(actx.destination);
  [['sawtooth', f, 0.5], ['square', f * 1.006, 0.35], ['sawtooth', f / 2, 0.5], ['sine', f / 4, 0.8]].forEach(([type, fr, g0]) => {
    const o = actx.createOscillator(); o.type = type; o.frequency.setValueAtTime(fr, t);
    const g = actx.createGain(); g.gain.value = g0;
    o.connect(g); g.connect(lp); o.start(t); o.stop(t + d + 0.05);
  });
}
function playDeden() {
  if (muted || !actx) return;
  try {
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + 0.03;
    hit(t, 233.1, 0.16, 0.32);        // デ
    hit(t + 0.2, 233.1, 0.75, 0.38);  // デン
  } catch (e) { /* noop */ }
}
// 時間切れの「カンカン」：鐘の音（倍音をずらして重ねる）を2回
function bell(t, f, d, vol) {
  const out = actx.createGain();
  out.gain.setValueAtTime(0.0001, t);
  out.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  out.gain.exponentialRampToValueAtTime(0.0001, t + d);
  out.connect(actx.destination);
  [[1, 0.6], [2.76, 0.3], [5.4, 0.15], [8.93, 0.08]].forEach(([mul, g0]) => {
    const o = actx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(f * mul, t);
    const g = actx.createGain(); g.gain.value = g0;
    o.connect(g); g.connect(out); o.start(t); o.stop(t + d + 0.05);
  });
}
function playKankan() {
  if (muted || !actx) return;
  try {
    if (actx.state === 'suspended') actx.resume();
    const t = actx.currentTime + 0.03;
    bell(t, 1046.5, 0.45, 0.4);         // カン
    bell(t + 0.22, 1046.5, 0.7, 0.4);   // カン
  } catch (e) { /* noop */ }
}

function updateMuteBtn() {
  const b = $('#muteBtn');
  if (b) { b.textContent = muted ? '🔇' : '🔊'; b.setAttribute('aria-label', muted ? '音を出す' : '音を消す'); b.title = muted ? '音を出す' : '音を消す'; }
}

function fail(msg) { errMsg = msg; mode = 'error'; banner(''); render(); }
function banner(msg) { const b = $('#banner'); b.textContent = msg; b.hidden = !msg; }
function joinUrl(room) { return location.origin + location.pathname + '?room=' + room; }

/* ---------- 描画 ---------- */
function render() {
  const app = $('#app');
  const a = document.activeElement;
  const fid = a && a.id && app.contains(a) ? a.id : null;
  let sel = null;
  try { if (fid && a.selectionStart != null) sel = [a.selectionStart, a.selectionEnd]; } catch (e) { /* noop */ }

  if (mode === 'home') { app.innerHTML = homeHTML(); lastKey = ''; }
  else if (mode === 'connecting') app.innerHTML = '<div class="card center"><div class="spinner"></div><p>つないでいます…</p></div>';
  else if (mode === 'error') app.innerHTML = `<div class="card center"><p class="err">${esc(errMsg)}</p><button class="btn primary" data-act="home">はじめに戻る</button></div>`;
  else {
    const key = S.phase + ':' + S.round + ':' + S.topic; // お題をパスした時も描き直す
    if (S.phase === 'writing') {
      if (key === lastKey) { updateWriting(); return; }
      // 新しい問題の時だけ答えを空にして音を鳴らす（時間の追加で戻った時は答えを残す）
      const qKey = S.round + '|' + S.topic + '|' + S.startedAt;
      if (qKey !== myRound) { myRound = qKey; myText = ''; myDone = false; playDeden(); }
      localDeadline = Date.now() + S.remaining;
    }
    if (S.phase === 'locked' && S.lockReason === 'time' && key !== lastKey) playKankan();
    lastKey = key;
    app.innerHTML = gameHTML() + leaveHTML();
    if (S.phase === 'writing') { updateWriting(); tick(); }
  }

  if (fid) {
    const el = document.getElementById(fid);
    if (el) { el.focus(); if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* noop */ } } }
  }
}

function homeHTML() {
  const q = new URLSearchParams(location.search).get('room') || '';
  const room = /^\d{4}$/.test(q) ? q : '';
  const joinBox = `
    <label for="room">部屋番号（4けた）</label>
    <input id="room" type="tel" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(room)}">
    <button class="btn primary big" data-act="join">部屋に入る</button>`;
  const createBox = `<button class="btn ${room ? '' : 'primary big'}" data-act="create">部屋を作る（親になる）</button>`;
  return `
  <div class="card">
    <h2>全員の答えがそろうまで、終われない。</h2>
    <p class="muted">お題に、みんなが同じ答えを書けたらクリア。何問でも続けて遊べます。</p>
    <label for="name">あなたの名前</label>
    <input id="name" type="text" maxlength="12" placeholder="例：たろう" value="${esc(myName)}">
    ${room ? joinBox + '<div class="divider">または</div>' + createBox : createBox + '<div class="divider">または</div>' + joinBox}
    <p id="homeErr" class="err" style="margin-top:10px"></p>
  </div>
  <div class="card rules">
    <h3>遊び方</h3>
    <ol>
      <li>1人が「部屋を作る」。出てきた4けたの番号を、みんなに伝えます。</li>
      <li>ほかの人は同じページを開き、番号を入れて参加します。</li>
      <li>親が問題数と書く時間を選んで「スタート」。全員の画面に、ランダムなお題「〇から始まる△△」が出ます。</li>
      <li>制限時間のうちに、それぞれ答えを書きます（ほかの人には見えません）。答えにくいお題は、親がパスできます。</li>
      <li>時間切れか全員が決定すると締め切り（時間切れの時は、親が時間を足せます）。親が「せーので オープン！」を押すと答えのカードが裏向きで並び、親がタップした人から1枚ずつめくれます。</li>
      <li>全員そろえば成功。成功でも失敗でも、次の問題へ進みます。</li>
      <li>最後の問題が終わると、何問中何問一致したかが出ます。</li>
    </ol>
    <p class="muted" style="margin-top:8px">答えは<b>ひらがなで書く</b>のがルールです。ひらがな・カタカナ・空白の違いは同じ答えとみなします（漢字は読みを調べないので一致になりません）。表記ゆれは親が「一致にする」で認められます。親は画面を閉じないでください（部屋が終わります）。</p>
  </div>
  <p class="notice">ご注意：スマホどうしを直接つなぐ仕組みのため、同じ部屋の人どうしで通信用の住所（IPアドレス）が相手に伝わります。名前や答えは保存していません。</p>`;
}

function statusHTML() {
  return `<div class="status"><span>部屋 <span class="room">${esc(S.room)}</span></span><span>${S.round ? S.round + ' / ' + S.qTotal + '問目' : '準備中'}・${S.players.filter((p) => p.online).length}人</span></div>`;
}

function chipsHTML(withState, kickable) {
  return '<div class="chips">' + S.players.map((p) => {
    const cls = ['chip', withState && p.submitted ? 'done' : '', p.online ? '' : 'off'].join(' ');
    const mark = withState ? (p.submitted ? '✓ ' : '… ') : '';
    const x = kickable && p.id !== S.host ? `<button class="x" data-act="kick" data-id="${esc(p.id)}" aria-label="外す">×</button>` : '';
    return `<span class="${cls}">${mark}${esc(p.name)}${p.id === S.host ? '（親）' : ''}${x}</span>`;
  }).join('') + '</div>';
}

// 最初の設定（親だけ）。お題は毎回ランダムで出るので選ばない
function setupPanelHTML() {
  const counts = COUNTS.map((n) => `<option value="${n}" ${ui.count === n ? 'selected' : ''}>${n}問</option>`).join('');
  const limits = [30, 60, 90, 120].map((n) => `<option value="${n}" ${ui.limit === n ? 'selected' : ''}>${n}秒</option>`).join('');
  return `
  <div class="card">
    <h3>ゲームの設定</h3>
    <div class="row">
      <div><label for="count">問題数</label><select id="count">${counts}</select></div>
      <div><label for="limit">書く時間</label><select id="limit">${limits}</select></div>
    </div>
    <p class="muted" style="margin-top:10px">お題は毎回ランダムで出ます。</p>
    <button class="btn primary big" data-act="start">スタート</button>
  </div>`;
}

function cardsHTML(final) {
  let groups = null;
  if (final) {
    const count = {};
    S.reveal.forEach((r) => { const k = norm(r.text); if (k) count[k] = (count[k] || 0) + 1; });
    const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    groups = { top, many: top && count[top] > 1 };
  }
  return '<div class="cards">' + S.reveal.map((r) => {
    const open = r.text !== null;
    const tappable = !final && !open && isHost;
    let cls = 'fcard' + (open ? ' flipped' : '');
    if (!final && open && r.id === S.lastOpened) cls += ' new';
    if (tappable) cls += ' tap';
    if (final && groups) cls += (S.result && S.result.match) || (groups.many && norm(r.text) === groups.top) ? ' same' : ' diff';
    const ans = open ? (r.text ? esc(r.text) : '（白紙）') : '';
    const attrs = tappable ? ` data-act="flipcard" data-id="${esc(r.id)}" role="button" aria-label="${esc(r.name)}のカードをめくる"` : '';
    return `<div class="${cls}"${attrs}><div class="inner">
      <div class="face front"><div class="who">${esc(r.name)}</div><div class="mark">？</div></div>
      <div class="face back"><div class="who">${esc(r.name)}</div><div class="ans">${ans}</div></div>
    </div></div>`;
  }).join('') + '</div>';
}

function logHTML() {
  if (!S.log.length) return '';
  return `<div class="card"><h3>これまでのお題</h3><ul class="log">${S.log.map((l) => `
    <li><div class="q">${l.round}問目：${esc(l.topic)} ${l.match ? '<span class="m">成功</span>' : '<span class="x">失敗</span>'}</div>
    ${l.answers.map((a) => `<div class="a">${esc(a.name)}「${esc(a.text || '白紙')}」</div>`).join('')}</li>`).join('')}</ul></div>`;
}

function gameHTML() {
  const host = isHost;
  if (S.phase === 'lobby') {
    return `
    <div class="card center">
      <h3>部屋番号</h3>
      <div class="bigcode">${esc(S.room)}</div>
      <div class="share"><span>${esc(joinUrl(S.room))}</span><button class="btn small" data-act="copy">コピー</button></div>
      <p class="muted" style="margin-top:8px">このURLを送るか、番号を伝えてください。</p>
    </div>
    <div class="card">${statusHTML()}${chipsHTML(false, host)}</div>
    ${host ? setupPanelHTML() : '<div class="card center"><p class="muted">親がゲームを始めるのを待っています…</p></div>'}`;
  }
  if (S.phase === 'writing') {
    return `
    <div class="card">
      ${statusHTML()}
      <div class="topic">${esc(S.topic)}</div>
      <div class="bar"><i id="barFill" style="width:100%"></i></div>
      <div id="timer" class="timer">のこり <b>--</b> 秒</div>
    </div>
    <div class="card">
      <label for="answer">あなたの答え</label>
      <textarea id="answer" maxlength="40" placeholder="ひらがなで書く" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
      <button id="doneBtn" class="btn primary big" data-act="done">これで決定</button>
    </div>
    <div class="card"><h3>書き終わった人</h3><div id="chipsBox"></div>
      ${host ? `<div class="row"><button class="btn" data-act="pass">このお題をパス</button>
        <button class="btn" data-act="close">ここで締め切る</button></div>` : ''}
    </div>`;
  }
  if (S.phase === 'locked') {
    const head = { time: '時間切れ！', all: '全員書き終わりました', host: '締め切りました' }[S.lockReason] || '締め切りました';
    return `
    <div class="card">${statusHTML()}
      <div class="topic">${esc(S.topic)}</div>
      <div class="result ng" style="margin:10px 0 0"><div class="t">${head}</div></div>
    </div>
    <div class="card"><h3>あなたの答え</h3><div class="topic-preview">${myText ? esc(myText) : '（白紙）'}</div></div>
    ${host ? `<div class="card">
      ${S.lockReason === 'time' ? `<h3>時間を足す</h3><div class="row">
        <button class="btn" data-act="extend" data-sec="15">＋15秒</button>
        <button class="btn" data-act="extend" data-sec="30">＋30秒</button></div>` : ''}
      <button class="btn primary big" data-act="open">せーので オープン！</button></div>` : ''}`;
  }
  if (S.phase === 'reveal') {
    return `
    <div class="card">${statusHTML()}<div class="topic">${esc(S.topic)}</div>
      <p class="muted center">${Math.min(S.shown, S.reveal.length)} / ${S.reveal.length}</p>
      ${cardsHTML(false)}</div>
    ${S.shown < S.reveal.length && host ? '<div class="card center"><p><b>回答者のカードをタップ</b></p></div>' : ''}`;
  }
  if (S.phase === 'end') {
    const rate = S.total ? Math.round((S.matches / S.total) * 100) : 0;
    return `
    <div class="card">
      <div class="result ok">
        <div class="t">結果発表</div>
        <div class="score">${S.total}問中${S.matches}問一致</div>
      </div>
      <div class="stats"><div><b>${rate}%</b>一致した割合</div><div><b>${fmtTime(S.elapsed)}</b>遊んだ時間</div></div>
    </div>
    ${host ? '<div class="card"><button class="btn primary big" data-act="reset">最初からもう一度</button></div>' : '<div class="card center"><p class="muted">親が次のゲームを始めるのを待っています…</p></div>'}
    ${logHTML()}`;
  }
  // result（1問ごとの結果。一致してもしなくても次のお題へ進める）
  const ok = S.result && S.result.match;
  return `
  <div class="card">
    ${statusHTML()}
    <div class="result ${ok ? 'ok' : 'ng'}">
      <div class="t">${ok ? '成功' : '失敗'}</div>
    </div>
    <div class="topic">${esc(S.topic)}</div>
    ${cardsHTML(true)}
    <div class="stats"><div><b>${S.matches}/${S.total}</b>ここまでの一致</div><div><b>${fmtTime(S.elapsed)}</b>経過</div></div>
    ${host && !ok ? '<button class="btn ghost" data-act="force">表記ゆれなので一致にする</button>' : ''}
  </div>
  ${host
    ? (S.round < S.qTotal
      ? `<div class="card"><button class="btn primary big" data-act="next">次の問題へ（${S.round + 1} / ${S.qTotal}問目）</button>
         <button class="btn ghost" data-act="end">途中で終わる（結果を見る）</button></div>`
      : '<div class="card"><button class="btn primary big" data-act="end">最終結果を見る</button></div>')
    : `<div class="card center"><p class="muted">${S.round < S.qTotal ? '親が次の問題を出すのを待っています…' : '最後の問題でした。親が最終結果を出します…'}</p></div>`}
  ${logHTML()}`;
}

function updateWriting() {
  const box = $('#chipsBox');
  if (box) box.innerHTML = chipsHTML(true, false);
  const ta = $('#answer'), btn = $('#doneBtn');
  if (ta && ta.value !== myText && document.activeElement !== ta) ta.value = myText;
  if (btn) { btn.textContent = myDone ? '書き直す' : 'これで決定'; btn.className = 'btn big ' + (myDone ? '' : 'primary'); }
  if (ta) ta.readOnly = myDone;
}

function tick() {
  if (mode !== 'game' || !S || S.phase !== 'writing') return;
  const left = Math.max(0, localDeadline - Date.now());
  const t = $('#timer'), f = $('#barFill');
  if (t) { t.innerHTML = `のこり <b>${Math.ceil(left / 1000)}</b> 秒`; t.className = 'timer' + (left < 10000 ? ' hurry' : ''); }
  if (f) f.style.width = (S.limit ? (left / (S.limit * 1000)) * 100 : 0) + '%';
}
setInterval(tick, 250);

/* ---------- 操作 ---------- */
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'create' || act === 'join') {
    const name = ($('#name').value || '').trim();
    const err = $('#homeErr');
    if (!name) { err.textContent = '名前を入れてください。'; $('#name').focus(); return; }
    myName = name.slice(0, 12); store.set('si-name', myName);
    if (typeof Peer === 'undefined') { err.textContent = '通信の部品を読み込めませんでした。ページを読み込み直してください。'; return; }
    unlockAudio(); // iPhoneでは、ここで一度触っておかないと音が出ない
    if (act === 'create') hostCreate();
    else {
      const room = ($('#room').value || '').replace(/\D/g, '');
      if (room.length !== 4) { err.textContent = '部屋番号は4けたの数字です。'; $('#room').focus(); return; }
      clientJoin(room);
    }
  } else if (act === 'home') {
    location.href = location.pathname + (joinRoom ? '?room=' + joinRoom : '');
  } else if (act === 'copy') {
    const url = joinUrl(S.room);
    const done = () => { el.textContent = 'コピーしました'; setTimeout(() => { el.textContent = 'コピー'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => {}); else done();
  } else if (act === 'done') {
    myDone = !myDone;
    const ta = $('#answer'); if (ta) myText = ta.value;
    clearTimeout(sendTimer);
    sendAnswer(myDone);
    updateWriting();
  } else if (act === 'mute') {
    muted = !muted;
    try { localStorage.setItem('si-mute', muted ? '1' : '0'); } catch (e) { /* noop */ }
    updateMuteBtn();
    if (!muted) { unlockAudio(); playDeden(); } // 音を戻した時に試しに鳴らす
  } else if (act === 'leave') {
    if (leaveArmed) doLeave(); else setLeaveArmed(true);
  } else if (!isHost) {
    return;
  } else if (act === 'start') startGame();
  else if (act === 'next') nextQuestion();
  else if (act === 'close') lockWriting('host');
  else if (act === 'pass') passTopic();
  else if (act === 'open') openAnswers();
  else if (act === 'extend') extendTime(Number(el.dataset.sec) || 15);
  else if (act === 'flipcard') flipCard(el.dataset.id);
  else if (act === 'force') forceMatch();
  else if (act === 'reset') resetGame();
  else if (act === 'end') endGame();
  else if (act === 'kick') kick(el.dataset.id);
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'answer') {
    myText = t.value;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => sendAnswer(myDone), 300);
  } else if (t.id === 'room') t.value = t.value.replace(/\D/g, '').slice(0, 4);
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'count') ui.count = Number(t.value) || 5;
  else if (t.id === 'limit') ui.limit = Number(t.value) || 60;
});
window.addEventListener('beforeunload', (e) => {
  if (!leaving && isHost && H && H.players.length > 1) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('pointerdown', unlockAudio, { once: true });

updateMuteBtn();
render();
