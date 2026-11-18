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
let lastKey = '', myText = '', myDone = false, localDeadline = 0, sendTimer = null;
const ui = { gen: randTopic(), custom: '', useCustom: false, limit: 60 };

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
      topic: null, limit: 60, deadline: 0, answers: {}, submitted: {}, order: [], shown: 0,
      result: null, startedAt: 0, matchedAt: 0, log: [],
    };
    mode = 'game';
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

function hostHandle(pid, m, c) {
  if (m.t === 'join') {
    const name = String(m.name || '').trim().slice(0, 12) || '名なし';
    const p = H.players.find((x) => x.id === pid);
    if (p) { p.name = name; p.online = true; }
    else {
      if (H.players.length >= MAX_PLAYERS) { if (c) c.send({ t: 'full' }); return; }
      H.players.push({ id: pid, name, online: true });
    }
    sync();
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
  H.answers = {}; H.submitted = {}; H.result = null; H.order = []; H.shown = 0;
  H.deadline = Date.now() + limit * 1000;
  if (!H.startedAt) H.startedAt = Date.now();
  writeTimer = setTimeout(() => lockWriting('time'), limit * 1000 + 400);
  sync();
}

// 書くのを締め切る。開くのは親の「せーので オープン」を待つ
function lockWriting(reason) {
  if (!H || H.phase !== 'writing') return;
  clearTimers();
  H.phase = 'locked';
  H.lockReason = reason;
  sync();
}

function openAnswers() {
  if (!H || H.phase !== 'locked') return;
  clearTimers();
  H.phase = 'reveal';
  H.order = H.players.filter((p) => p.online || p.id in H.answers).map((p) => p.id);
  H.shown = 0;
  sync();
  const step = () => {
    H.shown += 1;
    sync();
    revealTimer = setTimeout(H.shown >= H.order.length ? finish : step, H.shown >= H.order.length ? 1200 : REVEAL_MS);
  };
  revealTimer = setTimeout(step, 1200);
}

function finish() {
  clearTimers();
  const texts = H.order.map((id) => norm(H.answers[id]));
  const match = texts.length > 0 && texts.every((t) => t && t === texts[0]);
  H.result = { match };
  H.phase = 'result';
  if (match) H.matchedAt = Date.now();
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
  H.matchedAt = Date.now();
  sync();
}

function resetGame() {
  clearTimers();
  Object.assign(H, { phase: 'lobby', round: 0, topic: null, answers: {}, submitted: {}, order: [], shown: 0, result: null, startedAt: 0, matchedAt: 0, log: [] });
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
    room: H.room, phase: H.phase, round: H.round, host: myId,
    topic: H.topic ? topicText(H.topic) : '', limit: H.limit,
    remaining: Math.max(0, H.deadline - Date.now()),
    players: H.players.map((p) => ({ id: p.id, name: p.name, online: p.online, submitted: !!H.submitted[p.id] })),
    reveal: H.order.map((id, i) => ({ id, name: nameOf(id), text: (showAll || i < H.shown) ? (H.answers[id] || '') : null })),
    shown: H.shown, result: H.result, lockReason: H.lockReason || '',
    elapsed: H.startedAt ? (H.matchedAt || Date.now()) - H.startedAt : 0,
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
    const key = S.phase + ':' + S.round;
    if (S.phase === 'writing') {
      if (key === lastKey) { updateWriting(); return; }
      myText = ''; myDone = false; localDeadline = Date.now() + S.remaining;
    }
    lastKey = key;
    app.innerHTML = gameHTML();
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
    <p class="muted">お題に、みんなが同じ答えを書けたらクリア。そろうまで何回でも続きます。</p>
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
      <li>親が「お題を出す」と、全員の画面に「〇から始まる△△」が出ます。</li>
      <li>制限時間のうちに、それぞれ答えを書きます（ほかの人には見えません）。</li>
      <li>時間切れか全員が決定すると締め切り。親の「せーので オープン」で、答えが1人ずつ順番に開きます。</li>
      <li>全員そろえばクリア。そろわなければ次のお題へ。</li>
    </ol>
    <p class="muted" style="margin-top:8px">ひらがな・カタカナ・空白の違いは同じ答えとみなします。表記ゆれは親が「一致にする」で認められます。親は画面を閉じないでください（部屋が終わります）。</p>
  </div>`;
}

function statusHTML() {
  return `<div class="status"><span>部屋 <span class="room">${esc(S.room)}</span></span><span>${S.round ? S.round + '回目' : '準備中'}・${S.players.filter((p) => p.online).length}人</span></div>`;
}

function chipsHTML(withState, kickable) {
  return '<div class="chips">' + S.players.map((p) => {
    const cls = ['chip', withState && p.submitted ? 'done' : '', p.online ? '' : 'off'].join(' ');
    const mark = withState ? (p.submitted ? '✓ ' : '… ') : '';
    const x = kickable && p.id !== S.host ? `<button class="x" data-act="kick" data-id="${esc(p.id)}" aria-label="外す">×</button>` : '';
    return `<span class="${cls}">${mark}${esc(p.name)}${p.id === S.host ? '（親）' : ''}${x}</span>`;
  }).join('') + '</div>';
}

function hostPanelHTML(title) {
  const opts = [30, 60, 90, 120].map((n) => `<option value="${n}" ${ui.limit === n ? 'selected' : ''}>${n}秒</option>`).join('');
  return `
  <div class="card">
    <h3>${title}</h3>
    ${ui.useCustom ? '' : `<div class="topic-preview">「${esc(ui.gen.kana)}」から始まる${esc(ui.gen.theme)}</div>
    <button class="btn ghost" data-act="reroll">別のお題にする</button>`}
    <label class="check"><input type="checkbox" id="useCustom" ${ui.useCustom ? 'checked' : ''}> 自分でお題を書く</label>
    ${ui.useCustom ? `<input id="custom" type="text" maxlength="60" placeholder="例：「ち」から始まる、旅行先で買うチョコレート" value="${esc(ui.custom)}">` : ''}
    <label for="limit">書く時間</label>
    <select id="limit">${opts}</select>
    <button class="btn primary big" data-act="start">お題を出す</button>
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
  return '<div class="cards">' + S.reveal.map((r, i) => {
    const open = r.text !== null;
    let cls = 'acard ' + (open ? 'open' : 'closed');
    if (!final && open && i === S.shown - 1) cls += ' new';
    if (final && groups) cls += (S.result && S.result.match) || (groups.many && norm(r.text) === groups.top) ? ' same' : ' diff';
    const ans = open ? (r.text ? esc(r.text) : '（白紙）') : '？';
    return `<div class="${cls}"><div class="who">${esc(r.name)}</div><div class="ans">${ans}</div></div>`;
  }).join('') + '</div>';
}

function logHTML() {
  if (!S.log.length) return '';
  return `<div class="card"><h3>これまでのお題</h3><ul class="log">${S.log.map((l) => `
    <li><div class="q">${l.round}回目：${esc(l.topic)} ${l.match ? '<span class="m">一致！</span>' : ''}</div>
    <div class="a">${l.answers.map((a) => esc(a.name) + '「' + esc(a.text || '白紙') + '」').join('　')}</div></li>`).join('')}</ul></div>`;
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
    ${host ? hostPanelHTML('最初のお題') : '<div class="card center"><p class="muted">親がお題を出すのを待っています…</p></div>'}`;
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
      <label for="answer">あなたの答え（ほかの人には見えません）</label>
      <textarea id="answer" maxlength="40" placeholder="ここに書く"></textarea>
      <button id="doneBtn" class="btn primary big" data-act="done">これで決定</button>
    </div>
    <div class="card"><h3>書き終わった人</h3><div id="chipsBox"></div>
      ${host ? '<button class="btn" data-act="close">ここで締め切る</button>' : ''}
    </div>`;
  }
  if (S.phase === 'locked') {
    const head = { time: '時間切れ！', all: '全員書き終わりました', host: '締め切りました' }[S.lockReason] || '締め切りました';
    return `
    <div class="card">${statusHTML()}
      <div class="result ng" style="margin-bottom:10px"><div class="t">${head}</div><div>${host ? '準備ができたら、合図してオープンしてください。' : '親の「せーの」でオープンします。'}</div></div>
      <div class="topic">${esc(S.topic)}</div>
    </div>
    <div class="card"><h3>あなたの答え</h3><div class="topic-preview">${myText ? esc(myText) : '（白紙）'}</div></div>
    ${host ? '<div class="card"><button class="btn primary big" data-act="open">せーので オープン！</button></div>' : ''}`;
  }
  if (S.phase === 'reveal') {
    return `
    <div class="card">${statusHTML()}<div class="topic">${esc(S.topic)}</div>
      <p class="muted center">順番にオープン！（${Math.min(S.shown, S.reveal.length)} / ${S.reveal.length}）</p>
      ${cardsHTML(false)}</div>`;
  }
  // result
  const ok = S.result && S.result.match;
  return `
  <div class="card">
    ${statusHTML()}
    <div class="result ${ok ? 'ok' : 'ng'}">
      <div class="t">${ok ? '一致！' : 'そろわず…'}</div>
      <div>${ok ? (S.result.forced ? '親が一致と認めました。おつかれさまでした！' : 'みんなの答えがそろいました。おつかれさまでした！') : '次のお題で、もう一度そろえよう。'}</div>
    </div>
    <div class="topic">${esc(S.topic)}</div>
    ${cardsHTML(true)}
    <div class="stats"><div><b>${S.round}</b>回目</div><div><b>${fmtTime(S.elapsed)}</b>${ok ? 'かかった時間' : '経過'}</div></div>
    ${host && !ok ? '<button class="btn ghost" data-act="force">表記ゆれなので一致にする</button>' : ''}
  </div>
  ${host ? (ok ? '<div class="card"><button class="btn primary big" data-act="reset">最初からもう一度</button></div>' : hostPanelHTML('次のお題')) : `<div class="card center"><p class="muted">${ok ? 'クリアです！' : '親が次のお題を出すのを待っています…'}</p></div>`}
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
  } else if (!isHost) {
    return;
  } else if (act === 'reroll') { ui.gen = randTopic(); render(); }
  else if (act === 'start') {
    let topic = ui.gen;
    if (ui.useCustom) {
      const c = ui.custom.trim();
      if (!c) { const i = $('#custom'); if (i) i.focus(); return; }
      topic = { custom: c };
    }
    ui.gen = randTopic(); ui.custom = '';
    startRound(topic, ui.limit);
  } else if (act === 'close') lockWriting('host');
  else if (act === 'open') openAnswers();
  else if (act === 'force') forceMatch();
  else if (act === 'reset') resetGame();
  else if (act === 'kick') kick(el.dataset.id);
});

document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.id === 'answer') {
    myText = t.value;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(() => sendAnswer(myDone), 300);
  } else if (t.id === 'custom') ui.custom = t.value;
  else if (t.id === 'room') t.value = t.value.replace(/\D/g, '').slice(0, 4);
});
document.addEventListener('change', (ev) => {
  const t = ev.target;
  if (t.id === 'useCustom') { ui.useCustom = t.checked; render(); }
  else if (t.id === 'limit') ui.limit = Number(t.value) || 60;
});
window.addEventListener('beforeunload', (e) => {
  if (isHost && H && H.players.length > 1) { e.preventDefault(); e.returnValue = ''; }
});

render();
