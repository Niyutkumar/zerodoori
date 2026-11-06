// A pretend YouTube IFrame API used only for automated tests (the real one can't load here).
// It behaves like the real player closely enough to test the sync logic:
// states, events, time that advances while playing, seek rules, playback rate.
(function () {
  const S = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
  window.__fakeSpeed = 1; // >1 makes this "device" run fast, to test drift correction
  window.__fakeDuration = 600; // length of every video loaded from now on

  function Player(elId, opts) {
    this.opts = opts;
    this.state = S.UNSTARTED;
    this.base = 0; // time at baseWall
    this.baseWall = performance.now();
    this.rate = 1;
    this.videoId = null;
    this.duration = window.__fakeDuration;
    this.events = (opts && opts.events) || {};
    // Like YouTube: when playback reaches the end, the state becomes ENDED.
    setInterval(() => {
      if (this.state === S.PLAYING && this._now() >= this.duration) this._set(S.ENDED);
    }, 100);
    const el = document.getElementById(elId);
    const iframe = document.createElement('div');
    iframe.id = elId;
    iframe.className = 'fake-iframe';
    el.replaceWith(iframe);
    window.__fakePlayer = this;
    setTimeout(() => this.events.onReady && this.events.onReady({ target: this }), 50);
  }

  Player.prototype._now = function () {
    if (this.state !== S.PLAYING) return this.base;
    const t = this.base + ((performance.now() - this.baseWall) / 1000) * this.rate * window.__fakeSpeed;
    return Math.min(t, this.duration);
  };
  Player.prototype._set = function (state) {
    this.base = this._now();
    this.baseWall = performance.now();
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange && this.events.onStateChange({ target: this, data: state });
  };
  Player.prototype._playSoon = function () {
    this._set(S.BUFFERING);
    setTimeout(() => {
      if (this.state === S.BUFFERING) this._set(S.PLAYING);
    }, 150);
  };

  Player.prototype.loadVideoById = function (arg) {
    this.videoId = arg.videoId;
    this.duration = window.__fakeDuration;
    this.base = arg.startSeconds || 0;
    this.baseWall = performance.now();
    this.state = S.UNSTARTED;
    this.events.onStateChange && this.events.onStateChange({ target: this, data: S.UNSTARTED });
    if (window.__blockAutoplay) return; // like a browser refusing to start sound without a tap
    this._playSoon();
  };
  Player.prototype.cueVideoById = function (arg) {
    this.videoId = arg.videoId;
    this.duration = window.__fakeDuration;
    this.base = arg.startSeconds || 0;
    this.baseWall = performance.now();
    this._set(S.CUED);
  };
  Player.prototype.playVideo = function () {
    if (window.__blockAutoplay) return;
    if (this.state !== S.PLAYING) this._playSoon();
  };
  Player.prototype.pauseVideo = function () {
    if (this.state === S.PLAYING || this.state === S.BUFFERING) this._set(S.PAUSED);
  };
  Player.prototype.stopVideo = function () { this._set(S.UNSTARTED); };
  Player.prototype.seekTo = function (t) {
    const wasPlaying = this.state === S.PLAYING || this.state === S.BUFFERING;
    const startsPlaying = this.state === S.CUED || this.state === S.UNSTARTED;
    this.base = Math.max(0, Math.min(t, this.duration));
    this.baseWall = performance.now();
    if (wasPlaying || startsPlaying) this._playSoon();
  };
  Player.prototype.getCurrentTime = function () { return this._now(); };
  Player.prototype.getPlayerState = function () { return this.state; };
  Player.prototype.getDuration = function () { return this.duration; };
  Player.prototype.getPlaybackRate = function () { return this.rate; };
  Player.prototype.setPlaybackRate = function (r) {
    this.base = this._now();
    this.baseWall = performance.now();
    if (this.rate === r) return;
    this.rate = r;
    this.events.onPlaybackRateChange && this.events.onPlaybackRateChange({ target: this, data: r });
  };
  Player.prototype.getVideoData = function () { return { video_id: this.videoId, title: 'Test video ' + this.videoId }; };

  // "User" actions: what happens when someone clicks inside the YouTube player itself.
  Player.prototype.userPlay = function () { this._playSoon(); };
  Player.prototype.userPause = function () { this._set(S.PAUSED); };
  Player.prototype.userSeek = function (t) { this.seekTo(t); };
  Player.prototype.userRate = function (r) { this.setPlaybackRate(r); };

  window.YT = { Player, PlayerState: S };
  setTimeout(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady(), 0);
})();
