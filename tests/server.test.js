// Server tests: two fake viewers connect with socket.io-client and check the shared state.
const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { server, io, rooms } = require('../server.js');

let url;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});
test.after(() => new Promise((resolve) => io.close(() => resolve())));

function client() {
  const c = connect(url, { transports: ['websocket'], forceNew: true });
  openClients.add(c);
  return c;
}
test.afterEach(() => {
  for (const c of openClients) c.close();
  openClients.clear();
});
const openClients = new Set();
function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}
/** Waits for a 'state' broadcast with a specific action (everyone, including the sender, receives it). */
function stateFor(socket, action) {
  return new Promise((resolve) => {
    const handler = (s) => {
      if (s.action === action) {
        socket.off('state', handler);
        resolve(s);
      }
    };
    socket.on('state', handler);
  });
}
function join(socket, roomId, name, seed) {
  return new Promise((resolve) => socket.emit('join', { roomId, name, seed }, resolve));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('rejects bad room codes', async () => {
  const a = client();
  const res = await join(a, 'no!', 'A');
  assert.equal(res.ok, false);
  a.close();
});

test('two viewers share play / pause / seek / load', async () => {
  const a = client();
  const b = client();
  const ra = await join(a, 'TEST01', 'Niyut');
  assert.equal(ra.ok, true);
  assert.equal(ra.isNew, true);
  assert.equal(ra.state.videoId, null);

  const usersSeen = once(a, 'users');
  const rb = await join(b, 'test01', 'Friend'); // lower-case code works too
  assert.equal(rb.ok, true);
  assert.equal(rb.isNew, false);
  assert.equal(rb.roomId, 'TEST01');
  assert.equal((await usersSeen).length, 2);

  // A loads a video -> B hears about it
  let got = stateFor(b, 'load');
  a.emit('control', { action: 'load', videoId: 'M7lc1UVf-VE', position: 0 });
  let s = await got;
  assert.equal(s.action, 'load');
  assert.equal(s.videoId, 'M7lc1UVf-VE');
  assert.equal(s.isPlaying, true);
  assert.equal(s.byName, 'Niyut');

  // B pauses at 42.5s -> A hears it
  got = stateFor(a, 'pause');
  b.emit('control', { action: 'pause', position: 42.5, at: Date.now() });
  s = await got;
  assert.equal(s.isPlaying, false);
  assert.equal(s.position, 42.5);
  assert.equal(s.byName, 'Friend');

  // A seeks while paused
  got = stateFor(b, 'seek');
  a.emit('control', { action: 'seek', position: 90, at: Date.now() });
  s = await got;
  assert.equal(s.action, 'seek');
  assert.equal(s.position, 90);
  assert.equal(s.isPlaying, false);

  // Speed change
  got = stateFor(b, 'rate');
  a.emit('control', { action: 'rate', rate: 1.5, position: 90 });
  s = await got;
  assert.equal(s.rate, 1.5);

  // Invalid things are ignored
  a.emit('control', { action: 'load', videoId: 'bad video id!' });
  a.emit('control', { action: 'rate', rate: 7 });
  a.emit('control', { action: 'explode' });
  await sleep(100);
  assert.equal(rooms.get('TEST01').videoId, 'M7lc1UVf-VE');
  assert.equal(rooms.get('TEST01').rate, 1.5);

  a.close();
  b.close();
});

test('a late joiner gets the current position of a playing video', async () => {
  const a = client();
  await join(a, 'LATE01', 'A');
  const confirmed = stateFor(a, 'load');
  a.emit('control', { action: 'load', videoId: 'M7lc1UVf-VE', position: 0 });
  await confirmed;
  const played = stateFor(a, 'play');
  a.emit('control', { action: 'play', position: 10, at: Date.now() });
  await played;
  await sleep(1200);

  const b = client();
  const res = await join(b, 'LATE01', 'B');
  const st = res.state;
  const now = res.serverTime;
  const pos = st.position + (now - st.updatedAt) / 1000 * st.rate;
  assert.equal(st.isPlaying, true);
  assert.ok(pos > 11 && pos < 12, `expected ~11.2s, got ${pos}`);
  a.close();
  b.close();
});

test('chat is shared, kept in history, and spam is limited', async () => {
  const a = client();
  const b = client();
  await join(a, 'CHAT01', 'A');
  await join(b, 'CHAT01', 'B');
  const got = once(b, 'chat');
  a.emit('chat', '  hello there  ');
  const msg = await got;
  assert.equal(msg.text, 'hello there');
  assert.equal(msg.name, 'A');

  for (let i = 0; i < 20; i++) a.emit('chat', `spam ${i}`);
  await sleep(200);
  const userMessages = rooms.get('CHAT01').chat.filter((m) => !m.system);
  assert.ok(userMessages.length <= 9, `too many messages got through: ${userMessages.length}`);

  const c = client();
  const res = await join(c, 'CHAT01', 'C');
  assert.ok(res.chat.some((m) => m.text === 'hello there'));
  a.close(); b.close(); c.close();
});

test('room freezes when everyone leaves and is restored from a seed after a restart', async () => {
  const a = client();
  await join(a, 'FREEZE', 'A');
  const loaded = stateFor(a, 'load');
  a.emit('control', { action: 'load', videoId: 'M7lc1UVf-VE', position: 30 });
  await loaded;
  a.close();
  await sleep(150);
  const r = rooms.get('FREEZE');
  assert.equal(r.isPlaying, false);
  assert.ok(r.position >= 30);

  // Simulate a server restart: room is gone, first person back brings their state.
  rooms.delete('FREEZE');
  const b = client();
  const res = await join(b, 'FREEZE', 'B', { videoId: 'M7lc1UVf-VE', position: 77, rate: 1 });
  assert.equal(res.state.videoId, 'M7lc1UVf-VE');
  assert.equal(res.state.position, 77);
  assert.equal(res.state.isPlaying, false);
  b.close();
});

test('clock sync answers with server time', async () => {
  const a = client();
  await once(a, 'connect');
  const t = await new Promise((resolve) => a.emit('time', resolve));
  assert.ok(Math.abs(t - Date.now()) < 1000);
  a.close();
});

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
function queueAdd(socket, item) {
  return new Promise((resolve) => socket.emit('queue:add', item, resolve));
}

test('queue: first add starts playing, later adds wait in line', async () => {
  const a = client();
  const b = client();
  await join(a, 'QUEUE1', 'A');
  await join(b, 'QUEUE1', 'B');

  let started = stateFor(b, 'load');
  let res = await queueAdd(a, { videoId: 'aaaaaaaaaaa', title: 'First song' });
  assert.equal(res.started, true);
  let s = await started;
  assert.equal(s.videoId, 'aaaaaaaaaaa');
  assert.equal(s.title, 'First song');

  let q = once(b, 'queue');
  res = await queueAdd(b, { videoId: 'bbbbbbbbbbb', title: 'Second song', channel: 'Chan', duration: 215 });
  assert.equal(res.started, false);
  let list = await q;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Second song');
  assert.equal(list[0].addedBy, 'B');
  assert.equal(list[0].duration, 215);

  q = once(a, 'queue');
  await queueAdd(a, { videoId: 'ccccccccccc', title: 'Third song' });
  list = await q;
  assert.deepEqual(list.map((i) => i.videoId), ['bbbbbbbbbbb', 'ccccccccccc']);

  // Move the third to the top
  q = once(a, 'queue');
  b.emit('queue:top', { itemId: list[1].id });
  list = await q;
  assert.deepEqual(list.map((i) => i.videoId), ['ccccccccccc', 'bbbbbbbbbbb']);

  // Skip -> plays the top item
  started = stateFor(a, 'next');
  q = once(a, 'queue');
  b.emit('control', { action: 'next' });
  s = await started;
  list = await q;
  assert.equal(s.videoId, 'ccccccccccc');
  assert.equal(s.isPlaying, true);
  assert.equal(s.position, 0);
  assert.deepEqual(list.map((i) => i.videoId), ['bbbbbbbbbbb']);

  // Remove the last one
  q = once(a, 'queue');
  a.emit('queue:remove', { itemId: list[0].id });
  list = await q;
  assert.equal(list.length, 0);

  // Skip with an empty queue does nothing
  b.emit('control', { action: 'next' });
  await sleep(150);
  assert.equal(rooms.get('QUEUE1').videoId, 'ccccccccccc');
});

test('queue: when a video ends the next one plays, only once even if everyone reports it', async () => {
  const a = client();
  const b = client();
  await join(a, 'QUEUE2', 'A');
  await join(b, 'QUEUE2', 'B');
  await queueAdd(a, { videoId: 'aaaaaaaaaaa', title: 'One' });
  await queueAdd(a, { videoId: 'bbbbbbbbbbb', title: 'Two' });
  await queueAdd(a, { videoId: 'ccccccccccc', title: 'Three' });

  const auto = stateFor(b, 'auto-next');
  a.emit('control', { action: 'ended', videoId: 'aaaaaaaaaaa', position: 200 });
  b.emit('control', { action: 'ended', videoId: 'aaaaaaaaaaa', position: 200 }); // late duplicate
  const s = await auto;
  assert.equal(s.videoId, 'bbbbbbbbbbb');
  await sleep(150);
  const r = rooms.get('QUEUE2');
  assert.equal(r.videoId, 'bbbbbbbbbbb', 'duplicate "ended" must not skip a second video');
  assert.deepEqual(r.queue.map((i) => i.videoId), ['ccccccccccc']);

  // Play a specific queued item right now
  const loaded = stateFor(a, 'load');
  b.emit('queue:play', { itemId: r.queue[0].id });
  assert.equal((await loaded).videoId, 'ccccccccccc');

  // Last video ends with an empty queue -> pause at the end
  const ended = stateFor(b, 'ended');
  a.emit('control', { action: 'ended', videoId: 'ccccccccccc', position: 321 });
  const e = await ended;
  assert.equal(e.isPlaying, false);
  assert.equal(e.position, 321);
});

test('queue: late joiners get the queue and the current title', async () => {
  const a = client();
  await join(a, 'QUEUE3', 'A');
  await queueAdd(a, { videoId: 'aaaaaaaaaaa', title: 'Now playing' });
  await queueAdd(a, { videoId: 'bbbbbbbbbbb', title: 'Up next' });
  const b = client();
  const res = await join(b, 'QUEUE3', 'B');
  assert.equal(res.state.title, 'Now playing');
  assert.equal(res.queue.length, 1);
  assert.equal(res.queue[0].title, 'Up next');
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
test('search endpoint: explains when there is no key, and rejects tiny queries', async () => {
  const saved = process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_API_KEY;
  let r = await fetch(`${url}/api/search?q=a`);
  assert.equal(r.status, 400);
  r = await fetch(`${url}/api/search?q=arijit%20singh`);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /isn’t switched on/);
  if (saved) process.env.YOUTUBE_API_KEY = saved;
});

test('youtube.searchVideos: parses results, lengths, entities, and caches', async () => {
  const yt = require('../youtube.js');
  let calls = 0;
  const fakeFetch = async (u) => {
    calls++;
    const href = String(u);
    if (href.includes('/search?')) {
      assert.ok(href.includes('videoEmbeddable=true'));
      return new Response(JSON.stringify({
        items: [
          { id: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'Tom &amp; Jerry &#39;s best', channelTitle: 'Cartoon &quot;TV&quot;', thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } }, liveBroadcastContent: 'none' } },
          { id: { channelId: 'zzz' }, snippet: { title: 'not a video' } },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ items: [{ id: 'aaaaaaaaaaa', contentDetails: { duration: 'PT1H2M3S' } }] }), { status: 200 });
  };
  const results = await yt.searchVideos('Tom and Jerry', { fetchImpl: fakeFetch, apiKey: 'test' });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Tom & Jerry 's best");
  assert.equal(results[0].channel, 'Cartoon "TV"');
  assert.equal(results[0].duration, 3723);
  assert.equal(calls, 2);
  await yt.searchVideos('  tom AND jerry ', { fetchImpl: fakeFetch, apiKey: 'test' });
  assert.equal(calls, 2, 'second identical search should come from the cache');

  const quotaFetch = async () => new Response(JSON.stringify({ error: { errors: [{ reason: 'quotaExceeded' }] } }), { status: 403 });
  await assert.rejects(yt.searchVideos('something new', { fetchImpl: quotaFetch, apiKey: 'test' }), (e) => e.code === 'quota');
  await assert.rejects(yt.searchVideos('x', { apiKey: '' }), (e) => e.code === 'not_configured');
});
