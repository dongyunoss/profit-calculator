/*
 * 계산 엔진 · 엑셀 생성기 검증 테스트
 * 실행: node tests/engine.test.js
 */
'use strict';

const assert = require('assert');
const Engine = require('../js/engine.js');
const XlsxWriter = require('../js/xlsx-writer.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}
function approx(a, b, eps) {
  assert.ok(Math.abs(a - b) < (eps || 1e-6), `expected ${a} ≈ ${b}`);
}

console.log('engine.js');

// 1. 계좌 개설 + 평가 → 기준가/수익률
ok('개설 1억, 평가 1.05억 → 기준가 1050, 수익률 5%', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 105000000 }
    ]
  });
  approx(p.units, 100000000);
  approx(p.nav, 1050);
  approx(p.navReturn, 0.05);
  approx(p.principalReturn, 0.05);
  approx(p.eval, 105000000);
});

// 2. 입금이 수익률을 왜곡하지 않는지
ok('5% 수익 후 5천만 입금 → 기준가 수익률 5% 유지', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 105000000 },
      { id: '3', seq: 3, type: 'deposit', date: '2026-01-05', amount: 50000000 }
    ]
  });
  approx(p.nav, 1050);              // 입금은 기준가 불변
  approx(p.navReturn, 0.05);
  approx(p.eval, 155000000);        // 평가금액은 즉시 반영
  approx(p.principal, 150000000);
  // 입금 좌수 = 5천만 × 1000 ÷ 1050
  approx(p.units, 100000000 + 50000000 * 1000 / 1050, 1e-3);
});

// 3. 출금도 수익률 불변
ok('5% 수익 후 2천만 출금 → 기준가 수익률 5% 유지', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 105000000 },
      { id: '3', seq: 3, type: 'withdraw', date: '2026-01-05', amount: 20000000 }
    ]
  });
  approx(p.nav, 1050);
  approx(p.eval, 85000000);
  approx(p.principal, 80000000);
});

// 4. 입금 다음날 평가 → 일간 수익률이 입금 제외 순수 성과인지
ok('입금 후 평가: 일간 수익률은 입금액 제외 순수 성과', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 105000000 },
      { id: '3', seq: 3, type: 'deposit', date: '2026-01-04', amount: 50000000 },
      // 155,000,000 에서 1% 상승 = 156,550,000
      { id: '4', seq: 4, type: 'valuation', date: '2026-01-04', amount: 156550000 }
    ]
  });
  const last = p.daily[p.daily.length - 1];
  approx(last.ret, 0.01, 1e-9);
  approx(p.nav, 1050 * 1.01, 1e-6);
});

// 5. 성과보수 수취 → 기준가/수익률 초기화
ok('성과보수 수취 → 기준가 1000, 수익률 0%, 원금=차감 후 평가금액', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 110000000 },
      { id: '3', seq: 3, type: 'fee', date: '2026-01-03', amount: 2000000 }
    ]
  });
  approx(p.nav, 1000);
  approx(p.navReturn, 0);
  approx(p.principalReturn, 0);
  approx(p.eval, 108000000);
  approx(p.principal, 108000000);
  approx(p.units, 108000000);
  approx(p.totalFees, 2000000);
  // 누적 성과 지수는 보수와 무관하게 10% 유지
  approx(p.cumReturn, 0.10, 1e-9);
});

// 6. 보수 수취 후 추가 성과 → 초기화 이후 수익률만 표시
ok('보수 수취 후 2% 추가 성과 → 기준가 수익률 2%, 누적은 복리', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 110000000 },
      { id: '3', seq: 3, type: 'fee', date: '2026-01-03', amount: 2000000 },
      { id: '4', seq: 4, type: 'valuation', date: '2026-01-04', amount: 110160000 } // 1.08억 × 1.02
    ]
  });
  approx(p.navReturn, 0.02, 1e-9);
  approx(p.cumReturn, 1.10 * 1.02 - 1, 1e-9);
});

// 7. 종합 지표
ok('종합: 단순 수익률과 컴포지트 수익률', () => {
  const a = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 110000000 } // +10%
    ]
  });
  const b = Engine.processAccount({
    id: 'b', name: 'B',
    events: [
      { id: '3', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '4', seq: 2, type: 'valuation', date: '2026-01-03', amount: 95000000 } // -5%
    ]
  });
  const s = Engine.computeSummary([a, b]);
  approx(s.totalEval, 205000000);
  approx(s.totalPrincipal, 200000000);
  approx(s.simpleReturn, 0.025);
  const comp = Engine.computeComposite([a, b]);
  // 동일 가중 → (10% − 5%) / 2 = 2.5%
  approx(comp.ret, 0.025, 1e-9);
});

// 8. 컴포지트: 평가일이 어긋나는 경우 (없는 계좌는 수익률 0으로 가중)
ok('컴포지트: 평가일 불일치 시 직전 평가금액 가중', () => {
  const a = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 102000000 }, // +2%
      { id: '3', seq: 3, type: 'valuation', date: '2026-01-04', amount: 102000000 }  // 0%
    ]
  });
  const b = Engine.processAccount({
    id: 'b', name: 'B',
    events: [
      { id: '4', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '5', seq: 2, type: 'valuation', date: '2026-01-04', amount: 104000000 } // 1/4에만 평가, +4%
    ]
  });
  const comp = Engine.computeComposite([a, b]);
  // 1/3: A만 평가(+2%), B는 직전 평가 없음 → 가중치 A 1억만 → +2%
  approx(comp.series[0].ret, 0.02, 1e-9);
  // 1/4: A 0% (1.02억), B +4% (1억) → (0 + 0.04×1억) ÷ 2.02억
  approx(comp.series[1].ret, 0.04 * 100000000 / 202000000, 1e-9);
});

// 9. 같은 날짜 이벤트 처리 순서: 입금 → 평가
ok('같은 날짜: 입금이 평가보다 먼저 처리', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-05', amount: 210000000 },
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-05', amount: 100000000 },
      { id: '0', seq: 0, type: 'deposit', date: '2026-01-02', amount: 100000000 }
    ]
  });
  // 1/5: 입금 1억 (기준가 1000) → 좌수 2억 → 평가 2.1억 → 기준가 1050
  approx(p.nav, 1050);
  approx(p.navReturn, 0.05);
});

console.log('\nxlsx-writer.js');

// 10. xlsx 생성 → ZIP 구조 검증
ok('xlsx 바이트 생성 및 ZIP 시그니처 확인', () => {
  const bytes = XlsxWriter.build([{
    name: '테스트',
    colWidths: [12, 14],
    rows: [
      [{ v: '항목', s: XlsxWriter.S.HEAD }, { v: '값', s: XlsxWriter.S.HEAD }],
      [{ v: '원금' }, { v: 100000000, s: XlsxWriter.S.INT }],
      [{ v: '수익률' }, { v: 0.05, s: XlsxWriter.S.PCT }],
      [{ v: '특수문자 <&">' }, { v: 1.23, s: XlsxWriter.S.DEC }]
    ]
  }]);
  // ZIP local file header 시그니처 PK\x03\x04
  assert.strictEqual(bytes[0], 0x50);
  assert.strictEqual(bytes[1], 0x4B);
  assert.strictEqual(bytes[2], 0x03);
  assert.strictEqual(bytes[3], 0x04);
  // EOCD 시그니처가 끝에서 22바이트 앞에 존재
  const p = bytes.length - 22;
  assert.strictEqual(bytes[p], 0x50);
  assert.strictEqual(bytes[p + 1], 0x4B);
  assert.strictEqual(bytes[p + 2], 0x05);
  assert.strictEqual(bytes[p + 3], 0x06);
  require('fs').mkdirSync(__dirname + '/out', { recursive: true });
  require('fs').writeFileSync(__dirname + '/out/sample.xlsx', bytes);
});

// 11. 시트 이름 정리
ok('시트 이름 금지문자 제거 및 31자 제한', () => {
  assert.strictEqual(XlsxWriter.sanitizeSheetName('a/b[c]*d?', 'X'), 'a b c  d');
  assert.strictEqual(XlsxWriter.sanitizeSheetName('', 'X'), 'X');
  assert.strictEqual(XlsxWriter.sanitizeSheetName('가'.repeat(40), 'X').length, 31);
});

console.log('\n' + passed + '개 테스트 통과');
