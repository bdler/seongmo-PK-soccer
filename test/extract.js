'use strict';
// Index.html 의 <script> 에서 이름으로 함수 소스를 꺼내는 작은 도우미 (테스트 전용)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function readIndexScript() {
  const html = fs.readFileSync(path.join(ROOT, 'Index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('Index.html 에 <script> 가 없습니다');
  return m[1];
}
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('함수 없음: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('함수 끝을 찾지 못함: ' + name);
}
// 'var NAME = ...;' 또는 'var A = 1, NAME = 2;' 처럼 NAME 을 선언하는 var 문 전체
function extractVar(src, name) {
  const re = new RegExp('(?:^|\\n)(var [^;]*?\\b' + name + ' = [\\s\\S]*?;)[ \\t]*(?://[^\\n]*)?\\n');
  const m = src.match(re);
  if (!m) throw new Error('변수 없음: ' + name);
  return m[1];
}
module.exports = { ROOT, readIndexScript, extractFunction, extractVar };
