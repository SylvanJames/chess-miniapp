/* ================= 国际象棋核心逻辑（无依赖，兼容 Node / 浏览器） ================= */
(function (root) {
  'use strict';

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const SYM = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙', k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const isWhite = p => p && p === p.toUpperCase();
  const isBlack = p => p && p === p.toLowerCase();
  const colorOf = p => !p ? null : (isWhite(p) ? 'w' : 'b');
  const sq2rc = s => [8 - parseInt(s[1], 10), s.charCodeAt(0) - 97]; // [row, col]
  const rc2sq = (r, c) => String.fromCharCode(97 + c) + (8 - r);

  class Chess {
    constructor(fen) { this.load(fen || START_FEN); }

    load(fen) {
      const parts = fen.trim().split(/\s+/);
      this.board = Array.from({ length: 8 }, () => Array(8).fill(null));
      const rows = parts[0].split('/');
      for (let r = 0; r < 8; r++) {
        let c = 0;
        for (const ch of rows[r]) {
          if (/\d/.test(ch)) c += parseInt(ch, 10);
          else this.board[r][c++] = ch;
        }
      }
      this.turn = parts[1] || 'w';
      this.castling = parts[2] || '-';
      this.ep = (parts[3] && parts[3] !== '-') ? parts[3] : null;
      this.halfmove = parseInt(parts[4] || '0', 10);
      this.fullmove = parseInt(parts[5] || '1', 10);
      return this;
    }

    fen() {
      const rows = [];
      for (let r = 0; r < 8; r++) {
        let s = '', empty = 0;
        for (let c = 0; c < 8; c++) {
          const p = this.board[r][c];
          if (p) { if (empty) { s += empty; empty = 0; } s += p; }
          else empty++;
        }
        if (empty) s += empty;
        rows.push(s);
      }
      return [rows.join('/'), this.turn, this.castling, this.ep || '-', this.halfmove, this.fullmove].join(' ');
    }

    get(sq) { const [r, c] = sq2rc(sq); return this.board[r][c]; }
    set(sq, p) { const [r, c] = sq2rc(sq); this.board[r][c] = p; }

    /** 找到某方王的位置（用于合法性校验） */
    kingSquare(color) {
      const target = color === 'w' ? 'K' : 'k';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
        if (this.board[r][c] === target) return rc2sq(r, c);
      return null;
    }

    /** 伪合法走法（不检查是否送将） */
    pseudoMoves(sq) {
      const piece = this.get(sq);
      if (!piece) return [];
      const color = colorOf(piece);
      const [r0, c0] = sq2rc(sq);
      const out = [];
      const ok = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
      const targetOk = (r, c) => { const t = this.board[r][c]; return !t || colorOf(t) !== color; };
      const push = (r, c) => { if (ok(r, c) && targetOk(r, c)) out.push(rc2sq(r, c)); };

      const type = piece.toLowerCase();
      const slide = (dirs) => dirs.forEach(([dr, dc]) => {
        let r = r0 + dr, c = c0 + dc;
        while (ok(r, c)) {
          const t = this.board[r][c];
          if (!t) out.push(rc2sq(r, c));
          else { if (colorOf(t) !== color) out.push(rc2sq(r, c)); break; }
          r += dr; c += dc;
        }
      });

      if (type === 'p') {
        const dir = color === 'w' ? -1 : 1;
        const startRow = color === 'w' ? 6 : 1;
        const promoRow = color === 'w' ? 0 : 7;
        if (ok(r0 + dir, c0) && !this.board[r0 + dir][c0]) {
          out.push(rc2sq(r0 + dir, c0));
          if (r0 === startRow && !this.board[r0 + 2 * dir][c0]) out.push(rc2sq(r0 + 2 * dir, c0));
        }
        for (const dc of [-1, 1]) {
          const r = r0 + dir, c = c0 + dc;
          if (!ok(r, c)) continue;
          const t = this.board[r][c];
          if (t && colorOf(t) !== color) out.push(rc2sq(r, c));
          else if (!t && this.ep && rc2sq(r, c) === this.ep) out.push(rc2sq(r, c));
        }
      } else if (type === 'n') {
        [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]
          .forEach(([dr, dc]) => push(r0 + dr, c0 + dc));
      } else if (type === 'b') slide([[-1,-1],[-1,1],[1,-1],[1,1]]);
      else if (type === 'r') slide([[-1,0],[1,0],[0,-1],[0,1]]);
      else if (type === 'q') slide([[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]);
      else if (type === 'k') {
        [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]
          .forEach(([dr, dc]) => push(r0 + dr, c0 + dc));
        // 王车易位
        const homeRow = color === 'w' ? 7 : 0;
        const kSq = color === 'w' ? 'e1' : 'e8';
        if (sq === kSq && this.castling.includes(color === 'w' ? 'K' : 'k')) {
          const rook = color === 'w' ? 'R' : 'r';
          const f = this.board[homeRow][5], g = this.board[homeRow][6];
          if (!f && !g && this.board[homeRow][7] === rook) out.push(rc2sq(homeRow, 6));
        }
        if (sq === kSq && this.castling.includes(color === 'w' ? 'Q' : 'q')) {
          const rook = color === 'w' ? 'R' : 'r';
          const b = this.board[homeRow][1], cc = this.board[homeRow][2], d = this.board[homeRow][3];
          if (!b && !cc && !d && this.board[homeRow][0] === rook) out.push(rc2sq(homeRow, 2));
        }
      }
      return out;
    }

    /** 某方是否被将军 */
    inCheck(color) {
      const ks = this.kingSquare(color);
      if (!ks) return false;
      const [kr, kc] = sq2rc(ks);
      const enemy = color === 'w' ? 'b' : 'w';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (!p || colorOf(p) !== enemy) continue;
        const moves = this.pseudoMoves(rc2sq(r, c));
        if (moves.includes(ks)) return true;
        // 兵的攻击方向需单独确认（pseudoMoves 对兵不会包含空格斜向）
        if (p.toLowerCase() === 'p') {
          const dir = enemy === 'w' ? -1 : 1;
          if (r + dir === kr && Math.abs(c - kc) === 1) return true;
        }
      }
      return false;
    }

    /** 在副本上走子，返回新 Chess 实例 */
    clone() { return new Chess(this.fen()); }

    /** 执行走子（不做合法性判断，调用方保证） */
    applyMove(from, to, promotion) {
      const [fr, fc] = sq2rc(from), [tr, tc] = sq2rc(to);
      const piece = this.board[fr][fc];
      if (!piece) return { piece: null, captured: null, promotion: null };
      const color = colorOf(piece);
      let capture = this.board[tr][tc];
      const type = piece.toLowerCase();

      // 吃过路兵
      if (type === 'p' && this.ep === to && !capture && fc !== tc) {
        capture = this.board[fr][tc];
        this.board[fr][tc] = null;
      }

      this.board[tr][tc] = piece;
      this.board[fr][fc] = null;

      // 升变
      if (type === 'p' && (tr === 0 || tr === 7)) {
        const promo = promotion || 'q';
        this.board[tr][tc] = color === 'w' ? promo.toUpperCase() : promo.toLowerCase();
      }

      // 王车易位：同步移动车
      if (type === 'k' && Math.abs(tc - fc) === 2) {
        const row = tr;
        if (tc === 6) { this.board[row][5] = this.board[row][7]; this.board[row][7] = null; }
        else { this.board[row][3] = this.board[row][0]; this.board[row][0] = null; }
      }

      // 更新易位权
      let cast = this.castling;
      const drop = ch => { cast = cast.split('').filter(x => x !== ch).join('') || '-'; };
      if (type === 'k') { if (color === 'w') { drop('K'); drop('Q'); } else { drop('k'); drop('q'); } }
      if (from === 'a1' || to === 'a1') drop('Q');
      if (from === 'h1' || to === 'h1') drop('K');
      if (from === 'a8' || to === 'a8') drop('q');
      if (from === 'h8' || to === 'h8') drop('k');
      this.castling = cast;

      // 吃过路兵目标格
      this.ep = (type === 'p' && Math.abs(tr - fr) === 2) ? rc2sq((tr + fr) / 2, fc) : null;

      // 半回合 / 回合数
      this.halfmove = (type === 'p' || capture) ? 0 : this.halfmove + 1;
      if (color === 'b') this.fullmove++;
      this.turn = color === 'w' ? 'b' : 'w';
      return { piece, captured: capture, promotion: (type === 'p' && (tr === 0 || tr === 7)) ? (promotion || 'q') : null };
    }

    /** 合法走法：过滤掉会让自己被将军的走法 */
    legalMoves(sq) {
      const piece = this.get(sq);
      if (!piece) return [];
      const color = colorOf(piece);
      return this.pseudoMoves(sq).filter(to => {
        const test = this.clone();
        test.applyMove(sq, to, 'q');
        return !test.inCheck(color);
      });
    }

    /** 全部合法走法 */
    allLegalMoves(color) {
      const col = color || this.turn;
      const res = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (!p || colorOf(p) !== col) continue;
        const sq = rc2sq(r, c);
        for (const to of this.legalMoves(sq)) res.push({ from: sq, to, piece: p });
      }
      return res;
    }

    /** 对局状态 */
    status() {
      const moves = this.allLegalMoves(this.turn);
      const check = this.inCheck(this.turn);
      if (moves.length === 0) return check ? { over: true, result: this.turn === 'w' ? 'b' : 'w', reason: 'checkmate' }
                                          : { over: true, result: 'draw', reason: 'stalemate' };
      if (this.halfmove >= 100) return { over: true, result: 'draw', reason: 'fifty' };
      const same = this.turn === 'w' ? 'B' : 'b';
      const pieces = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (this.board[r][c]) pieces.push(this.board[r][c]);
      if (pieces.length === 2 && pieces.every(p => p === 'K' || p === 'k' || p === same)) {
        return { over: true, result: 'draw', reason: 'insufficient' };
      }
      return { over: false, check, turn: this.turn };
    }

    /** 代数记谱（简化 SAN，用于走子记录展示） */
    san(from, to, promotion) {
      const piece = this.get(from);
      if (!piece) return from + to;
      const type = piece.toLowerCase();
      const [tr, tc] = sq2rc(to);
      let s = '';
      if (type === 'k' && Math.abs(to.charCodeAt(0) - from.charCodeAt(0)) === 2) {
        s = to.charCodeAt(0) === 103 ? 'O-O' : 'O-O-O';
      } else {
        const capture = this.get(to) || (type === 'p' && from[0] !== to[0]);
        if (type === 'p') { if (capture) s += from[0] + 'x'; }
        else {
          s += type.toUpperCase();
          // 同类型棋子消歧
          const others = [];
          for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
            const sq = rc2sq(r, c);
            if (sq === from) continue;
            const p = this.board[r][c];
            if (p && colorOf(p) === colorOf(piece) && p.toLowerCase() === type && this.legalMoves(sq).includes(to)) others.push(sq);
          }
          if (others.length) {
            const sameFile = others.some(x => x[0] === from[0]);
            s += sameFile ? from[1] : from[0];
          }
          if (capture) s += 'x';
        }
        s += to;
        if (promotion) s += '=' + promotion.toUpperCase();
      }
      const after = this.clone(); after.applyMove(from, to, promotion);
      const st = after.status();
      if (st.over && st.reason === 'checkmate') s += '#';
      else if (st.check) s += '+';
      return s;
    }
  }

  Chess.START_FEN = START_FEN;
  Chess.SYM = SYM;
  Chess.colorOf = colorOf;
  Chess.rc2sq = rc2sq;
  Chess.sq2rc = sq2rc;

  if (typeof module !== 'undefined' && module.exports) module.exports = Chess;
  else root.Chess = Chess;
})(typeof globalThis !== 'undefined' ? globalThis : this);
