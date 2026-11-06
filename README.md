# ZeroDoori

**Watch YouTube together, at zero distance.**
ZeroDoori keeps a YouTube video in sync between you and friends anywhere: when one person plays, pauses, skips or changes the video, it happens for everyone. There's a chat too.

- **Website:** https://zerodoori.onrender.com
- **Android app:** https://github.com/Niyutkumar/zerodoori/releases/latest/download/ZeroDoori.apk

Everything runs on free plans (Render + GitHub). No ads, no accounts, no cost.

---

## How to use it

1. Open the website or the Android app and type your name.
2. Tap **Create a room**, then **Invite** to send your friend the link (WhatsApp, copy link, etc.).
3. Your friend opens the link (website or app), types their name and taps **Join room**.
4. Paste any YouTube link and tap **Play**. It starts for both of you.
5. Use the normal YouTube controls: play, pause, drag the progress bar, change speed. Your friend follows along.

The room code (like `7KQ2MX`) works too: your friend can type it under "or join a friend".

**Good to know**
- **First open after a quiet period takes up to a minute.** The free server goes to sleep after 15 minutes with nobody connected, and wakes up when someone opens the site. While anyone has ZeroDoori open, it stays awake.
- **Some videos can't be played outside YouTube.** The uploader can turn this off, and ZeroDoori shows a message when that happens. Try another video.
- **If a phone blocks autoplay**, an orange **Tap to start playing in sync** button appears. One tap and you're in sync.
- iPhone users can simply use the website in Safari (Share → Add to Home Screen gives it an app icon).

## Installing the Android app

1. On the Android phone, open the link above. It downloads `ZeroDoori.apk`.
2. Open the downloaded file. If Android asks, allow installing apps from this source (Chrome / Files).
3. Open **ZeroDoori** from your home screen.

It isn't on the Play Store, because publishing there costs a one-time $25. Sharing the APK link is free.
The app opens the ZeroDoori website inside a phone app, so **website updates reach the app automatically**: you only reinstall when the app itself changes.
If installing a newer APK fails with "App not installed", uninstall the old ZeroDoori first.

---

## How it works

```
 Your phone / browser                         Friend's phone / browser
 ┌───────────────────┐                        ┌───────────────────┐
 │ YouTube player    │◀── video from YouTube ─▶│ YouTube player    │
 │ ZeroDoori page    │                        │ ZeroDoori page    │
 └─────────┬─────────┘                        └─────────┬─────────┘
           │  tiny messages: play / pause / seek / chat │
           └──────────────▶  ZeroDoori server  ◀────────┘
                            (Node + Socket.IO on Render)
```

- The **video never goes through ZeroDoori**. Each person streams it from YouTube with the official IFrame Player API.
- The **server** (`server.js`) keeps one shared state per room: `videoId`, playing or paused, `position` at time `updatedAt`, and playback `rate`. When someone acts, the server updates the state and broadcasts it to the room.
- The **page** (`public/app.js`):
  - measures the difference between its clock and the server's clock, so "position at time X" means the same on every device;
  - follows every change from the room and ignores the player events it caused itself, so a change never bounces back and forth;
  - detects when *you* drag the progress bar (YouTube has no seek event, so it watches for jumps in time);
  - every 2 seconds, checks the video is within 1 second of where the room is, and quietly re-syncs if it drifted (slow phone, buffering);
  - catches up immediately when a phone comes back from the background, and rejoins automatically after a lost connection.
- If the free server restarts, the first person to reconnect brings back the video and position, so the room carries on.

## Project layout

| Path | What it is |
|---|---|
| `server.js` | Express + Socket.IO server: rooms, sync state, chat, clock sync |
| `public/` | The website: `index.html`, `style.css`, `app.js`, icons, web-app manifest |
| `mobile/` | Android app (Capacitor). `capacitor.config.json` points it at the website |
| `mobile/android/.../MainActivity.java` | Adds proper full-screen video, Back to exit full screen, keeps the screen on |
| `render.yaml` | Render Blueprint: one free web service |
| `.github/workflows/android.yml` | Builds the APK on GitHub for free and publishes it as a Release |
| `tests/server.test.js` | Server tests (two fake viewers over real sockets) |
| `tests/e2e/` | Browser tests: several people in one room with a fake YouTube player |

## Running it on your Mac

You need Node.js 20 or newer (`node -v`).

```bash
npm install
npm start            # http://localhost:3000
npm test             # server tests
npx playwright install chromium && npm run test:e2e   # full sync tests in real browsers
```

Open http://localhost:3000 in two browser windows to try a room with yourself.

## Updating

- **Website / server:** push to `main`. Render redeploys automatically in about a minute.
- **Android app:** change anything in `mobile/` and push. GitHub Actions builds a new APK, and the download link above always gives the newest one. You can also start a build by hand: GitHub → Actions → *Build Android app* → *Run workflow*.
