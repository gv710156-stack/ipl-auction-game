const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const PLAYERS = require('./players.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/ping', (req, res) => res.send('pong'));

const rooms = {};

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'IPL-';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  if (rooms[c]) return makeCode();
  return c;
}

function broadcast(room) {
  io.to(room.code).emit('room', room);
}

function findMember(room, id) {
  for (let i = 0; i < room.members.length; i++) {
    if (room.members[i].id === id) return room.members[i];
  }
  return null;
}

function present(room) {
  if (!room.queue || room.queue.length === 0) {
    room.current = null;
    room.phase = 'catEnd';
    broadcast(room);
    return;
  }
  const p = room.queue.shift();
  room.used[p.name] = true;
  room.current = p;
  room.queueLeft = room.queue.length;
  room.bid = { amount: p.base };
  room.bidder = null;
  room.bidderName = null;
  room.timeLeft = 15;
  room.phase = 'auction';
  broadcast(room);
}

function finalizeSale(room) {
  const w = room.rtmWindow;
  const p = w.player;
  const buyerId = w.rtmBuyerId || w.buyerId;
  if (buyerId) {
    const m = findMember(room, buyerId);
    if (m && m.purse >= w.amount && m.squad.length < 25) {
      m.purse = Math.round((m.purse - w.amount) * 100) / 100;
      m.squad.push(p);
      room.soldLog.push({ name: p.name, team: m.name, amount: w.amount });
    } else {
      room.soldLog.push({ name: p.name, team: 'UNSOLD', amount: 0 });
    }
  } else {
    room.soldLog.push({ name: p.name, team: 'UNSOLD', amount: 0 });
  }
  room.rtmWindow = null;
  present(room);
}

setInterval(function () {
  try {
    const codes = Object.keys(rooms);
    for (let i = 0; i < codes.length; i++) {
      const room = rooms[codes[i]];
      if (!room) continue;
      if (room.phase === 'auction') {
        room.timeLeft -= 1;
        if (room.timeLeft <= 0) {
          if (room.bidder) {
            room.phase = 'rtm';
            room.rtmWindow = {
              timeLeft: 10,
              playerName: room.current.name,
              buyerId: room.bidder,
              buyerName: room.bidderName,
              amount: room.bid.amount,
              rtmBuyer: null,
              rtmBuyerId: null,
              player: room.current
            };
            broadcast(room);
          } else {
            room.soldLog.push({ name: room.current.name, team: 'UNSOLD', amount: 0 });
            present(room);
          }
        } else {
          broadcast(room);
        }
      } else if (room.phase === 'rtm' && room.rtmWindow) {
        room.rtmWindow.timeLeft -= 1;
        if (room.rtmWindow.timeLeft <= 0) finalizeSale(room);
        else broadcast(room);
      }
    }
  } catch (e) {
    console.error('TICKER ERROR:', e);
  }
}, 1000);

function computeResults(room) {
  const res = [];
  for (let i = 0; i < room.members.length; i++) {
    const m = room.members[i];
    if (!m.xi) continue;
    let score = 0;
    for (let j = 0; j < m.xi.length; j++) {
      const p = m.squad.find(function (x) { return x.name === m.xi[j]; });
      if (p) score += p.rating;
    }
    let impactName = '-';
    if (m.impact) {
      const ip = m.squad.find(function (x) { return x.name === m.impact; });
      if (ip) { score += ip.rating; impactName = ip.name; }
    }
    res.push({ name: m.name, score: score, impact: impactName, xi: m.xi });
  }
  res.sort(function (a, b) { return b.score - a.score; });
  room.results = res;
  room.phase = 'results';
  broadcast(room);
}

io.on('connection', function (socket) {

  socket.on('create', function (d) {
    try {
      const name = ((d && d.name) || '').trim();
      if (!name) { socket.emit('err', 'Pehle apna naam likho!'); return; }
      const purse = parseInt(d && d.purse, 10) || 100;
      const code = makeCode();
      rooms[code] = {
        code: code,
        purse: purse,
        phase: 'lobby',
        members: [{ id: socket.id, name: name, isHost: true, purse: purse, squad: [], rtm: 2, xi: null, impact: null }],
        soldLog: [],
        queue: [],
        used: {},
        current: null,
        bid: { amount: 0 },
        bidder: null,
        bidderName: null,
        timeLeft: 15,
        rtmWindow: null,
        results: [],
        host: socket.id
      };
      socket.room = code;
      socket.join(code);
      socket.emit('joined', { self: socket.id });
      broadcast(rooms[code]);
    } catch (e) { console.error('CREATE ERROR:', e); }
  });

  socket.on('join', function (d) {
    try {
      const name = ((d && d.name) || '').trim();
      const code = ((d && d.code) || '').trim().toUpperCase();
      if (!name) { socket.emit('err', 'Pehle apna naam likho!'); return; }
      const room = rooms[code];
      if (!room) { socket.emit('err', 'Room nahi mila! Code check karo.'); return; }
      if (room.phase !== 'lobby') { socket.emit('err', 'Game pehle se shuru ho chuka hai!'); return; }
      if (room.members.length >= 10) { socket.emit('err', 'Room full hai (max 10)!'); return; }
      room.members.push({ id: socket.id, name: name, isHost: false, purse: room.purse, squad: [], rtm: 2, xi: null, impact: null });
      socket.room = code;
      socket.join(code);
      socket.emit('joined', { self: socket.id });
      broadcast(room);
    } catch (e) { console.error('JOIN ERROR:', e); }
  });

  socket.on('start', function () {
    try {
      const room = rooms[socket.room];
      if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
      if (room.members.length < 2) { socket.emit('err', 'Kam se kam 2 players chahiye!'); return; }
      room.phase = 'catPick';
      broadcast(room);
    } catch (e) { console.error('START ERROR:', e); }
  });

  socket.on('category', function (d) {
    try {
      const room = rooms[socket.room];
      if (!room || room.host !== socket.id) return;
      if (room.phase !== 'catPick' && room.phase !== 'catEnd') return;
      const role = (d && d.role) || 'ALL';
      const over = (d && d.over) || 'ALL';
      let list = PLAYERS.filter(function (p) { return role === 'ALL' || p.role === role; });
      list = list.filter(function (p) {
        if (over === 'IND') return !p.overseas;
        if (over === 'OVER') return !!p.overseas;
        return true;
      });
      list = list.filter(function (p) { return !room.used[p.name]; });
      if (list.length === 0) { socket.emit('err', 'Is category mein koi player nahi bacha!'); return; }
      room.queue = shuffle(list);
      present(room);
    } catch (e) { console.error('CATEGORY ERROR:', e); }
  });

  socket.on('bid', function () {
    try {
      const room = rooms[socket.room];
      if (!room || room.phase !== 'auction') return;
      const m = findMember(room, socket.id);
      if (!m) return;
      const next = Math.round((room.bid.amount + 0.25) * 100) / 100;
      if (m.purse < next) { socket.emit('err', 'Purse mein itne paise nahi!'); return; }
      if (m.squad.length >= 25) { socket.emit('err', 'Squad full (25)!'); return; }
      room.bid.amount = next;
      room.bidder = m.id;
      room.bidderName = m.name;
      broadcast(room);
    } catch (e) { console.error('BID ERROR:', e); }
  });

  socket.on('rtm', function () {
    try {
      const room = rooms[socket.room];
      if (!room || room.phase !== 'rtm' || !room.rtmWindow) return;
      const w = room.rtmWindow;
      if (w.rtmBuyerId) return;
      const m = findMember(room, socket.id);
      if (!m || m.id === w.buyerId) return;
      if (m.rtm <= 0 || m.purse < w.amount || m.squad.length >= 25) return;
      m.rtm -= 1;
      w.rtmBuyer = m.name;
      w.rtmBuyerId = m.id;
      finalizeSale(room);
    } catch (e) { console.error('RTM ERROR:', e); }
  });

  socket.on('stopCat', function () {
    try {
      const room = rooms[socket.room];
      if (!room || room.host !== socket.id) return;
      if (room.phase !== 'auction' && room.phase !== 'rtm') return;
      if (room.current && room.phase === 'auction') {
        room.soldLog.push({ name: room.current.name, team: 'UNSOLD', amount: 0 });
      }
      room.rtmWindow = null;
      room.current = null;
      room.queue = [];
      room.bid = { amount: 0 };
      room.bidder = null;
      room.bidderName = null;
      room.phase = 'catEnd';
      broadcast(room);
    } catch (e) { console.error('STOPCAT ERROR:', e); }
  });

  socket.on('endAuction', function () {
    try {
      const room = rooms[socket.room];
      if (!room || room.host !== socket.id) return;
      if (room.phase === 'xi' || room.phase === 'results') return;
      if (room.current && (room.phase === 'auction' || room.phase === 'rtm')) {
        room.soldLog.push({ name: room.current.name, team: 'UNSOLD', amount: 0 });
      }
      room.rtmWindow = null;
      room.current = null;
      room.queue = [];
      room.phase = 'xi';
      broadcast(room);
    } catch (e) { console.error('ENDAUCTION ERROR:', e); }
  });

  socket.on('xi', function (d) {
    try {
      const room = rooms[socket.room];
      if (!room || room.phase !== 'xi') return;
      const m = findMember(room, socket.id);
      if (!m || m.xi) return;
      if (m.squad.length < 11) { socket.emit('err', 'Aapke paas 11 players nahi hain!'); return; }
      const names = (d && d.xi) || [];
      if (names.length !== 11) { socket.emit('err', 'Exactly 11 players chuno!'); return; }
      const set = {};
      for (let i = 0; i < names.length; i++) {
        if (set[names[i]]) { socket.emit('err', 'Ek player do baar nahi!'); return; }
        set[names[i]] = true;
        if (!m.squad.some(function (p) { return p.name === names[i]; })) {
          socket.emit('err', 'Squad se bahar ka player!'); return;
        }
      }
      let ov = 0;
      for (let i = 0; i < names.length; i++) {
        const p = m.squad.find(function (x) { return x.name === names[i]; });
        if (p && p.overseas) ov++;
      }
      if (ov > 4) { socket.emit('err', 'XI mein max 4 overseas!'); return; }
      let impact = (d && d.impact) || '';
      if (impact && names.indexOf(impact) !== -1) impact = '';
      if (impact && !m.squad.some(function (p) { return p.name === impact; })) impact = '';
      m.xi = names;
      m.impact = impact;
      const eligible = room.members.filter(function (mm) { return mm.squad.length >= 11; });
      const done = eligible.every(function (mm) { return !!mm.xi; });
      if (done) computeResults(room);
      else broadcast(room);
    } catch (e) { console.error('XI ERROR:', e); }
  });

  socket.on('disconnect', function () {
    try {
      const room = rooms[socket.room];
      if (!room) return;
      const m = findMember(room, socket.id);
      if (!m) return;
      if (room.phase === 'lobby') {
        room.members = room.members.filter(function (mm) { return mm.id !== socket.id; });
        if (room.members.length === 0) { delete rooms[room.code]; return; }
        if (room.host === socket.id) {
          room.host = room.members[0].id;
          room.members[0].isHost = true;
        }
        broadcast(room);
      } else {
        if (room.host === socket.id) {
          const alive = room.members.find(function (mm) { return mm.id !== socket.id; });
          if (alive) { room.host = alive.id; alive.isHost = true; }
        }
        broadcast(room);
      }
    } catch (e) { console.error('DISCONNECT ERROR:', e); }
  });

});

const PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log('Server running on port ' + PORT);
});
