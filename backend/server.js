
// backend/server.js
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;

const ROOMS = new Map();
const CLIENTS = new Map();

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Roguelite Legacy backend ok');
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server });

function makeId(prefix = 'p') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function safeName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, 16);
  return name || 'Jogador';
}

function normalizeRoomCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function safeDifficulty(value) {
  const allowed = new Set(['easy', 'normal', 'hard', 'nightmare']);
  const difficulty = String(value ?? 'normal').toLowerCase();
  return allowed.has(difficulty) ? difficulty : 'normal';
}

function clampMaxPlayers(value) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return 4;
  return Math.max(2, Math.min(8, n));
}

function safeBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function makeRoomCode(len = 6) {
  let code = '';
  for (let i = 0; i < len; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function getFreeRoomCode() {
  let code = makeRoomCode();
  while (ROOMS.has(code)) code = makeRoomCode();
  return code;
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function roomSnapshot(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    started: room.started,
    seed: room.seed,
    settings: { ...room.settings },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      isHost: p.id === room.hostId,
      connected: p.connected
    }))
  };
}

function broadcastRoom(room, payload, excludePlayerId = null) {
  for (const player of room.players.values()) {
    if (excludePlayerId && player.id === excludePlayerId) continue;
    send(player.ws, payload);
  }
}

function broadcastRoomState(room) {
  broadcastRoom(room, {
    type: 'roomUpdated',
    room: roomSnapshot(room)
  });
}

function addPlayerToRoom(room, player) {
  room.players.set(player.id, player);
  player.roomCode = room.code;
  player.ready = false;
  player.connected = true;
}

function deleteRoomIfEmpty(room) {
  if (room.players.size === 0) {
    ROOMS.delete(room.code);
    return true;
  }
  return false;
}

function promoteNewHost(room) {
  const nextHost = room.players.values().next().value;
  if (!nextHost) return null;

  room.hostId = nextHost.id;

  for (const p of room.players.values()) {
    p.ready = false;
  }

  send(nextHost.ws, {
    type: 'hostChanged',
    roomCode: room.code,
    hostId: nextHost.id
  });

  return nextHost;
}

function removePlayerFromRoom(player, options = {}) {
  const roomCode = player.roomCode;
  if (!roomCode) return;

  const room = ROOMS.get(roomCode);
  if (!room) {
    player.roomCode = null;
    player.ready = false;
    return;
  }

  room.players.delete(player.id);
  player.roomCode = null;
  player.ready = false;

  if (room.hostId === player.id) {
    const newHost = promoteNewHost(room);
    if (!newHost) {
      ROOMS.delete(room.code);
      return;
    }
  }

  if (!options.silent) {
    broadcastRoomState(room);
  }

  deleteRoomIfEmpty(room);
}

function createRoom(owner, settings = {}) {
  const code = getFreeRoomCode();

  const room = {
    code,
    hostId: owner.id,
    started: false,
    seed: null,
    players: new Map(),
    settings: {
      difficulty: safeDifficulty(settings.difficulty),
      maxPlayers: clampMaxPlayers(settings.maxPlayers),
      public: safeBoolean(settings.public)
    }
  };

  ROOMS.set(code, room);
  addPlayerToRoom(room, owner);

  return room;
}

function getRoomForPlayer(player) {
  if (!player.roomCode) return null;
  return ROOMS.get(player.roomCode) || null;
}

function error(ws, message) {
  send(ws, { type: 'error', message });
}

wss.on('connection', (ws) => {
  const player = {
    id: makeId('player'),
    name: 'Jogador',
    ready: false,
    roomCode: null,
    connected: true,
    ws
  };

  CLIENTS.set(ws, player);
  ws.isAlive = true;

  send(ws, {
    type: 'hello',
    playerId: player.id
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      error(ws, 'JSON inválido.');
      return;
    }

    if (!data || typeof data !== 'object') {
      error(ws, 'Mensagem inválida.');
      return;
    }

    const type = String(data.type || '');

    if (type === 'setName') {
      player.name = safeName(data.name);
      const room = getRoomForPlayer(player);
      if (room) broadcastRoomState(room);
      return;
    }

    if (type === 'createRoom') {
      if (player.roomCode) {
        removePlayerFromRoom(player, { silent: true });
      }

      player.name = safeName(data.name ?? player.name);

      const room = createRoom(player, data.settings || {});
      send(ws, {
        type: 'roomCreated',
        room: roomSnapshot(room),
        youAreHost: true
      });
      broadcastRoomState(room);
      return;
    }

    if (type === 'joinRoom') {
      const roomCode = normalizeRoomCode(data.roomCode);
      const room = ROOMS.get(roomCode);

      if (!room) {
        error(ws, 'Sala não encontrada.');
        return;
      }

      if (room.started) {
        error(ws, 'A partida já começou.');
        return;
      }

      if (room.players.size >= room.settings.maxPlayers) {
        error(ws, 'Sala cheia.');
        return;
      }

      if (player.roomCode) {
        removePlayerFromRoom(player, { silent: true });
      }

      player.name = safeName(data.name ?? player.name);
      addPlayerToRoom(room, player);

      send(ws, {
        type: 'joinedRoom',
        room: roomSnapshot(room),
        youAreHost: player.id === room.hostId
      });

      broadcastRoomState(room);
      return;
    }

    if (type === 'setRoomSettings') {
      const room = getRoomForPlayer(player);

      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }

      if (room.hostId !== player.id) {
        error(ws, 'Só o host pode alterar as configurações.');
        return;
      }

      if (room.started) {
        error(ws, 'Não dá para mudar a sala durante a partida.');
        return;
      }

      const settings = data.settings || {};

      if (settings.difficulty !== undefined) {
        room.settings.difficulty = safeDifficulty(settings.difficulty);
      }

      if (settings.maxPlayers !== undefined) {
        room.settings.maxPlayers = clampMaxPlayers(settings.maxPlayers);
      }

      if (settings.public !== undefined) {
        room.settings.public = safeBoolean(settings.public);
      }

      broadcastRoomState(room);
      return;
    }

    if (type === 'setReady') {
      const room = getRoomForPlayer(player);

      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }

      player.ready = !!data.ready;
      broadcastRoomState(room);
      return;
    }

    if (type === 'startGame') {
      const room = getRoomForPlayer(player);

      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }

      if (room.hostId !== player.id) {
        error(ws, 'Só o host pode iniciar.');
        return;
      }

      room.started = true;
      room.seed = `${Date.now()}-${room.code}`;

      broadcastRoom(room, {
        type: 'gameStarted',
        room: roomSnapshot(room)
      });

      return;
    }

    if (type === 'relay') {
      const room = getRoomForPlayer(player);

      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }

      const target = String(data.target || 'room');
      const payload = data.payload ?? null;

      const packet = {
        type: 'relay',
        from: player.id,
        name: player.name,
        target,
        payload
      };

      if (target === 'host') {
        const host = room.players.get(room.hostId);
        if (host && host.id !== player.id) {
          send(host.ws, packet);
        }
        return;
      }

      if (target === 'others') {
        broadcastRoom(room, packet, player.id);
        return;
      }

      broadcastRoom(room, packet);
      return;
    }

    if (type === 'leaveRoom') {
      removePlayerFromRoom(player);
      send(ws, { type: 'leftRoom' });
      return;
    }

    error(ws, 'Tipo de mensagem não reconhecido.');
  });

  ws.on('close', () => {
    removePlayerFromRoom(player, { silent: true });
    CLIENTS.delete(ws);
  });
});

setInterval(() => {
  for (const ws of CLIENTS.keys()) {
    if (ws.isAlive === false) {
      try {
        ws.terminate();
      } catch {}
      continue;
    }

    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
