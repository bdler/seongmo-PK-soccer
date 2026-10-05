'use strict';
// Code.gs 를 Node 에서 가짜(mock) Apps Script 환경으로 실행해 보는 테스트.
// 실행: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT, readIndexScript, extractFunction, extractVar } = require('./extract');

const TZ = 'Asia/Seoul';
function fmtDate(d, fmt) {
  const parts = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  return fmt.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute);
}

// ── 가짜 시트 ──
function makeSheet(name, ss) {
  const sh = {
    name, rows: [], formats: {}, frozen: 0, maxRows: 1000,
    getParent: () => ss,
    getName: () => sh.name,
    setName: n => { if (ss.sheets.some(x => x !== sh && x.name === n)) throw new Error('같은 이름의 시트가 이미 있어요: ' + n); sh.name = n; return sh; },
    getMaxRows: () => sh.maxRows,
    insertRowAfter: () => { sh.maxRows++; },
    appendRow: row => {
      // 실제 시트처럼: ' 로 시작하면 글자로 저장(앞의 ' 는 빠짐), = 로 시작하면 수식이 됩니다.
      sh.rows.push(row.map(v => {
        if (typeof v === 'string' && v[0] === "'") return v.slice(1);
        if (typeof v === 'string' && v[0] === '=') { sh.formulaInjected = true; return '#FORMULA'; }
        return v;
      }));
      sh.maxRows = Math.max(sh.maxRows, sh.rows.length);
      return sh;
    },
    setFrozenRows: n => { sh.frozen = n; },
    getLastRow: () => sh.rows.length,
    deleteRows: (start, n) => {
      // 실제 시트처럼: 머리글(고정 줄)을 뺀 모든 줄을 한꺼번에 지우려 하면 오류
      if (n >= sh.maxRows - sh.frozen) throw new Error('고정되지 않은 모든 행을 삭제할 수 없습니다.');
      sh.rows.splice(start - 1, n); sh.maxRows -= n;
    },
    copyTo: target => { const c = makeSheet('Copy of ' + sh.name + '#' + target.sheets.length, target); c.rows = sh.rows.map(r => r.slice()); c.maxRows = sh.maxRows; target.sheets.push(c); return c; },
    getRange: (a, b, c, d) => {
      const rng = {
        setFontWeight: () => rng, setBackground: () => rng,
        setNumberFormat: f => { sh.formats[typeof a === 'string' ? a : a + ':' + b] = f; return rng; },
        getValues: () => sh.rows.slice(a - 1, a - 1 + c).map(r => r.slice(b - 1, b - 1 + d))
      };
      return rng;
    }
  };
  return sh;
}
function makeSpreadsheet(id) {
  const ss = { id, sheets: [], getId: () => id, getUrl: () => 'https://docs.google.com/spreadsheets/d/' + id };
  ss.getSheetByName = n => ss.sheets.find(s => s.name === n) || null;
  ss.insertSheet = n => { const s = makeSheet(n, ss); ss.sheets.push(s); return s; };
  return ss;
}
function makeEnv(opts = {}) {
  const store = { spreadsheets: {}, props: {}, cache: {}, logs: [], created: 0 };
  if (opts.sheetId) store.props.SHEET_ID = opts.sheetId;
  const active = opts.bound ? makeSpreadsheet('bound') : null;
  if (active) store.spreadsheets.bound = active;
  const ctx = {
    console,
    Date,
    SpreadsheetApp: {
      openById: id => { if (!store.spreadsheets[id]) throw new Error('없는 시트'); return store.spreadsheets[id]; },
      getActiveSpreadsheet: () => active,
      create: () => { const id = 'new' + (++store.created); const ss = makeSpreadsheet(id); store.spreadsheets[id] = ss; return ss; },
      flush: () => {},
      getUi: () => { throw new Error('no ui'); }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => opts.lockFails ? false : true, waitLock: () => {}, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({
      get: k => (k in store.cache ? store.cache[k] : null),
      put: (k, v) => { store.cache[k] = v; },
      remove: k => { delete store.cache[k]; }
    }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in store.props ? store.props[k] : null), setProperty: (k, v) => { store.props[k] = v; } }) },
    Utilities: { formatDate: (d, tz, f) => fmtDate(d, f) },
    Session: { getScriptTimeZone: () => TZ, getActiveUser: () => ({ getEmail: () => (opts.anonymous ? '' : 'teacher@school.kr') }), getEffectiveUser: () => ({ getEmail: () => 'teacher@school.kr' }) },
    Logger: { log: m => store.logs.push(m) },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutputFromFile: file => {
        const out = { file, meta: {}, title: '', xfo: null };
        out.setTitle = t => { out.title = t; return out; };
        out.addMetaTag = (n, c) => { out.meta[n] = c; return out; };
        out.setXFrameOptionsMode = m => { out.xfo = m; return out; };
        return out;
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8'), ctx, { filename: 'Code.gs' });
  return { ctx, store };
}
const REC = { nickname: '슛돌이', myTeam: '성모 FC', oppTeam: '한강 유나이티드', goalsFor: 4, goalsAgainst: 2, kicks: 4, saves: 2, faced: 4, difficulty: '보통' };

test('doGet: Index 화면 · viewport · 끼워 넣기 허용', () => {
  const { ctx } = makeEnv();
  const out = ctx.doGet({});
  assert.equal(out.file, 'Index');
  assert.match(out.meta.viewport, /width=device-width/);
  assert.equal(out.meta['mobile-web-app-capable'], 'yes');   // 홈 화면에 추가했을 때 앱처럼
  assert.equal(out.meta['apple-mobile-web-app-capable'], 'yes');
  assert.equal(out.xfo, 'ALLOWALL');
});

test('기록 저장: 점수는 서버가 계산하고 순위를 돌려줍니다', () => {
  const { ctx, store } = makeEnv();
  const r = ctx.savePkResult(Object.assign({}, REC, { score: 999999 }));
  assert.equal(r.ok, true, r.message);
  assert.equal(r.score, Math.round((4 * 100 + 2 * 100 + 300) * 1.5));
  assert.equal(r.rank, 1); assert.equal(r.total, 1); assert.equal(r.todayRank, 1);
  // 시트가 없으면 새로 만들고 ID 를 저장
  assert.ok(store.props.SHEET_ID);
  const sh = store.spreadsheets[store.props.SHEET_ID].getSheetByName('PK랭킹');
  assert.equal(sh.rows.length, 2); // 머리글 + 1
  assert.equal(sh.rows[1][1], '슛돌이');
  assert.equal(sh.rows[1][8], '승');
});

test('시트에 붙은 스크립트면 그 시트를 씁니다', () => {
  const { ctx, store } = makeEnv({ bound: true });
  assert.equal(ctx.savePkResult(REC).ok, true);
  assert.ok(store.spreadsheets.bound.getSheetByName('PK랭킹'));
  assert.equal(store.created, 0);
});

test('잘못된 기록은 거절합니다', () => {
  const { ctx } = makeEnv();
  const bad = [
    { nickname: '' },
    { nickname: '   ' },
    { nickname: '씨 발' },
    { nickname: 'ㅅ.ㅂ' },
    { difficulty: '레전드' },
    { myTeam: '없는 팀' },
    { oppTeam: '성모 FC' },
    { goalsFor: 5, kicks: 4 },
    { saves: 3 },                                        // 선방 > 받은 킥 - 실점
    { goalsFor: 5, goalsAgainst: 5, kicks: 5, faced: 5, saves: 0 }, // 5번씩 차고 비기면 끝나지 않음
    { goalsFor: 3, goalsAgainst: 2, kicks: 5, faced: 5, saves: 1 }, // 3:2 는 5번째 전에 끝나지 않으면... (가능) → 아래 따로
    { kicks: 0 },
    { kicks: 2.5 },
    { kicks: '4; DROP' },
    { goalsFor: -1 },
    { kicks: 7, faced: 5 }
  ];
  for (const b of bad.filter(x => !(x.goalsFor === 3 && x.goalsAgainst === 2))) {
    const r = ctx.savePkResult(Object.assign({}, REC, b));
    assert.equal(r.ok, false, JSON.stringify(b));
    assert.ok(r.message);
  }
  assert.equal(ctx.savePkResult(null).ok, false);
  assert.equal(ctx.savePkResult(Object.assign({}, REC, { goalsFor: 3, goalsAgainst: 2, kicks: 5, faced: 5, saves: 1 })).ok, true);
});

test('수식으로 시작하는 닉네임은 글자로 저장 (수식 주입 막기)', () => {
  const { ctx, store } = makeEnv();
  for (const nick of ['=1+1', '+SUM(A1)', '-2', '@me']) {
    assert.equal(ctx.savePkResult(Object.assign({}, REC, { nickname: nick })).ok, true);
  }
  const sh = store.spreadsheets[store.props.SHEET_ID].getSheetByName('PK랭킹');
  assert.ok(!sh.formulaInjected, '수식이 시트에 들어가면 안 됩니다');
  const names = JSON.parse(JSON.stringify(ctx.getPkLeaderboard({ period: 'all' }).map(r => r.nickname))).sort();
  assert.deepEqual(names, ['+SUM(A1)', '-2', '=1+1', '@me'].sort());
});

test('랭킹: 닉네임별 최고 기록 · 판 수 · 같은 점수는 먼저 세운 기록이 위', () => {
  const { ctx, store } = makeEnv();
  assert.equal(ctx.savePkResult(Object.assign({}, REC, { nickname: '가', goalsFor: 3, goalsAgainst: 0, kicks: 3, faced: 3, saves: 2 })).score, 1200); // (300+200+300)*1.5
  ctx.savePkResult(Object.assign({}, REC, { nickname: '나' }));                                                                // 1350
  ctx.savePkResult(Object.assign({}, REC, { nickname: '가' }));                                                                // 1350 (나보다 늦게)
  const list = ctx.getPkLeaderboard({ period: 'all' });
  assert.equal(list.length, 2);
  assert.equal(list[0].nickname, '나');
  assert.equal(list[1].nickname, '가'); assert.equal(list[1].score, 1350); assert.equal(list[1].games, 2);
  const all = ctx.getPkLeaderboard({ period: 'all', unique: false });
  assert.equal(all.length, 3);
  // 오늘 탭: 예전 기록은 빠집니다
  const sh = store.spreadsheets[store.props.SHEET_ID].getSheetByName('PK랭킹');
  sh.rows.push([new Date('2020-01-01T03:00:00Z'), '옛날', '성모 FC', '한강 유나이티드', 5, 0, 5, 5, '승', '어려움', 9999]);
  store.cache = {}; // 직접 넣은 줄이라 캐시를 비움
  assert.equal(ctx.getPkLeaderboard({ period: 'all' })[0].nickname, '옛날');
  assert.ok(!ctx.getPkLeaderboard({ period: 'today' }).some(r => r.nickname === '옛날'));
});

test('저장하면 랭킹 캐시가 바로 새로 고쳐집니다', () => {
  const { ctx } = makeEnv();
  ctx.savePkResult(Object.assign({}, REC, { nickname: '하나' }));
  assert.equal(ctx.getPkLeaderboard({ period: 'today' }).length, 1);
  ctx.savePkResult(Object.assign({}, REC, { nickname: '둘' }));
  assert.equal(ctx.getPkLeaderboard({ period: 'today' }).length, 2);
});

test('잠금을 못 얻으면 다시 시도하라고 알려 줍니다', () => {
  const { ctx } = makeEnv({ lockFails: true });
  const r = ctx.savePkResult(REC);
  assert.equal(r.ok, false); assert.match(r.message, /잠시/);
});

test('기록 초기화: 백업 탭을 만들고 비웁니다', () => {
  const { ctx, store } = makeEnv();
  ctx.savePkResult(REC);
  const name = ctx.clearPkRecords();
  const ss = store.spreadsheets[store.props.SHEET_ID];
  assert.equal(ss.getSheetByName('PK랭킹').rows.length, 1);
  assert.equal(ss.getSheetByName(name).rows.length, 2);
  assert.equal(ctx.getPkLeaderboard({}).length, 0);
});

// ── 화면(Index.html)과 서버(Code.gs)가 같은 규칙을 쓰는지 ──
function clientFns() {
  const src = readIndexScript();
  const code = [extractVar(src, 'REG_KICKS'), extractVar(src, 'MAX_ROUNDS'), extractVar(src, 'DIFF_MULT'), extractVar(src, 'PTS'), extractVar(src, 'BAD_WORDS'), extractVar(src, 'INVISIBLE_RE'),
    extractFunction(src, 'checkDecided'), extractFunction(src, 'computePoints'), extractFunction(src, 'hasBadWord'), extractFunction(src, 'cleanNick'),
    'var G = { kicks: [[], []] };'].join('\n');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  return ctx;
}

test('점수 계산 · 닉네임 필터가 화면과 서버에서 같습니다', () => {
  const c = clientFns(), { ctx } = makeEnv();
  for (const diff of ['쉬움', '보통', '어려움']) for (let g = 0; g <= 8; g++) for (let s = 0; s <= 6; s++) for (const w of [true, false]) {
    const srv = Math.round((g * 100 + s * 100 + (w ? 300 : 0)) * ctx.DIFF_MULT[diff]);
    assert.equal(c.computePoints(g, s, w, diff).total, srv);
  }
  for (const n of ['슛돌이', '시바견', '졸라맨', '미친듯이 잘함', 'fuck', 'F.U.C.K', '개새끼', '골키퍼', '병1신']) {
    assert.equal(c.hasBadWord(n), ctx.hasBadWord_(n), n);
  }
});

test('화면에서 끝난 승부차기 기록은 모두 서버가 받아 줍니다 (무작위 1만 판)', () => {
  const c = clientFns(), { ctx } = makeEnv();
  let n = 0;
  for (let i = 0; i < 10000; i++) {
    const kicks = [[], []], first = i % 2, p = [0.3 + Math.random() * 0.6, 0.3 + Math.random() * 0.6];
    let d = -2;
    while (d === -2) {
      const total = kicks[0].length + kicks[1].length, team = total % 2 === 0 ? first : 1 - first;
      kicks[team].push({ goal: Math.random() < p[team] });
      d = c.checkDecided(kicks);
    }
    const gf = kicks[0].filter(k => k.goal).length, ga = kicks[1].filter(k => k.goal).length;
    const faced = kicks[1].length, saves = Math.floor(Math.random() * (faced - ga + 1));
    const ok = ctx.validateRecord_(Object.assign({}, REC, { goalsFor: gf, goalsAgainst: ga, kicks: kicks[0].length, faced, saves }));
    assert.equal(ok.ok, true, JSON.stringify({ gf, ga, kicks: kicks[0].length, faced, d, msg: ok.message }));
    assert.equal(ok.result, d === 0 ? '승' : d === 1 ? '패' : '무');
    n++;
  }
  assert.equal(n, 10000);
});

/* ───────────── 코드 검토에서 찾은 문제들 (다시 생기지 않게) ───────────── */
test('관리 함수: 웹 앱 방문자는 기록을 지우거나 시트를 만들 수 없어요', () => {
  const anon = makeEnv({ anonymous: true });
  anon.ctx.savePkResult(REC);
  assert.throws(() => anon.ctx.clearPkRecords(), /관리자만/);
  assert.throws(() => anon.ctx.setupPk(), /관리자만/);
  assert.equal(anon.ctx.getPkLeaderboard({}).length, 1, '기록이 그대로 남아 있어야 해요');
  // 주인이 편집기에서 실행하면 됩니다
  const owner = makeEnv();
  owner.ctx.savePkResult(REC);
  assert.match(owner.ctx.setupPk(), /spreadsheets/);
  assert.ok(owner.ctx.clearPkRecords());
});

test('기록 초기화: 기록이 1000줄 가까이 쌓여도 · 같은 분에 다시 실행해도 안전해요', () => {
  for (const n of [1, 998, 999, 1000, 1001, 1500]) {
    const { ctx, store } = makeEnv();
    ctx.savePkResult(REC);
    const sh = store.spreadsheets[store.props.SHEET_ID].getSheetByName('PK랭킹');
    while (sh.rows.length < n + 1) sh.rows.push([new Date(), '채움' + sh.rows.length, '성모 FC', '한강 유나이티드', 1, 0, 1, 1, '승', '쉬움', 100]);
    sh.maxRows = Math.max(sh.maxRows, sh.rows.length);
    const a = ctx.clearPkRecords();
    assert.equal(sh.rows.length, 1, n + '줄: 머리글만 남아야 해요');
    // 같은 분에 한 번 더 (백업 이름이 겹침)
    ctx.savePkResult(REC);
    const b = ctx.clearPkRecords();
    assert.notEqual(a, b);
    const ss = store.spreadsheets[store.props.SHEET_ID];
    assert.equal(ss.sheets.length, 3, '백업 탭 2개 + 랭킹 탭 (남는 임시 탭이 없어야 해요)');
  }
});

test('설정한 시트를 열지 못해도 몰래 다른 시트를 만들지 않아요', () => {
  const { ctx, store } = makeEnv({ sheetId: 'typo-id' });
  const r = ctx.savePkResult(REC);
  assert.equal(r.ok, false);
  assert.match(r.message, /저장하지 못했어요/);
  assert.doesNotMatch(r.message, /없는 시트|Exception/);      // 어려운 오류 문장은 화면에 안 나옴
  assert.equal(store.props.SHEET_ID, 'typo-id');
  assert.equal(store.created, 0);
  assert.throws(() => ctx.getPkLeaderboard({}));              // 읽기도 다른 시트를 만들지 않고 오류로 알림
  assert.equal(store.created, 0);
});

test('랭킹 읽기는 시트를 새로 만들지 않아요 (아직 기록이 없으면 빈 목록)', () => {
  const { ctx, store } = makeEnv();
  assert.equal(ctx.getPkLeaderboard({}).length, 0);
  assert.equal(store.created, 0);
  assert.equal(store.props.SHEET_ID, undefined);
});

test('도배 방지: 1분에 120번을 넘으면 잠시 기다리라고 해요', () => {
  const { ctx } = makeEnv();
  let ok = 0, blocked = 0;
  for (let i = 0; i < 125; i++) { const r = ctx.savePkResult(Object.assign({}, REC, { nickname: '친구' + (i % 40) })); if (r.ok) ok++; else { blocked++; assert.match(r.message, /잠시/); } }
  assert.equal(ok, 120); assert.equal(blocked, 5);
});

test('닉네임: 보이지 않는 글자 · 전각 문자로 검사를 피할 수 없어요 (화면과 서버 모두)', () => {
  const c = clientFns(), { ctx } = makeEnv();
  const bad = ['ㅤ', '​', '씨ㅤ발', '씨​발', 'ｆｕｃｋ', '병ㆍ신', 'ﾠ', 'ᅟ', '­‍', 'ＳＨＩＴ', '시﻿발'];
  for (const n of bad) {
    const cn = c.cleanNick(n), sn = ctx.cleanNick_(n);
    assert.equal(cn, sn, JSON.stringify(n));
    assert.ok(cn === '' || c.hasBadWord(cn), '화면이 걸러야 해요: ' + JSON.stringify(n));
    assert.ok(sn === '' || ctx.hasBadWord_(sn), '서버가 걸러야 해요: ' + JSON.stringify(n));
    assert.equal(ctx.savePkResult(Object.assign({}, REC, { nickname: n })).ok, false, JSON.stringify(n));
  }
  for (const good of ['슛돌이', '⚽축구왕', 'Kim 10', '골키퍼_민수', 'ABC']) {
    assert.equal(c.hasBadWord(good), false, good); assert.equal(ctx.hasBadWord_(good), false, good);
    assert.ok(c.cleanNick(good).length > 0 && ctx.cleanNick_(good).length > 0);
  }
});

test('저장 메시지의 순위: 같은 닉네임의 더 높은 기록이 있으면 그 기록으로 순위를 매겨요 (랭킹 표와 같게)', () => {
  const { ctx } = makeEnv();
  ctx.savePkResult(Object.assign({}, REC, { nickname: '철수' }));                                                    // 1350
  ctx.savePkResult(Object.assign({}, REC, { nickname: '영희', goalsFor: 3, goalsAgainst: 0, kicks: 3, faced: 3, saves: 1 })); // (300+100+300)*1.5=1050
  const r = ctx.savePkResult(Object.assign({}, REC, { nickname: '철수', goalsFor: 3, goalsAgainst: 0, kicks: 3, faced: 3, saves: 0 })); // 이번엔 900점이지만 철수의 최고는 1350
  assert.equal(r.ok, true);
  assert.equal(r.rank, 1, '랭킹 표에서 철수는 1등(1350점)이에요');
  const board = ctx.getPkLeaderboard({ period: 'all' });
  assert.equal(board[0].nickname, '철수');
});

test('저장이 실패하면 쉬운 말만 돌려줘요 (오류 내용은 로그에만)', () => {
  const { ctx } = makeEnv({ sheetId: 'bad' });
  const r = ctx.savePkResult(REC);
  assert.equal(r.ok, false);
  assert.ok(r.message.length < 40);
});
