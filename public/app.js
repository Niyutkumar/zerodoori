/* ZeroDoori client
 *
 * How sync works:
 *  - The server keeps the room's truth: { videoId, isPlaying, position, updatedAt, rate }.
 *    "position" is where the video was at server time "updatedAt".
 *  - When YOU play / pause / seek / change video, we send that to the server.
 *  - When anyone does, the server sends the new truth to everyone and each player follows it.
 *  - Every couple of seconds we compare our player with where the room should be, and
 *    gently re-seek if we've drifted more than about a second (buffering, slow phones...).
 *  - Changes we make to our own player because of the room are "suppressed" for a moment,
 *    so they don't get sent back to the server (that would loop forever).
 */
(function () {
  'use strict';

  // ---------- constants ----------
  const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  const DRIFT_LIMIT = 1.0; // seconds of difference we tolerate while playing
  const TICK_MS = 500;
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const storage = {
    get(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ } },
  };

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }

  function clockTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function makeRoomCode() {
    let code = '';
    const random = new Uint32Array(6);
    window.crypto.getRandomValues(random);
    for (let i = 0; i < 6; i++) code += CODE_CHARS[random[i] % CODE_CHARS.length];
    return code;
  }

  /** "90", "90s", "1m30s", "1h2m3s" -> seconds */
  function parseStart(value) {
    if (!value) return 0;
    if (/^\d+(\.\d+)?s?$/.test(value)) return parseFloat(value);
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
    if (!m) return 0;
    return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  }

  /** Pulls the video id (and start time, if any) out of any common YouTube link. */
  function getVideoInfo(text) {
    const value = String(text || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(value)) return { videoId: value, start: 0 };
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch (e) {
      return null;
    }
    const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
    let id = null;
    if (host === 'youtu.be') {
      id = url.pathname.split('/')[1];
    } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = url.searchParams.get('v');
      if (!id) {
        const parts = url.pathname.split('/');
        if (['shorts', 'embed', 'live', 'v'].includes(parts[1])) id = parts[2];
      }
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return { videoId: id, start: parseStart(url.searchParams.get('t') || url.searchParams.get('start')) };
  }

  function getVideoId(text) {
    const info = getVideoInfo(text);
    return info ? info.videoId : null;
  }

  let toastTimer = null;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---------- app state ----------
  const socket = io({ autoConnect: true, reconnectionDelayMax: 4000 });

  let me = { id: null, name: '' };
  let roomId = null; // the room we're in (or trying to rejoin)
  let room = null; // last known room truth from the server
  let users = [];
  let queue = []; // videos waiting to play next (shared by the room)
  let clockOffset = 0; // serverTime - localTime, in ms

  let player = null;
  let playerReady = false;
  let ytApiReady = false;
  let loadedVideoId = null;
  let suppressEventsUntil = 0; // ignore player events we caused ourselves (short)
  let suppressJumpsUntil = 0; // ignore position jumps / drift checks right after we moved the player
  let lastPoll = null;
  let tickCount = 0;
  let autoplayTimer = null;
  let wakeLock = null;
  let hasConnectedOnce = false;

  const serverNow = () => Date.now() + clockOffset;
  const eventsSuppressed = () => Date.now() < suppressEventsUntil;
  const jumpsSuppressed = () => Date.now() < suppressJumpsUntil;
  /** Call right before WE change the player, so the change isn't mistaken for the user's. */
  function suppress(jumpMs) {
    const now = Date.now();
    suppressEventsUntil = Math.max(suppressEventsUntil, now + 700);
    suppressJumpsUntil = Math.max(suppressJumpsUntil, now + jumpMs);
    lastPoll = null;
  }

  /** Where the room's video should be right now, in seconds. */
  function expectedPosition() {
    if (!room) return 0;
    if (!room.isPlaying) return room.position;
    return room.position + ((serverNow() - room.updatedAt) / 1000) * room.rate;
  }

  // ======================================================================
  // LIGHT / DARK MODE
  // ======================================================================
  // Follows the phone's setting until you pick one with the sun / moon button.
  const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0B0D12' : '#F7F7FA');
  }
  applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

  document.querySelectorAll('.theme-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      storage.set('zd-theme', next);
      applyTheme(next);
    });
  });
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener('change', (e) => {
      const saved = storage.get('zd-theme');
      if (saved !== 'light' && saved !== 'dark') applyTheme(e.matches ? 'dark' : 'light');
    });
  }

  // ======================================================================
  // HOME SCREEN
  // ======================================================================
  const params = new URLSearchParams(window.location.search);
  const invitedCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  $('nameInput').value = storage.get('zd-name') || '';
  if (invitedCode) {
    $('inviteCode').textContent = invitedCode;
    $('inviteBox').classList.remove('hidden');
    $('codeInput').value = invitedCode;
  }

  function readName() {
    const name = $('nameInput').value.replace(/\s+/g, ' ').trim();
    if (!name) {
      $('homeError').textContent = 'Please enter your name first.';
      $('nameInput').focus();
      return null;
    }
    storage.set('zd-name', name);
    return name;
  }

  $('createBtn').addEventListener('click', () => {
    const name = readName();
    if (name) enterRoom(makeRoomCode(), name);
  });

  $('joinBtn').addEventListener('click', () => {
    const name = readName();
    if (!name) return;
    const code = $('codeInput').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) {
      $('homeError').textContent = 'Enter the room code your friend sent you.';
      $('codeInput').focus();
      return;
    }
    enterRoom(code, name);
  });

  $('joinInviteBtn').addEventListener('click', () => {
    const name = readName();
    if (name) enterRoom(invitedCode, name);
  });

  $('codeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('joinBtn').click();
  });
  $('nameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') (invitedCode ? $('joinInviteBtn') : $('createBtn')).click();
  });
  $('nameInput').addEventListener('input', () => { $('homeError').textContent = ''; });
  $('codeInput').addEventListener('input', () => { $('homeError').textContent = ''; });

  function enterRoom(code, name) {
    me.name = name;
    roomId = code;
    $('homeError').textContent = '';
    showRoomView();
    joinCurrentRoom();
  }

  function showRoomView() {
    $('homeView').classList.add('hidden');
    $('roomView').classList.remove('hidden');
    $('codeChip').textContent = roomId;
    $('chatList').innerHTML = '';
    window.history.replaceState(null, '', `/?room=${roomId}`);
    document.title = `ZeroDoori – room ${roomId}`;
    setSyncStatus('Connecting…', true);
    renderEmptyOverlay();
    createPlayerIfPossible();
  }

  function leaveRoom() {
    socket.emit('leave');
    roomId = null;
    room = null;
    users = [];
    queue = [];
    renderQueue();
    showTab('chat');
    loadedVideoId = null;
    if (player && playerReady) {
      try { player.stopVideo(); } catch (e) { /* ignore */ }
    }
    releaseWakeLock();
    hideTapToSync();
    $('roomView').classList.add('hidden');
    $('homeView').classList.remove('hidden');
    $('inviteBox').classList.add('hidden');
    $('codeInput').value = '';
    window.history.replaceState(null, '', '/');
    document.title = 'ZeroDoori – watch YouTube together';
  }

  $('leaveBtn').addEventListener('click', leaveRoom);

  // ======================================================================
  // CONNECTION + JOINING
  // ======================================================================
  function setBanner(text) {
    const el = $('connBanner');
    if (text) {
      el.textContent = text;
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function joinCurrentRoom() {
    if (!roomId || !socket.connected) return;
    const seed = room && room.videoId
      ? { videoId: room.videoId, title: room.title, position: expectedPosition(), rate: room.rate }
      : null;
    socket.emit('join', { roomId, name: me.name, seed }, (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || 'Could not join that room.');
        leaveRoom();
        return;
      }
      me.id = res.you.id;
      me.name = res.you.name;
      roomId = res.roomId;
      users = res.users;
      renderPeople();
      queue = res.queue || [];
      renderQueue();
      $('chatList').innerHTML = '';
      res.chat.forEach(renderChat);
      if (res.isNew && !res.state.videoId) {
        addSystemLine('Room created. Tap Invite to bring a friend in.');
      }
      syncClock().then(() => {
        room = res.state;
        applyRoomState();
        updateSyncStatus();
      });
    });
  }

  /** Estimates the difference between our clock and the server's (NTP-style). */
  async function syncClock() {
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      const serverTime = await new Promise((resolve) => {
        socket.timeout(4000).emit('time', (err, st) => resolve(err ? null : st));
      });
      const t1 = Date.now();
      if (typeof serverTime === 'number') {
        samples.push({ rtt: t1 - t0, offset: serverTime - (t0 + (t1 - t0) / 2) });
      }
    }
    if (samples.length) {
      samples.sort((a, b) => a.rtt - b.rtt);
      clockOffset = samples[0].offset;
    }
  }

  socket.on('connect', () => {
    hasConnectedOnce = true;
    setBanner('');
    if (roomId) joinCurrentRoom();
  });

  socket.on('disconnect', () => {
    if (roomId) {
      setBanner('Connection lost – reconnecting…');
      setSyncStatus('Reconnecting…', true);
    }
  });

  socket.io.on('reconnect_attempt', () => {
    if (roomId) setBanner('Connection lost – reconnecting…');
  });

  socket.on('connect_error', () => {
    if (!hasConnectedOnce) {
      setBanner('Waking up the ZeroDoori server… this can take up to a minute the first time.');
    } else if (roomId) {
      setBanner('Connection lost – reconnecting…');
    }
  });

  // Re-measure the clock now and then (phones drift and networks change).
  setInterval(() => {
    if (socket.connected && roomId) syncClock();
  }, 60000);

  socket.on('users', (list) => {
    users = list;
    renderPeople();
  });

  socket.on('chat', (msg) => {
    renderChat(msg);
    if (activeTab !== 'chat' && !msg.system) bumpChatBadge();
  });

  socket.on('queue', (list) => {
    queue = list;
    renderQueue();
  });

  socket.on('state', (state) => {
    if (!roomId) return;
    const mine = state.by === me.id;
    const previousVideo = room && room.videoId;
    room = {
      videoId: state.videoId,
      title: state.title || null,
      isPlaying: state.isPlaying,
      position: state.position,
      updatedAt: state.updatedAt,
      rate: state.rate,
    };

    // Our own change is already on our screen; only a new video needs loading.
    if (!mine || state.videoId !== loadedVideoId) applyRoomState();

    describeAction(state, mine, previousVideo);
    updateSyncStatus();
  });

  function describeAction(state, mine, previousVideo) {
    const who = mine ? 'You' : state.byName;
    const at = formatTime(state.position);
    const video = state.title ? `“${shorten(state.title, 60)}”` : 'a new video';
    let text = '';
    let logToChat = true;
    switch (state.action) {
      case 'load': text = `${who} started ${video}`; break;
      case 'next': text = `${who} skipped to ${video}`; break;
      case 'auto-next': text = `Up next: ${video}`; break;
      case 'ended': text = 'The video ended'; logToChat = false; break;
      case 'play': text = `${who} pressed play at ${at}`; break;
      case 'pause': text = `${who} paused at ${at}`; break;
      case 'seek': text = `${who} jumped to ${at}`; logToChat = false; break;
      case 'rate': text = `${who} set the speed to ${state.rate}×`; break;
      default: return;
    }
    if (state.action === 'load' && previousVideo === state.videoId) return;
    lastActivity = { text, at: Date.now() };
    if (logToChat) addSystemLine(text);
  }

  // ======================================================================
  // SENDING OUR OWN ACTIONS
  // ======================================================================
  function sendControl(action, position, extra) {
    if (!roomId || !socket.connected) return;
    // Give the server a moment to confirm before the drift check second-guesses us.
    suppressJumpsUntil = Math.max(suppressJumpsUntil, Date.now() + 1500);
    lastPoll = null;
    socket.emit('control', Object.assign({ action, position, at: serverNow() }, extra || {}));
  }

  /** Reads the link box. Returns {videoId, start} or null (after telling the user why). */
  function takeLink() {
    const info = getVideoInfo($('linkInput').value);
    if (!info) {
      toast($('linkInput').value.trim() ? "That doesn't look like a YouTube link." : 'Paste a YouTube link first.');
      return null;
    }
    if (!socket.connected) {
      toast('Not connected yet – try again in a moment.');
      return null;
    }
    $('linkInput').value = '';
    $('linkInput').blur();
    return info;
  }

  // Play now (for everyone). Starting from a tap also unlocks autoplay in the browser.
  $('linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const info = takeLink();
    if (info) sendControl('load', info.start, { videoId: info.videoId });
  });

  // Add to the queue.
  $('queueLinkBtn').addEventListener('click', () => {
    const info = takeLink();
    if (info) addToQueue(info.videoId);
  });

  function addToQueue(videoId, extra) {
    socket.emit('queue:add', Object.assign({ videoId }, extra || {}), (res) => {
      if (!res || !res.ok) {
        toast((res && res.error) || 'Could not add that video.');
        return;
      }
      if (res.started) {
        toast('Playing now');
        return;
      }
      toast('Added to the queue');
      // If the last video already finished, start the queue right away.
      if (playerReady && player.getPlayerState() === YT_STATE.ENDED) sendControl('next', 0);
    });
  }

  $('skipBtn').addEventListener('click', () => sendControl('next', 0));

  // ======================================================================
  // YOUTUBE PLAYER
  // ======================================================================
  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    createPlayerIfPossible();
  };

  function createPlayerIfPossible() {
    if (player || !ytApiReady || !roomId) return;
    player = new YT.Player('player', {
      width: '100%',
      height: '100%',
      playerVars: {
        playsinline: 1,
        rel: 0,
        enablejsapi: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onPlaybackRateChange: onPlaybackRateChange,
        onError: onPlayerError,
      },
    });
  }

  function onPlayerReady() {
    playerReady = true;
    applyRoomState();
  }

  /** Makes our player match the room. */
  function applyRoomState() {
    renderEmptyOverlay();
    if (!playerReady || !room) return;
    if (!room.videoId) return;

    const target = expectedPosition();

    if (room.videoId !== loadedVideoId) {
      loadedVideoId = room.videoId;
      suppress(4000);
      $('nowTitle').textContent = room.title || '';
      if (room.isPlaying) {
        player.loadVideoById({ videoId: room.videoId, startSeconds: target });
        scheduleAutoplayCheck();
      } else {
        player.cueVideoById({ videoId: room.videoId, startSeconds: target });
      }
      if (room.rate !== 1) setTimeout(() => safeSetRate(room.rate), 1500);
      return;
    }

    const state = player.getPlayerState();
    const local = player.getCurrentTime() || 0;
    suppress(1500);

    if (player.getPlaybackRate && player.getPlaybackRate() !== room.rate) safeSetRate(room.rate);

    if (room.isPlaying) {
      if (Math.abs(local - target) > 0.75) player.seekTo(target, true);
      if (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING) {
        player.playVideo();
        scheduleAutoplayCheck();
      }
    } else if (state === YT_STATE.CUED || state === YT_STATE.UNSTARTED) {
      // Seeking a cued video would start it playing, so re-cue at the new spot instead.
      if (Math.abs(local - target) > 0.75) {
        player.cueVideoById({ videoId: room.videoId, startSeconds: target });
      }
    } else {
      if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) player.pauseVideo();
      if (Math.abs(local - target) > 0.75) player.seekTo(target, true);
      hideTapToSync();
    }
  }

  function safeSetRate(rate) {
    try { player.setPlaybackRate(rate); } catch (e) { /* ignore */ }
  }

  function onPlayerStateChange(event) {
    const s = event.data;
    if (s === YT_STATE.PLAYING) {
      hideTapToSync();
      requestWakeLock();
      const data = player.getVideoData ? player.getVideoData() : null;
      if (data && data.title) {
        $('nowTitle').textContent = data.title;
        // Share the title so late joiners and the activity lines can show it.
        if (room && !room.title && data.video_id === room.videoId) {
          room.title = data.title;
          socket.emit('control', { action: 'title', videoId: room.videoId, title: data.title });
        }
      }
    } else if (s === YT_STATE.PAUSED || s === YT_STATE.ENDED) {
      releaseWakeLock();
    }
    updateSyncStatus();

    if (!room || !room.videoId || eventsSuppressed() || document.hidden) return;
    if (loadedVideoId !== room.videoId) return;

    if (s === YT_STATE.PLAYING && !room.isPlaying) {
      sendControl('play', player.getCurrentTime());
    } else if (s === YT_STATE.PAUSED && room.isPlaying) {
      sendControl('pause', player.getCurrentTime());
    } else if (s === YT_STATE.ENDED && room.isPlaying) {
      // The server plays the next queued video (or pauses if the queue is empty).
      sendControl('ended', player.getDuration(), { videoId: room.videoId });
    }
  }

  function onPlaybackRateChange(event) {
    if (!room || eventsSuppressed()) return;
    if (event.data !== room.rate) sendControl('rate', player.getCurrentTime(), { rate: event.data });
  }

  function onPlayerError(event) {
    const messages = {
      2: 'That video link seems broken.',
      5: 'This video can’t play here. Try another one.',
      100: 'That video was removed or is private.',
      101: 'The owner of this video doesn’t allow it to be played outside YouTube.',
      150: 'The owner of this video doesn’t allow it to be played outside YouTube.',
      153: 'YouTube refused to load the player here (error 153).',
    };
    const text = messages[event.data] || `YouTube error ${event.data}. Try another video.`;
    toast(text);
    addSystemLine(text);
  }

  // ---------- the sync loop ----------
  setInterval(tick, TICK_MS);

  function tick() {
    if (!playerReady || !room || !room.videoId || loadedVideoId !== room.videoId) return;
    if (document.hidden) { lastPoll = null; return; }

    const now = performance.now();
    const t = player.getCurrentTime() || 0;
    const state = player.getPlayerState();
    const stable = state === YT_STATE.PLAYING || state === YT_STATE.PAUSED;

    // 1) Did the user drag the progress bar? YouTube has no "seek" event, so we compare
    //    where the video is with where it should be since our last steady reading.
    //    While buffering, time doesn't move, so we just keep the old reading.
    if (!stable) {
      if (lastPoll) lastPoll.wall = now;
    } else {
      if (lastPoll && !jumpsSuppressed()) {
        const dt = (now - lastPoll.wall) / 1000;
        const predicted = lastPoll.state === YT_STATE.PLAYING ? lastPoll.t + dt * (room.rate || 1) : lastPoll.t;
        const jump = Math.abs(t - predicted);
        const limit = lastPoll.state === YT_STATE.PLAYING ? 1.5 : 0.6;
        if (jump > limit) {
          sendControl('seek', t);
          suppress(1200);
          return;
        }
      }
      lastPoll = { t, wall: now, state };

      // Paused videos don't drift, so being somewhere else means this person moved it
      // (for example while we were briefly ignoring jumps after someone else's change).
      if (!jumpsSuppressed() && !room.isPlaying && state === YT_STATE.PAUSED && Math.abs(t - room.position) > 1) {
        sendControl('seek', t);
        suppress(1200);
        return;
      }
    }

    // 2) Every ~2 seconds, check we're still where the room is.
    tickCount++;
    if (tickCount % 4 !== 0 || jumpsSuppressed()) return;

    const target = expectedPosition();
    const duration = player.getDuration ? player.getDuration() : 0;
    const nearEnd = duration > 0 && target > duration - 1;

    if (room.isPlaying && state === YT_STATE.PLAYING && !nearEnd) {
      if (Math.abs(t - target) > DRIFT_LIMIT) {
        suppress(1500);
        player.seekTo(target, true);
      }
    } else if (room.isPlaying && (state === YT_STATE.PAUSED || state === YT_STATE.CUED || state === YT_STATE.UNSTARTED) && !nearEnd) {
      // We should be playing but aren't (often: the browser blocked autoplay).
      suppress(1500);
      if (Math.abs(t - target) > DRIFT_LIMIT) player.seekTo(target, true);
      player.playVideo();
      scheduleAutoplayCheck();
    } else if (!room.isPlaying && state === YT_STATE.PLAYING) {
      suppress(1500);
      player.pauseVideo();
      if (Math.abs(t - room.position) > 0.75) player.seekTo(room.position, true);
    }
    updateSyncStatus();
  }

  // When the app comes back from the background, catch up straight away.
  document.addEventListener('visibilitychange', () => {
    lastPoll = null;
    if (!document.hidden && room) {
      applyRoomState();
      if (wakeLock === null && room.isPlaying) requestWakeLock();
    }
  });

  // ---------- autoplay fallback ----------
  function scheduleAutoplayCheck() {
    clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      if (!room || !room.isPlaying || !playerReady) return;
      const state = player.getPlayerState();
      if (state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING) showTapToSync();
    }, 3000);
  }
  function showTapToSync() { $('tapToSync').classList.remove('hidden'); }
  function hideTapToSync() { $('tapToSync').classList.add('hidden'); }

  $('tapToSync').addEventListener('click', () => {
    hideTapToSync();
    if (!room || !playerReady) return;
    suppress(1500);
    player.seekTo(expectedPosition(), true);
    player.playVideo();
    scheduleAutoplayCheck();
  });

  // ---------- keep the phone screen on while watching ----------
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !wakeLock && !document.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }

  // ======================================================================
  // UI RENDERING
  // ======================================================================
  let lastActivity = null;

  function renderEmptyOverlay() {
    const empty = !room || !room.videoId;
    $('emptyOverlay').classList.toggle('hidden', !empty);
  }

  function setSyncStatus(text, warn) {
    const el = $('syncStatus');
    el.textContent = '';
    const dot = document.createElement('span');
    dot.className = warn ? 'dot warn' : 'dot';
    el.appendChild(dot);
    el.appendChild(document.createTextNode(text));
  }

  function updateSyncStatus() {
    if (!roomId) return;
    if (!socket.connected) { setSyncStatus('Reconnecting…', true); return; }
    if (!room || !room.videoId) {
      const others = users.length - 1;
      setSyncStatus(others > 0 ? `Connected with ${others} ${others === 1 ? 'friend' : 'friends'}` : 'Waiting for a friend to join', others <= 0);
      return;
    }
    if (lastActivity && Date.now() - lastActivity.at < 6000) {
      setSyncStatus(lastActivity.text, false);
      return;
    }
    const state = playerReady ? player.getPlayerState() : null;
    if (state === YT_STATE.BUFFERING) { setSyncStatus('Buffering…', true); return; }
    const where = formatTime(expectedPosition());
    setSyncStatus(room.isPlaying ? `In sync · playing at ${where}` : `In sync · paused at ${where}`, false);
  }
  setInterval(updateSyncStatus, 1000);

  function shorten(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  // ---------- tabs: chat / up next ----------
  let activeTab = 'chat';
  let unreadChat = 0;

  function showTab(name) {
    activeTab = name;
    const chat = name === 'chat';
    $('tabChat').classList.toggle('active', chat);
    $('tabQueue').classList.toggle('active', !chat);
    $('tabChat').setAttribute('aria-selected', String(chat));
    $('tabQueue').setAttribute('aria-selected', String(!chat));
    $('chatPanel').classList.toggle('hidden', !chat);
    $('queuePanel').classList.toggle('hidden', chat);
    if (chat) {
      unreadChat = 0;
      $('chatBadge').classList.add('hidden');
      scrollChatToBottom();
    }
  }
  function bumpChatBadge() {
    unreadChat++;
    $('chatBadge').textContent = String(unreadChat);
    $('chatBadge').classList.remove('hidden');
  }
  $('tabChat').addEventListener('click', () => showTab('chat'));
  $('tabQueue').addEventListener('click', () => showTab('queue'));

  // ---------- queue ----------
  function thumbUrl(videoId) {
    return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  }

  function iconButton(icon, label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-btn small';
    btn.setAttribute('aria-label', label);
    btn.title = label;
    btn.innerHTML = `<svg class="ico"><use href="#i-${icon}"/></svg>`;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderQueue() {
    const list = $('queueList');
    list.innerHTML = '';
    $('queueCount').textContent = String(queue.length);
    $('queueEmpty').classList.toggle('hidden', queue.length > 0);
    $('skipBtn').classList.toggle('hidden', queue.length === 0 || !roomId);

    queue.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'q-item';

      const num = document.createElement('span');
      num.className = 'q-num';
      num.textContent = String(index + 1);

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      const img = document.createElement('img');
      img.src = thumbUrl(item.videoId);
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      thumb.appendChild(img);
      if (item.duration) {
        const len = document.createElement('span');
        len.className = 'len';
        len.textContent = formatTime(item.duration);
        thumb.appendChild(len);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const t = document.createElement('p');
      t.className = 't';
      t.textContent = item.title || 'YouTube video';
      const sub = document.createElement('p');
      sub.className = 's';
      sub.textContent = item.channel ? `${item.channel} · added by ${item.addedBy}` : `Added by ${item.addedBy}`;
      meta.appendChild(t);
      meta.appendChild(sub);

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.appendChild(iconButton('play', 'Play now', () => socket.emit('queue:play', { itemId: item.id })));
      if (index > 0) actions.appendChild(iconButton('up', 'Play next', () => socket.emit('queue:top', { itemId: item.id })));
      actions.appendChild(iconButton('x', 'Remove from queue', () => socket.emit('queue:remove', { itemId: item.id })));

      li.appendChild(num);
      li.appendChild(thumb);
      li.appendChild(meta);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  function renderPeople() {
    const list = $('peopleList');
    list.innerHTML = '';
    users.forEach((u) => {
      const li = document.createElement('li');
      li.textContent = u.id === me.id ? `${u.name} (you)` : u.name;
      if (u.id === me.id) li.classList.add('me');
      list.appendChild(li);
    });
    updateSyncStatus();
  }

  function scrollChatToBottom() {
    const list = $('chatList');
    list.scrollTop = list.scrollHeight;
  }

  function addSystemLine(text) {
    renderChat({ system: true, text, at: Date.now() });
  }

  function renderChat(msg) {
    const list = $('chatList');
    const li = document.createElement('li');
    if (msg.system) {
      li.className = 'sys';
      li.textContent = msg.text;
    } else {
      li.className = msg.from === me.id ? 'msg mine' : 'msg';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = msg.from === me.id ? 'You' : msg.name;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = clockTime(msg.at);
      who.appendChild(when);
      const text = document.createElement('div');
      text.textContent = msg.text;
      bubble.appendChild(who);
      bubble.appendChild(text);
      li.appendChild(bubble);
    }
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.appendChild(li);
    while (list.children.length > 200) list.removeChild(list.firstChild);
    if (nearBottom || msg.from === me.id) scrollChatToBottom();
  }

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;
    if (!socket.connected) { toast('Not connected – message not sent.'); return; }
    socket.emit('chat', text);
    $('chatInput').value = '';
  });

  // ---------- inviting ----------
  function inviteLink() {
    return `${window.location.origin}/?room=${roomId}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      const input = $('sheetLink');
      input.value = text;
      input.select();
      try { return document.execCommand('copy'); } catch (err) { return false; }
    }
  }

  function openInviteSheet() {
    const link = inviteLink();
    const message = `Watch YouTube with me on ZeroDoori! Room ${roomId}: ${link}`;
    $('sheetCode').textContent = roomId;
    $('sheetLink').value = link;
    $('whatsappLink').href = `https://wa.me/?text=${encodeURIComponent(message)}`;
    $('inviteSheet').classList.remove('hidden');
  }

  $('inviteBtn').addEventListener('click', async () => {
    const link = inviteLink();
    if (navigator.share) {
      try {
        await navigator.share({ title: 'ZeroDoori', text: `Watch YouTube with me on ZeroDoori! Room ${roomId}`, url: link });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    openInviteSheet();
  });

  $('codeChip').addEventListener('click', async () => {
    if (await copyText(inviteLink())) toast('Invite link copied');
    else openInviteSheet();
  });

  $('copyLinkBtn').addEventListener('click', async () => {
    if (await copyText($('sheetLink').value)) toast('Invite link copied');
    else toast('Press and hold the link to copy it');
  });
  $('closeSheetBtn').addEventListener('click', () => $('inviteSheet').classList.add('hidden'));
  $('inviteSheet').addEventListener('click', (e) => {
    if (e.target === $('inviteSheet')) $('inviteSheet').classList.add('hidden');
  });

  // Expose a tiny bit of state for automated tests.
  window.__zd = {
    get room() { return room; },
    get queue() { return queue; },
    get me() { return me; },
    get clockOffset() { return clockOffset; },
    expectedPosition,
    getVideoId,
    getVideoInfo,
  };
})();
