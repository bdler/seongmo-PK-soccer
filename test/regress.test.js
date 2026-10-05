'use strict';
// 코드 검토에서 찾은 문제들이 다시 생기지 않는지 확인하는 테스트 (브라우저 필요)
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ROOT } = require('./extract');

let chromium = null;
for (const p of ['playwright', process.env.PLAYWRIGHT_MODULE].filter(Boolean)) {
  try { chromium = require(p).chromium; break; } catch (e) { /* 다음 */ }
}
const URL = process.env.PK_URL || 'file://' + path.join(ROOT, 'Index.html');
const skip = chromium ? false : 'playwright 가 설치되어 있지 않아요 (npm install)';

async function open(viewport, touch) {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport, hasTouch: !!touch, isMobile: !!touch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.goto(URL);
  await page.waitForFunction(() => window.__pk && window.__pk.state.mode === 'menu');
  return { browser, page, errors };
}
// 내가 먼저 차는 경기를 시작해서 조준 단계까지
async function startKidFirst(page, diff) {
  await page.evaluate(d => {
    const P = window.__pk;
    P.start({ my: 0, opp: 1, diff: d || '보통', nick: '테스트' }); P.freeze(true); P.G.first = 0;
    P.G.turn = null; P.sim(0.01);
  }, diff);
  await page.evaluate(() => { const P = window.__pk; let g = 0; while (P.G.phase !== 'aim' && g++ < 2000) P.sim(0.05); });
}

test('결과 건너뛰기: 남은 "골!!!" 글자가 다음 배너를 가리지 않아요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    await startKidFirst(page, '쉬움');
    const r = await page.evaluate(() => {
      const P = window.__pk;
      P.aim(0, 1.0); P.setGauge(0.7); P.shoot();
      let g = 0; while (P.G.phase !== 'outcome' && g++ < 4000) P.sim(0.01);
      P.sim(1.1);                                  // 1초 넘게 본 뒤
      const popBefore = P.G.pop.t;
      P.G.phaseT = 99;                             // 건너뛰기(탭/스페이스)와 같은 효과
      P.sim(0.05);                                 // 다음 차례 배너가 뜸
      P.sim(0.2);
      return { popBefore, popAfter: P.G.pop.t, bannerT: P.G.banner.t };
    });
    assert.ok(r.popBefore > 0.5, JSON.stringify(r));
    assert.ok(r.bannerT > 0.5 && r.popAfter <= 0, JSON.stringify(r));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('오프라인 저장: 기록이 300개여도 방금 기록은 사라지지 않아요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    await page.evaluate(() => {
      const arr = [];
      for (let i = 0; i < 300; i++) arr.push({ date: '2020-01-01 10:00', nickname: '옛날' + i, myTeam: '성모 FC', oppTeam: '한강 유나이티드', goalsFor: 5, goalsAgainst: 0, kicks: 5, saves: 5, result: '승', difficulty: '어려움', score: 900 + i });
      localStorage.setItem('seongmoPK.records.v1', JSON.stringify(arr));
    });
    await page.fill('#nick', '새친구').catch(() => {});
    await page.click('[data-go="setup"]');
    await page.fill('#nick', '새친구');
    await page.click('#btnGo');
    await page.evaluate(() => {
      const P = window.__pk; P.freeze(true); let g = 0;
      while (P.G.mode === 'match' && g++ < 40000) {
        if (P.G.phase === 'aim') { P.aim(2.5, 1.0); P.shoot(0.1); }       // 일부러 약하게
        if (P.G.phase === 'flight' && P.G.turn.humanKeep && P.keeper.mode === 'ready' && P.G.phaseT > 0.25) P.dive(-3.5, 0.2); // 일부러 엉뚱한 곳
        P.sim(1 / 30);
      }
      P.freeze(false);
    });
    await page.waitForSelector('#scr-result:not(.hidden)');
    await page.click('#btnSave');
    await page.waitForFunction(() => /저장했어요/.test(document.getElementById('saveMsg').textContent));
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('seongmoPK.records.v1')).filter(r => r.nickname === '새친구').length);
    assert.equal(saved, 1, '방금 저장한 기록이 남아 있어야 해요');
    await page.click('#btnResRank');
    await page.click('#rankTabs button[data-p="today"]');
    await page.waitForSelector('table.rank');
    assert.match(await page.textContent('table.rank'), /새친구/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('저장 메시지의 순위가 랭킹 표와 같아요 (같은 닉네임의 더 높은 기록이 있을 때)', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    const today = await page.evaluate(() => { const d = new Date(), p = n => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' 09:00'; });
    await page.evaluate(date => {
      const mk = (n, s) => ({ date, nickname: n, myTeam: '성모 FC', oppTeam: '한강 유나이티드', goalsFor: 5, goalsAgainst: 0, kicks: 5, saves: 5, result: '승', difficulty: '어려움', score: s });
      localStorage.setItem('seongmoPK.records.v1', JSON.stringify([mk('철수', 99999), mk('영희', 600), mk('민수', 500)]));
    }, today);
    await page.click('[data-go="setup"]');
    await page.fill('#nick', '철수');
    await page.click('#btnGo');
    await page.evaluate(() => {
      const P = window.__pk; P.freeze(true); let g = 0;
      while (P.G.mode === 'match' && g++ < 40000) {
        if (P.G.phase === 'aim') { P.aim(2.5, 1.0); P.shoot(0.1); }
        if (P.G.phase === 'flight' && P.G.turn.humanKeep && P.keeper.mode === 'ready' && P.G.phaseT > 0.25) P.dive(-3.5, 0.2);
        P.sim(1 / 30);
      }
      P.freeze(false);
    });
    await page.waitForSelector('#scr-result:not(.hidden)');
    await page.click('#btnSave');
    await page.waitForFunction(() => /저장했어요/.test(document.getElementById('saveMsg').textContent));
    const msg = await page.textContent('#saveMsg');
    assert.match(msg, /오늘 1등/);     // 철수의 최고 기록(99999점)이 1등이므로 표와 같아야 해요
    assert.match(msg, /전체 1등/);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('"계속하기"를 두 번 눌러도 조준이 바뀌지 않아요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 390, height: 844 }, true);
  try {
    await startKidFirst(page, '쉬움');
    await page.evaluate(() => { const P = window.__pk; P.freeze(false); P.aim(2.5, 0.5); });
    await page.evaluate(() => { document.getElementById('btnPause').click(); });
    assert.equal(await page.evaluate(() => window.__pk.state.paused), true);
    const r = await page.locator('#btnResume').boundingBox();
    await page.touchscreen.tap(r.x + r.width / 2, r.y + r.height / 2);
    // 두 번째 탭은 이미 사라진 버튼 아래의 화면(캔버스)에 닿습니다
    await page.evaluate(([x, y]) => { const e = new PointerEvent('pointerdown', { clientX: x, clientY: y, pointerType: 'touch', pointerId: 7, bubbles: true }); document.getElementById('cv').dispatchEvent(e); }, [r.x + r.width / 2, r.y + r.height / 2]);
    const aim = await page.evaluate(() => window.__pk.G.aim);
    assert.ok(Math.abs(aim.x - 2.5) < 0.05 && Math.abs(aim.y - 0.5) < 0.05, JSON.stringify(aim));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('새 경기 소개 화면부터 두 팀 유니폼을 입어요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    const r = await page.evaluate(() => {
      const P = window.__pk;
      P.start({ my: 0, opp: 1, diff: '보통', nick: '테스트' }); P.freeze(true); P.sim(0.3);
      const t = P.G.teams[P.G.first], o = P.G.teams[1 - P.G.first];
      return { kicker: P.kicker.kit === t.kit, keeper: P.keeper.kit === o.kit, phase: P.G.phase, mood: P.kicker.mode };
    });
    assert.equal(r.phase, 'intro');
    assert.ok(r.kicker && r.keeper, JSON.stringify(r));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('골키퍼: 몸을 날린 뒤 공이 도착할 때까지 쭉 뻗은 자세를 유지해요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    await page.evaluate(() => { const P = window.__pk; P.start({ my: 0, opp: 1, diff: '쉬움', nick: '테스트' }); P.freeze(true); P.G.first = 1; P.G.turn = null; P.sim(0.01); });
    await page.evaluate(() => { const P = window.__pk; let g = 0; while (P.G.phase !== 'cpuRun' && g++ < 2000) P.sim(0.05); });
    const r = await page.evaluate(() => {
      const P = window.__pk; let g = 0;
      while (P.G.phase !== 'flight' && g++ < 4000) P.sim(0.01);
      P.dive(3.0, 1.0);                         // 공이 날아오자마자 몸을 날림 (쉬움의 느린 공)
      P.sim(0.5);                               // 다이빙(≈0.3초)은 이미 끝난 시간
      return { mode: P.keeper.mode, passed: P.ball.passedK, tf: P.G.shot.tf };
    });
    assert.ok(r.tf > 0.9, JSON.stringify(r));
    assert.equal(r.mode, 'dive', '공이 오기 전에 바닥에 떨어지면 안 돼요: ' + JSON.stringify(r));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('높이 뜬 공은 광고판에 튕기지 않고 사라져요 (골대 앞으로 되돌아오지 않음)', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    await startKidFirst(page, '쉬움');
    const r = await page.evaluate(() => {
      const P = window.__pk;
      P.aim(0, 1.0); P.setGauge(0.7); P.shoot();
      let g = 0; while (P.G.phase !== 'flight' && g++ < 4000) P.sim(0.01);
      // 크로스바 위 높은 곳으로 (골대를 한참 넘어감)
      P.G.shot.ty = 6; P.ball.vy += 5;
      let minZAfter = 99, maxZ = 0, passedBoard = false, last = P.ball.state;
      for (let i = 0; i < 500; i++) {
        P.sim(0.01);
        if (P.G.phase !== 'flight' && P.G.phase !== 'outcome') break; // 다음 차례가 시작되면 공이 제자리로 돌아오므로 그 전까지만 봐요
        last = P.ball.state;
        maxZ = Math.max(maxZ, P.ball.z);
        if (P.ball.z > 16.3) passedBoard = true;
        if (passedBoard) minZAfter = Math.min(minZAfter, P.ball.z);
      }
      return { state: last, maxZ, minZAfter, y: P.ball.y };
    });
    assert.ok(r.maxZ > 16, JSON.stringify(r));
    assert.ok(r.state === 'hidden' || r.minZAfter > 11.5, '골대 쪽으로 되돌아오면 안 돼요: ' + JSON.stringify(r));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('작은 화면(360x640)에서도 설정 화면의 시작 버튼이 바로 보여요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 360, height: 640 }, true);
  try {
    await page.tap('[data-go="setup"]');
    await page.waitForSelector('#btnGo');
    const b = await page.locator('#btnGo').boundingBox();
    assert.ok(b.y >= 0 && b.y + b.height <= 640, '시작 버튼이 화면 안에 있어야 해요: ' + JSON.stringify(b));
    const n = await page.locator('#nick').boundingBox();
    assert.ok(n.y + n.height <= 640, JSON.stringify(n));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('가로 휴대폰(667x375)에서 결과 화면의 버튼과 저장 메시지가 모두 보여요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 667, height: 375 }, true);
  try {
    await page.evaluate(() => {
      const P = window.__pk; P.start({ my: 0, opp: 1, diff: '쉬움', nick: '작은화면' }); P.freeze(true); let g = 0;
      while (P.G.mode === 'match' && g++ < 40000) {
        if (P.G.phase === 'aim') { P.aim(2.5, 1.0); P.shoot(0.7); }
        if (P.G.phase === 'flight' && P.G.turn.humanKeep && P.keeper.mode === 'ready' && P.G.phaseT > 0.25) P.dive(P.G.shot.tx, P.G.shot.ty);
        P.sim(1 / 30);
      }
      P.freeze(false);
    });
    await page.waitForSelector('#scr-result:not(.hidden)');
    await page.tap('#btnSave');
    await page.waitForFunction(() => /저장했어요/.test(document.getElementById('saveMsg').textContent));
    for (const id of ['#btnSave', '#saveMsg', '#btnResRank', '#btnAgain', '#btnResMenu']) {
      const b = await page.locator(id).boundingBox();
      assert.ok(b.y >= 0 && b.y + b.height <= 376, id + ' 가 화면 안에 있어야 해요: ' + JSON.stringify(b));
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('저장하지 않고 나가려 하면 한 번 알려 주고, 한 번 더 누르면 나가요', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    await page.evaluate(() => {
      const P = window.__pk; P.start({ my: 0, opp: 1, diff: '쉬움', nick: '나가기' }); P.freeze(true); let g = 0;
      while (P.G.mode === 'match' && g++ < 40000) {
        if (P.G.phase === 'aim') { P.aim(2.5, 1.0); P.shoot(0.7); }
        if (P.G.phase === 'flight' && P.G.turn.humanKeep && P.keeper.mode === 'ready' && P.G.phaseT > 0.25) P.dive(P.G.shot.tx, P.G.shot.ty);
        P.sim(1 / 30);
      }
      P.freeze(false);
    });
    await page.waitForSelector('#scr-result:not(.hidden)');
    await page.click('#btnResMenu');
    assert.ok(await page.isVisible('#scr-result'), '처음에는 나가지 않고 알려 줘요');
    assert.match(await page.textContent('#saveMsg'), /아직 랭킹에 저장하지 않았어요/);
    await page.click('#btnResMenu');
    assert.ok(await page.isVisible('#scr-title'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('막는 차례: 날아오는 공이 키커 몸에 가려지지 않아요 (키커를 빼고 그린 화면과 공 자리가 같음)', { skip }, async () => {
  const { browser, page, errors } = await open({ width: 1024, height: 768 });
  try {
    const r = await page.evaluate(async () => {
      const P = window.__pk, cvs = document.getElementById('cv'), x = cvs.getContext('2d');
      const frame = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
      P.start({ my: 0, opp: 1, diff: '쉬움', nick: '테스트' }); P.freeze(true);
      let overlapFrames = 0, coveredFrames = 0, samples = 0;
      for (let shot = 0; shot < 6; shot++) {
        P.G.first = 1; P.G.turn = null; P.G.kicks = [[], []]; P.G.phase = 'outcome'; P.G.phaseT = 99; P.sim(0.05); // 새 차례
        let g = 0; while (P.G.phase !== 'flight' && g++ < 6000) P.sim(0.01);
        for (let i = 0; i < 14 && P.G.phase === 'flight'; i++) {
          P.sim(0.03); await frame();
          const d = window.devicePixelRatio || 1, s = P.screenOf(P.ball.x, P.ball.y, P.ball.z), r = Math.max(4, 0.11 * 900 / (P.ball.z + 7.2 - P.cam.dolly) * d);
          const bx = Math.max(0, Math.round(s.x * d - r)), by = Math.max(0, Math.round(s.y * d - r)), w = Math.round(r * 2), h = Math.round(r * 2);
          const a = x.getImageData(bx, by, w, h).data;
          const kit = P.kicker.kit; P.kicker.kit = null; await frame();
          const b = x.getImageData(bx, by, w, h).data; P.kicker.kit = kit;
          let diff = 0; for (let k = 0; k < a.length; k += 4) if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 60) diff++;
          samples++; if (diff > 0) coveredFrames++;
        }
      }
      return { samples, coveredFrames };
    });
    assert.ok(r.samples >= 20, JSON.stringify(r));
    // 키커가 공 위에 그려지고 있다면 (예전 버그) 많은 장면에서 공 자리가 달라져요
    assert.ok(r.coveredFrames <= Math.ceil(r.samples * 0.05), '공이 키커에 가려지고 있어요: ' + JSON.stringify(r));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
