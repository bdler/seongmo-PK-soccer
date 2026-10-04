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

/* ───────────── 웹 앱 ───────────── */
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('성모 PK')
    // Apps Script 웹 앱은 HTML 안의 viewport 메타 태그를 쓰지 않으므로 여기서 넣어 줍니다 (태블릿 · 휴대폰 화면 맞춤).
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
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
      var sh = getSheet_();
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
    return { ok: false, message: '저장하는 중에 문제가 생겼어요: ' + (e && e.message ? e.message : e) };
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
  var list = rankList_(readAll_(getSheet_()), period, unique, today).slice(0, limit);
  try { cache.put(key, JSON.stringify(list), CACHE_SEC); } catch (e) { /* 캐시가 너무 크면 건너뜀 */ }
  return list;
}

/* ───────────── 관리용 (편집기에서 직접 실행) ───────────── */
// 처음 한 번 실행: 랭킹 시트를 만들고 주소를 실행 로그에 보여 줍니다.
function setupPk() {
  var sh = getSheet_();
  var url = sh.getParent().getUrl();
  Logger.log('랭킹 시트 준비 완료: ' + url + ' (탭: ' + SHEET_NAME + ')');
  return url;
}
// 기록 초기화: 지금 기록을 'PK랭킹_백업_날짜' 탭으로 복사한 뒤 비웁니다.
function clearPkRecords() {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(), ss = sh.getParent();
    var name = SHEET_NAME + '_백업_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
    sh.copyTo(ss).setName(name);
    var last = sh.getLastRow();
    if (last > 1) sh.deleteRows(2, last - 1);
    bumpCache_();
    Logger.log('기록을 비웠어요. 백업 탭: ' + name);
    return name;
  } finally {
    lock.releaseLock();
  }
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
function getSheet_() {
  var props = PropertiesService.getScriptProperties(), ss = null;
  var id = props.getProperty('SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('성모 PK 랭킹');
    props.setProperty('SHEET_ID', ss.getId());
  }
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
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
  var s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > NICK_MAX) s = s.substring(0, NICK_MAX);
  return s;
}
function hasBadWord_(s) {
  var t = String(s || '').toLowerCase().replace(/[\s.\-_~!@#$%^&*()\[\]{}\/\\|,·'"`:;?<>+=0-9]/g, '');
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
  var best = rankList_(all, period, true, today), better = 0;
  for (var i = 0; i < best.length; i++) if (best[i].nickname !== nick && best[i].score > score) better++;
  return { rank: better + 1, total: best.length };
}
function bumpCache_() {
  // 같은 밀리초에 두 번 저장해도 버전이 겹치지 않게 난수를 붙입니다.
  try { CacheService.getScriptCache().put('pk:ver', new Date().getTime() + '.' + Math.floor(Math.random() * 1e9), 21600); } catch (e) { /* 무시 */ }
}
