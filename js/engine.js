/*
 * engine.js — 계좌별 기준가/좌수 계산 엔진 (순수 함수, DOM 비의존)
 *
 * 회계 방식 (펀드 기준가 방식):
 *  - 기준가는 1,000좌당 가격이며 계좌 개설 시 1,000.00 에서 시작한다.
 *  - 입금/출금은 "현재 기준가"로 좌수를 발행/환매하므로 수익률(기준가)에 영향을 주지 않는다.
 *  - 일일 평가금액이 입력되면 기준가 = 평가금액 × 1000 ÷ 좌수 로 갱신된다.
 *  - 성과보수 수취 시 보수액을 차감(출금과 동일하게 좌수 차감)한 뒤,
 *    기준가를 1,000으로, 좌수와 원금을 차감 후 평가금액으로 재설정하여 수익률을 초기화한다.
 *
 * 이벤트 처리 순서(같은 날짜):
 *  - 입금/출금/평가는 사용자가 입력한 순서(seq)대로 처리한다.
 *    · 입금 기입 → 평가 입력: 입금은 직전 기준가로 좌수 발행 후 평가로 기준가 갱신
 *    · 평가 입력 → 입금 기입: 입금은 그날 갱신된 기준가로 발행되어 수익률 희석 없음
 *  - 성과보수는 입력 순서와 무관하게 항상 그날의 마지막에 처리한다.
 *    (당일 평가 반영 → 보수 차감 → 초기화 순서가 보장되어야
 *     기준가 수익률이 정확히 0으로 초기화되고 종합 성과 수익률이 오염되지 않는다)
 */
(function (global) {
  'use strict';

  var NAV_BASE = 1000;
  var EVENT_ORDER = { deposit: 0, withdraw: 1, valuation: 2, fee: 3 };
  var EVENT_LABEL = { deposit: '입금', withdraw: '출금', valuation: '평가', fee: '성과보수' };

  function sortEvents(events) {
    return events.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      // 성과보수는 입력 순서와 무관하게 항상 그날의 마지막에 처리한다.
      // (당일 평가가 반영된 뒤 보수를 차감·초기화해야 수익률이 오염되지 않는다)
      var af = a.type === 'fee' ? 1 : 0;
      var bf = b.type === 'fee' ? 1 : 0;
      if (af !== bf) return af - bf;
      // 나머지(입금/출금/평가)는 입력 순서(seq)대로 — 실제 발생 순서와 일치시킨다.
      var s = (a.seq || 0) - (b.seq || 0);
      if (s !== 0) return s;
      return EVENT_ORDER[a.type] - EVENT_ORDER[b.type];
    });
  }

  function processAccount(account) {
    var events = sortEvents(account.events || []);
    var units = 0;          // 좌수
    var nav = NAV_BASE;     // 기준가 (1,000좌당)
    var principal = 0;      // 원금 (순입금, 보수 수취 시 재설정)
    var cumIndex = NAV_BASE; // 보수 수취와 무관하게 이어지는 누적 성과 지수
    var totalDeposits = 0, totalWithdrawals = 0, totalFees = 0;
    var lastValuationDate = null, lastResetDate = null;
    var history = [];
    var daily = [];         // 종합(컴포지트) 계산용 일간 수익률
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
        dailyReturn: null
      };
      if (extra) for (var k in extra) row[k] = extra[k];
      history.push(row);
    }

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var amount = Number(ev.amount) || 0;

      if (ev.type === 'deposit') {
        var addUnits = amount * NAV_BASE / nav;
        units += addUnits;
        principal += amount;
        totalDeposits += amount;
        pushRow(ev, { deltaUnits: addUnits, units: units, eval: evalNow(), principal: principal });

      } else if (ev.type === 'withdraw') {
        var subUnits = amount * NAV_BASE / nav;
        if (subUnits > units + 1e-6) {
          warnings.push(ev.date + ' 출금액이 평가금액을 초과하여 좌수가 음수가 되었습니다. 내역을 확인하세요.');
        }
        units -= subUnits;
        principal -= amount;
        totalWithdrawals += amount;
        pushRow(ev, { deltaUnits: -subUnits, units: units, eval: evalNow(), principal: principal });

      } else if (ev.type === 'valuation') {
        if (units <= 1e-9) {
          warnings.push(ev.date + ' 좌수가 0인 상태의 평가금액 입력은 무시되었습니다.');
          continue;
        }
        var beginEval = evalNow();
        var prevNav = nav;
        nav = amount * NAV_BASE / units;
        var ret = nav / prevNav - 1;
        cumIndex *= (1 + ret);
        daily.push({ date: ev.date, ret: ret, beginEval: beginEval, endEval: amount });
        lastValuationDate = ev.date;
        pushRow(ev, { nav: nav, eval: evalNow(), dailyReturn: ret });

      } else if (ev.type === 'fee') {
        var evalBefore = evalNow();
        if (amount > evalBefore + 1e-6) {
          warnings.push(ev.date + ' 성과보수가 평가금액을 초과합니다. 내역을 확인하세요.');
        }
        // 보수는 성과가 아니라 자금 유출(flow)로 처리 → 수익률 왜곡 없음
        units -= amount * NAV_BASE / nav;
        totalFees += amount;
        var evalAfter = evalNow();
        // 초기화: 기준가 1,000 / 좌수·원금을 차감 후 평가금액으로 재설정
        nav = NAV_BASE;
        units = evalAfter; // 기준가 1,000이므로 좌수 = 평가금액
        principal = evalAfter;
        lastResetDate = ev.date;
        pushRow(ev, { deltaUnits: 0, units: units, nav: nav, eval: evalAfter, principal: principal });
      }
    }

    var currentEval = evalNow();
    return {
      id: account.id,
      name: account.name,
      history: history,
      daily: daily,
      warnings: warnings,
      units: units,
      nav: nav,
      principal: principal,
      eval: currentEval,
      pnl: currentEval - principal,
      navReturn: nav / NAV_BASE - 1,                                        // 기준가 수익률 (보수 수취 후 기준)
      principalReturn: principal > 0 ? (currentEval - principal) / principal : 0, // 원금대비 수익률
      cumReturn: cumIndex / NAV_BASE - 1,                                   // 개설 이후 누적 성과 수익률
      cumIndex: cumIndex,
      totalDeposits: totalDeposits,
      totalWithdrawals: totalWithdrawals,
      totalFees: totalFees,
      lastValuationDate: lastValuationDate,
      lastResetDate: lastResetDate
    };
  }

  /*
   * 종합 성과 수익률 (컴포지트):
   * 계좌별 일간 기준가 수익률(입출금 왜곡 없음)을 직전 평가금액 가중으로 합산하여
   * 일간 컴포지트 수익률을 만들고, 이를 체인링크하여 지수(1,000 시작)를 산출한다.
   * 해당 일자에 평가가 없는 계좌는 수익률 0으로 직전 평가금액만큼 가중치에 포함된다.
   */
  function computeComposite(processedAccounts) {
    var byDate = new Map();
    processedAccounts.forEach(function (p) {
      p.daily.forEach(function (d) {
        if (!byDate.has(d.date)) byDate.set(d.date, []);
        byDate.get(d.date).push({ id: p.id, ret: d.ret, beginEval: d.beginEval, endEval: d.endEval });
      });
    });
    var dates = Array.from(byDate.keys()).sort();
    var lastEval = new Map();
    var index = NAV_BASE;
    var series = [];
    dates.forEach(function (date) {
      var recs = byDate.get(date);
      var present = new Set(recs.map(function (r) { return r.id; }));
      var w = 0, wr = 0;
      recs.forEach(function (r) { w += r.beginEval; wr += r.beginEval * r.ret; });
      lastEval.forEach(function (ev, id) { if (!present.has(id)) w += ev; });
      var ret = w > 0 ? wr / w : 0;
      index *= (1 + ret);
      recs.forEach(function (r) { lastEval.set(r.id, r.endEval); });
      series.push({ date: date, ret: ret, index: index });
    });
    return { index: index, ret: index / NAV_BASE - 1, series: series };
  }

  function computeSummary(processedAccounts) {
    var totalEval = 0, totalPrincipal = 0, totalFees = 0, totalDeposits = 0, totalWithdrawals = 0;
    processedAccounts.forEach(function (p) {
      totalEval += p.eval;
      totalPrincipal += p.principal;
      totalFees += p.totalFees;
      totalDeposits += p.totalDeposits;
      totalWithdrawals += p.totalWithdrawals;
    });
    return {
      totalEval: totalEval,
      totalPrincipal: totalPrincipal,
      totalPnl: totalEval - totalPrincipal,
      simpleReturn: totalPrincipal > 0 ? (totalEval - totalPrincipal) / totalPrincipal : 0, // 원금대비 단순 수익률
      totalFees: totalFees,
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
