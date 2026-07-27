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

// 5. 성과보수 수취 → 기준가/수익률 초기화, 원금은 보수로 줄지 않음
ok('성과보수 수취 → 기준가 1000, 원금 유지(차감 없음), 평가금액만 차감', () => {
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
  approx(p.eval, 108000000);
  approx(p.principal, 100000000);       // 순입금은 보수 수취와 무관하게 유지
  // 순입금대비는 총수익 기준 — 나간 보수 200만을 되살려 10% (8%로 깎이지 않는다)
  approx(p.principalReturn, 0.10);
  approx(p.units, 108000000);
  approx(p.totalFees, 2000000);
  // 누적 성과 지수는 보수와 무관하게 10% 유지
  approx(p.cumReturn, 0.10, 1e-9);
});

// 5-2. 보수 수취는 만기 재계약과 같은 방식 — 보수 차감 후 평가금액이 새 계약 원금으로 승계
ok('보수 수취 → 계약원금 승계로 원금대비 수익률까지 0% 초기화, 전체 실적은 유지', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-06-30', amount: 110000000 },
      { id: '3', seq: 3, type: 'fee', date: '2026-06-30', amount: 2000000 }
    ]
  });
  // 개별 계좌: 완전 초기화 (기준가·원금대비 모두 0%)
  approx(p.contractPrincipal, 108000000); // 보수 차감 후 평가금액을 새 계약 원금으로 승계
  approx(p.contractReturn, 0);            // 원금대비 수익률도 0%로 초기화
  approx(p.contractPnl, 0);
  approx(p.navReturn, 0);
  // 전체 실적: 순입금·수익률 유지
  approx(p.principal, 100000000);
  const s = Engine.computeSummary([p]);
  approx(s.totalPrincipal, 100000000);
  approx(s.simpleReturn, 0.10);
});

// 5-3. 승계된 계약원금 기준으로 이후 성과가 계산된다
ok('보수 수취 후 5% 성과 → 원금대비 수익률 5%(승계 원금 기준)', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-06-30', amount: 110000000 },
      { id: '3', seq: 3, type: 'fee', date: '2026-06-30', amount: 2000000 },      // 계약원금 1.08억
      { id: '4', seq: 4, type: 'valuation', date: '2026-07-31', amount: 113400000 } // 1.08억 × 1.05
    ]
  });
  approx(p.contractReturn, 0.05, 1e-9);  // 승계된 계약원금 1.08억 대비 5%
  approx(p.navReturn, 0.05, 1e-9);
  approx(p.principal, 100000000);        // 순입금 불변
  approx(p.cumReturn, 1.10 * 1.05 - 1, 1e-9);
  // 전체 실적: (1.134억 + 보수 0.02억 − 1억) ÷ 1억
  approx(Engine.computeSummary([p]).simpleReturn, 0.154, 1e-9);
});

// 5-4. 승계 후 추가 입출금은 계약원금에도 반영된다
ok('보수 수취 후 추가 입금 → 계약원금·순입금 모두 증가', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-06-30', amount: 110000000 },
      { id: '3', seq: 3, type: 'fee', date: '2026-06-30', amount: 2000000 },   // 계약원금 1.08억
      { id: '4', seq: 4, type: 'deposit', date: '2026-07-01', amount: 20000000 }
    ]
  });
  approx(p.contractPrincipal, 128000000); // 1.08억 + 2천만
  approx(p.principal, 120000000);         // 순입금 1억 + 2천만
  approx(p.contractReturn, 0);            // 입금은 수익률을 왜곡하지 않음
  approx(p.navReturn, 0);
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

// 7-2. 성과보수 수취 후에도 전체 실적(원금·수익률)은 유지된다
ok('전체 실적: 성과보수 수취로 종합 원금대비 수익률이 줄지 않음', () => {
  const base = [
    { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
    { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 110000000 } // +10%
  ];
  // 보수 수취 전
  const before = Engine.computeSummary([
    Engine.processAccount({ id: 'a', name: 'A', events: base })
  ]);
  approx(before.totalPrincipal, 100000000);
  approx(before.simpleReturn, 0.10);
  // 같은 계좌에 성과보수 2백만 수취 → 개별 계좌는 기준가 0% 초기화
  const withFee = Engine.processAccount({
    id: 'a', name: 'A',
    events: base.concat([{ id: '3', seq: 3, type: 'fee', date: '2026-01-03', amount: 2000000 }])
  });
  approx(withFee.navReturn, 0);            // 개별 계좌: 초기화
  approx(withFee.eval, 108000000);         // 보수만큼 평가금액 차감
  // 전체 실적: 원금 유지 + 수익률 유지(보수 되살림)
  const after = Engine.computeSummary([withFee]);
  approx(after.totalPrincipal, 100000000); // 원금 그대로 유지
  approx(after.simpleReturn, 0.10);        // 수익률 그대로 유지 (8%로 줄지 않음)
  approx(after.grossPnl, 10000000);        // 보수 포함 총성과 1천만
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

// 9. 같은 날짜: 입력 순서(seq)대로 처리 — 입금 먼저 기입 후 평가(입금 포함 잔고) 입력
ok('같은 날짜: 입금 기입 후 평가 입력 → 입금은 직전 기준가로 반영', () => {
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

// 10. 같은 날짜: 평가를 먼저 입력한 뒤 입금 기입 → 기준가 수익률 희석 없음
ok('같은 날짜: 평가 입력 후 입금 기입 → 그날 기준가로 반영, 희석 없음', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 105000000 }, // +5%
      { id: '3', seq: 3, type: 'deposit', date: '2026-01-03', amount: 50000000 }     // 평가 후 입금
    ]
  });
  approx(p.nav, 1050);                 // 기준가 유지 — 희석되지 않음
  approx(p.navReturn, 0.05);
  approx(p.eval, 155000000);           // 평가 1.05억 + 입금 5천만
  approx(p.principal, 150000000);
  // 입금 좌수는 그날 기준가 1050으로 발행
  approx(p.units, 100000000 + 50000000 * 1000 / 1050, 1e-3);
});

// 11. 보수를 먼저 수취하고 당일 평가를 나중에 입력해도 초기화·종합 수익률이 정확해야 함
ok('보수 수취 → 당일 평가 입력 순서여도 수익률 0 초기화, 종합 오염 없음', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-07-01', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-07-21', amount: 110000000 }, // +10%
      { id: '3', seq: 3, type: 'fee', date: '2026-07-22', amount: 5000000 },         // 보수 먼저 기입
      { id: '4', seq: 4, type: 'valuation', date: '2026-07-22', amount: 110000000 }  // 그 후 당일 평가(보합)
    ]
  });
  // 성과보수는 그날 마지막에 처리 → 평가(보합) 후 보수 차감·초기화
  approx(p.navReturn, 0);
  approx(p.nav, 1000);
  approx(p.eval, 105000000);          // 1.1억 − 보수 500만
  approx(p.principal, 100000000);     // 원금은 보수 수취와 무관하게 유지
  const comp = Engine.computeComposite([p]);
  approx(comp.ret, 0.10, 1e-9);       // 종합 성과 수익률은 순수 성과 10% 유지
});

// 12. 보수 수취가 종합 성과 수익률을 변화시키지 않는지 (수취 전후 동일)
ok('보수 수취 전후 종합 성과 수익률 동일', () => {
  const base = [
    { id: '1', seq: 1, type: 'deposit', date: '2026-07-01', amount: 100000000 },
    { id: '2', seq: 2, type: 'valuation', date: '2026-07-21', amount: 110000000 }
  ];
  const noFee = Engine.processAccount({ id: 'a', name: 'A', events: base });
  const withFee = Engine.processAccount({
    id: 'a', name: 'A',
    events: base.concat([{ id: '3', seq: 3, type: 'fee', date: '2026-07-21', amount: 5000000 }])
  });
  approx(Engine.computeComposite([noFee]).ret, Engine.computeComposite([withFee]).ret, 1e-12);
});

// 13. 전액 출금: 이익이 난 상태에서도 원금 음수 없이 계좌가 비워져야 함
ok('전액 출금 → 평가금액·원금·좌수 0, 출금액은 해지 시점 평가금액', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 110000000 }, // +10%
      { id: '3', seq: 3, type: 'closeout', date: '2026-01-04', amount: 0 }
    ]
  });
  approx(p.eval, 0);
  approx(p.principal, 0);        // 일반 출금이었다면 -1천만이 됐을 상황
  approx(p.units, 0);
  approx(p.totalWithdrawals, 110000000);
  approx(p.cumReturn, 0.10, 1e-9); // 해지 시점까지의 누적 성과는 보존
  assert.strictEqual(p.isClosed, true);
  assert.strictEqual(p.lastCloseoutDate, '2026-01-04');
});

// 14. 해지된 계좌는 이후 종합 성과 수익률 가중치에서 제외
ok('해지 계좌는 이후 컴포지트 가중치에서 제외, 과거 성과는 보존', () => {
  const a = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-01-03', amount: 110000000 }, // +10%
      { id: '3', seq: 3, type: 'closeout', date: '2026-01-04', amount: 0 }
    ]
  });
  const b = Engine.processAccount({
    id: 'b', name: 'B',
    events: [
      { id: '4', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '5', seq: 2, type: 'valuation', date: '2026-01-03', amount: 100000000 }, // 0%
      { id: '6', seq: 3, type: 'valuation', date: '2026-01-05', amount: 105000000 }  // +5%
    ]
  });
  const comp = Engine.computeComposite([a, b]);
  // 1/3: (10%×1억 + 0%×1억) ÷ 2억 = 5% → 지수 1050
  // 1/5: A는 해지되어 제외 → B 단독 +5% → 지수 1050 × 1.05 = 1102.5
  approx(comp.ret, 0.1025, 1e-9);
  // 해지가 없었다면(수정 전 버그) A의 1.1억이 수익률 0으로 가중되어 2.38%로 희석됐을 것
});

// 15. 같은 날 평가 → 보수 수취 → 전액 출금 순서 보장 (입력 순서 무관)
ok('같은 날: 전액출금·보수를 먼저 기입해도 평가 → 보수 → 전액출금 순서로 처리', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '3', seq: 3, type: 'closeout', date: '2026-01-05', amount: 0 },          // 먼저 기입
      { id: '4', seq: 4, type: 'fee', date: '2026-01-05', amount: 5000000 },         // 그 다음 기입
      { id: '2', seq: 5, type: 'valuation', date: '2026-01-05', amount: 110000000 }  // 마지막 기입
    ]
  });
  // 평가 +10% → 보수 500만 차감·초기화 → 잔액 1.05억 전액 출금
  approx(p.totalFees, 5000000);
  approx(p.totalWithdrawals, 105000000);
  approx(p.eval, 0);
  assert.strictEqual(p.isClosed, true);
  approx(Engine.computeComposite([p]).ret, 0.10, 1e-9); // 종합 성과는 순수 성과 10%
  // 해지로 원금이 0이 되어도 그때까지의 원금·총수익 성과는 전체 실적에 남는다
  const s = Engine.computeSummary([p]);
  approx(s.totalPrincipal, 100000000);
  approx(s.grossPnl, 10000000);
  approx(s.simpleReturn, 0.10);
});

// 16. 만기: 만기 원리금은 평가와 동일하게 성과에 반영되고 만기 상태로 표시된다
ok('만기 평가 → 원리금 반영, 만기 도래 상태', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'maturity', date: '2026-07-02', amount: 103000000 } // 원리금 1.03억
    ]
  });
  approx(p.eval, 103000000);
  approx(p.navReturn, 0.03);
  approx(p.cumReturn, 0.03, 1e-9);
  assert.strictEqual(p.isMatured, true);
  assert.strictEqual(p.lastMaturityDate, '2026-07-02');
  approx(Engine.computeComposite([p]).ret, 0.03, 1e-9); // 종합 성과에도 그대로 반영
});

// 17. 이익지급(이자·쿠폰): 원금 불변, 기준가 수익률 왜곡 없음, 전체 실적엔 가산
ok('이익지급 → 원금·기준가 수익률 불변, 전체 실적 수익률 유지', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-03-02', amount: 103000000 }, // +3%
      { id: '3', seq: 3, type: 'payout', date: '2026-03-02', amount: 3000000 }       // 이자 300만 수령
    ]
  });
  approx(p.eval, 100000000);        // 이자 지급 후 잔액
  approx(p.principal, 100000000);   // 원금은 줄지 않는다
  approx(p.navReturn, 0.03);        // 자금 유출이므로 기준가 수익률 왜곡 없음
  approx(p.totalPayouts, 3000000);
  // 배당(이익지급)은 원금에서 까지지 않고, 수익률도 지급액만큼 깎이지 않는다 —
  // 계약·순입금 기준 수익률 모두 기준가 수익률과 동일한 3%로 유지된다.
  approx(p.contractReturn, 0.03);
  approx(p.principalReturn, 0.03);
  approx(p.contractPnl, 3000000);
  const s = Engine.computeSummary([p]);
  approx(s.simpleReturn, 0.03);     // 전체 실적: 지급된 이자를 되살려 3% 유지
  approx(s.totalPayouts, 3000000);
});

// 17-2. 배당을 여러 번 지급해도 계약 기준 수익률이 계단식으로 깎이지 않는다
ok('배당 반복 지급 → 원금 불변, 계약 수익률이 지급액만큼 깎이지 않음', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-03-31', amount: 103000000 },
      { id: '3', seq: 3, type: 'payout', date: '2026-03-31', amount: 3000000 },   // 1분기 배당
      { id: '4', seq: 4, type: 'valuation', date: '2026-06-30', amount: 104000000 },
      { id: '5', seq: 5, type: 'payout', date: '2026-06-30', amount: 4000000 }    // 2분기 배당
    ]
  });
  approx(p.eval, 100000000);       // 두 번의 배당을 모두 지급하고 원금만 남음
  approx(p.principal, 100000000);  // 원금은 배당으로 줄지 않는다
  approx(p.totalPayouts, 7000000);
  // 기준가는 지급액을 재투자한 것으로 보는 시간가중 수익률 → 1.03 × 1.04 − 1 = 7.12%
  approx(p.navReturn, 1.03 * 1.04 - 1, 1e-9);
  // 계약·순입금 기준은 지급액을 액면 그대로 되살리는 금액가중 수익률 → 700만 ÷ 1억 = 7%
  // (0%로 깎이지 않는 것이 핵심. 기준가와의 0.12%p 차이는 지급받은 배당의 재투자 복리분)
  approx(p.contractReturn, 0.07, 1e-9);
  approx(p.principalReturn, 0.07, 1e-9);
  approx(Engine.computeSummary([p]).simpleReturn, 0.07, 1e-9);
});

// 17-3. 보수 수취(= 배당 지급) 후에도 새 계약 안에서 배당이 수익률을 깎지 않는다
ok('보수 수취 후 배당 지급 → 새 계약 수익률이 기준가 수익률과 일치', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'valuation', date: '2026-06-30', amount: 110000000 },
      { id: '3', seq: 3, type: 'fee', date: '2026-06-30', amount: 2000000 },       // 계약원금 1.08억
      { id: '4', seq: 4, type: 'valuation', date: '2026-09-30', amount: 118800000 }, // 1.08억 × 1.10
      { id: '5', seq: 5, type: 'payout', date: '2026-09-30', amount: 3000000 }       // 배당 300만
    ]
  });
  approx(p.eval, 115800000);
  approx(p.contractPrincipal, 108000000);  // 배당은 계약원금을 줄이지 않는다
  approx(p.principal, 100000000);          // 순입금도 그대로
  approx(p.navReturn, 0.10, 1e-9);
  approx(p.contractReturn, 0.10, 1e-9);    // 배당 300만을 되살려 10% 유지
  // 순입금대비: (1.158억 + 보수 200만 + 배당 300만 − 1억) ÷ 1억
  approx(p.principalReturn, 0.208, 1e-9);
  approx(Engine.computeSummary([p]).simpleReturn, 0.208, 1e-9);
});

// 18. 재계약(원리금 재예치): 계약 기준 초기화, 원금·누적성과·전체실적 유지
ok('재계약(원리금) → 기준가 1,000 초기화, 누적 성과·전체 실적 유지', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'maturity', date: '2026-07-02', amount: 110000000 },  // 원리금 1.1억
      { id: '3', seq: 3, type: 'rollover', date: '2026-07-02', mode: 'compound', amount: 0 }
    ]
  });
  approx(p.nav, 1000);
  approx(p.navReturn, 0);            // 새 계약 기준 수익률 0%
  approx(p.eval, 110000000);         // 원리금 전액 승계
  approx(p.units, 110000000);
  approx(p.principal, 100000000);    // 원금(순입금)은 재계약으로 변하지 않는다
  approx(p.cumReturn, 0.10, 1e-9);   // 누적 성과는 이어진다
  assert.strictEqual(p.isMatured, false);   // 재계약으로 만기 처리 완료
  assert.strictEqual(p.lastResetKind, 'rollover');
  approx(Engine.computeSummary([p]).simpleReturn, 0.10); // 전체 실적 10% 유지
});

// 19. 재계약(원금만): 이익을 지급하고 원금만 재예치
ok('재계약(원금만) → 이익 지급 후 원금만 재예치, 전체 실적 수익률 유지', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'maturity', date: '2026-07-02', amount: 110000000 },
      { id: '3', seq: 3, type: 'rollover', date: '2026-07-02', mode: 'payout', amount: 0 }
    ]
  });
  approx(p.eval, 100000000);         // 이익 1천만 지급 → 원금만 재예치
  approx(p.principal, 100000000);
  approx(p.totalPayouts, 10000000);  // 지급된 이익
  approx(p.nav, 1000);
  approx(p.navReturn, 0);
  approx(p.cumReturn, 0.10, 1e-9);
  approx(Engine.computeSummary([p]).simpleReturn, 0.10); // 전체 실적 10% 유지
});

// 20. 재계약 후 추가 성과는 새 계약 기준으로 계산되고 누적은 복리로 이어진다
ok('재계약 후 2% 성과 → 계약 기준 2%, 누적은 복리', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'maturity', date: '2026-07-02', amount: 110000000 },
      { id: '3', seq: 3, type: 'rollover', date: '2026-07-02', mode: 'compound', amount: 0 },
      { id: '4', seq: 4, type: 'valuation', date: '2026-07-03', amount: 112200000 } // 1.1억 × 1.02
    ]
  });
  approx(p.navReturn, 0.02, 1e-9);
  approx(p.cumReturn, 1.10 * 1.02 - 1, 1e-9);
  approx(Engine.computeComposite([p]).ret, 1.10 * 1.02 - 1, 1e-9); // 종합 성과도 복리로 연속
});

// 21. 같은 날 처리 순서: 만기 평가 → 보수 → 재계약 (입력 순서 무관)
ok('같은 날: 재계약·보수를 먼저 기입해도 만기평가 → 보수 → 재계약 순서로 처리', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '4', seq: 2, type: 'rollover', date: '2026-07-02', mode: 'compound', amount: 0 }, // 먼저 기입
      { id: '3', seq: 3, type: 'fee', date: '2026-07-02', amount: 2000000 },                  // 그 다음
      { id: '2', seq: 4, type: 'maturity', date: '2026-07-02', amount: 110000000 }            // 마지막
    ]
  });
  // 만기 +10% → 보수 200만 차감 → 재계약 초기화
  approx(p.eval, 108000000);
  approx(p.nav, 1000);
  approx(p.navReturn, 0);
  approx(p.totalFees, 2000000);
  assert.strictEqual(p.lastResetKind, 'rollover'); // 보수 뒤에 재계약이 처리됨
  approx(p.cumReturn, 0.10, 1e-9);
  approx(Engine.computeComposite([p]).ret, 0.10, 1e-9); // 종합 성과 오염 없음
});

// 22. 잔액 없는 계좌의 재계약은 무시된다
ok('해지 후 재계약은 무시되고 경고가 남는다', () => {
  const p = Engine.processAccount({
    id: 'a', name: 'A',
    events: [
      { id: '1', seq: 1, type: 'deposit', date: '2026-01-02', amount: 100000000 },
      { id: '2', seq: 2, type: 'closeout', date: '2026-01-05', amount: 0 },
      { id: '3', seq: 3, type: 'rollover', date: '2026-01-06', mode: 'compound', amount: 0 }
    ]
  });
  approx(p.eval, 0);
  assert.ok(p.warnings.some(w => w.includes('재계약')));
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
