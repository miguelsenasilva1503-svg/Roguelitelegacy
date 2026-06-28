const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ROOMS = new Map();   // roomCode -> room
const CLIENTS = new Map(); // ws -> player

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

function makeId(prefix = 'id') {
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

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function safeMode(value) {
  const v = String(value ?? '').toLowerCase();
  return v === 'vs' ? 'vs' : 'coop';
}

function safeDifficulty(value) {
  const v = String(value ?? '').toLowerCase();
  if (v === 'hardcore') return 'hardcore';
  if (v === 'uhc') return 'uhc';
  return 'classico';
}

function safeMap(value) {
  const m = String(value ?? '').trim().slice(0, 24);
  return m || 'Planície';
}

function safeCharacter(value) {
  const c = String(value ?? '').trim().slice(0, 24);
  return c || null;
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

function error(ws, message) {
  send(ws, { type: 'error', message });
}

function getRoomByPlayer(player) {
  if (!player.roomCode) return null;
  return ROOMS.get(player.roomCode) || null;
}

function getPlayerList(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    character: p.character,
    ready: p.ready,
    alive: p.alive,
    isHost: p.id === room.hostId,
    banned: false,
    kicked: false,
    score: p.score,
    xp: p.xp,
    level: p.level,
    hp: p.hp,
    maxHp: p.maxHp,
    connected: p.connected,
    x: p.x,
    y: p.y,
    state: p.state || 'lobby'
  }));
}

function roomSnapshot(room) {
  return {
    roomCode: room.code,
    hostId: room.hostId,
    started: room.started,
    locked: room.locked,
    mode: room.settings.mode,
    seed: room.seed,
    map: room.settings.map,
    bannedCodes: [...room.bannedCodes],
    settings: { ...room.settings },
    players: getPlayerList(room)
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

function clearPlayerRuntime(player) {
  player.ready = false;
  player.alive = true;
  player.character = null;
  player.score = 0;
  player.xp = 0;
  player.level = 1;
  player.hp = 100;
  player.maxHp = 100;
  player.revivesLeft = 1;
  player.state = 'lobby';
  player.x = 0;
  player.y = 0;
}

function addPlayerToRoom(room, player) {
  room.players.set(player.id, player);
  player.roomCode = room.code;
  player.connected = true;
  clearPlayerRuntime(player);
}

function deleteRoomIfEmpty(room) {
  if (room.players.size === 0) {
    ROOMS.delete(room.code);
    return true;
  }
  return false;
}

function promoteHost(room, newHostId = null) {
  let nextHost = null;

  if (newHostId && room.players.has(newHostId)) {
    nextHost = room.players.get(newHostId);
  }

  if (!nextHost) {
    nextHost = room.players.values().next().value || null;
  }

  if (!nextHost) return null;

  room.hostId = nextHost.id;
  for (const p of room.players.values()) p.ready = false;

  broadcastRoom(room, {
    type: 'hostChanged',
    roomCode: room.code,
    hostId: nextHost.id
  });

  broadcastRoomState(room);
  return nextHost;
}

function removePlayerFromRoom(player, options = {}) {
  const roomCode = player.roomCode;
  if (!roomCode) return;

  const room = ROOMS.get(roomCode);
  if (!room) {
    player.roomCode = null;
    clearPlayerRuntime(player);
    return;
  }

  room.players.delete(player.id);
  player.roomCode = null;
  clearPlayerRuntime(player);

  if (room.hostId === player.id) {
    const nextHost = promoteHost(room);
    if (!nextHost) {
      ROOMS.delete(room.code);
      return;
    }
  }

  if (!options.silent) broadcastRoomState(room);
  deleteRoomIfEmpty(room);
}

function createRoom(owner, settings = {}) {
  const code = getFreeRoomCode();
  const room = {
    code,
    hostId: owner.id,
    started: false,
    locked: false,
    seed: null,
    players: new Map(),
    bannedCodes: new Set(),
    settings: {
      mode: safeMode(settings.mode),
      maxPlayers: clampInt(settings.maxPlayers, 2, 6, 6),
      difficulty: safeDifficulty(settings.difficulty),
      map: safeMap(settings.map),
      timeLimit: clampInt(settings.timeLimit, 1, 30, 10) // só usado no VS
    }
  };

  ROOMS.set(code, room);
  addPlayerToRoom(room, owner);
  return room;
}

function startGame(room) {
  room.started = true;
  room.seed = `${Date.now()}-${room.code}`;
  for (const p of room.players.values()) {
    p.state = 'game';
    p.alive = true;
  }
}

function endGame(room, reason = 'gameOver') {
  room.started = false;
  room.seed = null;
  for (const p of room.players.values()) {
    clearPlayerRuntime(p);
  }
  broadcastRoom(room, {
    type: 'gameEnded',
    room: roomSnapshot(room),
    reason
  });
  broadcastRoomState(room);
}

function returnLobby(room) {
  room.started = false;
  room.seed = null;
  for (const p of room.players.values()) {
    p.state = 'lobby';
    p.alive = true;
    p.ready = false;
    p.x = 0;
    p.y = 0;
  }
  broadcastRoom(room, {
    type: 'returnLobby',
    room: roomSnapshot(room)
  });
  broadcastRoomState(room);
}

function validateStart(room) {
  if (room.started) return { ok: false, message: 'A partida já começou.' };
  if (room.players.size < 1) return { ok: false, message: 'Sala vazia.' };

  for (const p of room.players.values()) {
    if (!p.character) return { ok: false, message: 'Todos devem escolher personagem.' };
    if (!p.ready) return { ok: false, message: 'Todos devem estar prontos.' };
  }

  return { ok: true };
}

function handleRelay(player, data) {
  const room = getRoomByPlayer(player);
  if (!room) return error(player.ws, 'Você não está em nenhuma sala.');

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
    if (host && host.id !== player.id) send(host.ws, packet);
    return;
  }

  if (target === 'others') {
    broadcastRoom(room, packet, player.id);
    return;
  }

  broadcastRoom(room, packet);
}

function handleKick(room, actor, targetId) {
  const target = room.players.get(targetId);
  if (!target) return error(actor.ws, 'Player não encontrado.');

  if (target.id === room.hostId) {
    return error(actor.ws, 'Não pode expulsar o host.');
  }

  target.roomCode = null;
  clearPlayerRuntime(target);
  send(target.ws, { type: 'kicked', roomCode: room.code });
  room.players.delete(target.id);
  broadcastRoomState(room);
}

function handleBan(room, actor, targetId) {
  const target = room.players.get(targetId);
  if (!target) return error(actor.ws, 'Player não encontrado.');

  if (target.id === room.hostId) {
    return error(actor.ws, 'Não pode banir o host.');
  }

  room.bannedCodes.add(target.id);
  target.roomCode = null;
  clearPlayerRuntime(target);
  send(target.ws, { type: 'banned', roomCode: room.code });
  room.players.delete(target.id);
  broadcastRoomState(room);
}

wss.on('connection', (ws) => {
  const player = {
    id: makeId('player'),
    name: 'Jogador',
    character: null,
    ready: false,
    roomCode: null,
    connected: true,
    alive: true,
    revivesLeft: 1,
    score: 0,
    xp: 0,
    level: 1,
    hp: 100,
    maxHp: 100,
    x: 0,
    y: 0,
    state: 'lobby',
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
      return error(ws, 'JSON inválido.');
    }

    if (!data || typeof data !== 'object') {
      return error(ws, 'Mensagem inválida.');
    }

    const type = String(data.type || '');

    if (type === 'setName') {
      player.name = safeName(data.name);
      const room = getRoomByPlayer(player);
      if (room) broadcastRoomState(room);
      return;
    }

    if (type === 'createRoom') {
      if (player.roomCode) removePlayerFromRoom(player, { silent: true });

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

      if (!room) return error(ws, 'Sala não encontrada.');
      if (room.started) return error(ws, 'A partida já começou.');
      if (room.locked) return error(ws, 'Sala bloqueada.');
      if (room.players.size >= room.settings.maxPlayers) return error(ws, 'Sala cheia.');
      if (room.bannedCodes.has(player.id)) return error(ws, 'Você foi banido desta sala.');

      if (player.roomCode) removePlayerFromRoom(player, { silent: true });

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

    if (type === 'leaveRoom') {
      removePlayerFromRoom(player);
      send(ws, { type: 'leftRoom' });
      return;
    }

    if (type === 'setCharacter' || type === 'selectCharacter') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.started) return error(ws, 'A partida já começou.');

      player.character = safeCharacter(data.character);
      player.ready = false;
      broadcastRoomState(room);
      return;
    }

    if (type === 'setReady') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.started) return error(ws, 'A partida já começou.');

      player.ready = !!data.ready;
      broadcastRoomState(room);
      return;
    }

    if (type === 'lockRoom') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode bloquear.');
      if (room.started) return error(ws, 'Não dá para bloquear durante a partida.');

      room.locked = safeBool(data.locked);
      broadcastRoomState(room);
      return;
    }

    if (type === 'setRoomSettings') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode alterar as configurações.');
      if (room.started) return error(ws, 'Não dá para mudar durante a partida.');

      const settings = data.settings || {};

      if (settings.mode !== undefined) room.settings.mode = safeMode(settings.mode);
      if (settings.maxPlayers !== undefined) room.settings.maxPlayers = clampInt(settings.maxPlayers, 2, 6, room.settings.maxPlayers);
      if (settings.difficulty !== undefined) room.settings.difficulty = safeDifficulty(settings.difficulty);
      if (settings.map !== undefined) room.settings.map = safeMap(settings.map);
      if (settings.timeLimit !== undefined) room.settings.timeLimit = clampInt(settings.timeLimit, 1, 30, room.settings.timeLimit);

      broadcastRoomState(room);
      return;
    }

    if (type === 'kickPlayer' || type === 'banPlayer') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode fazer isso.');
      if (room.started) return error(ws, 'Não dá para fazer isso durante a partida.');

      const targetId = String(data.targetId || '');
      if (!targetId) return error(ws, 'Target inválido.');

      if (type === 'kickPlayer') {
        handleKick(room, player, targetId);
      } else {
        handleBan(room, player, targetId);
      }
      return;
    }

    if (type === 'promotePlayer') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode coroar.');
      if (room.started) return error(ws, 'Não dá para fazer isso durante a partida.');

      const targetId = String(data.targetId || '');
      if (!room.players.has(targetId)) return error(ws, 'Player não encontrado.');

      promoteHost(room, targetId);
      return;
    }

    if (type === 'startGame') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode iniciar.');

      const check = validateStart(room);
      if (!check.ok) return error(ws, check.message);

      startGame(room);
      broadcastRoom(room, {
        type: 'gameStarted',
        room: roomSnapshot(room)
      });
      broadcastRoomState(room);
      return;
    }

    if (type === 'endGame') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode encerrar.');

      endGame(room, data.reason || 'gameOver');
      return;
    }

    if (type === 'returnLobby') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');
      if (room.hostId !== player.id) return error(ws, 'Só o host pode trazer para o lobby.');

      returnLobby(room);
      return;
    }

    if (type === 'updatePlayerState') {
      const room = getRoomByPlayer(player);
      if (!room) return error(ws, 'Você não está em nenhuma sala.');

      player.state = String(data.state || player.state);
      if (data.x !== undefined) player.x = Number(data.x) || 0;
      if (data.y !== undefined) player.y = Number(data.y) || 0;
      if (data.hp !== undefined) player.hp = Math.max(0, Number(data.hp) || 0);
      if (data.maxHp !== undefined) player.maxHp = Math.max(1, Number(data.maxHp) || 1);
      if (data.level !== undefined) player.level = Math.max(1, Number(data.level) || 1);
      if (data.xp !== undefined) player.xp = Math.max(0, Number(data.xp) || 0);
      if (data.score !== undefined) player.score = Math.max(0, Number(data.score) || 0);
      if (data.ready !== undefined) player.ready = !!data.ready;
      if (data.character !== undefined) player.character = safeCharacter(data.character);
      if (data.alive !== undefined) player.alive = !!data.alive;

      broadcastRoomState(room);
      return;
    }

    if (type === 'relay') {
      return handleRelay(player, data);
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
