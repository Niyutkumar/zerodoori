// ZeroDoori sync server
// - Serves the website from /public
// - Keeps one shared "room state" per room (which video, playing or paused, where) and a shared queue
// - Relays play / pause / seek / video changes, queue changes and chat messages to everyone in the room
// - /api/search: YouTube search through the server, so the API key never reaches the browser
//
// Video never passes through this server: every viewer streams it from YouTube.
// The server only stores and forwards tiny messages.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');
const { Server } = require('socket.io');
const youtube = require('./youtube');

const PORT = process.env.PORT || 3000;
const EMPTY_ROOM_TTL_MS = 6 * 60 * 60 * 1000; // forget empty rooms after 6 hours
const MAX_CHAT_HISTORY = 60;
const MAX_NAME_LENGTH = 24;
const MAX_CHAT_LENGTH = 400;
const MAX_QUEUE = 50;

const ROOM_ID_RE = /^[A-Z0-9]{4,10}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const ALLOWED_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {Object} QueueItem
 * @property {string} id
 * @property {string} videoId
 * @property {string|null} title
 * @property {string|null} channel
 * @property {number} duration   seconds, 0 if unknown
 * @property {string} addedBy
 *
 * @typedef {Object} Room
 * @property {string} id
 * @property {string|null} videoId
 * @property {string|null} title
 * @property {boolean} isPlaying
 * @property {number} position   seconds into the video at `updatedAt`
 * @property {number} updatedAt  server time (ms) when `position` was true
 * @property {number} rate       playback speed
 * @property {QueueItem[]} queue
 * @property {Map<string, {id: string, name: string}>} users
 * @property {Array<object>} chat
 * @property {number|null} emptySince
 */

function createRoom(id) {
  return {
    id,
    videoId: null,
    title: null,
    isPlaying: false,
    position: 0,
    updatedAt: Date.now(),
    rate: 1,
    queue: [],
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
    title: room.title,
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

function cleanText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || null;
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

function quoted(title) {
  return title ? `“${title.length > 60 ? `${title.slice(0, 57)}…` : title}”` : 'a video';
}

// ---------------------------------------------------------------------------
// HTTP: website, health check, search
// ---------------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render sits in front of us; use the visitor's real IP for rate limits

app.use(compression()); // gzip pages and scripts: about 4x less data per visit

app.get('/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size, search: Boolean(process.env.YOUTUBE_API_KEY), time: Date.now() });
});

// Protect the shared daily quota: at most 20 searches per 5 minutes per visitor.
const searchHits = new Map();
function searchAllowed(ip) {
  const now = Date.now();
  const hits = (searchHits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (hits.length >= 20) {
    searchHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  searchHits.set(ip, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of searchHits) {
    if (!hits.some((t) => now - t < 5 * 60 * 1000)) searchHits.delete(ip);
  }
}, 10 * 60 * 1000).unref();

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').replace(/\s+/g, ' ').trim();
  if (q.length < 2) {
    res.status(400).json({ error: 'Type at least two letters to search.' });
    return;
  }
  if (!searchAllowed(req.ip)) {
    res.status(429).json({ error: 'That’s a lot of searches. Wait a few minutes and try again.' });
    return;
  }
  try {
    const results = await youtube.searchVideos(q);
    res.json({ results });
  } catch (err) {
    const code = err && err.code;
    if (code === 'not_configured') {
      res.status(503).json({ error: 'Search isn’t switched on yet. Paste a YouTube link instead.' });
    } else if (code === 'quota') {
      res.status(429).json({ error: 'Today’s free searches are used up. Paste a YouTube link instead – search comes back tomorrow.' });
    } else if (code === 'bad_key') {
      res.status(503).json({ error: 'Search is set up with a key YouTube doesn’t accept. Paste a link for now.' });
    } else {
      res.status(502).json({ error: 'Search didn’t work this time. Try again, or paste a link.' });
    }
  }
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
// Room helpers used by several events
// ---------------------------------------------------------------------------
function broadcastState(room, action, byId, byName, extra) {
  io.to(room.id).emit('state', {
    ...publicState(room),
    action,
    by: byId,
    byName,
    ...(extra || {}),
  });
}

function broadcastQueue(room) {
  io.to(room.id).emit('queue', room.queue);
}

function postSystem(room, text) {
  const msg = systemMessage(text);
  addChat(room, msg);
  io.to(room.id).emit('chat', msg);
}

function startVideo(room, videoId, title, position = 0) {
  room.videoId = videoId;
  room.title = title || null;
  room.position = position;
  room.isPlaying = true;
  room.rate = 1;
  room.updatedAt = Date.now();
}

/** Plays the first queued video. Returns the item, or null if the queue is empty. */
function playNextFromQueue(room) {
  const next = room.queue.shift();
  if (!next) return null;
  startVideo(room, next.videoId, next.title, 0);
  return next;
}

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
      target.title = cleanText(seed.title, 200);
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
      queue: room.queue,
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
        startVideo(room, videoId, cleanText(payload.title, 200), position);
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
      case 'next': {
        // "Skip": jump to the first video in the queue.
        const next = playNextFromQueue(room);
        if (!next) return;
        broadcastQueue(room);
        broadcastState(room, 'next', socket.id, name);
        return;
      }
      case 'ended': {
        // The video finished on someone's screen. Only the first report for this video counts.
        if (String(payload.videoId || '') !== room.videoId) return;
        const next = playNextFromQueue(room);
        if (next) {
          broadcastQueue(room);
          broadcastState(room, 'auto-next', socket.id, name);
          return;
        }
        if (!room.isPlaying) return;
        room.position = position;
        room.isPlaying = false;
        room.updatedAt = at;
        broadcastState(room, 'ended', socket.id, name);
        return;
      }
      case 'title': {
        // A viewer's player knows the title of the current video; remember it for late joiners.
        if (String(payload.videoId || '') !== room.videoId || room.title) return;
        room.title = cleanText(payload.title, 200);
        return;
      }
      default:
        return;
    }

    broadcastState(room, action, socket.id, name);
  });

  // ---------- queue ----------
  socket.on('queue:add', async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const target = room;
    const videoId = String((payload && payload.videoId) || '');
    if (!target || !VIDEO_ID_RE.test(videoId)) {
      reply({ ok: false, error: 'That video can’t be added.' });
      return;
    }
    if (target.queue.length >= MAX_QUEUE) {
      reply({ ok: false, error: `The queue is full (${MAX_QUEUE} videos).` });
      return;
    }

    let title = cleanText(payload.title, 200);
    let channel = cleanText(payload.channel, 100);
    if (!title) {
      const info = await youtube.videoInfo(videoId);
      title = info.title;
      channel = channel || info.channel;
    }
    if (room !== target) return; // left the room while we looked up the title

    if (!target.videoId) {
      // Nothing is playing yet, so start it straight away.
      startVideo(target, videoId, title, 0);
      broadcastState(target, 'load', socket.id, name);
      reply({ ok: true, started: true });
      return;
    }

    const item = {
      id: crypto.randomUUID(),
      videoId,
      title,
      channel,
      duration: Math.max(0, Math.round(Number(payload.duration) || 0)),
      addedBy: name,
    };
    target.queue.push(item);
    broadcastQueue(target);
    postSystem(target, `${name} added ${quoted(title)} to the queue`);
    reply({ ok: true, started: false });
  });

  socket.on('queue:remove', (payload) => {
    if (!room || !payload) return;
    const before = room.queue.length;
    room.queue = room.queue.filter((item) => item.id !== payload.itemId);
    if (room.queue.length !== before) broadcastQueue(room);
  });

  socket.on('queue:top', (payload) => {
    if (!room || !payload) return;
    const index = room.queue.findIndex((item) => item.id === payload.itemId);
    if (index <= 0) return;
    const [item] = room.queue.splice(index, 1);
    room.queue.unshift(item);
    broadcastQueue(room);
  });

  socket.on('queue:play', (payload) => {
    if (!room || !payload) return;
    const index = room.queue.findIndex((item) => item.id === payload.itemId);
    if (index < 0) return;
    const [item] = room.queue.splice(index, 1);
    startVideo(room, item.videoId, item.title, 0);
    broadcastQueue(room);
    broadcastState(room, 'load', socket.id, name);
  });

  // ---------- chat ----------
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
      postSystem(left, `${name} left`);
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

module.exports = { server, io, rooms, app };
