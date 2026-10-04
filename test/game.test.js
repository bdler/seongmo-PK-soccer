'use strict';
// Index.html 을 실제 브라우저(Chromium, Playwright)로 열어 보는 테스트.
// 실행: npm install && npx playwright install chromium && npm test
// Playwright 가 없으면 이 테스트는 건너뜁니다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT } = require('./extract');

let chromium = null;
for (const p of ['playwright', process.env.PLAYWRIGHT_MODULE].filter(Boolean)) {
  try { chromium = require(p).chromium; break; } catch (e) { /* 다음 */ }
}
const URL = 'file://' + path.join(ROOT, 'Index.html');
const skip = chromium ? false : 'playwright 가 설치되어 있지 않아요 (npm install)';

async function open(viewport, touch) {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport, hasTouch: !!touch, isMobile: !!touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort()); // 인터넷 없이도
  await page.goto(URL);
  await page.waitForFunction(() => window.__pk && window.__pk.state.mode === 'menu');
  return { browser, page, errors };
}
// 아이 대신 공을 차고 막는 자동 플레이 (브라우저 안에서 시간을 직접 돌림)
async function autoplay(page) {
  return page.evaluate(() => {
    const P = window.__pk; let guard = 0;
    P.freeze(true);
    while (P.G.mode === 'match' && guard++ < 40000) {
      if (P.G.phase === 'aim') { P.aim((Math.random() < 0.5 ? -1 : 1) * (1.4 + Math.random() * 1.8), 0.4 + Math.random() * 1.5); P.shoot(0.55 + Math.random() * 0.3); }
      if (P.G.phase === 'flight' && P.G.turn.humanKeep && P.keeper.mode === 'ready' && P.G.phaseT > 0.25) P.dive(P.G.shot.tx, P.G.shot.ty);
      P.sim(1 / 30);
    }
    P.freeze(false);
    return P.state;
  });
}

test('처음 화면 → 설정 → 승부차기 한 판 → 결과 → 기록 저장 → 랭킹', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1280, height: 800 });
  try {
    assert.ok(await page.isVisible('#scr-title'));
    await page.click('[data-go="setup"]');
    // 고운 말이 아니면 시작하지 않음
    await page.fill('#nick', '바보 씨발');
    await page.click('#btnGo');
    assert.equal(await page.evaluate(() => window.__pk.state.mode), 'menu');
    assert.match(await page.textContent('#nickWarn'), /고운 말/);
    await page.fill('#nick', '슛돌이');
    await page.click('#segDiff button[data-v="보통"]');
    await page.click('#btnGo');
    assert.equal(await page.evaluate(() => window.__pk.state.mode), 'match');
    const st = await autoplay(page);
    assert.equal(st.mode, 'result');
    assert.ok(st.winner === 0 || st.winner === 1 || st.winner === -1);
    assert.ok(st.kicks[0] >= 3 && st.kicks[1] >= 3, JSON.stringify(st));
    assert.equal(st.stats.kicks, st.kicks[0]);
    assert.equal(st.stats.faced, st.kicks[1]);
    await page.waitForSelector('#scr-result:not(.hidden)');
    await page.click('#btnSave');
    await page.waitForFunction(() => /저장했어요/.test(document.getElementById('saveMsg').textContent));
    await page.click('#btnResRank');
    await page.waitForSelector('table.rank');
    assert.match(await page.textContent('table.rank'), /슛돌이/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('세 가지 난이도 모두 끝까지 진행됩니다', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    for (const diff of ['쉬움', '보통', '어려움']) {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(d => window.__pk.start({ my: 2, opp: 5, diff: d, nick: '테스트' }), diff);
        const st = await autoplay(page);
        assert.equal(st.mode, 'result', diff);
      }
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('터치: 골대를 누르면 그곳을 조준하고, 막을 때는 누른 쪽으로 몸을 날립니다', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 390, height: 844 }, true);
  try {
    await page.evaluate(() => { window.__pk.start({ my: 0, opp: 1, diff: '쉬움', nick: '터치' }); window.__pk.freeze(true); window.__pk.G.first = 0; });
    // 내가 먼저 차도록 순서를 고정한 뒤 조준 단계까지
    await page.evaluate(() => { const P = window.__pk; while (P.G.phase !== 'aim') P.sim(0.05); });
    const pt = await page.evaluate(() => window.__pk.screenOf(2.5, 1.5, 11));
    await page.touchscreen.tap(pt.x, pt.y);
    const aim = await page.evaluate(() => window.__pk.G.aim);
    assert.ok(Math.abs(aim.x - 2.5) < 0.15 && Math.abs(aim.y - 1.5) < 0.15, JSON.stringify(aim));
    assert.ok(await page.isVisible('#btnShoot'));
    await page.tap('#btnShoot');
    // 상대 차례까지 진행 → 상대가 찬 뒤 왼쪽 아래를 눌러 막기
    await page.evaluate(() => { const P = window.__pk; while (!(P.G.phase === 'flight' && P.G.turn.humanKeep)) P.sim(0.02); });
    const kp = await page.evaluate(() => window.__pk.screenOf(-2.5, 0.5, 10.75));
    await page.touchscreen.tap(kp.x, kp.y);
    const k = await page.evaluate(() => ({ mode: window.__pk.keeper.mode, side: window.__pk.keeper.side }));
    assert.equal(k.mode, 'dive'); assert.equal(k.side, -1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('키보드: 방향키 조준 · 스페이스 슛 · Esc 일시정지', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1280, height: 720 });
  try {
    await page.evaluate(() => { window.__pk.start({ my: 0, opp: 1, diff: '보통', nick: '키보드' }); window.__pk.G.first = 0; });
    await page.waitForFunction(() => window.__pk.state.phase === 'aim', null, { timeout: 8000 });
    await page.keyboard.down('ArrowRight'); await page.waitForTimeout(400); await page.keyboard.up('ArrowRight');
    assert.ok(await page.evaluate(() => window.__pk.G.aim.x) > 0.5);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__pk.state.paused), true);
    assert.ok(await page.isVisible('#scr-pause'));
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.__pk.state.paused), false);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.__pk.state.phase), 'runup');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
