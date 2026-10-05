/**
 * 성모 PK (승부차기 게임) — Google Apps Script 서버
 *
 *  - doGet          : 웹 앱 주소로 접속하면 Index.html 게임 화면을 보여 줍니다.
 *  - savePkResult   : 경기 기록을 구글 시트('PK랭킹' 탭)에 저장하고 순위를 돌려줍니다.
 *  - getPkLeaderboard: 랭킹(오늘 / 전체, 닉네임별 최고 기록)을 돌려줍니다.
 *
 * 처음 한 번: 편집기 위쪽에서 함수 'setupPk' 를 골라 [실행] → 권한 허용
 *            → 실행 로그에 랭킹 시트 주소가 나옵니다.
 * 학기 초기화: 'clearPkRecords' 실행 (지금 기록은 백업 탭으로 복사한 뒤 비웁니다)
 *
 * 점수 계산은 Index.html 의 computePoints 와 같아야 합니다.
 */

var SHEET_NAME = 'PK랭킹';
var HEADERS = ['일시', '닉네임', '내 팀', '상대 팀', '득점', '실점', '내 킥', '선방', '결과', '난이도', '점수'];
var DIFF_MULT = { '쉬움': 1, '보통': 1.5, '어려움': 2 };
var PTS = { goal: 100, save: 100, win: 300 };
var MAX_KICKS = 15;   // 승부차기 최대 라운드 (5번 + 서든데스 10번)
var NICK_MAX = 10;
var TEAM_NAMES = ['성모 FC', '한강 유나이티드', '푸른별 시티', '백두 타이거즈', '은하 로버스', '청솔 워리어스', '바다 갈매기', '불꽃 레인저스'];
var BAD_WORDS = ['시발', '씨발', '씨바', '씨빨', '시벌', '씨벌', 'ㅅㅂ', 'ㅆㅂ', '병신', '븅신', '빙신', 'ㅂㅅ', '개새', '개색', '새끼', 'ㅅㄲ', '좆', '존나',
  'ㅈㄴ', '지랄', 'ㅈㄹ', '미친', 'ㅁㅊ', '닥쳐', '꺼져', '엿먹', '니애미', '느금', '섹스', 'sex', 'fuck', 'shit', 'bitch'];
var CACHE_SEC = 30;
var RATE_PER_MIN = 120; // 1분에 저장할 수 있는 최대 횟수 (모든 사용자 합계)
var MAX_ROWS = 20000;   // 시트가 이 줄 수를 넘으면 더 저장하지 않음
// 눈에 보이지 않는 글자 (소프트 하이픈, 한글 채움 문자, 너비 없는 공백, 방향 제어 문자 등)
var INVISIBLE_RE = /[\u00AD\u115F\u1160\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;

/* ───────────── 웹 앱 ───────────── */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('성모 PK')
    // Apps Script 웹 앱은 HTML 안의 viewport 메타 태그를 쓰지 않으므로 여기서 넣어 줍니다 (태블릿 · 휴대폰 화면 맞춤).
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
    // '홈 화면에 추가'로 열면 주소창 없이 앱처럼 보이게 (HTML 파일 안의 같은 태그는 웹 앱에서는 무시됩니다)
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    // 구글 사이트도구 등에 끼워 넣을(embed) 수 있게 합니다.
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ───────────── 기록 저장 ───────────── */
function savePkResult(rec) {
  try {
    var r = validateRecord_(rec);
    if (!r.ok) return r;
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return { ok: false, message: '지금 저장하는 사람이 많아요. 잠시 뒤에 다시 눌러 주세요.' };
    var now = new Date(), all;
    try {
      // 한꺼번에 너무 많이 들어오면 막기 (도배 방지). 1분에 120번 · 시트가 2만 줄이 넘으면 중단
      var cache = CacheService.getScriptCache(), rk = 'pk:rl:' + Math.floor(new Date().getTime() / 60000), n = Number(cache.get(rk) || 0) + 1;
      cache.put(rk, String(n), 120);
      if (n > RATE_PER_MIN) return { ok: false, message: '지금 저장하는 사람이 많아요. 잠시 뒤에 다시 눌러 주세요.' };
      var sh = getSheet_(true);
      if (sh.getLastRow() > MAX_ROWS) return { ok: false, message: '기록이 가득 찼어요. 선생님께 알려 주세요.' };
      sh.appendRow([now, safeCell_(r.nickname), safeCell_(r.myTeam), safeCell_(r.oppTeam), r.goalsFor, r.goalsAgainst, r.kicks, r.saves, r.result, r.difficulty, r.score]);
      SpreadsheetApp.flush();
      bumpCache_();
      all = readAll_(sh);
    } finally {
      lock.releaseLock();
    }
    var today = dayOf_(now);
    var ra = rankOf_(all, 'all', today, r.nickname, r.score), rt = rankOf_(all, 'today', today, r.nickname, r.score);
    return { ok: true, score: r.score, rank: ra.rank, total: ra.total, todayRank: rt.rank, todayTotal: rt.total };
  } catch (e) {
    console.error(e); // 자세한 내용은 실행 로그에만 남기고, 화면에는 쉬운 말만 보여 줍니다
    return { ok: false, message: '저장하지 못했어요. 잠시 뒤에 다시 눌러 주세요.' };
  }
}

/* ───────────── 랭킹 ───────────── */
// opts: { limit: 1~100 (기본 30), period: 'today' | 'all', unique: 닉네임별 최고 기록만 (기본 true) }
function getPkLeaderboard(opts) {
  opts = opts || {};
  var limit = clampInt_(opts.limit, 1, 100, 30);
  var period = opts.period === 'today' ? 'today' : 'all';
  var unique = opts.unique !== false;
  var today = dayOf_(new Date());
  var cache = CacheService.getScriptCache();
  var key = 'pk:' + (cache.get('pk:ver') || '0') + ':' + period + ':' + (unique ? 1 : 0) + ':' + limit + ':' + (period === 'today' ? today : '');
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* 다시 읽기 */ } }
  var sh = getSheet_(false);
  var list = sh ? rankList_(readAll_(sh), period, unique, today).slice(0, limit) : [];
  try { cache.put(key, JSON.stringify(list), CACHE_SEC); } catch (e) { /* 캐시가 너무 크면 건너뜀 */ }
  return list;
}

/* ───────────── 관리용 (편집기에서 직접 실행) ───────────── */
// 처음 한 번 실행: 랭킹 시트를 만들고 주소를 실행 로그에 보여 줍니다.
function setupPk() {
  assertAdmin_();
  var sh = getSheet_(true);
  var url = sh.getParent().getUrl();
  Logger.log('랭킹 시트 준비 완료: ' + url + ' (탭: ' + SHEET_NAME + ')');
  return url;
}
// 기록 초기화: 지금 기록을 'PK랭킹_백업_날짜' 탭으로 복사한 뒤 비웁니다.
function clearPkRecords() {
  assertAdmin_(); // 웹 앱 주소를 아는 누구나 호출할 수 있으므로, 시트 주인이 직접 실행한 경우에만
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(true), ss = sh.getParent();
    var base = SHEET_NAME + '_백업_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm'), name = base, k = 2;
    while (ss.getSheetByName(name)) name = base + '_' + (k++); // 복사하기 전에 이름 확인 (같은 분에 다시 실행해도 안전)
    sh.copyTo(ss).setName(name);
    var last = sh.getLastRow();
    if (last > 1) {
      if (sh.getMaxRows() <= last) sh.insertRowAfter(last); // 머리글 말고 비울 수 있는 줄이 하나는 남아 있어야 지울 수 있어요
      sh.deleteRows(2, last - 1);
    }
    bumpCache_();
    Logger.log('기록을 비웠어요. 백업 탭: ' + name);
    return name;
  } finally {
    lock.releaseLock();
  }
}
// 관리 함수는 이 스크립트의 주인(웹 앱을 배포한 사람)이 편집기나 시트 메뉴에서 직접 실행할 때만 동작합니다.
function assertAdmin_() {
  var who = Session.getActiveUser().getEmail(), me = Session.getEffectiveUser().getEmail();
  if (!who || who !== me) throw new Error('관리자만 실행할 수 있어요. (Apps Script 편집기에서 직접 실행해 주세요)');
}
// 이 스크립트가 구글 시트에 붙어 있을 때(확장 프로그램 → Apps Script) 시트 위에 메뉴를 만듭니다.
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu('성모 PK')
      .addItem('랭킹 시트 준비', 'setupPk')
      .addItem('기록 초기화 (백업 후 비우기)', 'clearPkRecords')
      .addToUi();
  } catch (e) { /* 시트에 붙어 있지 않은 스크립트면 무시 */ }
}

/* ───────────── 내부 함수 ───────────── */
// create 가 true 일 때만 시트 · 탭을 새로 만듭니다 (저장 · 관리). 읽기에서는 만들지 않고 null 을 돌려줍니다.
// SHEET_ID 가 정해져 있으면 그 시트만 씁니다 (열지 못하면 오류를 그대로 알려 줌: 다른 시트로 몰래 바꾸지 않아요).
function getSheet_(create) {
  var props = PropertiesService.getScriptProperties(), ss = null;
  var id = props.getProperty('SHEET_ID');
  if (id) ss = SpreadsheetApp.openById(id);
  else { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; } }
  if (!ss) {
    if (!create) return null;
    ss = SpreadsheetApp.create('성모 PK 랭킹');
    props.setProperty('SHEET_ID', ss.getId());
  }
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    if (!create) return null;
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#fde047');
    // 닉네임 · 팀 · 결과 · 난이도는 글자 그대로 (숫자 · 날짜로 바뀌지 않게)
    sh.getRange('B:D').setNumberFormat('@');
    sh.getRange('I:J').setNumberFormat('@');
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
  }
  return sh;
}
function validateRecord_(rec) {
  if (!rec || typeof rec !== 'object') return { ok: false, message: '기록이 비어 있어요.' };
  var nick = cleanNick_(rec.nickname);
  if (!nick) return { ok: false, message: '닉네임을 적어 주세요.' };
  if (hasBadWord_(nick)) return { ok: false, message: '고운 말로 닉네임을 지어 주세요.' };
  var diff = String(rec.difficulty || '');
  if (!DIFF_MULT.hasOwnProperty(diff)) return { ok: false, message: '난이도가 올바르지 않아요.' };
  var myTeam = String(rec.myTeam || ''), oppTeam = String(rec.oppTeam || '');
  if (TEAM_NAMES.indexOf(myTeam) < 0 || TEAM_NAMES.indexOf(oppTeam) < 0 || myTeam === oppTeam) return { ok: false, message: '팀 정보가 올바르지 않아요.' };
  var kicks = clampInt_(rec.kicks, 0, MAX_KICKS, -1), faced = clampInt_(rec.faced, 0, MAX_KICKS, -1);
  var gf = clampInt_(rec.goalsFor, 0, MAX_KICKS, -1), ga = clampInt_(rec.goalsAgainst, 0, MAX_KICKS, -1), saves = clampInt_(rec.saves, 0, MAX_KICKS, -1);
  if (kicks < 1 || faced < 1 || gf < 0 || ga < 0 || saves < 0) return { ok: false, message: '경기 기록이 올바르지 않아요.' };
  // 승부차기 규칙으로 가능한 기록인지 확인
  if (gf > kicks || ga > faced || saves > faced - ga || Math.abs(kicks - faced) > 1) return { ok: false, message: '경기 기록이 올바르지 않아요.' };
  if (!possibleShootout_(gf, kicks, ga, faced)) return { ok: false, message: '경기 기록이 올바르지 않아요.' };
  var win = gf > ga;
  var score = Math.round((gf * PTS.goal + saves * PTS.save + (win ? PTS.win : 0)) * DIFF_MULT[diff]);
  return { ok: true, nickname: nick, myTeam: myTeam, oppTeam: oppTeam, goalsFor: gf, goalsAgainst: ga, kicks: kicks, saves: saves,
    result: gf > ga ? '승' : (gf < ga ? '패' : '무'), difficulty: diff, score: score };
}
// 승부차기로 끝날 수 있는 결과인지: 정규 5번 안에서 끝났거나, 서든데스에서 같은 횟수를 차고 한 골 차로 끝났거나,
// 아주 긴 서든데스(15번)에서 비김
function possibleShootout_(gf, kicks, ga, faced) {
  if (kicks <= 5 && faced <= 5) {
    if (kicks === 5 && faced === 5) return gf !== ga;
    return gf + (5 - kicks) < ga || ga + (5 - faced) < gf;
  }
  if (kicks !== faced) return false;
  if (gf === ga) return kicks === MAX_KICKS;
  return Math.abs(gf - ga) === 1;
}
function cleanNick_(v) {
  var s = String(v === undefined || v === null ? '' : v).replace(INVISIBLE_RE, '').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > NICK_MAX) s = s.substring(0, NICK_MAX);
  return s;
}
function hasBadWord_(s) {
  var t = String(s || '').replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).toLowerCase().replace(/[^a-z\uAC00-\uD7A3\u3131-\u3163]/g, '');
  for (var i = 0; i < BAD_WORDS.length; i++) if (t.indexOf(BAD_WORDS[i]) >= 0) return true;
  return false;
}
// = + - @ 로 시작하는 글자는 시트가 수식으로 읽지 않도록 앞에 ' 를 붙입니다.
function safeCell_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function clampInt_(v, lo, hi, def) {
  var n = Number(v);
  if (!isFinite(n) || Math.floor(n) !== n) return def;
  return n < lo ? def : (n > hi ? def : n);
}
function dayOf_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function readAll_(sh) {
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, HEADERS.length).getValues(), tz = Session.getScriptTimeZone(), out = [];
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i], nick = String(v[1] === null || v[1] === undefined ? '' : v[1]).replace(/^'/, '');
    if (!nick) continue;
    var date = v[0] instanceof Date ? Utilities.formatDate(v[0], tz, 'yyyy-MM-dd HH:mm') : String(v[0]);
    out.push({
      date: date, nickname: nick, myTeam: String(v[2]).replace(/^'/, ''), oppTeam: String(v[3]).replace(/^'/, ''),
      goalsFor: Number(v[4]) || 0, goalsAgainst: Number(v[5]) || 0, kicks: Number(v[6]) || 0, saves: Number(v[7]) || 0,
      result: String(v[8]), difficulty: String(v[9]), score: Number(v[10]) || 0
    });
  }
  return out;
}
// 점수 높은 순 → 같으면 먼저 세운 기록. unique 면 닉네임별 최고 기록만 (판 수 games 포함)
function rankList_(all, period, unique, today) {
  var list = [], i;
  for (i = 0; i < all.length; i++) if (period !== 'today' || String(all[i].date).substring(0, 10) === today) list.push(all[i]);
  list.sort(function (a, b) { return (b.score - a.score) || String(a.date).localeCompare(String(b.date)); });
  if (!unique) return list;
  var seen = {}, games = {}, out = [];
  for (i = 0; i < list.length; i++) games[list[i].nickname] = (games[list[i].nickname] || 0) + 1;
  for (i = 0; i < list.length; i++) {
    var n = list[i].nickname;
    if (seen[n]) continue;
    seen[n] = true;
    var r = {}; for (var k in list[i]) r[k] = list[i][k];
    r.games = games[n];
    out.push(r);
  }
  return out;
}
// 이 점수가 닉네임별 최고 기록 중 몇 등인지 (같은 점수는 같은 등수)
function rankOf_(all, period, today, nick, score) {
  var best = rankList_(all, period, true, today), better = 0, mine = score, i;
  // 랭킹 표는 닉네임마다 최고 기록이므로, 내 닉네임의 최고 점수로 순위를 매깁니다.
  for (i = 0; i < best.length; i++) if (best[i].nickname === nick) mine = Math.max(mine, best[i].score);
  for (i = 0; i < best.length; i++) if (best[i].nickname !== nick && best[i].score > mine) better++;
  return { rank: better + 1, total: best.length };
}
function bumpCache_() {
  // 같은 밀리초에 두 번 저장해도 버전이 겹치지 않게 난수를 붙입니다.
  try { CacheService.getScriptCache().put('pk:ver', new Date().getTime() + '.' + Math.floor(Math.random() * 1e9), 21600); } catch (e) { /* 무시 */ }
}
