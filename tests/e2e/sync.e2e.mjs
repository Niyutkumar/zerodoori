// End-to-end sync test: several browser "people" in one room, using a fake YouTube player
// (tests/e2e/fake-yt.js) so it runs offline and gives exact, repeatable timings.
//
//   npm install            (installs Playwright)
//   npx playwright install chromium
//   npm run test:e2e
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SHOTS = path.join(tmpdir(), 'zerodoori-screenshots');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const fakeYT = readFileSync(new URL('./fake-yt.js', import.meta.url), 'utf8');
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const server = spawn('node', ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), ZD_OFFLINE: '1' },
  stdio: 'inherit',
});
await sleep(800);

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
);

async function person(viewport = { width: 1200, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fakeYT })
  );
  const page = await ctx.newPage();
  page.controls = 0;
  page.on('websocket', (ws) => {
    ws.on('framesent', (f) => {
      if (typeof f.payload === 'string' && f.payload.includes('"control"')) page.controls++;
    });
  });
  page.on('pageerror', (err) => check(`no page errors`, false, err.message));
  return page;
}

const t = (page) => page.evaluate(() => window.__fakePlayer && window.__fakePlayer.getCurrentTime());
const st = (page) => page.evaluate(() => window.__fakePlayer && window.__fakePlayer.getPlayerState());
const PLAYING = 1, PAUSED = 2;

try {
  // --- A creates a room ---
  const A = await person();
  await A.goto(BASE);

  // --- Light / dark mode ---
  const theme0 = await A.getAttribute('html', 'data-theme');
  await A.click('#homeView .theme-toggle');
  const theme1 = await A.getAttribute('html', 'data-theme');
  check('theme toggle switches light/dark', theme0 !== theme1 && ['light', 'dark'].includes(theme1), `${theme0} -> ${theme1}`);
  await A.reload();
  check('chosen theme is remembered', (await A.getAttribute('html', 'data-theme')) === theme1);
  await A.click('#homeView .theme-toggle'); // back to the original

  await A.fill('#nameInput', 'Niyut');
  await A.click('#createBtn');
  await A.waitForSelector('#roomView:not(.hidden)');
  const code = (await A.textContent('#codeChip')).trim();
  check('room created with a 6 character code', /^[A-Z0-9]{6}$/.test(code), code);
  check('URL contains the room code', A.url().includes(`room=${code}`));

  // --- B opens the invite link on a phone-sized screen ---
  const B = await person({ width: 390, height: 844 });
  await B.goto(`${BASE}/?room=${code}`);
  check('invite box shows the code', (await B.textContent('#inviteCode')).trim() === code);
  await B.fill('#nameInput', 'Friend');
  await B.click('#joinInviteBtn');
  await B.waitForSelector('#roomView:not(.hidden)');
  await sleep(800);
  const peopleA = await A.$$eval('#peopleList li', (els) => els.map((e) => e.textContent));
  check('both people listed', peopleA.length === 2 && peopleA.some((p) => p.includes('Friend')), peopleA.join(', '));

  // --- A loads a video ---
  await A.fill('#linkInput', 'https://www.youtube.com/watch?v=M7lc1UVf-VE&t=10s');
  await A.click('#goBtn');
  await sleep(2500);
  const [sa, sb, ta, tb] = [await st(A), await st(B), await t(A), await t(B)];
  check('both are playing after a link is pasted', sa === PLAYING && sb === PLAYING, `A=${sa} B=${sb}`);
  check('both are at the same spot', Math.abs(ta - tb) < 0.6, `A=${ta.toFixed(2)} B=${tb.toFixed(2)}`);
  check('empty overlay hidden', await B.isHidden('#emptyOverlay'));
  check('title shown', (await B.textContent('#nowTitle')).includes('Test video'));

  // --- B pauses ---
  await B.evaluate(() => window.__fakePlayer.userPause());
  await sleep(1200);
  check('pause on B pauses A', (await st(A)) === PAUSED, `A state=${await st(A)}`);
  const pa = await t(A), pb = await t(B);
  check('paused at the same moment', Math.abs(pa - pb) < 0.4, `A=${pa.toFixed(2)} B=${pb.toFixed(2)}`);

  // --- A seeks while paused ---
  await A.evaluate(() => window.__fakePlayer.userSeek(120));
  await sleep(1500);
  check('seek while paused reaches B', Math.abs((await t(B)) - 120) < 0.3 && (await st(B)) === PAUSED, `B=${(await t(B)).toFixed(2)} state=${await st(B)}`);

  // --- B presses play ---
  await B.evaluate(() => window.__fakePlayer.userPlay());
  await sleep(3000);
  const ta2 = await t(A), tb2 = await t(B);
  check('play on B plays A', (await st(A)) === PLAYING, `A state=${await st(A)}`);
  check('playing together after play', Math.abs(ta2 - tb2) < 0.6 && ta2 > 121, `A=${ta2.toFixed(2)} B=${tb2.toFixed(2)}`);

  // --- A jumps ahead while playing ---
  await A.evaluate(() => window.__fakePlayer.userSeek(300));
  await sleep(2500);
  const tb3 = await t(B);
  check('seek while playing reaches B', tb3 > 300 && tb3 < 304, `B=${tb3.toFixed(2)}`);

  // --- C joins late ---
  const C = await person();
  await C.goto(`${BASE}/?room=${code}`);
  await C.fill('#nameInput', 'Late friend');
  await C.click('#joinInviteBtn');
  await sleep(3000);
  const ta4 = await t(A), tc4 = await t(C);
  check('late joiner starts at the right spot', Math.abs(ta4 - tc4) < 0.8 && (await st(C)) === PLAYING, `A=${ta4.toFixed(2)} C=${tc4.toFixed(2)}`);

  // --- No echo loops: 6 quiet seconds should send zero control messages ---
  const before = A.controls + B.controls + C.controls;
  await sleep(6000);
  const after = A.controls + B.controls + C.controls;
  check('no feedback loop while just watching', after === before, `${after - before} extra messages`);

  // --- Drift correction: C's device runs 8% fast for a while ---
  await C.evaluate(() => { window.__fakeSpeed = 1.08; });
  await sleep(9000);
  const ta5 = await t(A), tc5 = await t(C);
  check('drift is corrected', Math.abs(ta5 - tc5) < 1.3, `A=${ta5.toFixed(2)} C=${tc5.toFixed(2)}`);
  const quietBefore = A.controls + B.controls;
  check('drift fixing does not disturb others', A.controls + B.controls === quietBefore);
  await C.evaluate(() => { window.__fakeSpeed = 1; });

  // --- Speed change ---
  await A.evaluate(() => window.__fakePlayer.userRate(1.5));
  await sleep(1500);
  check('speed change reaches others', (await B.evaluate(() => window.__fakePlayer.getPlaybackRate())) === 1.5);
  await A.evaluate(() => window.__fakePlayer.userRate(1));
  await sleep(1000);

  // --- Chat ---
  await B.fill('#chatInput', 'Namaste from far away!');
  await B.press('#chatInput', 'Enter');
  await sleep(600);
  const chatA = await A.$$eval('#chatList li', (els) => els.map((e) => e.textContent));
  check('chat message arrives', chatA.some((m) => m.includes('Namaste from far away!')));
  check('activity lines in chat', chatA.some((m) => m.includes('paused at')) && chatA.some((m) => m.includes('pressed play')));
  const xss = '<img src=x onerror="window.__pwned=1">';
  await A.fill('#chatInput', xss);
  await A.press('#chatInput', 'Enter');
  await sleep(500);
  check('chat is safe from HTML injection', !(await B.evaluate(() => window.__pwned)));

  // --- Queue: add, skip, auto-play next ---
  await A.fill('#linkInput', 'https://youtu.be/aaaaaaaaaaa');
  await A.click('#queueLinkBtn');
  await sleep(800);
  const qB = await B.evaluate(() => window.__zd.queue.map((i) => i.videoId));
  check('queued video shows for everyone', qB.length === 1 && qB[0] === 'aaaaaaaaaaa', qB.join(','));
  check('Next button appears when something is queued', await B.isVisible('#skipBtn'));
  await B.click('#tabQueue');
  check('queue tab lists the video', (await B.$$eval('#queueList li', (els) => els.length)) === 1);
  await B.click('#skipBtn');
  await sleep(1500);
  const [vA, vB] = await Promise.all([A, B].map((p) => p.evaluate(() => window.__fakePlayer.videoId)));
  check('Next plays the queued video for everyone', vA === 'aaaaaaaaaaa' && vB === 'aaaaaaaaaaa', `A=${vA} B=${vB}`);
  check('queue is empty after skipping', (await A.evaluate(() => window.__zd.queue.length)) === 0);

  for (const p of [A, B, C]) await p.evaluate(() => { window.__fakeDuration = 5; });
  await A.fill('#linkInput', 'https://www.youtube.com/watch?v=bbbbbbbbbbb');
  await A.click('#queueLinkBtn');
  await sleep(600);
  await B.fill('#linkInput', 'ccccccccccc');
  await B.click('#queueLinkBtn');
  await sleep(600);
  await A.click('#skipBtn'); // starts bbbbbbbbbbb, which is only 5 seconds long
  await sleep(8000);
  const [wA, wB, wC] = await Promise.all([A, B, C].map((p) => p.evaluate(() => window.__fakePlayer.videoId)));
  check('when a video ends, the next one plays for everyone', [wA, wB, wC].every((v) => v === 'ccccccccccc'), `A=${wA} B=${wB} C=${wC}`);
  for (const p of [A, B, C]) await p.evaluate(() => { window.__fakeDuration = 600; });
  const chatAfterQueue = await A.$$eval('#chatList li', (els) => els.map((e) => e.textContent));
  check('queue activity appears in chat', chatAfterQueue.some((m) => m.includes('added') && m.includes('queue')) && chatAfterQueue.some((m) => m.startsWith('Up next')));
  await B.click('#tabChat');
  await A.fill('#linkInput', 'https://www.youtube.com/watch?v=M7lc1UVf-VE');
  await A.click('#goBtn');
  await sleep(2000);

  // --- Autoplay blocked: D's browser refuses to start until tapped ---
  const D = await person({ width: 390, height: 844 });
  await D.addInitScript(() => { window.__blockAutoplay = true; });
  await D.goto(`${BASE}/?room=${code}`);
  await D.fill('#nameInput', 'Blocked');
  await D.click('#joinInviteBtn');
  await sleep(6000);
  check('tap-to-sync button appears when autoplay is blocked', await D.isVisible('#tapToSync'));
  // The tap is the "user gesture" that lets the browser start the video.
  await D.evaluate(() => { window.__blockAutoplay = false; document.getElementById('tapToSync').click(); });
  await sleep(1500);
  const ta6 = await t(A), td6 = await t(D);
  check('after tapping, the blocked viewer catches up', (await st(D)) === PLAYING && Math.abs(ta6 - td6) < 0.8, `A=${ta6.toFixed(2)} D=${td6.toFixed(2)}`);

  // --- Leave ---
  await D.click('#leaveBtn');
  await sleep(600);
  const peopleAfter = await A.$$eval('#peopleList li', (els) => els.length);
  check('leaving updates the people list', peopleAfter === 3, `${peopleAfter} people`);

  // --- Bad link ---
  await A.fill('#linkInput', 'hello world');
  await A.click('#goBtn');
  await sleep(300);
  check('bad link shows a message', (await A.textContent('#toast')).includes("doesn't look like"));

  // --- Screenshots for a visual check ---
  const { mkdirSync } = await import('node:fs');
  mkdirSync(SHOTS, { recursive: true });
  const H = await person({ width: 390, height: 844 });
  await H.goto(BASE);
  await H.screenshot({ path: path.join(SHOTS, 'home-phone.png') });
  await A.fill('#linkInput', 'https://youtu.be/ddddddddddd');
  await A.click('#queueLinkBtn');
  await A.fill('#linkInput', 'https://youtu.be/eeeeeeeeeee');
  await A.click('#queueLinkBtn');
  await sleep(800);
  await B.screenshot({ path: path.join(SHOTS, 'room-phone.png'), fullPage: true });
  await A.click('#tabQueue');
  await A.screenshot({ path: path.join(SHOTS, 'room-desktop.png') });
  await A.click('#roomView .theme-toggle');
  await sleep(300);
  await A.screenshot({ path: path.join(SHOTS, 'room-desktop-other-theme.png') });
  await A.click('#tabChat');
  await B.click('#roomView .theme-toggle');
  await sleep(300);
  await B.screenshot({ path: path.join(SHOTS, 'room-phone-other-theme.png'), fullPage: true });
} catch (err) {
  check('test run finished without crashing', false, err.stack);
} finally {
  await browser.close();
  server.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
