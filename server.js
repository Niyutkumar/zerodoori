// ZeroDoori sync server
// - Serves the website from /public
// - Keeps one shared "room state" per room (which video, playing or paused, where)
// - Relays play / pause / seek / video changes and chat messages to everyone in the room
//
// Video never passes through this server: every viewer streams it from YouTube.
// The server only stores and forwards tiny messages.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000; // forget empty rooms after 6 hours
const MAX_CHAT_HISTORY = 60;
const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 400;

const ROOM_ID_RE = /^[A-Z0-9]{4,10}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {string|null} videoId
 * @property {boolean} isPlaying
 * @property {number} position   seconds into the video at `updatedAt`
 * @property {number} updatedAt  server time (ms) when `position` was true
 * @property {number} rate       playback speed
 * @property {Map<string, {id: string, name: string}>} users
 * @property {Array<object>} chat
 * @property {number|null} emptySince
 */

function createRoom(id) {
  return {
    id,
    videoId: null,
    isPlaying: false,
    position: 0,
    updatedAt: Date.now(),
    rate: 1,
    users: new Map(),
    chat: [],
    emptySince: null,
  };
}

function currentPosition(room, now = Date.now()) {
  if (!room.isPlaying) return room.position;
  return room.position + ((now - room.updatedAt) / 1000) * room.rate;
}

function publicState(room) {
  return {
    videoId: room.videoId,
    isPlaying: room.isPlaying,
    position: room.position,
    updatedAt: room.updatedAt,
    rate: room.rate,
  };
}

function userList(room) {
  return Array.from(room.users.values());
}

function cleanName(name) {
  const trimmed = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || 'Guest';
}

function cleanPosition(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 60 * 60 * 24); // nothing on YouTube is longer than a day
}

/** The time the client says the action happened, kept within the last 3 seconds. */
function cleanTimestamp(value, now) {
  const n = Number(value);
  if (!Number.isFinite(n)) return now;
  return Math.min(now, Math.max(now - 3000, n));
}

function addChat(room, message) {
  room.chat.push(message);
  if (room.chat.length > MAX_CHAT_HISTORY) room.chat.shift();
}

let messageCounter = 0;
function systemMessage(text) {
  return { id: `m${Date.now()}-${messageCounter++}`, system: true, text, at: Date.now() };
}

// ---------------------------------------------------------------------------
// HTTP: website + health check
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, time: Date.now() });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // Always check for a newer version so the Android app picks up website updates.
      if (/\.(html|js|css|webmanifest)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 25000,
  maxHttpBufferSize: 16 * 1024,
});

// ---------------------------------------------------------------------------
// Real-time sync
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  /** @type {Room|null} */
  let room = null;
  let name = 'Guest';
  const chatTimes = [];

  // Clock sync: the client asks "what time is it on the server?" a few times.
  socket.on('time', (ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('join', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const roomId = String((payload && payload.roomId) || '').toUpperCase().trim();
    if (!ROOM_ID_RE.test(roomId)) {
      reply({ ok: false, error: 'That room code does not look right.' });
      return;
    }

    if (room) leaveRoom();

    name = cleanName(payload && payload.name);
    let target = rooms.get(roomId);
    const isNew = !target;
    if (!target) {
      target = createRoom(roomId);
      rooms.set(roomId, target);
    }

    // If the server restarted (free hosting can do that), the first person back
    // brings the video they were watching, so the room continues where it was.
    const seed = payload && payload.seed;
    if (!target.videoId && seed && VIDEO_ID_RE.test(String(seed.videoId || ''))) {
      target.videoId = String(seed.videoId);
      target.position = cleanPosition(seed.position);
      target.isPlaying = false;
      target.rate = ALLOWED_RATES.includes(Number(seed.rate)) ? Number(seed.rate) : 1;
      target.updatedAt = Date.now();
    }

    room = target;
    room.emptySince = null;
    room.users.set(socket.id, { id: socket.id, name });
    socket.join(room.id);

    reply({
      ok: true,
      roomId: room.id,
      isNew,
      you: { id: socket.id, name },
      state: publicState(room),
      users: userList(room),
      chat: room.chat,
      serverTime: Date.now(),
    });

    const msg = systemMessage(`${name} joined`);
    addChat(room, msg);
    socket.to(room.id).emit('chat', msg);
    io.to(room.id).emit('users', userList(room));
  });

  socket.on('control', (payload) => {
    if (!room || !payload) return;
    const now = Date.now();
    const action = String(payload.action || '');
    const at = cleanTimestamp(payload.at, now);
    const position = cleanPosition(payload.position);

    switch (action) {
      case 'load': {
        const videoId = String(payload.videoId || '');
        if (!VIDEO_ID_RE.test(videoId)) return;
        room.videoId = videoId;
        room.position = position;
        room.isPlaying = true;
        room.rate = 1;
        room.updatedAt = now;
        break;
      }
      case 'play':
        if (!room.videoId) return;
        room.position = position;
        room.isPlaying = true;
        room.updatedAt = at;
        break;
      case 'pause':
        if (!room.videoId) return;
        room.position = position;
        room.isPlaying = false;
        room.updatedAt = at;
        break;
      case 'seek':
        if (!room.videoId) return;
        room.position = position;
        room.updatedAt = at;
        break;
      case 'rate': {
        const rate = Number(payload.rate);
        if (!room.videoId || !ALLOWED_RATES.includes(rate)) return;
        room.position = currentPosition(room, now);
        room.rate = rate;
        room.updatedAt = now;
        break;
      }
      default:
        return;
    }

    io.to(room.id).emit('state', {
      ...publicState(room),
      action,
      by: socket.id,
      byName: name,
    });
  });

  socket.on('chat', (text) => {
    if (!room) return;
    const clean = String(text || '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!clean) return;

    // Simple spam guard: at most 8 messages per 10 seconds per person.
    const now = Date.now();
    while (chatTimes.length && now - chatTimes[0] > 10000) chatTimes.shift();
    if (chatTimes.length >= 8) return;
    chatTimes.push(now);

    const msg = {
      id: `m${now}-${messageCounter++}`,
      system: false,
      from: socket.id,
      name,
      text: clean,
      at: now,
    };
    addChat(room, msg);
    io.to(room.id).emit('chat', msg);
  });

  socket.on('leave', () => {
    if (room) leaveRoom();
  });

  socket.on('disconnect', () => {
    if (room) leaveRoom();
  });

  function leaveRoom() {
    const left = room;
    room = null;
    socket.leave(left.id);
    if (!left.users.delete(socket.id)) return;

    if (left.users.size === 0) {
      // Nobody is watching: freeze the video where it is so it doesn't "keep playing" while empty.
      left.position = currentPosition(left);
      left.isPlaying = false;
      left.updatedAt = Date.now();
      left.emptySince = Date.now();
    } else {
      const msg = systemMessage(`${name} left`);
      addChat(left, msg);
      io.to(left.id).emit('chat', msg);
      io.to(left.id).emit('users', userList(left));
    }
  }
});

// Forget rooms that have been empty for a long time.
setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    if (r.users.size === 0 && r.emptySince && now - r.emptySince > EMPTY_ROOM_TTL_MS) {
      rooms.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`ZeroDoori server running on http://localhost:${PORT}`);
  });
}

module.exports = { server, io, rooms };
