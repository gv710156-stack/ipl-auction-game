const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const PLAYERS = require('./players.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const BID_TIME = 15;
const RTM_TIME = 10;
const r2 = (x) => Math.round(x * 100) / 100;

function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++)
    c += chars[Math.floor(Math.random() * chars.length)];
  return 'IPL-' + c;
}

function pub(room) {
  return {
    code: room.code,
    purse: room.purse,
    phase: room.phase,
    category: room.category,
    queueLeft: room.queue.length,
    current: room.current,
    bid: room.bid,
    bidderName: room.bidder ? room.members[room.bidder].name : null,
    timeLeft: room.timeLeft,
    rtmWindow: room.rtmWindow,
    soldLog: room.soldLog.slice(-8),
    results: room.results,
    members: Object.entries(room.members).map(([id, m]) => ({
      id,
      name: m.name,
      purse: m.purse,
      rtm: m.rtm,
      squad: m.squad,
      xi: m.xi,
      isHost: id === room.host,
    })),
  };
}

function broadcast(room) {
  io.to(room.code).emit('room', pub(room));
}
function stopTimer(room) {
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
}

function canBuy(room, id, player, amount) {
  const m = room.members[id];
  if (!m) return 'Member nahi mila';
  if (m.squad.length >= 25) return 'Max 25 players ho sakte hain!';
  if (player.overseas && m.squad.filter((p) => p.overseas).length >= 8)
    return 'Max 8 overseas players!';
  if (amount > m.purse) return 'Purse mein paise nahi hain!';
  return null;
}

function startBidTimer(room) {
  stopTimer(room);
  room.timeLeft = BID_TIME;
  broadcast(room);
  room.timer = setInterval(() => {
    room.timeLeft--;
    if (room.timeLeft <= 0) sellPlayer(room);
    else broadcast(room);
  }, 1000);
}

function nextPlayer(room) {
  room.current = null;
  room.bid = null;
  room.bidder = null;
  if (room.queue.length === 0) {
    room.phase = 'catEnd';
    broadcast(room);
    return;
  }
  room.current = room.queue.shift();
  room.bid = { amount: room.current.base };
  room.phase = 'auction';
  startBidTimer(room);
}

function sellPlayer(room) {
  stopTimer(room);
  const player = room.current;
  if (!room.bidder) {
    room.soldLog.push({ name: player.name, team: 'UNSOLD', amount: 0 });
    nextPlayer(room);
    return;
  }
  const amount = room.bid.amount;
  const candidates = Object.keys(room.members).filter(
    (id) =>
      id !== room.bidder &&
      room.members[id].rtm > 0 &&
      canBuy(room, id, player, amount) === null
  );
  if (candidates.length > 0) {
    room.phase = 'rtm';
    room.rtmWindow = {
      playerName: player.name,
      amount,
      buyerId: room.bidder,
      buyerName: room.members[room.bidder].name,
      timeLeft: RTM_TIME,
      rtmBuyer: null,
    };
    broadcast(room);
    room.timer = setInterval(() => {
      room.rtmWindow.timeLeft--;
      if (room.rtmWindow.timeLeft <= 0) finishSale(room);
      else broadcast(room);
    }, 1000);
  } else finishSale(room);
}

function finishSale(room) {
  stopTimer(room);
  let player, amount, buyer;
  if (room.rtmWindow) {
    player =
      PLAYERS.find((p) => p.name === room.rtmWindow.playerName) || room.current;
    amount = room.rtmWindow.amount;
    buyer = room.rtmWindow.rtmBuyer || room.rtmWindow.buyerId;
    if (room.rtmWindow.rtmBuyer) room.members[room.rtmWindow.rtmBuyer].rtm--;
    room.rtmWindow = null;
  } else {
    player = room.current;
    amount = room.bid.amount;
    buyer = room.bidder;
  }
  const m = room.members[buyer];
  m.purse = r2(m.purse - amount);
  m.squad.push(player);
  room.soldLog.push({ name: player.name, team: m.name, amount });
  room.phase = 'auction';
  nextPlayer(room);
}

io.on('connection', (socket) => {
  socket.on('create', (data) => {
    const name = (data.name || '').trim();
    if (!name) return socket.emit('err', 'Pehle apna naam likho!');
    const purse = Number(data.purse) || 100;
    const code = newCode();
    rooms[code] = {
      code,
      host: socket.id,
      purse,
      members: { [socket.id]: { name, purse, rtm: 2, squad: [], xi: null } },
      phase: 'lobby',
      queue: [],
      current: null,
      bid: null,
      bidder: null,
      timer: null,
      timeLeft: 0,
      category: null,
      soldLog: [],
      rtmWindow: null,
      results: null,
    };
    socket.room = code;
    socket.join(code);
    socket.emit('joined', { code, self: socket.id });
    broadcast(rooms[code]);
  });

  socket.on('join', (data) => {
    const name = (data.name || '').trim();
    if (!name) return socket.emit('err', 'Pehle apna naam likho!');
    const room = rooms[(data.code || '').trim().toUpperCase()];
    if (!room) return socket.emit('err', 'Room code galat hai!');
    if (room.phase !== 'lobby')
      return socket.emit('err', 'Auction shuru ho chuka hai!');
    if (Object.keys(room.members).length >= 10)
      return socket.emit('err', 'Room full hai (max 10)!');
    room.members[socket.id] = {
      name,
      purse: room.purse,
      rtm: 2,
      squad: [],
      xi: null,
    };
    socket.room = room.code;
    socket.join(room.code);
    socket.emit('joined', { code: room.code, self: socket.id });
    broadcast(room);
  });

  socket.on('start', () => {
    const room = rooms[socket.room];
    if (!room || socket.id !== room.host) return;
    if (Object.keys(room.members).length < 2)
      return socket.emit('err', 'Kam se kam 2 members chahiye!');
    room.phase = 'catPick';
    broadcast(room);
  });

  socket.on('category', (f) => {
    const room = rooms[socket.room];
    if (!room || socket.id !== room.host) return;
    if (room.phase !== 'catPick' && room.phase !== 'catEnd') return;
    const sold = new Set();
    Object.values(room.members).forEach((m) =>
      m.squad.forEach((p) => sold.add(p.name))
    );
    room.soldLog.forEach((s) => sold.add(s.name));
    let list = PLAYERS.filter((p) => !sold.has(p.name));
    if (f.role && f.role !== 'ALL')
      list = list.filter((p) => p.role === f.role);
    if (f.over === 'IND') list = list.filter((p) => !p.overseas);
    if (f.over === 'OVER') list = list.filter((p) => p.overseas);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    if (list.length === 0)
      return socket.emit('err', 'Is category mein koi player bacha nahi!');
    room.queue = list;
    room.category = f;
    nextPlayer(room);
  });

  socket.on('bid', () => {
    const room = rooms[socket.room];
    if (!room || room.phase !== 'auction' || !room.current) return;
    const amount = room.bidder ? r2(room.bid.amount + 0.25) : room.current.base;
    const err = canBuy(room, socket.id, room.current, amount);
    if (err) return socket.emit('err', err);
    room.bid = { amount };
    room.bidder = socket.id;
    startBidTimer(room);
  });

  socket.on('rtm', () => {
    const room = rooms[socket.room];
    if (!room || room.phase !== 'rtm' || !room.rtmWindow) return;
    const w = room.rtmWindow;
    if (socket.id === w.buyerId) return;
    const m = room.members[socket.id];
    if (!m || m.rtm <= 0 || w.rtmBuyer) return;
    const player = PLAYERS.find((p) => p.name === w.playerName);
    if (canBuy(room, socket.id, player, w.amount)) return;
    w.rtmBuyer = socket.id;
    finishSale(room);
  });
  socket.on('stopCat', () => {
    const room = rooms[socket.room];
    if (!room || socket.id !== room.host) return;
    if (room.phase !== 'auction' && room.phase !== 'rtm') return;
    stopTimer(room);
    room.rtmWindow = null;
    room.current = null;
    room.bid = null;
    room.bidder = null;
    room.phase = 'catEnd';
    broadcast(room);
  });
  socket.on('stopCat', () => {
    const room = rooms[socket.room];
    if (!room || socket.id !== room.host) return;
    if (room.phase !== 'auction' && room.phase !== 'rtm') return;
    stopTimer(room);
    room.rtmWindow = null;
    room.current = null;
    room.bid = null;
    room.bidder = null;
    room.phase = 'catEnd';
    broadcast(room);
  });
  socket.on('endAuction', () => {
    const room = rooms[socket.room];
    if (!room || socket.id !== room.host) return;
    stopTimer(room);
    room.rtmWindow = null;
    room.current = null;
    room.bid = null;
    room.bidder = null;
    room.queue = [];
    room.phase = 'xi';
    if (Object.values(room.members).every((mm) => mm.squad.length < 11)) {
      room.results = [];
      room.phase = 'results';
    }
    broadcast(room);
  });


  socket.on('xi', (data) => {
    const room = rooms[socket.room];
    if (!room || room.phase !== 'xi') return;
    const m = room.members[socket.id];
    const squadNames = m.squad.map((p) => p.name);
    const xi = data.xi || [];
    if (xi.length !== 11)
      return socket.emit('err', 'Playing XI mein exactly 11 players chahiye!');
    if (new Set(xi).size !== 11)
      return socket.emit('err', 'Ek player do baar nahi chun sakte!');
    for (const n of xi)
      if (!squadNames.includes(n))
        return socket.emit('err', n + ' aapki squad mein nahi hai!');
    const xiP = xi.map((n) => m.squad.find((p) => p.name === n));
    if (xiP.filter((p) => p.overseas).length > 4)
      return socket.emit('err', 'XI mein max 4 overseas players!');
    if (!xiP.some((p) => p.role === 'WK'))
      return socket.emit('err', 'XI mein kam se kam 1 wicket-keeper chahiye!');
    const impact = data.impact;
    if (!squadNames.includes(impact))
      return socket.emit('err', 'Impact player aapki squad se hona chahiye!');
    if (xi.includes(impact))
      return socket.emit('err', 'Impact player XI se bahar hona chahiye!');
    const impP = m.squad.find((p) => p.name === impact);
    const score =
      xiP.reduce((s, p) => s + p.rating, 0) +
      Math.round(impP.rating / 2) +
      Math.round(m.purse);
    m.xi = { xi, impact, score };
    const allDone = Object.values(room.members).every(
      (mm) => mm.xi || mm.squad.length < 11
    );
    if (allDone) {
      room.results = Object.values(room.members)
        .filter((mm) => mm.xi)
        .map((mm) => ({
          name: mm.name,
          score: mm.xi.score,
          xi: mm.xi.xi,
          impact: mm.xi.impact,
        }))
        .sort((a, b) => b.score - a.score);
      room.phase = 'results';
    }
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.room];
    if (!room) return;
    if (room.phase === 'lobby') {
      delete room.members[socket.id];
      if (Object.keys(room.members).length === 0) delete rooms[room.code];
      else {
        if (room.host === socket.id) room.host = Object.keys(room.members)[0];
        broadcast(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
app.get('/ping', (req, res) => res.send('pong'));
server.listen(PORT, () => console.log('Server running on port ' + PORT));
