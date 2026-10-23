/**
 * 国际象棋 · 双人对战 + 对局聊天  （小程序风格 Demo）
 * 纯 Node 实现：静态页服务 + WebSocket 房间/走子/聊天
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8848;
const PUB = path.join(__dirname, 'public');

/* ---------------- 静态文件服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain; charset=utf-8'}); return res.end('404 Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

/* ---------------- 极简 WebSocket（RFC6455，无依赖） ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();       // 全部连接
const rooms = new Map();         // roomId -> { id, players:[conn], spectators:[conn], chat:[] }

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);

  const conn = {
    socket, alive: true, id: crypto.randomBytes(4).toString('hex'),
    room: null, name: '棋手', side: null, buf: Buffer.alloc(0),
  };
  clients.add(conn);

  socket.on('data', chunk => {
    conn.buf = Buffer.concat([conn.buf, chunk]);
    let frame;
    while ((frame = decodeFrame(conn.buf))) {
      conn.buf = conn.buf.slice(frame.total);
      if (frame.opcode === 0x8) return closeConn(conn);          // close
      if (frame.opcode === 0x9) { sendRaw(conn, frame.payload, 0xA); continue; } // ping -> pong
      if (frame.opcode === 0xA) continue;                         // pong
      if (frame.opcode === 0x1) {
        let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        handle(conn, msg);
      }
    }
  });
  socket.on('error', () => closeConn(conn));
  socket.on('close', () => closeConn(conn));
  socket.on('end', () => closeConn(conn));
  socket.setTimeout(60000, () => closeConn(conn));   // 空闲超时兜底
});

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  let payload = buf.slice(off + maskLen, off + maskLen + len);
  if (masked) {
    const mask = buf.slice(off, off + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload, total: off + maskLen + len };
}

function sendRaw(conn, payload, opcode = 0x1) {
  if (!conn.socket.writable) return;
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode;
  try { conn.socket.write(Buffer.concat([header, data])); } catch {}
}
function send(conn, obj) { sendRaw(conn, JSON.stringify(obj)); }

function closeConn(conn) {
  if (!conn.alive) return;
  conn.alive = false;
  clients.delete(conn);
  const room = conn.room && rooms.get(conn.room);
  if (room) {
    const i = room.players.indexOf(conn);
    if (i >= 0) room.players.splice(i, 1);
    broadcast(room, { type: 'peer', event: 'leave', name: conn.name }, conn);
    broadcast(room, { type: 'sys', text: `「${conn.name}」离开了对局` });
    if (room.players.length === 0) rooms.delete(room.id);
  }
  try { conn.socket.destroy(); } catch {}
}

function broadcast(room, obj, except) {
  for (const c of room.players) if (c !== except && c.alive) send(c, obj);
}

/* ---------------- 业务逻辑 ---------------- */
function newRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
    if (!rooms.has(id)) return id;
  }
  return 'R' + Date.now().toString(36).slice(-3).toUpperCase();
}

function handle(conn, msg) {
  switch (msg.type) {
    /* 创建房间 */
    case 'create': {
      const id = newRoomId();
      const room = { id, players: [], history: [], chat: [] };
      rooms.set(id, room);
      conn.name = (msg.name || '棋手').slice(0, 12);
      conn.room = id; conn.side = 'w';
      room.players.push(conn);
      send(conn, { type: 'joined', roomId: id, side: 'w', name: conn.name, peer: null, chat: [] });
      break;
    }
    /* 加入房间 */
    case 'join': {
      const id = String(msg.roomId || '').toUpperCase().trim();
      const room = rooms.get(id);
      conn.name = (msg.name || '棋手').slice(0, 12);
      if (!room) { send(conn, { type: 'error', text: '房间不存在，请检查房间号' }); break; }
      if (room.players.length >= 2) { send(conn, { type: 'error', text: '房间已满，无法加入' }); break; }
      conn.room = id; conn.side = 'b';
      room.players.push(conn);
      send(conn, {
        type: 'joined', roomId: id, side: 'b', name: conn.name,
        peer: room.players[0].name, history: room.history, chat: room.chat,
      });
      broadcast(room, { type: 'peer', event: 'join', name: conn.name }, conn);
      broadcast(room, { type: 'sys', text: `「${conn.name}」加入了对局，可以开始下棋了` }, conn);
      break;
    }
    /* 走子 */
    case 'move': {
      const room = conn.room && rooms.get(conn.room);
      if (!room) break;
      const isRejoin = msg.action === 'rejoin';
      room.history.push({ from: msg.from, to: msg.to, promotion: msg.promotion || null,
                          san: msg.san || '', fen: msg.fen, color: msg.color, rejoin: isRejoin });
      if (isRejoin) {
        broadcast(room, { type: 'sys', text: `「${conn.name}」申请悔棋` }, conn);
      }
      broadcast(room, { type: 'move', from: msg.from, to: msg.to, promotion: msg.promotion || null,
                        san: msg.san || '', fen: msg.fen, color: msg.color, rejoin: isRejoin }, conn);
      break;
    }
    /* 议和结论（同意/拒绝悔棋、和棋） */
    case 'answer': {
      const room = conn.room && rooms.get(conn.room);
      if (!room) break;
      broadcast(room, { type: 'answer', ok: !!msg.ok, kind: msg.kind, by: conn.name }, conn);
      break;
    }
    /* 悔棋 / 提和 请求（需要对方裁决） */
    case 'request': {
      const room = conn.room && rooms.get(conn.room);
      if (!room) break;
      broadcast(room, { type: 'request', kind: msg.kind, by: conn.name }, conn);
      break;
    }
    /* 认输 / 和棋 */
    case 'resign':
    case 'draw': {
      const room = conn.room && rooms.get(conn.room);
      if (!room) break;
      broadcast(room, { type: 'gameover', reason: msg.type, color: msg.color, by: conn.name });
      break;
    }
    /* 聊天 */
    case 'chat': {
      const room = conn.room && rooms.get(conn.room);
      if (!room) break;
      const text = String(msg.text || '').slice(0, 300).trim();
      if (!text) break;
      const item = { name: conn.name, text, ts: Date.now(), side: conn.side };
      room.chat.push(item);
      if (room.chat.length > 200) room.chat.shift();
      for (const c of room.players) if (c.alive) send(c, { type: 'chat', ...item, self: c === conn });
      break;
    }
    case 'ping': send(conn, { type: 'pong' }); break;

    /* ---------- 语音通话信令（WebRTC 点对点，音频不经服务器） ---------- */
    case 'voice': {
      const room = conn.room && rooms.get(conn.room);
      if (!room) break;
      // 转发信令：offer / answer / ice / invite / accept / decline / hangup / mute
      broadcast(room, { type: 'voice', action: msg.action, payload: msg.payload, by: conn.name }, conn);
      break;
    }
  }
}

server.listen(PORT, () => {
  console.log(`\n  国际象棋小程序 Demo 已启动`);
  console.log(`  本机访问:  http://localhost:${PORT}`);
  console.log(`  局域网内手机可用同网段 IP 访问\n`);
});
