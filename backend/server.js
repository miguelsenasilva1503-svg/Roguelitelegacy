// backend/server.js
// Roguelite Legacy multiplayer backend
// Lobby/host authoritative server with room codes, kick/ban/crown, settings,
// readiness, character selection, and generic gameplay state relay.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS_MIN = 2;
const MAX_PLAYERS_MAX = 6;
const VS_MAX_MINUTES = 30;

const ROOMS = new Map(); // roomCode -> room
const CLIENTS = new Map(); // ws -> player

function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeString(value, fallback = '') {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  return s || fallback;
}

function safeName(value) {
  return safeString(value, 'Jogador').slice(0, 16);
}

function normalizeRoomCode(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

function normalizeMode(value) {
  const v = String(value ?? '').toLowerCase();
  return v === 'vs' ? 'vs' : 'coop';
}

function normalizeDifficulty(value) {
  const v = String(value ?? '').toLowerCase();
  if (v === 'hardcore' || v === 'uhc') return v;
  return 'classic';
}

function normalizeMap(value) {
  const map = safeString(value, 'planicie').slice(0, 32);
  return map || 'planicie';
}

function normalizeCharacter(value) {
  return safeString(value, 'none').slice(0, 32);
}

function normalizeBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const v = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on', 'sim'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'nao', 'não'].includes(v)) return false;
  return fallback;
}

function makeRoomCode() {
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    out += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return out;
}

function getUniqueRoomCode() {
  let code = makeRoomCode();
  while (ROOMS.has(code)) code = makeRoomCode();
  return code;
}

function fingerprintFromRequest(req) {
  const remoteAddress = req?.socket?.remoteAddress || 'unknown-ip';
  const userAgent = req?.headers?.['user-agent'] || 'unknown-ua';
  return `${remoteAddress}::${userAgent}`;
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function error(ws, message, code = 'error') {
  send(ws, { type: code, message });
}

function roomPublicSettings(room) {
  return {
    mode: room.settings.mode,
    maxPlayers: room.settings.maxPlayers,
    difficulty: room.settings.difficulty,
    map: room.settings.map,
    locked: room.settings.locked,
    timeLimit: room.settings.timeLimit,
  };
}

function playerPublicState(player, room) {
  return {
    id: player.id,
    name: player.name,
    character: player.character,
    ready: player.ready,
    isHost: room.hostId === player.id,
    isAdmin: room.adminIds.has(player.id),
    connected: player.connected,
    alive: player.alive,
    revived: player.revived,
    score: player.score,
    xp: player.xp,
    level: player.level,
    hp: player.hp,
    maxHp: player.maxHp,
    x: player.x,
    y: player.y,
    dir: player.dir,
    tombstone: player.tombstone,
    state: player.state || 'lobby',
  };
}

function roomSnapshot(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    started: room.started,
    inGame: room.inGame,
    seed: room.seed,
    settings: roomPublicSettings(room),
    bannedCount: room.bannedIds.size,
    players: [...room.players.values()].map((player) => playerPublicState(player, room)),
  };
}

function broadcastRoom(room, payload, exceptPlayerId = null) {
  for (const player of room.players.values()) {
    if (exceptPlayerId && player.id === exceptPlayerId) continue;
    send(player.ws, payload);
  }
}

function broadcastRoomState(room) {
  broadcastRoom(room, {
    type: 'roomUpdated',
    room: roomSnapshot(room),
  });
}

function createPlayer(ws, request) {
  return {
    id: makeId('player'),
    sessionId: makeId('session'),
    fingerprint: fingerprintFromRequest(request),
    ws,
    name: 'Jogador',
    ready: false,
    character: null,
    roomCode: null,
    connected: true,
    alive: true,
    revived: false,
    score: 0,
    xp: 0,
    level: 1,
    hp: 100,
    maxHp: 100,
    x: 0,
    y: 0,
    dir: 'down',
    tombstone: false,
    state: 'lobby',
    kickedBy: null,
    lastSeenAt: Date.now(),
  };
}

function addPlayerToRoom(room, player) {
  room.players.set(player.id, player);
  player.roomCode = room.code;
  player.connected = true;
  player.lastSeenAt = Date.now();
  if (!player.character) player.character = null;
}

function createRoom(owner, settings = {}) {
  const code = getUniqueRoomCode();
  const room = {
    code,
    hostId: owner.id,
    started: false,
    inGame: false,
    seed: null,
    players: new Map(),
    adminIds: new Set([owner.id]),
    bannedIds: new Set(),
    bannedNames: new Set(),
    bannedFingerprints: new Set(),
    bannedAddresses: new Set(),
    settings: {
      mode: normalizeMode(settings.mode),
      maxPlayers: clampInt(settings.maxPlayers, MAX_PLAYERS_MIN, MAX_PLAYERS_MAX, 6),
      difficulty: normalizeDifficulty(settings.difficulty),
      map: normalizeMap(settings.map),
      locked: normalizeBool(settings.locked, false),
      timeLimit: clampInt(settings.timeLimit, 1, VS_MAX_MINUTES, 10),
    },
    createdAt: Date.now(),
  };
  ROOMS.set(code, room);
  addPlayerToRoom(room, owner);
  return room;
}

function getRoomForPlayer(player) {
  if (!player.roomCode) return null;
  return ROOMS.get(player.roomCode) || null;
}

function deleteRoomIfEmpty(room) {
  if (room.players.size === 0) {
    ROOMS.delete(room.code);
    return true;
  }
  return false;
}

function resetReadyStates(room) {
  for (const p of room.players.values()) p.ready = false;
}

function resetGameState(room) {
  room.started = false;
  room.inGame = false;
  room.seed = null;
  for (const p of room.players.values()) {
    p.alive = true;
    p.revived = false;
    p.tombstone = false;
    p.score = 0;
    p.xp = 0;
    p.level = 1;
    p.hp = p.maxHp;
  }
}

function chooseNewHost(room) {
  const candidates = [...room.players.values()];
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function removePlayerFromRoom(player, { silent = false, reason = 'left' } = {}) {
  const room = getRoomForPlayer(player);
  if (!room) {
    player.roomCode = null;
    player.ready = false;
    player.connected = false;
    return;
  }

  room.players.delete(player.id);
  room.adminIds.delete(player.id);
  player.roomCode = null;
  player.ready = false;
  player.connected = false;

  const wasHost = room.hostId === player.id;

  if (wasHost) {
    const replacement = chooseNewHost(room);
    if (replacement) {
      room.hostId = replacement.id;
      room.adminIds.add(replacement.id);
      resetReadyStates(room);
      broadcastRoom(room, {
        type: 'hostChanged',
        roomCode: room.code,
        hostId: replacement.id,
        by: 'hostLeft',
      });
    } else {
      ROOMS.delete(room.code);
      return;
    }
  }

  if (!silent) {
    broadcastRoom(room, {
      type: 'playerLeft',
      roomCode: room.code,
      playerId: player.id,
      reason,
    });
    broadcastRoomState(room);
  }

  deleteRoomIfEmpty(room);
}

function isBanned(room, player, data = {}) {
  const name = safeName(data.name ?? player.name);
  const fingerprint = data.clientFingerprint || player.fingerprint;
  const address = data.clientAddress || String(fingerprint).split('::')[0] || 'unknown-ip';
  return (
    room.bannedIds.has(player.id) ||
    room.bannedNames.has(name.toLowerCase()) ||
    room.bannedFingerprints.has(String(fingerprint)) ||
    room.bannedAddresses.has(String(address))
  );
}

function validateJoin(room, player, data = {}) {
  if (room.started && room.inGame) {
    return { ok: false, message: 'A partida já começou.' };
  }
  if (room.settings.locked && room.hostId !== player.id) {
    return { ok: false, message: 'A sala está bloqueada.' };
  }
  if (room.players.size >= room.settings.maxPlayers && !room.players.has(player.id)) {
    return { ok: false, message: 'Sala cheia.' };
  }
  if (isBanned(room, player, data)) {
    return { ok: false, message: 'Você foi banido desta sala.' };
  }
  return { ok: true };
}

function applyPlayerState(player, patch) {
  if (patch.name !== undefined) player.name = safeName(patch.name);
  if (patch.character !== undefined) player.character = normalizeCharacter(patch.character);
  if (patch.ready !== undefined) player.ready = normalizeBool(patch.ready, false);
  if (patch.alive !== undefined) player.alive = normalizeBool(patch.alive, true);
  if (patch.revived !== undefined) player.revived = normalizeBool(patch.revived, false);
  if (patch.score !== undefined) player.score = clampInt(patch.score, -999999, 999999999, player.score);
  if (patch.xp !== undefined) player.xp = clampInt(patch.xp, 0, 999999999, player.xp);
  if (patch.level !== undefined) player.level = clampInt(patch.level, 1, 999, player.level);
  if (patch.hp !== undefined) player.hp = clampInt(patch.hp, 0, player.maxHp || 999999, player.hp);
  if (patch.maxHp !== undefined) player.maxHp = clampInt(patch.maxHp, 1, 999999, player.maxHp);
  if (patch.x !== undefined) player.x = Number(patch.x) || 0;
  if (patch.y !== undefined) player.y = Number(patch.y) || 0;
  if (patch.dir !== undefined) player.dir = safeString(patch.dir, 'down').slice(0, 12);
  if (patch.tombstone !== undefined) player.tombstone = normalizeBool(patch.tombstone, false);
  if (patch.state !== undefined) {
    player.state = safeString(patch.state, 'lobby').slice(0, 16);
    if (player.state === 'spectator') {
      player.ready = false;
      player.alive = false;
    }
  }
  player.lastSeenAt = Date.now();
}

function allPlayersReady(room) {
  const players = [...room.players.values()].filter((p) => p.state !== 'spectator');
  return players.length > 0 && players.every((p) => p.ready && p.character);
}

function endGameAndReturnLobby(room, payload = {}) {
  const endSnapshot = roomSnapshot(room);
  broadcastRoom(room, {
    type: 'gameEnded',
    room: endSnapshot,
    ...payload,
  });

  resetGameState(room);
  resetReadyStates(room);
  broadcastRoomState(room);
}

function withHost(player, room, ws, actionName) {
  if (room.hostId !== player.id) {
    error(ws, `Só o host pode ${actionName}.`);
    return false;
  }
  return true;
}

function attachSocketHandlers(ws, request) {
  const player = createPlayer(ws, request);
  CLIENTS.set(ws, player);
  ws.isAlive = true;

  send(ws, {
    type: 'hello',
    playerId: player.id,
    sessionId: player.sessionId,
    playerName: player.name,
  });

  ws.on('pong', () => {
    ws.isAlive = true;
    player.lastSeenAt = Date.now();
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

    const type = String(data.type || '').trim();
    player.lastSeenAt = Date.now();

    if (
      type === 'identify' ||
      type === 'auth' ||
      type === 'register'
    ) {
      if (data.name !== undefined) player.name = safeName(data.name);
      if (data.clientFingerprint) player.fingerprint = String(data.clientFingerprint);
      send(ws, { type: 'identified', playerId: player.id, name: player.name });
      const room = getRoomForPlayer(player);
      if (room) broadcastRoomState(room);
      return;
    }

    if (type === 'setName' || type === 'setNickname') {
      player.name = safeName(data.name ?? data.nickname);
      const room = getRoomForPlayer(player);
      if (room) broadcastRoomState(room);
      return;
    }

    if (type === 'createRoom' || type === 'roomCreate') {
      if (player.roomCode) removePlayerFromRoom(player, { silent: true, reason: 'createRoom' });
      player.name = safeName(data.name ?? player.name);
      if (data.character !== undefined) player.character = normalizeCharacter(data.character);
      const room = createRoom(player, data.settings || data.room || {});
      send(ws, {
        type: 'roomCreated',
        room: roomSnapshot(room),
        youAreHost: true,
      });
      broadcastRoomState(room);
      return;
    }

    if (type === 'joinRoom' || type === 'roomJoin') {
      const roomCode = normalizeRoomCode(data.roomCode || data.code);
      const room = ROOMS.get(roomCode);
      if (!room) {
        error(ws, 'Sala não encontrada.');
        return;
      }

      const check = validateJoin(room, player, data);
      if (!check.ok) {
        error(ws, check.message);
        return;
      }

      if (player.roomCode && player.roomCode !== room.code) {
        removePlayerFromRoom(player, { silent: true, reason: 'switchRoom' });
      }

      player.name = safeName(data.name ?? player.name);
      if (data.character !== undefined) player.character = normalizeCharacter(data.character);
      addPlayerToRoom(room, player);

      send(ws, {
        type: 'joinedRoom',
        room: roomSnapshot(room),
        youAreHost: room.hostId === player.id,
      });
      broadcastRoomState(room);
      return;
    }

    if (type === 'leaveRoom' || type === 'roomLeave') {
      removePlayerFromRoom(player, { reason: 'left' });
      send(ws, { type: 'leftRoom' });
      return;
    }

    if (type === 'setRoomSettings' || type === 'roomSettings') {
      const room = getRoomForPlayer(player);
      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }
      if (!withHost(player, room, ws, 'alterar as configurações')) return;
      if (room.started && room.inGame) {
        error(ws, 'Não é possível alterar a sala durante a partida.');
        return;
      }

      const settings = data.settings || data.room || {};
      if (settings.mode !== undefined) room.settings.mode = normalizeMode(settings.mode);
      if (settings.maxPlayers !== undefined) room.settings.maxPlayers = clampInt(settings.maxPlayers, MAX_PLAYERS_MIN, MAX_PLAYERS_MAX, room.settings.maxPlayers);
      if (settings.difficulty !== undefined) room.settings.difficulty = normalizeDifficulty(settings.difficulty);
      if (settings.map !== undefined) room.settings.map = normalizeMap(settings.map);
      if (settings.locked !== undefined) room.settings.locked = normalizeBool(settings.locked, room.settings.locked);
      if (settings.timeLimit !== undefined) room.settings.timeLimit = clampInt(settings.timeLimit, 1, VS_MAX_MINUTES, room.settings.timeLimit);

      resetReadyStates(room);
      broadcastRoomState(room);
      return;
    }

    if (type === 'toggleRoomLock' || type === 'lockRoom') {
      const room = getRoomForPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (!withHost(player, room, ws, 'bloquear a entrada')) return;
      room.settings.locked = !room.settings.locked;
      resetReadyStates(room);
      broadcastRoomState(room);
      return;
    }

    if (type === 'setCharacter' || type === 'selectCharacter' || type === 'characterSelect') {
      const room = getRoomForPlayer(player);
      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }
      player.character = normalizeCharacter(data.character ?? data.value);
      if (data.ready !== undefined) player.ready = normalizeBool(data.ready, player.ready);
      broadcastRoomState(room);
      return;
    }

    if (type === 'setReady' || type === 'playerReady' || type === 'readyUp') {
      const room = getRoomForPlayer(player);
      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }
      player.ready = normalizeBool(data.ready, true);
      broadcastRoomState(room);
      return;
    }

    if (type === 'kickPlayer' || type === 'banPlayer' || type === 'promotePlayer' || type === 'crownPlayer') {
      const room = getRoomForPlayer(player);
      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }
      if (!withHost(player, room, ws, 'editar a sala')) return;

      const targetId = String(data.targetId || data.playerId || data.id || '');
      const target = room.players.get(targetId);
      if (!target) {
        error(ws, 'Jogador não encontrado.');
        return;
      }

      if (type === 'promotePlayer' || type === 'crownPlayer') {
        room.hostId = target.id;
        room.adminIds.add(target.id);
        room.adminIds.add(player.id);
        resetReadyStates(room);
        broadcastRoom(room, {
          type: 'hostChanged',
          roomCode: room.code,
          hostId: room.hostId,
          by: 'promotePlayer',
          targetId: target.id,
        });
        broadcastRoomState(room);
        return;
      }

      if (type === 'kickPlayer') {
        send(target.ws, {
          type: 'kicked',
          roomCode: room.code,
          by: player.name,
          byId: player.id,
        });
        removePlayerFromRoom(target, { reason: 'kicked' });
        return;
      }

      if (type === 'banPlayer') {
        room.bannedIds.add(target.id);
        room.bannedNames.add(target.name.toLowerCase());
        room.bannedFingerprints.add(target.fingerprint);
        const addr = String(target.fingerprint).split('::')[0];
        if (addr) room.bannedAddresses.add(addr);
        send(target.ws, {
          type: 'banned',
          roomCode: room.code,
          by: player.name,
          byId: player.id,
        });
        removePlayerFromRoom(target, { reason: 'banned' });
        broadcastRoomState(room);
        return;
      }
    }

    if (type === 'unbanPlayer') {
      const room = getRoomForPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (!withHost(player, room, ws, 'desbanir jogadores')) return;
      room.bannedIds.delete(String(data.playerId || ''));
      room.bannedNames.delete(safeString(data.name || data.value || '').toLowerCase());
      room.bannedFingerprints.delete(String(data.fingerprint || ''));
      room.bannedAddresses.delete(String(data.address || ''));
      broadcastRoomState(room);
      return;
    }

    if (type === 'startGame' || type === 'startMatch') {
      const room = getRoomForPlayer(player);
      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }
      if (!withHost(player, room, ws, 'iniciar a partida')) return;
      if (!allPlayersReady(room)) {
        error(ws, 'Nem todos os jogadores escolheram personagem e ficaram prontos.');
        return;
      }

      room.started = true;
      room.inGame = true;
      room.seed = `${Date.now()}-${room.code}-${Math.random().toString(36).slice(2, 8)}`;

      for (const p of room.players.values()) {
        p.alive = true;
        p.revived = false;
        p.tombstone = false;
        p.score = 0;
        p.xp = 0;
        p.level = 1;
        p.hp = p.maxHp;
      }

      broadcastRoom(room, {
        type: 'gameStarted',
        room: roomSnapshot(room),
        seed: room.seed,
      });
      return;
    }

    if (type === 'endGame' || type === 'returnLobby' || type === 'gameOver') {
      const room = getRoomForPlayer(player);
      if (!room) return;
      if (type !== 'gameOver' && !withHost(player, room, ws, 'encerrar a partida')) return;
      endGameAndReturnLobby(room, { reason: type });
      return;
    }

    if (type === 'updatePlayerState' || type === 'playerState' || type === 'syncPlayerState') {
      const room = getRoomForPlayer(player);
      if (!room) return;
      applyPlayerState(player, data.state || data.patch || data);
      broadcastRoom(room, {
        type: 'playerStateUpdated',
        roomCode: room.code,
        player: playerPublicState(player, room),
      }, player.id);
      return;
    }

    if (type === 'gameEvent' || type === 'relay' || type === 'syncEvent') {
      const room = getRoomForPlayer(player);
      if (!room) {
        error(ws, 'Você não está em nenhuma sala.');
        return;
      }
      const target = String(data.target || 'room');
      const payload = data.payload ?? data.event ?? null;
      const packet = {
        type: type === 'relay' ? 'relay' : 'gameEvent',
        from: player.id,
        name: player.name,
        target,
        payload,
      };

      if (target === 'host') {
        const host = room.players.get(room.hostId);
        if (host && host.id !== player.id) send(host.ws, packet);
        return;
      }
      if (target === 'others') {
        broadcastRoom(room, packet, player.id);
        return;
      }
      broadcastRoom(room, packet);
      return;
    }

    if (type === 'heartbeat' || type === 'ping') {
      send(ws, { type: 'heartbeatAck', at: Date.now() });
      return;
    }

    error(ws, `Tipo de mensagem não reconhecido: ${type}`);
  });

  ws.on('close', () => {
    const room = getRoomForPlayer(player);
    if (room) {
      removePlayerFromRoom(player, { silent: true, reason: 'disconnect' });
      if (room.players.size > 0) {
        broadcastRoom(room, {
          type: 'playerDisconnected',
          roomCode: room.code,
          playerId: player.id,
        });
        broadcastRoomState(room);
      }
    }
    CLIENTS.delete(ws);
  });

  ws.on('error', () => {
    // O close cuida da limpeza.
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Roguelite Legacy backend ok');
    return;
  }

  if (req.url === '/rooms') {
    const summary = [...ROOMS.values()].map((room) => ({
      code: room.code,
      players: room.players.size,
      started: room.started,
      inGame: room.inGame,
      settings: roomPublicSettings(room),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: summary }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server });
wss.on('connection', attachSocketHandlers);

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

setInterval(() => {
  for (const room of [...ROOMS.values()]) {
    if (room.players.size === 0) {
      ROOMS.delete(room.code);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});