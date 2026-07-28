/*
 * engine.js — 계좌별 기준가/좌수 계산 엔진 (순수 함수, DOM 비의존)
 *
 * 회계 방식 (펀드 기준가 방식):
 *  - 기준가는 1,000좌당 가격이며 계좌 개설 시 1,000.00 에서 시작한다.
 *  - 입금/출금은 "현재 기준가"로 좌수를 발행/환매하므로 수익률(기준가)에 영향을 주지 않는다.
 *  - 일일 평가금액이 입력되면 기준가 = 평가금액 × 1000 ÷ 좌수 로 갱신된다.
 *  - 성과보수 수취 시 보수액을 차감(출금과 동일하게 좌수 차감)한 뒤,
 *    기준가를 1,000으로, 좌수를 차감 후 평가금액으로 재설정하여 수익률을 초기화한다.
 *
 * 원금의 두 기준 — 보는 시점에 따라 다른 원금을 쓴다:
 *  · contractPrincipal (계약원금) — 보수 수취·재계약 시 평가금액을 새 계약 원금으로 승계.
 *    **개별 계좌를 열어 볼 때** 쓰는 기준이다. 재설정된 원금 대비 성과가 보인다.
 *  · principal (원금 흐름) — 입금하면 늘고 출금하면 주는 것이 전부. 보수·배당·재계약이
 *    건드리지 않는다. **전체 성과 측정(computeSummary)** 에 쓰는 기준이다.
 *  두 기준 모두 보수는 원금에서 나가지 않는다 — 보수는 수익에서 지출되는 비용이다.
 *
 * 만기 · 재계약(Rollover) 회계:
 *  실물 자산의 만기 처리 관행을 이벤트로 옮긴 것이다.
 *   · 예금        : 만기 원리금 확정 → 원리금 재예치 / 원금만 재예치(이자 수령) / 해지
 *   · 채권        : 이표(쿠폰) 수령, 만기 상환(액면 + 최종이자) → 재투자 / 출금
 *   · ELS         : 조기·만기 상환(원금 + 쿠폰) 또는 손실 상환 → 재투자(롤오버) / 출금
 *   · 펀드(폐쇄형): 만기 청산·상환 → 재설정(롤오버) / 환매
 *  - 만기(maturity)는 만기 시점의 원리금(상환금)을 평가금액으로 입력하는 이벤트다.
 *    평가와 동일하게 기준가·성과에 반영되며, 만기 도래 상태로 표시된다.
 *  - 이익지급(payout)은 이자·쿠폰·배당·상환수익의 인출이다. 출금과 동일한 자금 유출(flow)이므로
 *    기준가 수익률을 왜곡하지 않으며, 두 기준의 원금도 줄이지 않는다(보수와 같은 취급).
 *
 * 총수익(Total Return) 회계 — 배당·보수 지급이 수익률을 깎지 않게 하는 원칙:
 *  펀드가 배당(분배금)을 지급하면 순자산은 줄지만 원금은 줄지 않는다. 이때 수익률을
 *  "지급 후 잔액 ÷ 원금"으로 재면 지급한 만큼 수익률이 사라져 버린다.
 *  그래서 지급·수취되어 계좌 밖으로 나간 금액(배당·이자·성과보수)은 수익률 분자에 되살린다
 *  (분배금 재투자 기준 = Total Return).
 *    · 기준가(nav) — 지급액만큼 좌수를 상환하므로 기준가 자체는 변하지 않는다 → 왜곡 없음
 *    · 계약 기준 수익률 — 계약 시작 이후 유출액(contractFees·contractPayouts)을 되살려 계산
 *    · 원금 흐름 대비 수익률 — 개설 이후 유출액 전부를 되살려 계산
 *    · 전체 실적(computeSummary) — 계좌별 총수익 성과를 그대로 합산
 *  세 지표가 모두 같은 기준을 쓰므로, 배당을 주든 보수를 떼든 개별 계좌·전체 실적 어디에서도
 *  수익률이 깎여 보이지 않는다.
 *  - 재계약(rollover)은 새 계약의 시작이므로 기준가를 1,000으로 되돌려 계약 기준 수익률을
 *    0%로 초기화한다. 두 가지 모드를 지원한다.
 *      · compound (원리금 재계약) : 원리금 전액을 새 계약 원금으로 승계 — 평가금액 그대로
 *      · payout   (원금만 재계약) : 이익(평가금액 − 원금)을 지급한 뒤 원금만 재예치
 *  - 개별 계좌는 재계약으로 초기화되지만, 누적 성과 지수(cumIndex)와 종합 성과 수익률은
 *    끊기지 않고 이어진다. 지급된 이익은 전체 실적 수익률에 다시 가산되어(computeSummary)
 *    재계약·지급으로 전체 수익률이 깎여 보이지 않는다.
 *
 * 이벤트 처리 순서(같은 날짜):
 *  - 입금/출금/평가/만기는 사용자가 입력한 순서(seq)대로 처리한다.
 *    · 입금 기입 → 평가 입력: 입금은 직전 기준가로 좌수 발행 후 평가로 기준가 갱신
 *    · 평가 입력 → 입금 기입: 입금은 그날 갱신된 기준가로 발행되어 수익률 희석 없음
 *  - 이익지급·성과보수는 입력 순서와 무관하게 당일 평가(만기) 반영 후에 처리한다.
 *    (당일 평가 반영 → 보수·이익 차감 → 초기화 순서가 보장되어야
 *     기준가 수익률이 정확히 0으로 초기화되고 종합 성과 수익률이 오염되지 않는다)
 *  - 재계약은 그 뒤(보수·이익지급 후), 전액출금(해지)은 그날의 가장 마지막에 처리한다.
 */
(function (global) {
  'use strict';

  var NAV_BASE = 1000;
  var EVENT_ORDER = {
    deposit: 0, withdraw: 1, valuation: 2, maturity: 3,
    payout: 4, fee: 5, rollover: 6, closeout: 7
  };
  var EVENT_LABEL = {
    deposit: '입금', withdraw: '출금', valuation: '평가', maturity: '만기',
    payout: '이익지급', fee: '성과보수', rollover: '재계약', closeout: '전액출금'
  };

  // 같은 날짜 안에서의 처리 단계:
  //   일반(입금/출금/평가/만기) → 이익지급·성과보수 → 재계약 → 전액출금
  function dayRank(type) {
    if (type === 'payout' || type === 'fee') return 1;
    if (type === 'rollover') return 2;
    if (type === 'closeout') return 3;
    return 0;
  }

  function sortEvents(events) {
    return events.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      // 이익지급·성과보수는 입력 순서와 무관하게 당일 평가(만기) 반영 후, 재계약은 그 뒤,
      // 전액출금은 그보다도 뒤에 처리한다.
      // (당일 평가 → 보수·이익 차감 → 재계약 초기화 → 잔액 전액 출금 순서가 보장되어야
      //  수익률이 오염되지 않는다)
      var r = dayRank(a.type) - dayRank(b.type);
      if (r !== 0) return r;
      // 나머지(입금/출금/평가/만기)는 입력 순서(seq)대로 — 실제 발생 순서와 일치시킨다.
      var s = (a.seq || 0) - (b.seq || 0);
      if (s !== 0) return s;
      return EVENT_ORDER[a.type] - EVENT_ORDER[b.type];
    });
  }

  function processAccount(account) {
    var events = sortEvents(account.events || []);
    var units = 0;          // 좌수
    var nav = NAV_BASE;     // 기준가 (1,000좌당)
    var principal = 0;      // 원금 흐름 (전체 성과 기준 — 보수·이익지급·재계약으로 변하지 않음)
    // 계약원금: 현재 계약의 원금 기준.
    // 만기 재계약에서 원리금을 새 계약 원금으로 승계하는 것과 같은 방식으로,
    // 성과보수 수취 시에도 보수 차감 후 평가금액을 새 계약의 원금으로 승계한다.
    // → 개별 계좌는 기준가·원금대비 수익률이 모두 0%로 초기화되고,
    //   전체 성과는 원금 흐름(principal) 기준이므로 영향을 받지 않는다.
    var contractPrincipal = 0;
    // 현재 계약이 시작된 이후 계좌 밖으로 나간 금액. 계약 기준 수익률의 분자에 되살려
    // 배당·보수 지급이 계약 수익률을 깎지 않게 한다. 계약이 새로 시작되면(보수·재계약) 0으로.
    var contractFees = 0, contractPayouts = 0;
    // 보수 되살린 계약원금 — 계약원금(contractPrincipal)과 같지만 보수 차감 '전' 평가금액으로
    // 재설정된다. 전액 출금(해지) 시 원금 흐름에서 차감할 "남은 원금"이 이 값이다.
    // 일반 출금으로 계좌를 정리할 때 사용자가 기입하는 금액과 같은 기준이므로,
    // 해지로 기입하든 출금으로 기입하든 전체 성과가 동일하게 나온다.
    var contractPrincipalGross = 0;
    var cumIndex = NAV_BASE; // 보수 수취·재계약과 무관하게 이어지는 누적 성과 지수
    var totalDeposits = 0, totalWithdrawals = 0, totalFees = 0, totalPayouts = 0;
    var lastValuationDate = null, lastResetDate = null, lastCloseoutDate = null;
    var lastResetKind = null;   // 'fee' | 'rollover' — 기준가를 초기화한 마지막 사유
    var lastMaturityDate = null, lastRolloverDate = null;
    var maturedPending = false; // 만기 도래 후 재계약·해지 등 후속 처리가 없는 상태
    var history = [];
    var daily = [];         // 종합(컴포지트) 계산용 일간 수익률
    var evalByDate = {};    // 종합 가중치 갱신용: 일자별 하루 마감 시점 평가금액
    var warnings = [];

    function evalNow() { return units * nav / NAV_BASE; }

    function pushRow(ev, extra) {
      var row = {
        id: ev.id,
        date: ev.date,
        type: ev.type,
        label: EVENT_LABEL[ev.type],
        amount: Number(ev.amount) || 0,
        deltaUnits: 0,
        units: units,
        nav: nav,
        eval: evalNow(),
        principal: principal,
        contractPrincipal: contractPrincipal,
        // 이 이벤트로 원금 흐름이 움직인 금액. 입출금은 기입액과 같지만,
        // 전액출금(해지)은 실제 인출 현금이 아니라 "남은 원금"만큼 차감되므로 다르다.
        principalDelta: 0,
        dailyReturn: null
      };
      if (extra) for (var k in extra) row[k] = extra[k];
      // 계약 기준 손익·수익률은 총수익(Total Return) 기준 — 계약 시작 이후 지급·수취되어
      // 나간 금액을 되살려 계산한다. (배당을 지급해도 그 행의 수익률이 내려가지 않는다)
      row.contractFees = contractFees;
      row.contractPayouts = contractPayouts;
      row.contractPnl = row.eval + contractFees + contractPayouts - row.contractPrincipal;
      row.contractReturn = row.contractPrincipal > 0 ? row.contractPnl / row.contractPrincipal : null;
      // 원금 흐름 기준(전체 성과와 같은 기준)의 총수익 손익·수익률
      row.grossPnl = row.eval + totalFees + totalPayouts - row.principal;
      row.principalReturn = row.principal > 0 ? row.grossPnl / row.principal : null;
      history.push(row);
    }

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var amount = Number(ev.amount) || 0;

      if (ev.type === 'deposit') {
        var addUnits = amount * NAV_BASE / nav;
        units += addUnits;
        principal += amount;
        contractPrincipal += amount;
        contractPrincipalGross += amount;
        totalDeposits += amount;
        pushRow(ev, {
          deltaUnits: addUnits, units: units, eval: evalNow(),
          principal: principal, contractPrincipal: contractPrincipal,
          principalDelta: amount
        });

      } else if (ev.type === 'withdraw') {
        // 출금액은 원금 차감액이므로 평가금액을 초과할 수 있다.
        // (보수 수취 후 손실이 나면 "남은 원금"이 실제 잔고보다 커진다)
        // 좌수는 실제 잔고까지만 환매하고(하한 0), 원금은 입력한 금액대로 차감한다.
        var subUnits = amount * NAV_BASE / nav;
        if (subUnits > units + 1e-6) {
          warnings.push(ev.date + ' 출금액(' + Math.round(amount).toLocaleString() +
            '원)이 평가금액(' + Math.round(evalNow()).toLocaleString() +
            '원)을 초과합니다. 좌수는 0으로 정리하고 원금만 전액 차감했습니다.' +
            ' 잔여 평가금액이 있다면 입금으로 기입하세요.');
          subUnits = units;
        }
        units -= subUnits;
        principal -= amount;
        contractPrincipal -= amount;
        contractPrincipalGross -= amount;
        totalWithdrawals += amount;
        pushRow(ev, {
          deltaUnits: -subUnits, units: units, eval: evalNow(),
          principal: principal, contractPrincipal: contractPrincipal,
          principalDelta: -amount
        });

      } else if (ev.type === 'valuation' || ev.type === 'maturity') {
        // 만기는 만기 시점의 원리금(상환금)을 평가금액으로 입력하는 이벤트 —
        // 기준가·성과 반영은 일반 평가와 동일하고, 만기 도래 상태만 추가로 표시한다.
        if (units <= 1e-9) {
          warnings.push(ev.date + ' 좌수가 0인 상태의 ' +
            (ev.type === 'maturity' ? '만기 원리금' : '평가금액') + ' 입력은 무시되었습니다.');
          continue;
        }
        var beginEval = evalNow();
        var prevNav = nav;
        nav = amount * NAV_BASE / units;
        var ret = nav / prevNav - 1;
        cumIndex *= (1 + ret);
        daily.push({ date: ev.date, ret: ret, beginEval: beginEval, endEval: amount });
        lastValuationDate = ev.date;
        if (ev.type === 'maturity') {
          lastMaturityDate = ev.date;
          maturedPending = true;
        }
        pushRow(ev, { nav: nav, eval: evalNow(), dailyReturn: ret });

      } else if (ev.type === 'payout') {
        // 이자·쿠폰·배당·상환수익의 인출. 출금과 같은 자금 유출(flow)이므로 기준가는 그대로 —
        // 수익률 왜곡이 없고, 두 기준의 원금도 줄지 않는다(보수와 동일한 취급).
        var payEvalBefore = evalNow();
        if (amount > payEvalBefore + 1e-6) {
          warnings.push(ev.date + ' 이익지급액이 평가금액을 초과합니다. 내역을 확인하세요.');
        }
        // 이익만 인출하므로 계약원금은 그대로 유지된다.
        // 지급액은 contractPayouts에 쌓아 계약 기준 수익률의 분자로 되살린다 →
        // 배당을 지급해도 원금이 줄지 않고, 수익률도 지급액만큼 깎이지 않는다.
        var payUnits = amount * NAV_BASE / nav;
        if (payUnits > units) payUnits = units; // 좌수는 음수가 되지 않는다
        units -= payUnits;
        totalPayouts += amount;
        contractPayouts += amount;
        pushRow(ev, {
          deltaUnits: -payUnits, units: units, eval: evalNow(),
          principal: principal, contractPrincipal: contractPrincipal
        });

      } else if (ev.type === 'rollover') {
        // 재계약(롤오버): 새 계약이 시작되므로 기준가를 1,000으로 되돌려 계약 기준 수익률을
        // 0%로 초기화한다. 누적 성과 지수(cumIndex)는 끊기지 않고 이어진다.
        if (units <= 1e-9) {
          warnings.push(ev.date + ' 잔액이 없는 상태의 재계약은 무시되었습니다.');
          continue;
        }
        var rollEvalBefore = evalNow();
        var paidOut = 0;
        if (ev.mode === 'payout') {
          // 원금만 재계약: 이익(평가금액 − 계약원금)을 지급한 뒤 원금만 재예치.
          // 평가금액이 원금 이하(손실)면 지급할 이익이 없으므로 초기화만 한다.
          paidOut = rollEvalBefore - contractPrincipal;
          if (paidOut > 1e-6) {
            units -= paidOut * NAV_BASE / nav;
            totalPayouts += paidOut;
          } else {
            paidOut = 0;
          }
        }
        var rollEvalAfter = evalNow();
        nav = NAV_BASE;
        units = rollEvalAfter;  // 기준가 1,000이므로 좌수 = 평가금액
        contractPrincipal = rollEvalAfter; // 재예치 금액이 새 계약의 원금
        contractPrincipalGross = rollEvalBefore; // 지급분을 되살린 기준
        contractFees = 0;                  // 새 계약이 시작되므로 계약 기준 성과는 0에서 다시
        contractPayouts = 0;
        lastResetDate = ev.date;
        lastResetKind = 'rollover';
        lastRolloverDate = ev.date;
        maturedPending = false; // 재계약으로 만기 후속 처리 완료
        pushRow(ev, {
          amount: paidOut, deltaUnits: 0, units: units, nav: nav,
          eval: rollEvalAfter, principal: principal, contractPrincipal: contractPrincipal
        });

      } else if (ev.type === 'fee') {
        var evalBefore = evalNow();
        if (amount > evalBefore + 1e-6) {
          warnings.push(ev.date + ' 성과보수가 평가금액을 초과합니다. 내역을 확인하세요.');
        }
        // 보수는 성과가 아니라 자금 유출(flow)로 처리 → 수익률 왜곡 없음.
        // 배당 지급과 똑같이 원금에서 나가지 않으며, 나간 금액은 원금흐름대비·전체 성과
        // 수익률의 분자에 되살아난다.
        var feeUnits = amount * NAV_BASE / nav;
        if (feeUnits > units) feeUnits = units; // 좌수는 음수가 되지 않는다
        units -= feeUnits;
        totalFees += amount;
        contractFees += amount;
        var evalAfter = evalNow();
        // 초기화(만기 재계약과 동일한 방식): 기준가 1,000 / 좌수를 차감 후 평가금액으로 재설정하고,
        // 보수 차감 후 평가금액을 새 계약의 원금으로 승계한다 → 원금대비 수익률도 0%로 초기화.
        // 원금 흐름(principal)은 유지된다 — 보수는 원금에서 나가지 않으며, 전체 성과는
        // 원금 흐름 기준이므로 보수 수취로 총원금과 수익률이 변하지 않는다.
        nav = NAV_BASE;
        units = evalAfter; // 기준가 1,000이므로 좌수 = 평가금액
        contractPrincipal = evalAfter;
        contractPrincipalGross = evalBefore; // 보수를 되살린 기준 — 해지 시 차감할 남은 원금
        contractFees = 0;  // 새 계약이 시작되므로 계약 기준 성과는 0에서 다시
        contractPayouts = 0;
        lastResetDate = ev.date;
        lastResetKind = 'fee';
        pushRow(ev, {
          deltaUnits: 0, units: units, nav: nav, eval: evalAfter,
          principal: principal, contractPrincipal: contractPrincipal
        });

      } else if (ev.type === 'closeout') {
        if (units <= 1e-9) {
          warnings.push(ev.date + ' 잔액이 없는 상태의 전액 출금은 무시되었습니다.');
          continue;
        }
        // 현재 평가금액 전액을 출금하고 계좌를 비운다 (원금도 0으로 — 음수 원금 방지)
        var amountOut = evalNow();
        var deltaOut = -units;
        totalWithdrawals += amountOut;
        // 원금 흐름에서는 "남은 원금"(보수 되살린 계약원금)을 차감한다.
        // 같은 정리를 일반 출금으로 기입했을 때와 동일한 결과가 나오도록 맞춘 것이다.
        // 이익까지 인출한 계좌는 원금이 음수가 되며, 그만큼이 실현이익으로 잡힌다.
        var principalOut = contractPrincipalGross;
        // 실제 인출 현금과 원금 차감액의 차이 — 해지 시점의 미실현 손익을 정리한 금액이다.
        // (손실 상태면 원금이 현금보다 더 줄고, 이익 상태면 덜 줄어든다)
        var settleAdj = principalOut - amountOut;
        units = 0;
        nav = NAV_BASE;   // 이후 재입금 시 새 출발
        principal -= contractPrincipalGross;
        contractPrincipal = 0;
        contractPrincipalGross = 0;
        contractFees = 0;
        contractPayouts = 0;
        lastCloseoutDate = ev.date;
        maturedPending = false; // 만기 후 해지로 후속 처리 완료
        pushRow(ev, {
          amount: amountOut, deltaUnits: deltaOut, units: 0, nav: nav, eval: 0,
          principal: principal, contractPrincipal: 0,
          principalDelta: -principalOut, // 원금에서 실제로 빠진 금액 (인출 현금과 다를 수 있음)
          cashOut: amountOut,            // 실제 인출한 현금
          settleAdj: settleAdj           // 손익 정리분 (+면 손실 정리, −면 이익 정리)
        });
      }

      // 하루 마감 시점 평가금액 기록 (같은 날짜는 마지막 이벤트 값으로 덮어씀)
      evalByDate[ev.date] = evalNow();
    }

    var currentEval = evalNow();
    // 총수익 기준 성과 — 계좌 밖으로 나간 보수·배당을 분자에 되살린다
    var grossPrincipal = principal;
    var grossPnl = currentEval + totalFees + totalPayouts - principal;
    var contractPnl = currentEval + contractFees + contractPayouts - contractPrincipal;
    return {
      id: account.id,
      name: account.name,
      createdDate: account.createdDate,
      history: history,
      daily: daily,
      evalByDate: evalByDate,
      warnings: warnings,
      isClosed: !!lastCloseoutDate && currentEval <= 1e-6,
      lastCloseoutDate: lastCloseoutDate,
      units: units,
      nav: nav,
      principal: principal,                 // 원금 흐름 (전체 성과 기준 — 보수·재계약 무관)
      contractPrincipal: contractPrincipal, // 계약원금 (보수 수취·재계약 시 평가금액으로 승계)
      eval: currentEval,
      pnl: currentEval - principal,         // 실보유 평가손익 (유출분 제외)
      grossPrincipal: grossPrincipal,       // 해지분 포함 원금 (전체 실적 집계 기준)
      grossPnl: grossPnl,                   // 총수익 성과 (배당·보수 유출분을 되살린 값)
      contractPnl: contractPnl,             // 계약 기준 총수익 손익
      contractPrincipalGross: contractPrincipalGross, // 해지 시 원금에서 차감할 남은 원금
      contractFees: contractFees,
      contractPayouts: contractPayouts,
      navReturn: nav / NAV_BASE - 1,                                        // 기준가 수익률 (보수 수취·재계약 후 기준)
      // 계약 기준 원금대비 수익률 — 보수 수취·재계약으로 0%로 초기화되고,
      // 계약 기간 중의 배당·이익지급은 되살려 계산하므로 지급으로 깎이지 않는다.
      contractReturn: contractPrincipal > 0 ? contractPnl / contractPrincipal : 0,
      // 원금 흐름 대비 누적 수익률 — 개설 이후 나간 배당·보수를 모두 되살린 총수익 기준
      principalReturn: grossPrincipal !== 0 ? grossPnl / grossPrincipal : 0,
      cumReturn: cumIndex / NAV_BASE - 1,                                   // 개설 이후 누적 성과 수익률
      cumIndex: cumIndex,
      totalDeposits: totalDeposits,
      totalWithdrawals: totalWithdrawals,
      totalFees: totalFees,
      totalPayouts: totalPayouts,          // 누적 이익지급(이자·쿠폰·배당·상환수익)
      lastValuationDate: lastValuationDate,
      lastResetDate: lastResetDate,
      lastResetKind: lastResetKind,         // 기준가 초기화 사유: 'fee' | 'rollover'
      lastMaturityDate: lastMaturityDate,
      lastRolloverDate: lastRolloverDate,
      isMatured: maturedPending && currentEval > 1e-6 // 만기 도래·후속 처리 대기
    };
  }

  /*
   * 종합 성과 수익률 (컴포지트):
   * 계좌별 일간 기준가 수익률(입출금 왜곡 없음)을 직전 평가금액 가중으로 합산하여
   * 일간 컴포지트 수익률을 만들고, 이를 체인링크하여 지수(1,000 시작)를 산출한다.
   * - 해당 일자에 평가가 없는 계좌는 수익률 0으로 직전 평가금액만큼 가중치에 포함된다.
   * - 계좌는 첫 평가일부터 컴포지트에 편입된다.
   * - 입출금·성과보수·전액출금으로 잔액이 바뀌면 그날 마감 잔액(evalByDate)으로
   *   가중치를 갱신한다. 전액 출금(해지)된 계좌는 이후 가중치 0으로 제외된다.
   */
  function computeComposite(processedAccounts) {
    var byDate = new Map();
    var dateSet = new Set();
    processedAccounts.forEach(function (p) {
      p.daily.forEach(function (d) {
        if (!byDate.has(d.date)) byDate.set(d.date, []);
        byDate.get(d.date).push({ id: p.id, ret: d.ret, beginEval: d.beginEval, endEval: d.endEval });
        dateSet.add(d.date);
      });
      Object.keys(p.evalByDate || {}).forEach(function (d) { dateSet.add(d); });
    });
    var dates = Array.from(dateSet).sort();
    var lastEval = new Map();
    var index = NAV_BASE;
    var series = [];
    dates.forEach(function (date) {
      var recs = byDate.get(date) || [];
      if (recs.length) {
        var present = new Set(recs.map(function (r) { return r.id; }));
        var w = 0, wr = 0;
        recs.forEach(function (r) { w += r.beginEval; wr += r.beginEval * r.ret; });
        lastEval.forEach(function (ev, id) { if (!present.has(id)) w += ev; });
        var ret = w > 0 ? wr / w : 0;
        index *= (1 + ret);
        series.push({ date: date, ret: ret, index: index });
        recs.forEach(function (r) { lastEval.set(r.id, r.endEval); });
      }
      // 이 날짜에 잔액이 바뀐 계좌의 가중치를 하루 마감 잔액으로 갱신
      // (첫 평가 전의 계좌는 아직 편입 전이므로 건너뛴다)
      processedAccounts.forEach(function (p) {
        if (p.evalByDate && p.evalByDate[date] !== undefined && lastEval.has(p.id)) {
          lastEval.set(p.id, p.evalByDate[date]);
        }
      });
    });
    return { index: index, ret: index / NAV_BASE - 1, series: series };
  }

  function computeSummary(processedAccounts) {
    var totalEval = 0, totalPrincipal = 0, totalFees = 0, totalPayouts = 0;
    var totalDeposits = 0, totalWithdrawals = 0, totalPnl = 0, grossPnl = 0;
    // 전체 실적 기준 성과: 이미 실현되어 계좌 밖으로 나간 성과를 되살려 계산한다.
    //  · 성과보수(totalFees)  — 수익에서 지출된 비용
    //  · 이익지급(totalPayouts) — 만기·이표 시 지급된 이자·쿠폰·배당·상환수익
    // 개별 계좌는 보수 수취·재계약 시 기준가·수익률이 0으로 초기화되지만,
    // 종합(전체) 실적에서는 이 유출로 성과가 깎여 보이지 않도록 다시 더한다.
    // 계좌 단위에서 이미 총수익 기준으로 계산된 값(grossPrincipal·grossPnl)을 합산하므로
    // 해지된 계좌의 원금·성과도 사라지지 않는다.
    processedAccounts.forEach(function (p) {
      totalEval += p.eval;
      totalPrincipal += p.grossPrincipal;
      totalPnl += p.pnl;
      grossPnl += p.grossPnl;
      totalFees += p.totalFees;
      totalPayouts += p.totalPayouts || 0;
      totalDeposits += p.totalDeposits;
      totalWithdrawals += p.totalWithdrawals;
    });
    return {
      totalEval: totalEval,
      totalPrincipal: totalPrincipal,
      totalPnl: totalPnl,          // 현재 보유 기준 평가손익 (보수·이익지급 유출 후 실보유)
      grossPnl: grossPnl,          // 보수·이익지급 포함 총성과 (전체 실적 기준 — 수취·재계약과 무관)
      simpleReturn: totalPrincipal > 0 ? grossPnl / totalPrincipal : 0, // 원금대비 단순 수익률 (보수·재계약으로 줄지 않음)
      totalFees: totalFees,
      totalPayouts: totalPayouts,
      totalDeposits: totalDeposits,
      totalWithdrawals: totalWithdrawals
    };
  }

  var api = {
    NAV_BASE: NAV_BASE,
    EVENT_LABEL: EVENT_LABEL,
    sortEvents: sortEvents,
    processAccount: processAccount,
    computeComposite: computeComposite,
    computeSummary: computeSummary
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
