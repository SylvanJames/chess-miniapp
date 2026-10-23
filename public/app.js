/* ================= 国际象棋小程序 · 前端交互 ================= */
(function () {
  'use strict';

  /* ---------- 全局状态 ---------- */
  const S = {
    name: '棋手',
    roomId: null,
    side: null,          // 'w' | 'b'
    peer: null,          // 对手昵称
    game: new Chess(),
    sel: null,           // 当前选中格
    legal: [],           // 选中格的可走格
    lastMove: null,      // { from, to }
    history: [],         // 走子记录 [{color, san}]
    gameOver: false,
    pendingPromotion: null,
    peerOnline: false,
    unread: 0,
    ws: null,
    chatOpen: false,
    myTurnMsg: false,
  };

  const $ = id => document.getElementById(id);
  const PIECE_NAME = { k: '王', q: '后', r: '车', b: '象', n: '马', p: '兵' };
  const value = p => ({ p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 })[p.toLowerCase()];

  /* ---------- 状态栏时间 ---------- */
  function tickClock() {
    const d = new Date();
    $('sbTime').textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  tickClock(); setInterval(tickClock, 20000);

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(text, ms = 1800) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  /* ---------- 通用对话框 ---------- */
  function showDialog({ title, text, emoji, buttons }) {
    const mask = $('dlgMask');
    $('dlgTitle').textContent = title;
    $('dlgText').textContent = text || '';
    const old = mask.querySelector('.over-emoji');
    if (old) old.remove();
    if (emoji) {
      const e = document.createElement('div');
      e.className = 'over-emoji'; e.textContent = emoji;
      mask.querySelector('.dialog').insertBefore(e, mask.querySelector('.dialog-title'));
    }
    const box = $('dlgBtns');
    box.innerHTML = '';
    buttons.forEach(b => {
      const btn = document.createElement('button');
      btn.className = 'd-btn ' + (b.cls || 'd-ghost');
      btn.textContent = b.label;
      btn.onclick = () => { mask.classList.remove('show'); b.onClick && b.onClick(); };
      box.appendChild(btn);
    });
    mask.classList.add('show');
  }
  $('dlgMask').addEventListener('click', e => { if (e.target === $('dlgMask')) $('dlgMask').classList.remove('show'); });

  /* ================= WebSocket ================= */
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    const ws = new WebSocket(proto + location.host);
    S.ws = ws;

    ws.onopen = () => console.log('[ws] connected');
    ws.onclose = () => {
      if (S.roomId && !S.gameOver) {
        setStatus('连接已断开，正在重连…', 'warn');
        setTimeout(() => { if (S.roomId) connect(); }, 1500);
      }
    };
    ws.onerror = () => {};
    ws.onmessage = ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleServer(msg);
    };
  }

  function sendRaw(obj) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify(obj));
  }

  function handleServer(msg) {
    switch (msg.type) {
      case 'joined':
        S.roomId = msg.roomId; S.side = msg.side; S.name = msg.name; S.peer = msg.peer || null;
        S.peerOnline = !!msg.peer;
        S.gameOver = false;
        enterGame(msg);
        break;

      case 'peer':
        if (msg.event === 'join') {
          S.peer = msg.name; S.peerOnline = true;
          setStatus('对手已加入，轮到你走棋');
          renderPlayers();
        } else if (msg.event === 'leave') {
          S.peerOnline = false;
          renderPlayers();
        }
        break;

      case 'move':
        applyRemoteMove(msg);
        break;

      case 'answer':
        if (msg.kind === 'undo') {
          S.pendingOffer = null;
          if (msg.ok) {
            // 对方同意：回退两步（对方的 + 我方的）
            doUndoLocal();
            if (S.history.length && S.history[S.history.length - 1].color !== S.side) doUndoLocal();
            pushSys(`「${msg.by}」同意悔棋，已回退`);
          } else {
            pushSys(`「${msg.by}」拒绝了悔棋`);
            toast('对方拒绝了悔棋');
          }
        } else if (msg.kind === 'draw') {
          S.pendingOffer = null;
          if (msg.ok) {
            pushSys(`「${msg.by}」同意和棋`);
            endGame('draw', '双方同意和棋');
          } else {
            pushSys(`「${msg.by}」拒绝了和棋`);
            toast('对方拒绝了和棋');
          }
        }
        break;

      /* 收到对方的悔棋 / 提和请求 → 弹窗裁决 */
      case 'request': {
        const isUndo = msg.kind === 'undo';
        showDialog({
          emoji: isUndo ? '↩︎' : '🤝',
          title: isUndo ? '对方申请悔棋' : '对方提出和棋',
          text: `「${msg.by}」${isUndo ? '希望回退一步，是否同意？' : '希望和棋，是否同意？'}`,
          buttons: [
            { label: '拒绝', cls: 'd-ghost', onClick: () => sendRaw({ type: 'answer', ok: false, kind: msg.kind }) },
            { label: '同意', cls: 'd-primary', onClick: () => {
                sendRaw({ type: 'answer', ok: true, kind: msg.kind });
                if (isUndo) {
                  doUndoLocal();
                  if (S.history.length && S.history[S.history.length - 1].color !== S.side) doUndoLocal();
                  pushSys(`你同意了「${msg.by}」的悔棋请求`);
                } else {
                  pushSys(`你同意了「${msg.by}」的和棋请求`);
                  endGame('draw', '双方同意和棋');
                }
              } },
          ],
        });
        break;
      }

      case 'gameover':
        if (msg.reason === 'resign') endGame(msg.color === 'w' ? 'b' : 'w', `「${msg.by}」认输`);
        else if (msg.reason === 'draw') endGame('draw', `「${msg.by}」提出和棋`);
        break;

      case 'chat':
        pushChat({ name: msg.name, text: msg.text, ts: msg.ts, self: msg.self });
        break;

      /* ---------- 语音信令转发 ---------- */
      case 'voice':
        Voice.handleSignal({ action: msg.action, payload: msg.payload, by: msg.by });
        break;

      case 'sys':
        pushSys(msg.text);
        break;

      case 'error':
        $('lobbyTip').textContent = msg.text;
        toast(msg.text);
        break;
    }
  }

  /* ================= 大厅 ================= */
  $('btnCreate').onclick = () => {
    const name = ($('inpName').value || '棋手').trim().slice(0, 12);
    $('lobbyTip').textContent = '';
    sendRaw({ type: 'create', name });
  };

  $('btnJoin').onclick = () => {
    const name = ($('inpName').value || '棋手').trim().slice(0, 12);
    const roomId = $('inpRoom').value.trim().toUpperCase();
    if (roomId.length !== 4) { $('lobbyTip').textContent = '请输入 4 位房间号'; return; }
    $('lobbyTip').textContent = '';
    sendRaw({ type: 'join', name, roomId });
  };

  $('inpRoom').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoin').click(); });
  $('inpName').addEventListener('keydown', e => { if (e.key === 'Enter') $('inpRoom').focus(); });
  $('inpRoom').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

  /* ================= 进入对局 ================= */
  let autoFlip = false; // 是否上下翻转棋盘（黑方视角置底）

  function enterGame(msg) {
    autoFlip = (S.side === 'b');
    $('pageLobby').classList.remove('active');
    $('pageGame').classList.add('active');
    $('btnBack').style.visibility = 'visible';
    $('roomCode').textContent = S.roomId;

    S.game = new Chess();
    S.sel = null; S.legal = []; S.lastMove = null; S.history = [];
    S.gameOver = false; S.unread = 0; updateBadge();

    if (S.side === 'b') {
      $('botName').textContent = S.name + '（我）';
      $('botSub').textContent = '黑方';
    } else {
      $('botName').textContent = S.name + '（我）';
      $('botSub').textContent = '白方';
    }

    renderPlayers();
    renderBoard();
    renderHistory();
    updateStatus();

    if (S.side === 'w' && !S.peer) setStatus('等待对手加入…房间号 ' + S.roomId);
    else if (S.side === 'w') setStatus('对手已加入，你执白先行');
    else setStatus('已加入房间，等待白方走子');

    // 恢复聊天记录
    $('chatList').innerHTML = '';
    if (msg.chat && msg.chat.length) {
      msg.chat.forEach(c => pushChat({ ...c, self: false }));
    } else {
      $('chatList').innerHTML = '<div class="chat-empty">还没有消息，打个招呼吧 👋</div>';
    }
  }

  /* ---------- 渲染：玩家信息 ---------- */
  function renderPlayers() {
    // 视角：我方永远在下方
    const meName = S.name + '（我）';
    const meSide = S.side === 'w' ? '白方' : '黑方';
    const opName = S.peer ? S.peer : '等待对手加入…';
    const opSide = S.side === 'w' ? '黑方' : '白方';

    $('botName').textContent = meName;
    $('botSub').textContent = meSide;
    $('topName').textContent = opName;
    $('topSub').textContent = opSide + (S.peer && !S.peerOnline ? ' · 已离线' : '');

    // 头像
    document.querySelector('#stripBottom .avatar').textContent = S.side === 'w' ? '♔' : '♚';
    document.querySelector('#stripBottom .avatar').className = 'avatar ' + (S.side === 'w' ? 'avatar-w' : 'avatar-b');
    document.querySelector('#stripTop .avatar').textContent = S.side === 'w' ? '♚' : '♔';
    document.querySelector('#stripTop .avatar').className = 'avatar ' + (S.side === 'w' ? 'avatar-b' : 'avatar-w');

    // 回合指示
    const turn = S.gameOver ? null : S.game.turn;
    $('botTurn').parentElement.classList.toggle('active', turn === S.side);
    $('topTurn').parentElement.classList.toggle('active', turn && turn !== S.side);

    // 被吃棋子
    renderCaptured();
  }

  function renderCaptured() {
    const captured = { w: [], b: [] }; // captured[color] = 该方被吃掉的子
    // 从历史推算（这里用简化的子力差展示）
    const full = { w: { p: 8, n: 2, b: 2, r: 2, q: 1 }, b: { p: 8, n: 2, b: 2, r: 2, q: 1 } };
    const now = { w: {}, b: {} };
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = S.game.board[r][c];
      if (!p) continue;
      const col = p === p.toUpperCase() ? 'w' : 'b';
      const t = p.toLowerCase();
      if (t === 'k') continue;
      now[col][t] = (now[col][t] || 0) + 1;
    }
    const lost = { w: [], b: [] };
    ['w', 'b'].forEach(col => {
      for (const t in full[col]) {
        const n = full[col][t] - (now[col][t] || 0);
        for (let i = 0; i < n; i++) lost[col].push(t);
      }
    });
    // 显示：我吃掉对方的子 = 对方损失
    const myCaptured = lost[S.side === 'w' ? 'b' : 'w'];   // 我的战利品
    const opCaptured = lost[S.side === 'w' ? 'w' : 'b'];   // 对方的战利品
    const toSym = (arr, upper) => arr.sort((a, b) => value({ toLowerCase: () => b }) - 0)
      .sort((a, b) => ({p:1,n:3,b:3,r:5,q:9})[b] - ({p:1,n:3,b:3,r:5,q:9})[a])
      .map(t => upper ? t.toUpperCase() : t).map(t => Chess.SYM[t]).join('');
    $('botCaptured').textContent = toSym(myCaptured.slice(), S.side === 'w');
    $('topCaptured').textContent = toSym(opCaptured.slice(), S.side !== 'w');
  }

  /* ---------- 渲染：棋盘 ---------- */
  function renderBoard() {
    const board = $('board');
    board.innerHTML = '';
    // 视角翻转：黑方玩家看到翻转后的棋盘
    const rows = autoFlip ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
    const cols = autoFlip ? [...Array(8).keys()].reverse() : [...Array(8).keys()];

    const checkColor = S.gameOver ? null : (S.game.inCheck(S.game.turn) ? S.game.turn : null);
    const kingSq = checkColor ? S.game.kingSquare(checkColor) : null;

    for (const r of rows) {
      for (const c of cols) {
        const sq = Chess.rc2sq(r, c);
        const piece = S.game.board[r][c];
        const cell = document.createElement('div');
        cell.className = 'sq ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        cell.dataset.sq = sq;

        if (S.sel === sq) cell.classList.add('sel');
        if (S.lastMove && S.lastMove.from === sq) cell.classList.add('last-from');
        if (S.lastMove && S.lastMove.to === sq) cell.classList.add('last-to');
        if (kingSq === sq) cell.classList.add('check');

        if (c === (autoFlip ? 7 : 0)) {
          const cr = document.createElement('span');
          cr.className = 'coord-r';
          cr.textContent = 8 - r;
          cell.appendChild(cr);
        }

        if (piece) {
          const el = document.createElement('span');
          el.className = 'piece ' + (piece === piece.toUpperCase() ? 'w' : 'b');
          el.textContent = Chess.SYM[piece];
          cell.appendChild(el);
        }

        if (S.legal.includes(sq)) {
          const h = document.createElement('span');
          h.className = 'hint' + (piece ? ' cap' : '');
          cell.appendChild(h);
        }

        cell.onclick = () => onSquareClick(sq);
        board.appendChild(cell);
      }
    }
  }

  /* ---------- 点击棋盘 ---------- */
  function onSquareClick(sq) {
    if (S.gameOver) return;
    if (S.side !== S.game.turn) { toast('还没轮到你走棋'); return; }

    const piece = S.game.get(sq);
    const myColor = piece && (piece === piece.toUpperCase() ? 'w' : 'b');

    // 已选中且点击的是合法目标 → 走子
    if (S.sel && S.legal.includes(sq)) {
      tryMove(S.sel, sq);
      return;
    }
    // 选中自己的子
    if (piece && myColor === S.side) {
      S.sel = sq;
      S.legal = S.game.legalMoves(sq);
      if (S.legal.length === 0) toast('该棋子没有合法走法');
      renderBoard();
      return;
    }
    // 点空白 / 取消
    S.sel = null; S.legal = [];
    renderBoard();
  }

  /* ---------- 走子 ---------- */
  function tryMove(from, to) {
    const piece = S.game.get(from);
    const isPawn = piece.toLowerCase() === 'p';
    const toRow = Chess.sq2rc(to)[0];
    // 升变
    if (isPawn && (toRow === 0 || toRow === 7)) {
      S.pendingPromotion = { from, to };
      openPromotion(piece === piece.toUpperCase() ? 'w' : 'b');
      return;
    }
    commitMove(from, to, null);
  }

  function openPromotion(color) {
    const row = $('promoRow');
    row.innerHTML = '';
    ['q', 'r', 'b', 'n'].forEach(t => {
      const b = document.createElement('button');
      b.className = color;
      b.textContent = Chess.SYM[color === 'w' ? t.toUpperCase() : t];
      b.onclick = () => {
        $('promoMask').classList.remove('show');
        const p = S.pendingPromotion; S.pendingPromotion = null;
        commitMove(p.from, p.to, t);
      };
      row.appendChild(b);
    });
    $('promoMask').classList.add('show');
  }

  function commitMove(from, to, promotion) {
    const san = S.game.san(from, to, promotion);
    const color = S.game.turn;
    S.game.applyMove(from, to, promotion);

    S.lastMove = { from, to };
    S.sel = null; S.legal = [];
    S.history.push({ color, san, from, to, promotion });

    renderBoard();
    renderHistory();
    renderPlayers();
    updateStatus();
    beep();

    sendRaw({ type: 'move', from, to, promotion, san, fen: S.game.fen(), color });

    checkGameEnd();
  }

  /* ---------- 接收对方走子 ---------- */
  function applyRemoteMove(msg) {
    S.game.load(msg.fen);
    S.lastMove = { from: msg.from, to: msg.to };
    S.history.push({ color: msg.color, san: msg.san, from: msg.from, to: msg.to, promotion: msg.promotion || null });
    S.sel = null; S.legal = [];
    renderBoard();
    renderHistory();
    renderPlayers();
    updateStatus();
    beep();
    checkGameEnd();
  }

  /* ---------- 本地悔棋（回退一步） ---------- */
  function doUndoLocal() {
    if (S.history.length === 0) return;
    S.history.pop();
    rebuildFromHistory();
  }

  function rebuildFromHistory() {
    const g = new Chess();
    for (const h of S.history) {
      if (h.from && h.to) g.applyMove(h.from, h.to, h.promotion || null);
    }
    S.game = g;
    S.sel = null; S.legal = [];
    const last = S.history[S.history.length - 1];
    S.lastMove = last && last.from ? { from: last.from, to: last.to } : null;
    S.gameOver = S.game.status().over;
    renderBoard(); renderHistory(); renderPlayers(); updateStatus();
  }

  /* ---------- 结束检测 ---------- */
  function checkGameEnd() {
    const st = S.game.status();
    if (st.over) {
      if (st.reason === 'checkmate') {
        const winner = st.result;
        endGame(winner, '将死');
      } else {
        const label = { stalemate: '逼和（无子可动）', fifty: '50 回合规则', insufficient: '子力不足' }[st.reason] || '和棋';
        endGame('draw', label);
      }
    }
  }

  function endGame(result, reason) {
    if (S.gameOver) return;
    S.gameOver = true;
    renderPlayers();
    updateStatus();

    let emoji, title, text;
    if (result === 'draw') {
      emoji = '🤝'; title = '和棋';
      text = reason;
    } else if (result === S.side) {
      emoji = '🏆'; title = '你赢了！';
      text = reason;
    } else {
      emoji = '😔'; title = '你输了';
      text = reason;
    }
    showDialog({
      emoji, title, text,
      buttons: [
        { label: '返回大厅', cls: 'd-ghost', onClick: backToLobby },
        { label: '复盘聊天', cls: 'd-primary', onClick: () => openChat() },
      ],
    });
  }

  /* ---------- 状态栏文本 ---------- */
  function setStatus(text, cls) {
    const el = $('gameStatus');
    el.textContent = text;
    el.className = 'game-status' + (cls ? ' ' + cls : '');
  }

  function updateStatus() {
    if (S.gameOver) return;
    if (!S.peer) { setStatus('等待对手加入…房间号 ' + S.roomId); return; }
    const st = S.game.status();
    const my = S.game.turn === S.side;
    const who = my ? '轮到你走棋' : '等待对方走棋…';
    if (st.check) setStatus((my ? '你被将军！' : '对方被将军'), 'warn');
    else setStatus(who);
    // 按钮可用性
    $('btnUndo').disabled = S.history.length < 1;
    $('btnDraw').disabled = false;
    $('btnResign').disabled = false;
  }

  /* ---------- 走子记录 ---------- */
  function renderHistory() {
    const el = $('movelist');
    if (S.history.length === 0) { el.innerHTML = ''; return; }
    let html = '';
    for (let i = 0; i < S.history.length; i += 2) {
      const no = i / 2 + 1;
      const wMove = S.history[i];
      const bMove = S.history[i + 1];
      html += `<span class="mv-no">${no}.</span>`;
      html += `<span class="mv">${wMove ? wMove.san : ''}</span>`;
      html += `<span class="mv">${bMove ? bMove.san : ''}</span>`;
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
  }

  /* ================= 操作按钮 ================= */
  $('btnUndo').onclick = () => {
    if (S.gameOver) return;
    if (S.history.length === 0) return toast('还没有可回退的着法');
    if (!S.peer) return toast('对手还没加入');
    if (S.pendingOffer) return toast('已有请求等待对方回应');
    S.pendingOffer = 'undo';
    sendRaw({ type: 'request', kind: 'undo' });
    pushSys(`你向「${S.peer}」申请悔棋，等待对方回应…`);
  };

  $('btnDraw').onclick = () => {
    if (S.gameOver) return;
    if (!S.peer) return toast('对手还没加入');
    if (S.pendingOffer) return toast('已有请求等待对方回应');
    S.pendingOffer = 'draw';
    sendRaw({ type: 'request', kind: 'draw' });
    pushSys(`你向「${S.peer}」提出和棋，等待对方回应…`);
  };

  $('btnResign').onclick = () => {
    if (S.gameOver || !S.peer) return;
    showDialog({
      title: '确认认输？',
      text: '认输后本局将判你为负。',
      buttons: [
        { label: '取消', cls: 'd-ghost', onClick: () => {} },
        { label: '确认认输', cls: 'd-danger', onClick: () => {
            sendRaw({ type: 'resign', color: S.side });
            endGame(S.side === 'w' ? 'b' : 'w', '你认输了');
          } },
      ],
    });
  };

  /* ================= 聊天 ================= */
  function openChat() {
    $('chatMask').classList.add('show');
    $('chatSheet').classList.add('show');
    S.chatOpen = true;
    S.unread = 0; updateBadge();
    setTimeout(() => {
      const list = $('chatList');
      list.scrollTop = list.scrollHeight;
      if (window.innerWidth > 700) $('chatInput').focus();
    }, 320);
  }
  function closeChat() {
    $('chatMask').classList.remove('show');
    $('chatSheet').classList.remove('show');
    S.chatOpen = false;
  }
  $('btnChat').onclick = openChat;
  $('chatClose').onclick = closeChat;
  $('chatMask').onclick = closeChat;

  function pushChat({ name, text, ts, self }) {
    const list = $('chatList');
    const empty = list.querySelector('.chat-empty');
    if (empty) empty.remove();

    const wrap = document.createElement('div');
    wrap.className = 'msg ' + (self ? 'self' : 'other');
    const t = new Date(ts || Date.now());
    const hhmm = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');

    wrap.innerHTML =
      `<div class="msg-name">${escapeHtml(name)} · ${hhmm}</div>` +
      `<div class="bubble">${escapeHtml(text)}</div>`;
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;

    if (!self && !S.chatOpen) { S.unread++; updateBadge(); }
  }

  function pushSys(text) {
    const list = $('chatList');
    const empty = list.querySelector('.chat-empty');
    if (empty) empty.remove();
    const wrap = document.createElement('div');
    wrap.className = 'msg sys';
    wrap.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    list.appendChild(wrap);
    list.scrollTop = list.scrollHeight;
    if (!S.chatOpen) { S.unread++; updateBadge(); }
  }

  function updateBadge() {
    const b = $('chatBadge');
    b.textContent = S.unread > 99 ? '99+' : S.unread;
    b.classList.toggle('show', S.unread > 0);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function sendChat() {
    const inp = $('chatInput');
    const text = inp.value.trim();
    if (!text) return;
    sendRaw({ type: 'chat', text });
    inp.value = '';
  }
  $('chatSend').onclick = sendChat;
  $('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  $('chatQuick').addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $('chatInput').value = btn.dataset.q;
    sendChat();
  });

  /* ================= 语音对讲 ================= */
  const VB = {
    bar: () => $('voiceBar'),
    title: () => $('voiceTitle'),
    sub: () => $('voiceSub'),
    main: () => $('btnVoice'),
    icon: () => $('voiceIcon'),
    mute: () => $('btnMute'),
    hang: () => $('btnHang'),
    wave: () => $('voiceWave'),
  };
  let micMeter = null;
  let remoteMeter = null;

  function initVoice() {
    if (!Voice.isSupported()) {
      VB.bar().style.display = 'none';
      return;
    }
    Voice.V.send = payload => sendRaw({ type: 'voice', ...payload });
    Voice.V.onStateChange = onVoiceState;

    // 波形条动画
    const bars = VB.wave().querySelectorAll('span');
    const waveBase = [0.5, 0.85, 1, 0.7, 0.45];
    let waveRaf = null, waveAmp = 0;
    function animateWave() {
      bars.forEach((b, i) => {
        b.style.height = (5 + waveBase[i] * waveAmp * 20).toFixed(1) + 'px';
      });
      waveRaf = requestAnimationFrame(animateWave);
    }
    animateWave();

    // 我方说话音量 → 波形
    const origOnLevel = () => {};
    function startMicMeter() {
      if (micMeter) return;
      micMeter = Voice.createLevelMeter(Voice.V.localStream, lv => {
        waveAmp = Math.max(waveAmp * 0.7, lv);
        const av = document.querySelector('#stripBottom .avatar');
        if (av) av.classList.toggle('speaking', lv > 0.08);
      });
    }
    function stopMicMeter() {
      if (micMeter) { micMeter.stop(); micMeter = null; }
      const av = document.querySelector('#stripBottom .avatar');
      if (av) av.classList.remove('speaking');
    }
    S._startMicMeter = startMicMeter;
    S._stopMicMeter = stopMicMeter;

    // 衰减
    setInterval(() => { waveAmp *= 0.82; }, 120);

    VB.main().onclick = async () => {
      if (!S.peer) return toast('对手还没加入');
      if (Voice.V.state === 'active' || Voice.V.state === 'connecting') { Voice.hangup(); return; }
      try {
        await Voice.invite();
      } catch (e) {
        toast(e.message || '无法获取麦克风权限');
      }
    };

    VB.mute().onclick = () => {
      const m = Voice.toggleMute();
      VB.mute().textContent = m ? '🔇' : '🔊';
      VB.mute().classList.toggle('muted', m);
      toast(m ? '已静音' : '已取消静音', 1000);
    };

    VB.hang().onclick = () => Voice.hangup();
  }

  function onVoiceState(state, extra) {
    const bar = VB.bar();
    bar.classList.remove('active', 'ringing');

    switch (state) {
      case 'inviting':
        bar.classList.add('ringing');
        VB.title().textContent = '正在呼叫…';
        VB.sub().textContent = `等待「${S.peer || '对手'}」接听`;
        VB.icon().textContent = '⏳';
        VB.main().classList.add('on');
        break;

      case 'ringing':
        bar.classList.add('ringing');
        VB.title().textContent = '来电邀请';
        VB.sub().textContent = `「${extra || S.peer}」想与你语音`;
        showCallInvite(extra);
        break;

      case 'connecting':
        bar.classList.add('active');
        VB.title().textContent = '正在接通…';
        VB.sub().textContent = '正在建立点对点语音';
        VB.icon().textContent = '🔗';
        $('callMask').classList.remove('show');
        break;

      case 'active':
        bar.classList.add('active');
        VB.title().textContent = '语音通话中';
        VB.icon().textContent = '🎙️';
        VB.main().classList.remove('on');
        VB.mute().style.display = 'flex';
        VB.hang().style.display = 'flex';
        $('callMask').classList.remove('show');
        if (S._startMicMeter) S._startMicMeter();
        tickVoiceDuration();
        pushSys('语音通话已接通');
        break;

      case 'ended':
        VB.title().textContent = '语音对讲';
        VB.sub().textContent = extra || '点击麦克风与对手语音';
        VB.icon().textContent = '🎙️';
        VB.main().classList.remove('on');
        VB.mute().style.display = 'none';
        VB.hang().style.display = 'none';
        VB.mute().textContent = '🔊';
        VB.mute().classList.remove('muted');
        $('callMask').classList.remove('show');
        clearInterval(S._voiceTimer);
        if (S._stopMicMeter) S._stopMicMeter();
        if (extra) pushSys(extra);
        break;
    }
  }

  function tickVoiceDuration() {
    clearInterval(S._voiceTimer);
    S._voiceTimer = setInterval(() => {
      if (Voice.V.state !== 'active') return clearInterval(S._voiceTimer);
      const s = Voice.duration();
      const mm = String(Math.floor(s / 60)).padStart(2, '0');
      const ss = String(s % 60).padStart(2, '0');
      VB.title().textContent = `语音通话中 ${mm}:${ss}`;
      VB.sub().textContent = Voice.V.lastJitter ? `延迟 ${Voice.V.lastJitter} · 静音请按 🔇` : '静音请按 🔇';
    }, 1000);
  }

  function showCallInvite(name) {
    $('callText').textContent = `「${name || S.peer}」想与你语音对局`;
    $('callAvatar').textContent = S.side === 'w' ? '♚' : '♔';
    $('callMask').classList.add('show');
  }

  $('callAccept').onclick = async () => {
    $('callMask').classList.remove('show');
    try { await Voice.accept(); }
    catch (e) { toast(e.message || '无法获取麦克风权限'); }
  };
  $('callDecline').onclick = () => {
    $('callMask').classList.remove('show');
    Voice.decline();
    pushSys('你拒绝了语音邀请');
  };

  /* ================= 顶栏 / 规则 ================= */
  $('btnCopy').onclick = async () => {
    const text = `来下国际象棋！房间号：${S.roomId}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('邀请信息已复制');
    } catch {
      const inp = document.createElement('input');
      inp.value = text; document.body.appendChild(inp); inp.select();
      document.execCommand('copy'); inp.remove();
      toast('邀请信息已复制');
    }
  };

  $('btnRules').onclick = () => $('rulesMask').classList.add('show');
  $('rulesClose').onclick = () => $('rulesMask').classList.remove('show');
  $('rulesMask').onclick = e => { if (e.target === $('rulesMask')) $('rulesMask').classList.remove('show'); };

  $('btnBack').onclick = () => {
    showDialog({
      title: '退出对局？',
      text: '离开后将无法继续本局对战。',
      buttons: [
        { label: '继续下棋', cls: 'd-ghost', onClick: () => {} },
        { label: '确认退出', cls: 'd-danger', onClick: backToLobby },
      ],
    });
  };

  function backToLobby() {
    try { Voice.hangup(); } catch {}
    clearInterval(S._voiceTimer);
    if (S._stopMicMeter) S._stopMicMeter();
    if (S.ws) { try { S.ws.close(); } catch {} }
    S.roomId = null; S.side = null; S.peer = null; S.gameOver = false;
    S.history = []; S.unread = 0; updateBadge();
    closeChat();
    $('pageGame').classList.remove('active');
    $('pageLobby').classList.add('active');
    $('btnBack').style.visibility = 'hidden';
    $('inpRoom').value = '';
    $('lobbyTip').textContent = '';
    connect();
  }

  /* ================= 音效（走子轻响） ================= */
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      o.type = 'sine'; o.frequency.value = 620;
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
      o.start(); o.stop(audioCtx.currentTime + 0.12);
    } catch {}
  }

  /* ================= 键盘快捷键 ================= */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if ($('promoMask').classList.contains('show')) return;
      if (S.chatOpen) closeChat();
    }
  });

  /* ================= 启动 ================= */
  initVoice();
  connect();
  // 支持 ?room=XXXX 直接加入
  const params = new URLSearchParams(location.search);
  if (params.get('room')) {
    $('inpRoom').value = params.get('room').toUpperCase();
    if (params.get('name')) $('inpName').value = params.get('name');
  }
})();
