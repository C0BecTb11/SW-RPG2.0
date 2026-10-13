// WebSocket (RFC 6455) без зависимостей: только то, что нужно игровому
// серверу. Рукопожатие, кадры текст/двоичные, ping/pong, закрытие,
// склейка фрагментов. Сжатие не используем: поток боя уже компактный.

'use strict';

var crypto = require('crypto');
var EventEmitter = require('events');

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
var MAX_MSG = 64 * 1024;          // от игрока приходят только короткие приказы

function Socket(sock) {
  EventEmitter.call(this);
  this.sock = sock;
  this.buf = Buffer.alloc(0);
  this.frag = null; this.fragOp = 0;
  this.open = true;
  this.alive = true;
  var self = this;
  sock.setNoDelay(true);
  sock.on('data', function(d) { self.onData(d); });
  sock.on('close', function() { self.finish(1006); });
  sock.on('error', function() { self.finish(1006); });
}
Socket.prototype = Object.create(EventEmitter.prototype);

Object.defineProperty(Socket.prototype, 'bufferedAmount', {
  get: function() { return this.sock.writableLength || 0; }
});

Socket.prototype.onData = function(d) {
  this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
  while (this.open) {
    var b = this.buf;
    if (b.length < 2) return;
    var fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    var len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return;
      var hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
      if (hi !== 0) return this.fail(1009);
      len = lo; off = 10;
    }
    if (!masked) return this.fail(1002);        // кадры от браузера всегда в маске
    if (len > MAX_MSG) return this.fail(1009);
    if (b.length < off + 4 + len) return;
    var mask = b.slice(off, off + 4), data = Buffer.allocUnsafe(len);
    for (var i = 0; i < len; i++) data[i] = b[off + 4 + i] ^ mask[i & 3];
    this.buf = b.slice(off + 4 + len);
    this.frame(fin, op, data);
  }
};

Socket.prototype.frame = function(fin, op, data) {
  if (op >= 0x8 && (!fin || data.length > 125)) return this.fail(1002);   // служебные кадры — короткие и целые
  if (op === 0x8) { this.close(1000); return; }
  if (op === 0x9) { this.write(0xA, data); return; }
  if (op === 0xA) { this.alive = true; return; }
  if (op === 0x1 || op === 0x2) {
    if (this.frag) return this.fail(1002);
    if (fin) { this.emit('message', op === 0x1 ? data.toString('utf8') : data, op === 0x2); return; }
    this.frag = [data]; this.fragOp = op; this.fragLen = data.length; return;
  }
  if (op === 0x0) {
    if (!this.frag) return this.fail(1002);
    this.frag.push(data); this.fragLen += data.length;
    if (this.fragLen > MAX_MSG) return this.fail(1009);
    if (fin) {
      var all = Buffer.concat(this.frag), bin = this.fragOp === 0x2;
      this.frag = null;
      this.emit('message', bin ? all : all.toString('utf8'), bin);
    }
    return;
  }
  this.fail(1002);
};

Socket.prototype.write = function(op, payload) {
  if (!this.open) return false;
  var len = payload.length, head;
  if (len < 126) { head = Buffer.allocUnsafe(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.allocUnsafe(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.allocUnsafe(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | op;
  this.sock.cork();
  this.sock.write(head);
  var ok = this.sock.write(payload);
  this.sock.uncork();
  return ok;
};

// Отправка: строка — текстом, ArrayBuffer/Buffer — двоичным кадром
Socket.prototype.send = function(data) {
  if (typeof data === 'string') return this.write(0x1, Buffer.from(data, 'utf8'));
  if (data instanceof ArrayBuffer) return this.write(0x2, Buffer.from(data));
  return this.write(0x2, data);
};

Socket.prototype.ping = function() { this.write(0x9, Buffer.alloc(0)); };

Socket.prototype.close = function(code) {
  if (!this.open) return;
  var p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0);
  this.write(0x8, p);
  var s = this.sock;
  setTimeout(function() { s.destroy(); }, 1000);
  this.finish(code || 1000);
};

Socket.prototype.fail = function(code) { this.close(code); };

Socket.prototype.terminate = function() { this.sock.destroy(); this.finish(1006); };

Socket.prototype.finish = function(code) {
  if (!this.open) return;
  this.open = false;
  this.emit('close', code);
};

// Принять апгрейд HTTP → WebSocket. Возвращает Socket или null
function accept(req, sock, head) {
  var key = req.headers['sec-websocket-key'];
  var upg = String(req.headers.upgrade || '').toLowerCase();
  if (upg !== 'websocket' || !key || req.headers['sec-websocket-version'] !== '13') {
    sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  var acceptKey = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\n' +
             'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
             'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n');
  var ws = new Socket(sock);
  if (head && head.length) ws.onData(head);
  return ws;
}

module.exports = { accept: accept, Socket: Socket };
