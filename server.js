const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const lobbyProto = require('./jackaroo_proto.js');
const gameProto = require('./jackaroo_game_proto.js');

const PORT = process.env.PORT || 8088;
const ROOT = 'C:/Users/burak/Downloads/jackaroo_1.0.2_31';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const CARD_POOL = [
  101, 104, 105, 107, 110, 111, 112, 113, // Karo
  201, 204, 205, 207, 210, 211, 212, 213, // Sinek
  301, 304, 305, 307, 310, 311, 312, 313, // Kupa
  401, 404, 405, 407, 410, 411, 412, 413  // Maça
];

function getRandomHand() {
  const hand = [101]; // Garantili çıkış için As/Papaz
  for (let i = 1; i < 4; i++) {
    hand.push(CARD_POOL[Math.floor(Math.random() * CARD_POOL.length)]);
  }
  return hand;
}

// Multi-Room Registry: Map<string, Room>
const rooms = new Map();

// Active WebSocket Clients: Map<string, { ws, uid, name, avatar, roomId, seatIndex }>
const connectedClients = new Map();

function createNewRoom(roomId, captainUid, captainName, captainAvatar) {
  const captainPlayer = {
    uid: captainUid,
    appId: 'gfs',
    userId: captainUid,
    name: captainName || 'Kaptan',
    avatar: captainAvatar || '',
    gender: '1',
    seatIndex: 0,
    state: 1, // Captain ready
    isManaged: 0,
    handCards: getRandomHand(),
    numOfHandCards: 4,
    pieces: [0, 0, 0, 0]
  };

  const room = {
    id: roomId,
    mode: 1,
    state: 0, // 0 = LobbyView, 2 = GameView
    captain: captainUid,
    actorId: captainUid,
    timeout: 30,
    turnTimer: null,
    players: [captainPlayer],
    modeInfos: [
      {
        mode: 1,
        teamCount: [2, 4],
        teamMemberCount: [1, 1],
        rule: JSON.stringify({ round_time: 25, total_time: 500, settle_time: 3, win_score: 50 })
      }
    ],
    rule: JSON.stringify({ round_time: 25, total_time: 500, settle_time: 3, win_score: 50 }),
    setting: '{}'
  };

  rooms.set(roomId, room);
  console.log(`[ROOM CREATED] Room ${roomId} created by Captain UID=${captainUid} (${captainName})`);
  return room;
}

function getOrCreateRoom(roomId, clientUid, clientName, clientAvatar) {
  let room = rooms.get(roomId);
  if (!room) {
    return createNewRoom(roomId, clientUid, clientName, clientAvatar);
  }

  // Room exists; check if client is already inside
  const existingPlayer = room.players.find(p => p.uid === clientUid);
  if (existingPlayer) {
    if (clientName) existingPlayer.name = clientName;
    if (clientAvatar) existingPlayer.avatar = clientAvatar;
    return room;
  }

  // Client is joining existing room in Lobby state
  if (room.state === 0) {
    const maxSeats = room.modeInfos && room.modeInfos[0] ? room.modeInfos[0].teamCount[1] : 4;
    const occupiedSeats = new Set(room.players.map(p => p.seatIndex));
    let freeSeat = -1;
    for (let s = 1; s < maxSeats; s++) {
      if (!occupiedSeats.has(s)) {
        freeSeat = s;
        break;
      }
    }
    if (freeSeat === -1 && !occupiedSeats.has(0)) {
      freeSeat = 0;
    }

    if (freeSeat !== -1) {
      const newPlayer = {
        uid: clientUid,
        appId: 'gfs',
        userId: clientUid,
        name: clientName || `Oyuncu ${freeSeat + 1}`,
        avatar: clientAvatar || '',
        gender: '1',
        seatIndex: freeSeat,
        state: 1, // Ready by default in lobby
        isManaged: 0,
        pieces: [0, 0, 0, 0],
        handCards: getRandomHand(),
        numOfHandCards: 4
      };
      room.players.push(newPlayer);
      console.log(`[ROOM JOIN] UID=${clientUid} (${clientName}) joined room ${roomId} at Seat ${freeSeat}`);

      // Broadcast OnPlayerEnter & OnPlayerReady to other players in this room
      const enterMsg = lobbyProto.pb.OnPlayerEnter.create({ player: newPlayer });
      broadcastToRoom(roomId, 2, 0, 2604, Buffer.from(lobbyProto.pb.OnPlayerEnter.encode(enterMsg).finish()));

      const readyMsg = lobbyProto.pb.OnPlayerReady.create({ uid: clientUid, isReady: 1 });
      broadcastToRoom(roomId, 2, 0, 2608, Buffer.from(lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish()));
    } else {
      console.warn(`[ROOM JOIN ERROR] Room ${roomId} is full! Could not seat UID=${clientUid}`);
    }
  }

  return room;
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Health check for Render.com
  if (pathname === '/' || pathname === '/health') {
    const allRoomsData = [];
    for (let [id, r] of rooms.entries()) {
      allRoomsData.push({
        id,
        state: r.state === 0 ? 'Lobby' : 'InGame',
        captain: r.captain,
        players: r.players.map(p => ({ uid: p.uid, name: p.name, seat: p.seatIndex, isReady: p.state === 1 }))
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      status: 'online',
      service: 'Jackaroo Multi-Room Online Game Server',
      version: '2.0.0',
      connectedClients: connectedClients.size,
      totalRooms: rooms.size,
      rooms: allRoomsData
    }, null, 2));
  }

  // HTTP POST /jackaroo/login
  if (pathname === '/jackaroo/login' || pathname.endsWith('/login')) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const uid = parsedUrl.searchParams.get('uid') || '1001';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        resultCode: 0,
        uid: uid,
        token: 'token_' + Date.now(),
        gameModeInfo: [
          {
            mode: 1,
            rule: JSON.stringify({
              teamCount: [2, 4],
              teamMemberCount: [1, 1],
              round_time: 25,
              total_time: 500,
              settle_time: 3,
              win_score: 50
            })
          }
        ]
      }));
    });
    return;
  }

  // API: Invite Bot / Friend
  if (pathname === '/api/invite_bot') {
    const roomId = parsedUrl.searchParams.get('roomId') || 'room_1';
    const room = rooms.get(roomId);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Oda bulunamadı' }));
    }

    const friendId = parsedUrl.searchParams.get('id') || ('bot_' + Date.now());
    const friendName = decodeURIComponent(parsedUrl.searchParams.get('name') || 'Misafir');
    const friendAvatar = decodeURIComponent(parsedUrl.searchParams.get('avatar') || '');

    const maxSeats = 4;
    const occupiedSeats = new Set(room.players.map(p => p.seatIndex));
    let freeSeat = -1;
    for (let s = 1; s < maxSeats; s++) {
      if (!occupiedSeats.has(s)) {
        freeSeat = s;
        break;
      }
    }

    if (freeSeat !== -1) {
      const invitedPlayer = {
        uid: friendId,
        appId: 'gfs',
        userId: friendId,
        name: friendName,
        avatar: friendAvatar,
        gender: '1',
        seatIndex: freeSeat,
        state: 1, // Ready
        isManaged: 1,
        pieces: [0, 0, 0, 0],
        handCards: getRandomHand(),
        numOfHandCards: 4
      };
      room.players.push(invitedPlayer);

      const enterMsg = lobbyProto.pb.OnPlayerEnter.create({ player: invitedPlayer });
      broadcastToRoom(roomId, 2, 0, 2604, Buffer.from(lobbyProto.pb.OnPlayerEnter.encode(enterMsg).finish()));

      const readyMsg = lobbyProto.pb.OnPlayerReady.create({ uid: friendId, isReady: 1 });
      broadcastToRoom(roomId, 2, 0, 2608, Buffer.from(lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish()));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, seat: freeSeat, player: invitedPlayer }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Masa dolu!' }));
    }
  }

  // API: Kick Player from Seat
  if (pathname === '/api/kick_player' || pathname === '/api/kick_seat') {
    const roomId = parsedUrl.searchParams.get('roomId') || 'room_1';
    const room = rooms.get(roomId);
    if (!room) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Oda bulunamadı' }));
    }

    const seat = parseInt(parsedUrl.searchParams.get('seatIndex') || '-1', 10);
    const targetIdx = room.players.findIndex(p => p.seatIndex === seat && p.uid !== room.captain);
    if (targetIdx !== -1) {
      const kicked = room.players.splice(targetIdx, 1)[0];
      const leaveMsg = lobbyProto.pb.OnPlayerLeave.create({
        uid: kicked.uid,
        kickUid: room.captain || '1001'
      });
      broadcastToRoom(roomId, 2, 0, 2606, Buffer.from(lobbyProto.pb.OnPlayerLeave.encode(leaveMsg).finish()));
      console.log(`[HTTP API] Kicked player from seat ${seat} (UID: ${kicked.uid}, Name: ${kicked.name}) in Room ${roomId}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ success: true, seat }));
  }

  // API: Reset Lobby
  if (pathname === '/api/reset_lobby') {
    const roomId = parsedUrl.searchParams.get('roomId') || 'room_1';
    const room = rooms.get(roomId);
    if (room) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      room.state = 0;
      room.round = 1;
      room.players = room.players.filter(p => p.uid === room.captain);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'Lobi sıfırlandı' }));
  }

  // Optional: Serve static files
  const publicDir = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : ROOT;
  if (fs.existsSync(publicDir)) {
    let filePath = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

const wss = new WebSocket.Server({ server });

function buildPacket(type, sn, cmdId, payloadBuffer) {
  const payload = payloadBuffer || Buffer.alloc(0);
  const dataLen = payload.length;
  const totalLen = 11 + dataLen;
  const header = Buffer.alloc(11);
  header.writeUInt16BE(totalLen, 0);
  header.writeUInt8(type, 2);
  header.writeUInt32BE(sn, 3);
  header.writeUInt16BE(cmdId, 7);
  header.writeUInt16BE(dataLen, 9);
  return Buffer.concat([header, payload]);
}

// Broadcast packet only to clients in the specified room
function broadcastToRoom(roomId, type, sn, cmdId, payloadBuffer) {
  const pkt = buildPacket(type, sn, cmdId, payloadBuffer);
  for (let client of connectedClients.values()) {
    if (client.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(pkt);
    }
  }
}

function chooseBotMove(player, opponent) {
  if (!player || !player.handCards || player.handCards.length === 0) {
    return null;
  }

  const pieces = player.pieces || [0, 0, 0, 0];
  const startPos = player.seatIndex === 0 ? 1 : 39;

  // Case 1: If player is banned
  if (player.isBanned) {
    player.isBanned = false;
    const card = player.handCards[0];
    return {
      card,
      cmd: 2, // Discard / Skip
      moves: [],
      reason: 'Player was banned, discarding card'
    };
  }

  // Case 2: Can we move a marble out of base (pos === 0)?
  const baseMarbleIndex = pieces.findIndex(p => p === 0);
  const startOccupiedByOwn = pieces.includes(startPos);

  if (baseMarbleIndex !== -1 && !startOccupiedByOwn) {
    const exitCard = player.handCards.find(c => {
      const rank = c % 100;
      return rank === 1 || rank === 13;
    });

    if (exitCard) {
      return {
        card: exitCard,
        cmd: 3, // Base exit
        moves: [{ uid: player.uid, index: baseMarbleIndex, pos: startPos }],
        pieceUpdates: [{ index: baseMarbleIndex, pos: startPos }],
        reason: 'Base exit with Ace/King'
      };
    }
  }

  // Case 3: Can we move any active marble on the board (pos > 0)?
  const activeMarbles = [];
  pieces.forEach((pos, idx) => {
    if (pos > 0) activeMarbles.push({ idx, pos });
  });

  if (activeMarbles.length > 0) {
    const marble = activeMarbles[0];

    // Rank 4 (backward 4 steps)
    const card4 = player.handCards.find(c => c % 100 === 4);
    if (card4) {
      let newPos = marble.pos - 4;
      if (newPos <= 0) newPos += 76;
      return {
        card: card4,
        cmd: 0,
        moves: [{ uid: player.uid, index: marble.idx, pos: newPos, step: -4 }],
        pieceUpdates: [{ index: marble.idx, pos: newPos }],
        reason: 'Move backward 4 steps'
      };
    }

    // Rank 10 (Ban opponent)
    const card10 = player.handCards.find(c => c % 100 === 10);
    if (card10 && opponent && !opponent.isBanned) {
      opponent.isBanned = true;
      return {
        card: card10,
        cmd: 4,
        moves: [{ uid: opponent.uid, index: 0, pos: 0 }],
        pieceUpdates: [],
        reason: 'Ban opponent with Card 10'
      };
    }

    // Standard movement cards
    for (let c of player.handCards) {
      const rank = c % 100;
      let step = 0;
      if (rank === 1) step = 1;
      else if (rank === 4) step = -4;
      else if (rank >= 5 && rank <= 13) step = rank;

      if (step !== 0) {
        let newPos = ((marble.pos - 1 + step) % 76) + 1;
        if (step === -4) {
          newPos = marble.pos - 4;
          if (newPos <= 0) newPos += 76;
        }
        return {
          card: c,
          cmd: 0,
          moves: [{ uid: player.uid, index: marble.idx, pos: newPos, step: step }],
          pieceUpdates: [{ index: marble.idx, pos: newPos }],
          reason: `Step forward ${step} steps with card ${c}`
        };
      }
    }
  }

  // Fallback: Discard first card
  const fallbackCard = player.handCards[0];
  return {
    card: fallbackCard,
    cmd: 2,
    moves: [],
    reason: 'Fallback discard (no valid moves)'
  };
}

function setActiveTurn(room, actorId, timeoutSec = 25) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.state !== 2) return;

  room.actorId = actorId;

  const player = room.players.find(p => p.uid === actorId);

  // If this player has 0 cards, switch to next
  if (!player || !player.handCards || player.handCards.length === 0) {
    console.log(`[TURN] Room ${room.id} - Player ${actorId} has 0 cards.`);
    switchTurn(room, actorId);
    return;
  }

  // Broadcast OnUpdateActor (2629)
  const actorMsg = gameProto.pb.OnUpdateActor.create({
    actorId: actorId,
    timeout: timeoutSec
  });
  const actorEnc = gameProto.pb.OnUpdateActor.encode(actorMsg).finish();
  broadcastToRoom(room.id, 2, 0, 2629, Buffer.from(actorEnc));
  console.log(`[WS] Room ${room.id} - OnUpdateActor: Actor=${actorId}, Timeout=${timeoutSec}s`);

  const isConnected = connectedClients.has(actorId);
  const isBot = !isConnected || player.isManaged === 1;

  if (isBot) {
    console.log(`[BOT] Room ${room.id} - Player ${actorId} is BOT. Playing in 1.5s...`);
    room.turnTimer = setTimeout(() => {
      executeBotTurn(room, actorId);
    }, 1500);
  } else {
    console.log(`[HUMAN] Room ${room.id} - Player ${actorId} is HUMAN. Waiting ${timeoutSec}s...`);
    room.turnTimer = setTimeout(() => {
      console.log(`[BOT] Room ${room.id} - Player ${actorId} timed out! Enabling bot.`);
      player.isManaged = 1;
      const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
        uid: actorId,
        isManaged: 1
      });
      broadcastToRoom(room.id, 2, 0, 2625, Buffer.from(lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish()));
      executeBotTurn(room, actorId);
    }, timeoutSec * 1000);
  }
}

function executeBotTurn(room, actorId) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.state !== 2) return;

  const player = room.players.find(p => p.uid === actorId);
  const opponent = room.players.find(p => p.uid !== actorId);

  if (!player || !player.handCards || player.handCards.length === 0) {
    switchTurn(room, actorId);
    return;
  }

  const botMove = chooseBotMove(player, opponent);
  if (!botMove) {
    switchTurn(room, actorId);
    return;
  }

  console.log(`[BOT] Room ${room.id} - ${actorId} (${player.name}) plays: Card ${botMove.card}, Cmd ${botMove.cmd} (${botMove.reason})`);

  player.handCards = player.handCards.filter(c => c !== botMove.card);
  player.numOfHandCards = player.handCards.length;

  if (botMove.pieceUpdates && botMove.pieceUpdates.length > 0) {
    for (let u of botMove.pieceUpdates) {
      player.pieces[u.index] = u.pos;
    }
  }

  const onDiscardMsg = gameProto.pb.OnPlayerDiscard.create({
    uid: actorId,
    cards: [botMove.card],
    cmd: botMove.cmd,
    moves: botMove.moves || [],
    handCards: player.handCards,
    numOfHandCards: player.numOfHandCards
  });
  const discardEnc = gameProto.pb.OnPlayerDiscard.encode(onDiscardMsg).finish();
  broadcastToRoom(room.id, 2, 0, 2627, Buffer.from(discardEnc));

  switchTurn(room, actorId);
}

function switchTurn(room, currentActorId) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.state !== 2) return;

  const totalCards = room.players.reduce((sum, p) => sum + (p.numOfHandCards || 0), 0);
  if (totalCards === 0) {
    console.log(`[WS] Room ${room.id} - All hands finished! Dealing new round...`);
    setTimeout(() => {
      dealNewRound(room);
    }, 1200);
    return;
  }

  const currentIdx = room.players.findIndex(p => p.uid === currentActorId);
  let nextActor = null;
  for (let i = 1; i <= room.players.length; i++) {
    const candidate = room.players[(currentIdx + i) % room.players.length];
    if (candidate && candidate.numOfHandCards > 0) {
      nextActor = candidate.uid;
      break;
    }
  }

  if (!nextActor) nextActor = currentActorId;

  setTimeout(() => {
    setActiveTurn(room, nextActor, 25);
  }, 800);
}

function dealNewRound(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  if (room.state !== 2) return;

  for (let p of room.players) {
    p.handCards = getRandomHand();
    p.numOfHandCards = 4;
  }

  for (let client of connectedClients.values()) {
    if (client.roomId !== room.id) continue;
    const p = room.players.find(x => x.uid === client.uid);
    const dealPayload = gameProto.pb.OnDealCard.create({
      players: room.players.map(pl => ({
        uid: pl.uid,
        appId: pl.appId || 'gfs',
        userId: pl.userId || pl.uid,
        name: pl.name,
        avatar: pl.avatar || '',
        gender: pl.gender || '1',
        seatIndex: pl.seatIndex,
        state: pl.state || 1,
        isBanned: pl.isBanned || false,
        handCards: pl.uid === client.uid ? (p ? p.handCards : [101, 113, 207, 311]) : [],
        numOfHandCards: 4,
        pieces: pl.pieces || [0, 0, 0, 0]
      })),
      isShuffle: true
    });
    const dealEnc = gameProto.pb.OnDealCard.encode(dealPayload).finish();
    client.ws.send(buildPacket(2, 0, 2628, Buffer.from(dealEnc)));
  }

  console.log(`[WS] Room ${room.id} - New round dealt!`);
  setTimeout(() => {
    setActiveTurn(room, room.captain || '1001', 25);
  }, 1200);
}

function startGameSequence(room) {
  room.state = 2; // Transition to Gaming!
  for (let pl of room.players) {
    pl.pieces = [0, 0, 0, 0];
    pl.isBanned = false;
    if (connectedClients.has(pl.uid)) {
      pl.isManaged = 0;
      const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
        uid: pl.uid,
        isManaged: 0
      });
      broadcastToRoom(room.id, 2, 0, 2625, Buffer.from(lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish()));
    }
  }
  console.log(`[GAME] Room ${room.id} - Starting Game Sequence!`);

  // Broadcast OnGameReady (cmd 2610)
  const gameReadyMsg = gameProto.pb.OnGameReady.create({
    players: room.players,
    roundId: '1'
  });
  const readyEnc = gameProto.pb.OnGameReady.encode(gameReadyMsg).finish();
  broadcastToRoom(room.id, 2, 0, 2610, Buffer.from(readyEnc));

  // Broadcast OnGameStart (cmd 2611)
  setTimeout(() => {
    const gameStartMsg = gameProto.pb.OnGameStart.create({});
    const startEnc = gameProto.pb.OnGameStart.encode(gameStartMsg).finish();
    broadcastToRoom(room.id, 2, 0, 2611, Buffer.from(startEnc));
    console.log(`[WS] Room ${room.id} - Broadcasted OnGameStart to all devices! GameView active!`);

    setTimeout(() => {
      dealNewRound(room);
    }, 1500);
  }, 300);
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const clientUid = urlParams.get('uid') || '1001';
  const clientName = decodeURIComponent(urlParams.get('name') || 'Oyuncu');
  const clientAvatar = decodeURIComponent(urlParams.get('avatar') || '');
  const roomId = urlParams.get('roomId') || 'room_1';

  console.log(`[WS] Client connected: UID=${clientUid}, Name=${clientName}, Avatar=${clientAvatar ? 'yes' : 'no'}, Room=${roomId}`);

  const clientInfo = { ws, uid: clientUid, name: clientName, avatar: clientAvatar, roomId: roomId };
  connectedClients.set(clientUid, clientInfo);

  ws.on('message', (data) => {
    try {
      const buf = Buffer.from(data);
      if (buf.length < 11) return;

      const totalLen = buf.readUInt16BE(0);
      const type = buf.readUInt8(2);
      const sn = buf.readUInt32BE(3);
      const cmdId = buf.readUInt16BE(7);
      const dataLen = buf.readUInt16BE(9);

      const currentRoom = rooms.get(clientInfo.roomId) || getOrCreateRoom(clientInfo.roomId, clientUid, clientName, clientAvatar);

      if (cmdId === 101) {
        // Heartbeat
        ws.send(buildPacket(1, sn, 101, Buffer.alloc(0)));
      } else if (cmdId === 102) {
        // Ping
        ws.send(buildPacket(1, sn, 102, Buffer.alloc(0)));
      } else if (cmdId === 2601) {
        // Login (cmd 2601) -> Reply
        ws.send(buildPacket(1, sn, 2601, Buffer.from([0x08, 0x00])));
        console.log(`[WS] Sent LoginReply to UID: ${clientUid} (${clientName}) in Room: ${currentRoom.id}`);

        // Register or fetch player in room
        const room = getOrCreateRoom(clientInfo.roomId, clientUid, clientName, clientAvatar);

        // Send OnPlayerLogin (cmd 2602) containing full room state with all seated players
        setTimeout(() => {
          const onLoginMsg = gameProto.pb.OnPlayerLogin.create({
            account: {
              uid: clientUid,
              appId: 'gfs',
              userId: clientUid,
              name: clientName,
              avatar: clientAvatar,
              gender: '1'
            },
            game: room,
            serverTime: Date.now()
          });

          const encoded = gameProto.pb.OnPlayerLogin.encode(onLoginMsg).finish();
          ws.send(buildPacket(2, 0, 2602, Buffer.from(encoded)));
          console.log(`[WS] Sent OnPlayerLogin to UID: ${clientUid} (${clientName}) in Room ${room.id}. Total Players: ${room.players.length}`);
        }, 100);

      } else if (cmdId === 2607) {
        // Ready (cmd 2607)
        let isReady = 1;
        try {
          if (buf.length > 11) {
            const req = lobbyProto.pb.ReadyAPI.decode(buf.subarray(11));
            if (req.isReady !== undefined) isReady = req.isReady;
          }
        } catch (e) {
          console.error('[WS] Error decoding ReadyAPI:', e);
        }
        console.log(`[WS] Player ${clientUid} in Room ${currentRoom.id} set isReady to ${isReady}`);
        const p = currentRoom.players.find(x => x.uid === clientUid);
        if (p) p.state = isReady === 1 ? 1 : 0;

        ws.send(buildPacket(1, sn, 2607, Buffer.from([0x08, 0x00])));

        // Broadcast OnPlayerReady (cmd 2608) to room
        const readyMsg = lobbyProto.pb.OnPlayerReady.create({
          uid: clientUid,
          isReady: isReady
        });
        const readyEnc = lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish();
        broadcastToRoom(currentRoom.id, 2, 0, 2608, Buffer.from(readyEnc));

      } else if (cmdId === 2609) {
        // Captain clicked Start Game (cmd 2609)!
        console.log(`[WS] Room ${currentRoom.id} - CAPTAIN CLICKED START GAME!`);
        ws.send(buildPacket(1, sn, 2609, Buffer.from([0x08, 0x00]))); // StartReply
        startGameSequence(currentRoom);

      } else if (cmdId === 2612) {
        // Loaded (2612)
        ws.send(buildPacket(1, sn, 2612, Buffer.from([0x08, 0x00])));

      } else if (cmdId === 2614) {
        // Kickout (cmd 2614)
        let kickSeat = -1;
        try {
          if (buf.length > 11) {
            const req = lobbyProto.pb.KickoutAPI.decode(buf.subarray(11));
            if (req.seatIndex !== undefined) kickSeat = req.seatIndex;
          }
        } catch(e) {}
        console.log(`[WS] Room ${currentRoom.id} - Kickout called for seat: ${kickSeat} by UID ${clientUid}`);

        // Only captain can kick
        if (currentRoom.captain === clientUid) {
          const targetIdx = currentRoom.players.findIndex(p => p.seatIndex === kickSeat && p.uid !== currentRoom.captain);
          if (targetIdx !== -1) {
            const kicked = currentRoom.players.splice(targetIdx, 1)[0];
            ws.send(buildPacket(1, sn, 2614, Buffer.from([0x08, 0x00])));
            const leaveMsg = lobbyProto.pb.OnPlayerLeave.create({
              uid: kicked.uid,
              kickUid: clientUid
            });
            broadcastToRoom(currentRoom.id, 2, 0, 2606, Buffer.from(lobbyProto.pb.OnPlayerLeave.encode(leaveMsg).finish()));
            console.log(`[WS] Room ${currentRoom.id} - Player ${kicked.uid} (${kicked.name}) kicked!`);
          } else {
            ws.send(buildPacket(1, sn, 2614, Buffer.from([0x08, 0x00])));
          }
        } else {
          ws.send(buildPacket(1, sn, 2614, Buffer.from([0x08, 0x00])));
        }

      } else if (cmdId === 2620) {
        // ChangeSeat (cmd 2620)
        let newSeat = 0;
        try {
          if (buf.length > 11) {
            const req = lobbyProto.pb.ChangeSeatAPI.decode(buf.subarray(11));
            if (req.seatIndex !== undefined) newSeat = req.seatIndex;
          }
        } catch (e) {
          console.error('[WS] Error decoding ChangeSeatAPI:', e);
        }
        console.log(`[WS] Room ${currentRoom.id} - Player ${clientUid} requested change to seat ${newSeat}`);
        const p = currentRoom.players.find(x => x.uid === clientUid);
        if (p) p.seatIndex = newSeat;

        ws.send(buildPacket(1, sn, 2620, Buffer.from([0x08, 0x00])));

        // Broadcast OnPlayerChangeSeat (cmd 2621)
        const changeSeatMsg = lobbyProto.pb.OnPlayerChangeSeat.create({
          uid: clientUid,
          seatIndex: newSeat
        });
        broadcastToRoom(currentRoom.id, 2, 0, 2621, Buffer.from(lobbyProto.pb.OnPlayerChangeSeat.encode(changeSeatMsg).finish()));

      } else if (cmdId === 2622) {
        // JoinBot (cmd 2622)
        console.log(`[WS] Room ${currentRoom.id} - JoinBot called! Adding bot to empty seat...`);
        const maxSeats = currentRoom.modeInfos && currentRoom.modeInfos[0] ? currentRoom.modeInfos[0].teamCount[1] : 4;
        const occupiedSeats = new Set(currentRoom.players.map(p => p.seatIndex));
        let freeSeat = -1;
        for (let s = 0; s < maxSeats; s++) {
          if (!occupiedSeats.has(s)) {
            freeSeat = s;
            break;
          }
        }
        if (freeSeat !== -1) {
          const botUid = 'bot_' + (freeSeat + 1);
          const botPlayer = {
            uid: botUid,
            appId: 'gfs',
            userId: botUid,
            name: 'Robot ' + (freeSeat + 1),
            avatar: '',
            gender: '1',
            seatIndex: freeSeat,
            state: 1, // Ready
            isManaged: 1,
            pieces: [0, 0, 0, 0],
            handCards: getRandomHand(),
            numOfHandCards: 4
          };
          currentRoom.players.push(botPlayer);
          ws.send(buildPacket(1, sn, 2622, Buffer.from([0x08, 0x00])));

          // Broadcast OnPlayerEnter (cmd 2604)
          const enterMsg = lobbyProto.pb.OnPlayerEnter.create({
            player: botPlayer
          });
          broadcastToRoom(currentRoom.id, 2, 0, 2604, Buffer.from(lobbyProto.pb.OnPlayerEnter.encode(enterMsg).finish()));

          // Broadcast OnPlayerReady (cmd 2608)
          const readyMsg = lobbyProto.pb.OnPlayerReady.create({
            uid: botUid,
            isReady: 1
          });
          broadcastToRoom(currentRoom.id, 2, 0, 2608, Buffer.from(lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish()));
          console.log(`[WS] Room ${currentRoom.id} - Bot added to seat ${freeSeat}: ${botPlayer.name}`);
        } else {
          ws.send(buildPacket(1, sn, 2622, Buffer.from([0x08, 0x00])));
        }

      } else if (cmdId === 2626) {
        // Discard (2626)
        console.log(`[WS] Room ${currentRoom.id} - Player ${clientUid} played a card!`);
        ws.send(buildPacket(1, sn, 2626, Buffer.from([0x08, 0x00]))); // DiscardReply

        try {
          const discardReq = gameProto.pb.DiscardAPI.decode(buf.subarray(11));
          console.log(`[WS] Played card: ${discardReq.card}, cmd: ${discardReq.cmd}, moves:`, discardReq.moves);

          const player = currentRoom.players.find(p => p.uid === clientUid);
          if (player) {
            player.isManaged = 0; // Real player played: turn off bot
            player.handCards = player.handCards.filter(c => c !== discardReq.card);
            player.numOfHandCards = player.handCards.length;
          }

          if (discardReq.moves && discardReq.moves.length > 0) {
            for (let m of discardReq.moves) {
              const targetP = currentRoom.players.find(p => p.uid === m.uid);
              if (targetP && targetP.pieces && m.index !== undefined && m.pos !== undefined) {
                targetP.pieces[m.index] = m.pos;
                console.log(`[WS] Room ${currentRoom.id} - Piece updated: UID=${m.uid}, Index ${m.index} -> Pos ${m.pos}`);
              }
            }
          }

          let broadcastMoves = discardReq.moves || [];
          if (discardReq.cmd === 4 && (!broadcastMoves || broadcastMoves.length === 0)) {
            const targetP = currentRoom.players.find(p => p.uid !== clientUid);
            if (targetP) {
              broadcastMoves = [{ uid: targetP.uid, index: 0, pos: 0 }];
              targetP.isBanned = true;
              console.log(`[WS] Room ${currentRoom.id} - Card 10 (BAN): Player ${targetP.uid} banned!`);
            }
          }

          const onDiscardMsg = gameProto.pb.OnPlayerDiscard.create({
            uid: clientUid,
            cards: [discardReq.card],
            cmd: discardReq.cmd,
            moves: broadcastMoves,
            handCards: player ? player.handCards : [],
            numOfHandCards: player ? player.numOfHandCards : 0
          });
          const discardEnc = gameProto.pb.OnPlayerDiscard.encode(onDiscardMsg).finish();
          broadcastToRoom(currentRoom.id, 2, 0, 2627, Buffer.from(discardEnc));

          switchTurn(currentRoom, clientUid);

        } catch (e) {
          console.error('[WS] Error processing discard:', e);
        }
      } else if (cmdId === 2624) {
        // SetManaged (2624) - Toggling Auto-play / Bot mode
        ws.send(buildPacket(1, sn, 2624, Buffer.from([0x08, 0x00]))); // SetManagedReply
        try {
          const managedReq = lobbyProto.pb.SetManagedAPI.decode(buf.subarray(11));
          const player = currentRoom.players.find(p => p.uid === clientUid);
          if (player) {
            player.isManaged = managedReq.isManaged;
          }
          console.log(`[WS] Room ${currentRoom.id} - Player ${clientUid} isManaged set to: ${managedReq.isManaged}`);

          const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
            uid: clientUid,
            isManaged: managedReq.isManaged
          });
          const enc = lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish();
          broadcastToRoom(currentRoom.id, 2, 0, 2625, Buffer.from(enc));

          if (managedReq.isManaged === 0) {
            console.log(`[WS] Bot mode turned OFF for ${clientUid}. Restored 25s countdown.`);
            if (currentRoom.turnTimer && currentRoom.actorId === clientUid) {
              clearTimeout(currentRoom.turnTimer);
              currentRoom.turnTimer = setTimeout(() => executeBotTurn(currentRoom, clientUid), 25000);
            }
          } else if (managedReq.isManaged === 1 && currentRoom.actorId === clientUid) {
            clearTimeout(currentRoom.turnTimer);
            currentRoom.turnTimer = setTimeout(() => executeBotTurn(currentRoom, clientUid), 1500);
          }
        } catch (e) {
          console.error('[WS] Error processing SetManaged:', e);
        }
      }
    } catch (err) {
      console.error('[WS] Error:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[WS] Client disconnected: UID=${clientUid}, Room=${roomId}`);
    connectedClients.delete(clientUid);

    const room = rooms.get(roomId);
    if (room) {
      // If lobby stage and client was not captain, remove from room and notify
      if (room.state === 0) {
        const pIdx = room.players.findIndex(p => p.uid === clientUid && p.uid !== room.captain);
        if (pIdx !== -1) {
          room.players.splice(pIdx, 1);
          const leaveMsg = lobbyProto.pb.OnPlayerLeave.create({
            uid: clientUid,
            kickUid: '0'
          });
          broadcastToRoom(roomId, 2, 0, 2606, Buffer.from(lobbyProto.pb.OnPlayerLeave.encode(leaveMsg).finish()));
        }
      }

      // Check if room is completely empty (no connected sockets in this room)
      let roomActiveClients = 0;
      for (let cl of connectedClients.values()) {
        if (cl.roomId === roomId) roomActiveClients++;
      }
      if (roomActiveClients === 0) {
        console.log(`[ROOM CLEANUP] Room ${roomId} has 0 active clients. Cleaning up room.`);
        if (room.turnTimer) clearTimeout(room.turnTimer);
        rooms.delete(roomId);
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[JACKAROO MULTI-ROOM SERVER] Ready and listening on port ${PORT}`);
});
