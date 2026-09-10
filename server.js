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

// Global Room State (Lobby default: state = 0)
const roomState = {
  id: 'room_1',
  mode: 1,
  state: 0, // 0 = LobbyView, 2 = GameView
  captain: '1001',
  actorId: '1001',
  timeout: 30,
  players: [],
  modeInfos: [
    {
      mode: 1,
      teamCount: [2, 4], // Min 2, Max 4 seats in Lobby
      teamMemberCount: [1, 1],
      rule: JSON.stringify({ round_time: 25, total_time: 500, settle_time: 3, win_score: 50 })
    }
  ],
  rule: JSON.stringify({ round_time: 25, total_time: 500, settle_time: 3, win_score: 50 }),
  setting: '{}'
};

// Chat & Emoji event bus for players
const roomChatEvents = [];

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
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      status: 'online',
      service: 'Jackaroo Online Game Server',
      version: '1.0.0',
      connectedPlayers: connectedClients.size,
      roomState: roomState.state === 0 ? 'Lobby' : 'InGame',
      players: roomState.players.map(p => ({ uid: p.uid, name: p.name, seat: p.seatIndex, isReady: p.state === 1 }))
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
    const friendId = parsedUrl.searchParams.get('id') || ('bot_' + Date.now());
    const friendName = decodeURIComponent(parsedUrl.searchParams.get('name') || 'Misafir');
    const friendAvatar = decodeURIComponent(parsedUrl.searchParams.get('avatar') || '');

    const maxSeats = 4;
    const occupiedSeats = new Set(roomState.players.map(p => p.seatIndex));
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
      roomState.players.push(invitedPlayer);

      const enterMsg = lobbyProto.pb.OnPlayerEnter.create({ player: invitedPlayer });
      broadcastPacket(2, 0, 2604, Buffer.from(lobbyProto.pb.OnPlayerEnter.encode(enterMsg).finish()));

      const readyMsg = lobbyProto.pb.OnPlayerReady.create({ uid: friendId, isReady: 1 });
      broadcastPacket(2, 0, 2608, Buffer.from(lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish()));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: true, seat: freeSeat, player: invitedPlayer }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Masa dolu!' }));
    }
  }

  // API: Kick Player from Seat
  if (pathname === '/api/kick_player' || pathname === '/api/kick_seat') {
    const seat = parseInt(parsedUrl.searchParams.get('seatIndex') || '-1', 10);
    const targetIdx = roomState.players.findIndex(p => p.seatIndex === seat && p.uid !== roomState.captain);
    if (targetIdx !== -1) {
      const kicked = roomState.players.splice(targetIdx, 1)[0];
      const leaveMsg = lobbyProto.pb.OnPlayerLeave.create({
        uid: kicked.uid,
        kickUid: roomState.captain || '1001'
      });
      broadcastPacket(2, 0, 2606, Buffer.from(lobbyProto.pb.OnPlayerLeave.encode(leaveMsg).finish()));
      console.log(`[HTTP API] Kicked player from seat ${seat} (UID: ${kicked.uid}, Name: ${kicked.name})`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ success: true, seat }));
  }

  // API: Reset Lobby
  if (pathname === '/api/reset_lobby') {
    roomState.state = 0;
    roomState.round = 1;
    roomState.players = [
      {
        uid: '1001',
        appId: 'gfs',
        userId: '1001',
        name: 'Burak (Kaptan)',
        avatar: '',
        gender: '1',
        seatIndex: 0,
        state: 1,
        handCards: getRandomHand(),
        numOfHandCards: 4,
        pieces: [0, 0, 0, 0]
      },
      {
        uid: '1002',
        appId: 'gfs',
        userId: '1002',
        name: 'Misafir',
        avatar: '',
        gender: '1',
        seatIndex: 1,
        state: 0,
        handCards: getRandomHand(),
        numOfHandCards: 4,
        pieces: [0, 0, 0, 0]
      }
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: true, message: 'Lobi sıfırlandı' }));
  }

  // Optional: Serve static files if local ROOT or ./public exists
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

// Broadcast packet to all connected clients
function broadcastPacket(type, sn, cmdId, payloadBuffer) {
  const pkt = buildPacket(type, sn, cmdId, payloadBuffer);
  for (let client of connectedClients.values()) {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(pkt);
    }
  }
}

// Track active sockets
const connectedClients = new Map(); // uid -> { ws, uid }

let turnTimer = null;

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

function cancelBotForPlayer(uid) {
  const player = roomState.players.find(p => p.uid === uid);
  if (!player) return;

  player.isManaged = 0;
  console.log(`[CANCEL_BOT] Player ${uid} touched screen / cancelled bot!`);

  const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
    uid: uid,
    isManaged: 0
  });
  broadcastPacket(2, 0, 2625, Buffer.from(lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish()));

  if (roomState.actorId === uid) {
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = setTimeout(() => {
        console.log(`[BOT] Player ${uid} süresi doldu (25s)! BOTA BAĞLANDI.`);
        player.isManaged = 1;
        const onMsg = lobbyProto.pb.OnPlayerSetManaged.create({
          uid: uid,
          isManaged: 1
        });
        broadcastPacket(2, 0, 2625, Buffer.from(lobbyProto.pb.OnPlayerSetManaged.encode(onMsg).finish()));
        executeBotTurn(uid);
      }, 25000);
    }
  }
}

function setActiveTurn(actorId, timeoutSec = 25) {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (roomState.state !== 2) return;

  roomState.actorId = actorId;

  const player = roomState.players.find(p => p.uid === actorId);

  // If this player has 0 cards, switch to next
  if (!player || !player.handCards || player.handCards.length === 0) {
    console.log(`[TURN] Player ${actorId} has 0 cards.`);
    switchTurn(actorId);
    return;
  }

  // Broadcast OnUpdateActor (2629)
  const actorMsg = gameProto.pb.OnUpdateActor.create({
    actorId: actorId,
    timeout: timeoutSec
  });
  const actorEnc = gameProto.pb.OnUpdateActor.encode(actorMsg).finish();
  broadcastPacket(2, 0, 2629, Buffer.from(actorEnc));
  console.log(`[WS] OnUpdateActor broadcasted: Actor=${actorId}, Timeout=${timeoutSec}s`);

  const isConnected = connectedClients.has(actorId);
  const isBot = !isConnected || player.isManaged === 1;

  if (isBot) {
    console.log(`[BOT] Player ${actorId} BOT modunda (Bota salınmış / AFK). 1.5s içinde bot oynuyor...`);
    turnTimer = setTimeout(() => {
      executeBotTurn(actorId);
    }, 1500);
  } else {
    console.log(`[HUMAN] Player ${actorId} aktif insan. Tam ${timeoutSec}s bekleniyor...`);
    turnTimer = setTimeout(() => {
      console.log(`[BOT] Player ${actorId} süresi doldu (${timeoutSec}s)! BOTA BAĞLANDI.`);
      player.isManaged = 1;
      const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
        uid: actorId,
        isManaged: 1
      });
      broadcastPacket(2, 0, 2625, Buffer.from(lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish()));
      executeBotTurn(actorId);
    }, timeoutSec * 1000);
  }
}

function executeBotTurn(actorId) {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (roomState.state !== 2) return;

  const player = roomState.players.find(p => p.uid === actorId);
  const opponent = roomState.players.find(p => p.uid !== actorId);

  if (!player || !player.handCards || player.handCards.length === 0) {
    switchTurn(actorId);
    return;
  }

  const botMove = chooseBotMove(player, opponent);
  if (!botMove) {
    switchTurn(actorId);
    return;
  }

  console.log(`[BOT] ${actorId} (${player.name}) plays: Card ${botMove.card}, Cmd ${botMove.cmd} (${botMove.reason})`);

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
  broadcastPacket(2, 0, 2627, Buffer.from(discardEnc));

  switchTurn(actorId);
}

function switchTurn(currentActorId) {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (roomState.state !== 2) return;

  const totalCards = roomState.players.reduce((sum, p) => sum + (p.numOfHandCards || 0), 0);
  if (totalCards === 0) {
    console.log('[WS] Tüm eller bitti! Yeni tur başlatılıyor...');
    setTimeout(() => {
      dealNewRound();
    }, 1200);
    return;
  }

  const currentIdx = roomState.players.findIndex(p => p.uid === currentActorId);
  let nextActor = null;
  for (let i = 1; i <= roomState.players.length; i++) {
    const candidate = roomState.players[(currentIdx + i) % roomState.players.length];
    if (candidate && candidate.numOfHandCards > 0) {
      nextActor = candidate.uid;
      break;
    }
  }

  if (!nextActor) nextActor = currentActorId;

  setTimeout(() => {
    setActiveTurn(nextActor, 25);
  }, 800);
}

function dealNewRound() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
  if (roomState.state !== 2) return;

  for (let p of roomState.players) {
    p.handCards = getRandomHand();
    p.numOfHandCards = 4;
  }
  for (let client of connectedClients.values()) {
    const p = roomState.players.find(x => x.uid === client.uid);
    const dealPayload = gameProto.pb.OnDealCard.create({
      players: roomState.players.map(pl => ({
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
  console.log('[WS] Yeni tur kartları dağıtıldı!');
  setTimeout(() => {
    setActiveTurn('1001', 25);
  }, 1200);
}

function startGameSequence() {
  roomState.state = 2; // Transition to Gaming!
  for (let pl of roomState.players) {
    pl.pieces = [0, 0, 0, 0];
    pl.isBanned = false;
    if (connectedClients.has(pl.uid)) {
      pl.isManaged = 0;
      const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
        uid: pl.uid,
        isManaged: 0
      });
      broadcastPacket(2, 0, 2625, Buffer.from(lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish()));
    }
  }
  console.log(`[GAME] Starting Game Sequence! Broadcasting to ${connectedClients.size} connected clients...`);

  // Broadcast OnGameReady (cmd 2610)
  const gameReadyMsg = gameProto.pb.OnGameReady.create({
    players: roomState.players,
    roundId: '1'
  });
  const readyEnc = gameProto.pb.OnGameReady.encode(gameReadyMsg).finish();
  broadcastPacket(2, 0, 2610, Buffer.from(readyEnc));

  // Broadcast OnGameStart (cmd 2611)
  setTimeout(() => {
    const gameStartMsg = gameProto.pb.OnGameStart.create({});
    const startEnc = gameProto.pb.OnGameStart.encode(gameStartMsg).finish();
    broadcastPacket(2, 0, 2611, Buffer.from(startEnc));
    console.log(`[WS] Broadcasted OnGameStart to all devices! GameView is now active on PC & Phone!`);

    setTimeout(() => {
      dealNewRound();
    }, 1500);
  }, 300);
}

wss.on('connection', (ws, req) => {
  const urlParams = new URLSearchParams(req.url.split('?')[1] || '');
  const clientUid = urlParams.get('uid') || '1001';
  const clientName = decodeURIComponent(urlParams.get('name') || 'Oyuncu');
  const clientAvatar = decodeURIComponent(urlParams.get('avatar') || '');
  console.log(`[WS] Client connected: UID=${clientUid}, Name=${clientName}, Avatar=${clientAvatar ? 'yes' : 'no'}`);

  connectedClients.set(clientUid, { ws, uid: clientUid, name: clientName, avatar: clientAvatar });

  ws.on('message', (data) => {
    try {
      const buf = Buffer.from(data);
      if (buf.length < 11) return;

      const totalLen = buf.readUInt16BE(0);
      const type = buf.readUInt8(2);
      const sn = buf.readUInt32BE(3);
      const cmdId = buf.readUInt16BE(7);
      const dataLen = buf.readUInt16BE(9);

      if (cmdId === 101) {
        // Heartbeat
        ws.send(buildPacket(1, sn, 101, Buffer.alloc(0)));
      } else if (cmdId === 102) {
        // Ping
        ws.send(buildPacket(1, sn, 102, Buffer.alloc(0)));
      } else if (cmdId === 2601) {
        // Login (cmd 2601) -> Reply
        ws.send(buildPacket(1, sn, 2601, Buffer.from([0x08, 0x00])));
        console.log(`[WS] Sent LoginReply to UID: ${clientUid} (${clientName})`);

        // If in Lobby, seat this connecting user as Captain at Seat 0!
        if (roomState.state === 0) {
          roomState.captain = clientUid;
          roomState.actorId = clientUid;

          const captainPlayer = {
            uid: clientUid,
            appId: 'gfs',
            userId: clientUid,
            name: clientName,
            avatar: clientAvatar,
            gender: '1',
            seatIndex: 0,
            state: 1, // Ready (Captain ready)
            handCards: getRandomHand(),
            numOfHandCards: 4,
            pieces: [0, 0, 0, 0]
          };

          // Room contains ONLY this player at Seat 0; seats 1, 2, 3 are empty!
          roomState.players = [ captainPlayer ];
        }

        // Send OnPlayerLogin (cmd 2602)
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
            game: roomState,
            serverTime: Date.now()
          });

          const encoded = gameProto.pb.OnPlayerLogin.encode(onLoginMsg).finish();
          ws.send(buildPacket(2, 0, 2602, Buffer.from(encoded)));
          console.log(`[WS] Sent OnPlayerLogin to UID: ${clientUid} (${clientName}) at Seat 0. Players in room: ${roomState.players.length}`);
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
        console.log(`[WS] Player ${clientUid} set isReady to ${isReady}`);
        const p = roomState.players.find(x => x.uid === clientUid);
        if (p) p.state = isReady === 1 ? 1 : 0;

        ws.send(buildPacket(1, sn, 2607, Buffer.from([0x08, 0x00])));

        // Broadcast OnPlayerReady (cmd 2608)
        const readyMsg = lobbyProto.pb.OnPlayerReady.create({
          uid: clientUid,
          isReady: isReady
        });
        const readyEnc = lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish();
        broadcastPacket(2, 0, 2608, Buffer.from(readyEnc));

      } else if (cmdId === 2609) {
        // Captain clicked Start Game (cmd 2609)!
        console.log(`[WS] CAPTAIN CLICKED START GAME! Launching Board for ALL players!`);
        ws.send(buildPacket(1, sn, 2609, Buffer.from([0x08, 0x00]))); // StartReply
        startGameSequence();

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
        console.log(`[WS] Kickout called for seat: ${kickSeat}`);
        const targetIdx = roomState.players.findIndex(p => p.seatIndex === kickSeat && p.uid !== roomState.captain);
        if (targetIdx !== -1) {
          const kicked = roomState.players.splice(targetIdx, 1)[0];
          ws.send(buildPacket(1, sn, 2614, Buffer.from([0x08, 0x00])));
          const leaveMsg = lobbyProto.pb.OnPlayerLeave.create({
            uid: kicked.uid,
            kickUid: clientUid
          });
          broadcastPacket(2, 0, 2606, Buffer.from(lobbyProto.pb.OnPlayerLeave.encode(leaveMsg).finish()));
          console.log(`[WS] Player ${kicked.uid} (${kicked.name}) kicked!`);
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
        console.log(`[WS] Player ${clientUid} requested change to seat ${newSeat}`);
        const p = roomState.players.find(x => x.uid === clientUid);
        if (p) p.seatIndex = newSeat;

        ws.send(buildPacket(1, sn, 2620, Buffer.from([0x08, 0x00])));

        // Broadcast OnPlayerChangeSeat (cmd 2621)
        const changeSeatMsg = lobbyProto.pb.OnPlayerChangeSeat.create({
          uid: clientUid,
          seatIndex: newSeat
        });
        broadcastPacket(2, 0, 2621, Buffer.from(lobbyProto.pb.OnPlayerChangeSeat.encode(changeSeatMsg).finish()));

      } else if (cmdId === 2622) {
        // JoinBot (cmd 2622)
        console.log(`[WS] JoinBot called! Adding bot to empty seat...`);
        const maxSeats = roomState.modeInfos && roomState.modeInfos[0] ? roomState.modeInfos[0].teamCount[1] : 4;
        const occupiedSeats = new Set(roomState.players.map(p => p.seatIndex));
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
          roomState.players.push(botPlayer);
          ws.send(buildPacket(1, sn, 2622, Buffer.from([0x08, 0x00])));

          // Broadcast OnPlayerEnter (cmd 2604)
          const enterMsg = lobbyProto.pb.OnPlayerEnter.create({
            player: botPlayer
          });
          broadcastPacket(2, 0, 2604, Buffer.from(lobbyProto.pb.OnPlayerEnter.encode(enterMsg).finish()));

          // Broadcast OnPlayerReady (cmd 2608)
          const readyMsg = lobbyProto.pb.OnPlayerReady.create({
            uid: botUid,
            isReady: 1
          });
          broadcastPacket(2, 0, 2608, Buffer.from(lobbyProto.pb.OnPlayerReady.encode(readyMsg).finish()));
          console.log(`[WS] Bot added to seat ${freeSeat}: ${botPlayer.name}`);
        } else {
          ws.send(buildPacket(1, sn, 2622, Buffer.from([0x08, 0x00])));
        }

      } else if (cmdId === 2626) {
        // Discard (2626)
        console.log(`[WS] Player ${clientUid} played a card!`);
        ws.send(buildPacket(1, sn, 2626, Buffer.from([0x08, 0x00]))); // DiscardReply

        try {
          const discardReq = gameProto.pb.DiscardAPI.decode(buf.subarray(11));
          console.log(`[WS] Played card: ${discardReq.card}, cmd: ${discardReq.cmd}, moves:`, discardReq.moves);

          const player = roomState.players.find(p => p.uid === clientUid);
          if (player) {
            player.isManaged = 0; // Real player played: turn off bot
            player.handCards = player.handCards.filter(c => c !== discardReq.card);
            player.numOfHandCards = player.handCards.length;
          }

          if (discardReq.moves && discardReq.moves.length > 0) {
            for (let m of discardReq.moves) {
              const targetP = roomState.players.find(p => p.uid === m.uid);
              if (targetP && targetP.pieces && m.index !== undefined && m.pos !== undefined) {
                targetP.pieces[m.index] = m.pos;
                console.log(`[WS] Taş konumu güncellendi: UID=${m.uid}, Taş ${m.index} -> Kare ${m.pos}`);
              }
            }
          }

          let broadcastMoves = discardReq.moves || [];
          if (discardReq.cmd === 4 && (!broadcastMoves || broadcastMoves.length === 0)) {
            const targetUid = clientUid === '1001' ? '1002' : '1001';
            broadcastMoves = [{ uid: targetUid, index: 0, pos: 0 }];
            const targetPlayer = roomState.players.find(p => p.uid === targetUid);
            if (targetPlayer) targetPlayer.isBanned = true;
            console.log(`[WS] Kart 10 (BAN / Pas Geçtir) çalıştı: Oyuncu ${targetUid} banlandı!`);
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
          broadcastPacket(2, 0, 2627, Buffer.from(discardEnc));
          console.log(`[WS] Broadcasted move to PC and Phone simultaneously!`);

          switchTurn(clientUid);

        } catch (e) {
          console.error('[WS] Error processing discard:', e);
        }
      } else if (cmdId === 2624) {
        // SetManaged (2624) - Toggling Auto-play / Bot mode
        ws.send(buildPacket(1, sn, 2624, Buffer.from([0x08, 0x00]))); // SetManagedReply
        try {
          const managedReq = lobbyProto.pb.SetManagedAPI.decode(buf.subarray(11));
          const player = roomState.players.find(p => p.uid === clientUid);
          if (player) {
            player.isManaged = managedReq.isManaged;
          }
          console.log(`[WS] Player ${clientUid} isManaged set to: ${managedReq.isManaged}`);

          const onManagedMsg = lobbyProto.pb.OnPlayerSetManaged.create({
            uid: clientUid,
            isManaged: managedReq.isManaged
          });
          const enc = lobbyProto.pb.OnPlayerSetManaged.encode(onManagedMsg).finish();
          broadcastPacket(2, 0, 2625, Buffer.from(enc));

          if (managedReq.isManaged === 0) {
            console.log(`[WS] Bot mode turned OFF for ${clientUid}. Restored 25s countdown.`);
            if (turnTimer && roomState.actorId === clientUid) {
              clearTimeout(turnTimer);
              turnTimer = setTimeout(() => executeBotTurn(clientUid), 25000);
            }
          } else if (managedReq.isManaged === 1 && roomState.actorId === clientUid) {
            clearTimeout(turnTimer);
            turnTimer = setTimeout(() => executeBotTurn(clientUid), 1500);
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
    console.log(`[WS] Client disconnected: UID=${clientUid}`);
    connectedClients.delete(clientUid);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[JACKAROO GAME SERVER] Ready and listening on port ${PORT}`);
  console.log(`- PC (Kaptan Türkçe): http://localhost:${PORT}/index.html?test=1&lang=tr&uid=1001`);
  console.log(`- Phone (Türkçe):     http://192.168.1.40:${PORT}/index.html?test=1&lang=tr&uid=1002`);
});
