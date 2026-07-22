/*
 * app.js — 화면 렌더링, 이벤트 처리, localStorage 저장, 엑셀 다운로드
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'profit-calculator-data-v1';
  var state = { accounts: [] };
  var selectedAccountId = null;
  var seqCounter = 1;

  // ---------- 저장/불러오기 ----------

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.accounts)) state = parsed;
      }
    } catch (e) { /* 손상된 데이터는 무시하고 새로 시작 */ }
    var maxSeq = 0;
    state.accounts.forEach(function (a) {
      (a.events || []).forEach(function (ev) { if (ev.seq > maxSeq) maxSeq = ev.seq; });
    });
    seqCounter = maxSeq + 1;
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ---------- 유틸 ----------

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
  }

  function fmtWon(n) {
    return Math.round(n).toLocaleString('ko-KR') + '원';
  }

  function fmtNum(n, digits) {
    return n.toLocaleString('ko-KR', {
      minimumFractionDigits: digits, maximumFractionDigits: digits
    });
  }

  function fmtPct(r) {
    return (r * 100).toFixed(2) + '%';
  }

  function pctClass(r) {
    if (r > 0.00005) return 'pos';
    if (r < -0.00005) return 'neg';
    return '';
  }

  function el(id) { return document.getElementById(id); }

  function h(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function getAccount(id) {
    return state.accounts.find(function (a) { return a.id === id; }) || null;
  }

  // ---------- 계산 ----------

  function computeAll() {
    var processed = state.accounts.map(Engine.processAccount);
    return {
      processed: processed,
      summary: Engine.computeSummary(processed),
      composite: Engine.computeComposite(processed)
    };
  }

  // ---------- 렌더링 ----------

  function render() {
    var result = computeAll();
    renderSummary(result);
    renderAccountsTable(result);
    renderDetail(result);
  }

  function card(label, value, sub, cls) {
    return h('div', { class: 'card' }, [
      h('div', { class: 'card-label', text: label }),
      h('div', { class: 'card-value' + (cls ? ' ' + cls : ''), text: value }),
      sub ? h('div', { class: 'card-sub', text: sub }) : null
    ]);
  }

  function renderSummary(result) {
    var s = result.summary, comp = result.composite;
    var wrap = el('summary-cards');
    wrap.innerHTML = '';
    wrap.appendChild(card('총 원금', fmtWon(s.totalPrincipal), '누적입금 ' + fmtWon(s.totalDeposits) + ' · 누적출금 ' + fmtWon(s.totalWithdrawals)));
    wrap.appendChild(card('총 평가금액', fmtWon(s.totalEval), '평가손익 ' + fmtWon(s.totalPnl), pctClass(s.totalPnl)));
    wrap.appendChild(card('종합 성과 수익률', fmtPct(comp.ret), '기준가 방식 · 지수 ' + fmtNum(comp.index, 2), pctClass(comp.ret)));
    wrap.appendChild(card('원금대비 단순 수익률', fmtPct(s.simpleReturn), '(총평가 − 총원금) ÷ 총원금', pctClass(s.simpleReturn)));
    wrap.appendChild(card('누적 성과보수', fmtWon(s.totalFees), ''));
  }

  function renderAccountsTable(result) {
    var tbody = el('accounts-table').querySelector('tbody');
    tbody.innerHTML = '';
    el('accounts-empty').hidden = state.accounts.length > 0;
    el('accounts-table').hidden = state.accounts.length === 0;

    result.processed.forEach(function (p) {
      var tr = h('tr', {
        class: p.id === selectedAccountId ? 'selected' : '',
        onclick: function () {
          selectedAccountId = (selectedAccountId === p.id) ? null : p.id;
          render();
        }
      }, [
        h('td', { class: 'name' }, [
          h('span', { text: p.name }),
          p.isClosed ? h('span', { class: 'tag tag-closed', text: '해지' }) : null
        ]),
        h('td', { text: fmtWon(p.principal), class: 'num' }),
        h('td', { text: fmtWon(p.eval), class: 'num' }),
        h('td', { text: fmtWon(p.pnl), class: 'num ' + pctClass(p.pnl) }),
        h('td', { text: fmtNum(p.nav, 2), class: 'num' }),
        h('td', { text: fmtNum(p.units, 0), class: 'num' }),
        h('td', { text: fmtPct(p.navReturn), class: 'num ' + pctClass(p.navReturn) }),
        h('td', { text: fmtPct(p.principalReturn), class: 'num ' + pctClass(p.principalReturn) }),
        h('td', { text: p.lastValuationDate || '-', class: 'date' })
      ]);
      tbody.appendChild(tr);
    });
  }

  function renderDetail(result) {
    var panel = el('detail-panel');
    var p = result.processed.find(function (x) { return x.id === selectedAccountId; });
    if (!p) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    el('detail-title').textContent = p.name + (p.isClosed ? ' (해지)' : '');

    var cards = el('detail-cards');
    cards.innerHTML = '';
    cards.appendChild(card('기준가', fmtNum(p.nav, 2), '1,000좌 기준'));
    cards.appendChild(card('좌수', fmtNum(p.units, 0), ''));
    cards.appendChild(card('원금', fmtWon(p.principal), ''));
    cards.appendChild(card('평가금액', fmtWon(p.eval), '평가손익 ' + fmtWon(p.pnl), pctClass(p.pnl)));
    cards.appendChild(card('기준가 수익률', fmtPct(p.navReturn), p.lastResetDate ? '보수수취(' + p.lastResetDate + ') 이후' : '개설 이후', pctClass(p.navReturn)));
    cards.appendChild(card('원금대비 수익률', fmtPct(p.principalReturn), '', pctClass(p.principalReturn)));
    cards.appendChild(card('누적 성과 수익률', fmtPct(p.cumReturn), '보수수취 무관, 개설 이후', pctClass(p.cumReturn)));
    cards.appendChild(card('누적 성과보수', fmtWon(p.totalFees), ''));

    var warnBox = el('detail-warnings');
    warnBox.innerHTML = '';
    p.warnings.forEach(function (w) {
      warnBox.appendChild(h('div', { class: 'warning', text: '⚠ ' + w }));
    });

    var tbody = el('history-table').querySelector('tbody');
    tbody.innerHTML = '';
    p.history.slice().reverse().forEach(function (row) {
      var delBtn = h('button', {
        class: 'btn tiny danger', text: '삭제',
        onclick: function (e) {
          e.stopPropagation();
          if (!confirm(row.date + ' ' + row.label + ' 내역을 삭제할까요? 이후 수치가 다시 계산됩니다.')) return;
          var acc = getAccount(p.id);
          acc.events = acc.events.filter(function (ev) { return ev.id !== row.id; });
          saveState();
          render();
        }
      });
      tbody.appendChild(h('tr', {}, [
        h('td', { text: row.date, class: 'date' }),
        h('td', {}, [h('span', { class: 'tag tag-' + row.type, text: row.label })]),
        h('td', { text: row.type === 'valuation' ? '-' : fmtWon(row.amount), class: 'num' }),
        h('td', { text: row.deltaUnits ? fmtNum(row.deltaUnits, 0) : '-', class: 'num' }),
        h('td', { text: fmtNum(row.units, 0), class: 'num' }),
        h('td', { text: fmtNum(row.nav, 2), class: 'num' }),
        h('td', { text: fmtWon(row.eval), class: 'num' }),
        h('td', { text: fmtWon(row.principal), class: 'num' }),
        h('td', { text: row.dailyReturn === null ? '-' : fmtPct(row.dailyReturn), class: 'num ' + (row.dailyReturn === null ? '' : pctClass(row.dailyReturn)) }),
        h('td', {}, [delBtn])
      ]));
    });
  }

  // ---------- 이벤트 추가 ----------

  function addEvent(accountId, type, date, amount) {
    var acc = getAccount(accountId);
    if (!acc) return;
    if (type === 'valuation') {
      // 같은 날짜의 평가금액은 덮어쓴다 (장 마감 후 수정 입력 허용)
      var existing = acc.events.find(function (ev) { return ev.type === 'valuation' && ev.date === date; });
      if (existing) {
        existing.amount = amount;
        saveState();
        render();
        return;
      }
    }
    acc.events.push({ id: uid(), seq: seqCounter++, type: type, date: date, amount: amount });
    saveState();
    render();
  }

  function readForm(form) {
    var date = form.elements.date.value;
    var amount = parseFloat(form.elements.amount.value);
    if (!date) { alert('날짜를 입력하세요.'); return null; }
    if (!isFinite(amount) || amount < 0) { alert('금액을 올바르게 입력하세요.'); return null; }
    return { date: date, amount: amount };
  }

  // ---------- 엑셀 ----------

  function buildWorkbook(result) {
    var S = XlsxWriter.S;
    var s = result.summary, comp = result.composite;

    var summaryRows = [
      [{ v: '자산운용 종합 현황', s: S.BOLD }, null, { v: '생성일: ' + todayStr() }],
      [],
      [{ v: '종합 지표', s: S.HEAD }, { v: '', s: S.HEAD }],
      [{ v: '총 원금' }, { v: Math.round(s.totalPrincipal), s: S.INT }],
      [{ v: '총 평가금액' }, { v: Math.round(s.totalEval), s: S.INT }],
      [{ v: '총 평가손익' }, { v: Math.round(s.totalPnl), s: S.INT }],
      [{ v: '원금대비 단순 수익률' }, { v: s.simpleReturn, s: S.PCT }],
      [{ v: '종합 성과 수익률 (기준가 방식)' }, { v: comp.ret, s: S.PCT }],
      [{ v: '종합 성과 지수 (1,000 시작)' }, { v: comp.index, s: S.DEC }],
      [{ v: '누적 입금' }, { v: Math.round(s.totalDeposits), s: S.INT }],
      [{ v: '누적 출금' }, { v: Math.round(s.totalWithdrawals), s: S.INT }],
      [{ v: '누적 성과보수' }, { v: Math.round(s.totalFees), s: S.INT }],
      [],
      [
        { v: '계좌명', s: S.HEAD }, { v: '원금', s: S.HEAD }, { v: '평가금액', s: S.HEAD },
        { v: '평가손익', s: S.HEAD }, { v: '기준가', s: S.HEAD }, { v: '좌수', s: S.HEAD },
        { v: '기준가 수익률', s: S.HEAD }, { v: '원금대비 수익률', s: S.HEAD },
        { v: '누적 성과 수익률', s: S.HEAD }, { v: '누적입금', s: S.HEAD },
        { v: '누적출금', s: S.HEAD }, { v: '누적 성과보수', s: S.HEAD },
        { v: '최근 평가일', s: S.HEAD }, { v: '최근 보수수취일', s: S.HEAD }
      ]
    ];
    result.processed.forEach(function (p) {
      summaryRows.push([
        { v: p.name + (p.isClosed ? ' (해지)' : '') },
        { v: Math.round(p.principal), s: S.INT },
        { v: Math.round(p.eval), s: S.INT },
        { v: Math.round(p.pnl), s: S.INT },
        { v: p.nav, s: S.DEC },
        { v: Math.round(p.units), s: S.INT },
        { v: p.navReturn, s: S.PCT },
        { v: p.principalReturn, s: S.PCT },
        { v: p.cumReturn, s: S.PCT },
        { v: Math.round(p.totalDeposits), s: S.INT },
        { v: Math.round(p.totalWithdrawals), s: S.INT },
        { v: Math.round(p.totalFees), s: S.INT },
        { v: p.lastValuationDate || '-' },
        { v: p.lastResetDate || '-' }
      ]);
    });
    summaryRows.push([
      { v: '합계', s: S.BOLD },
      { v: Math.round(s.totalPrincipal), s: S.BOLD_INT },
      { v: Math.round(s.totalEval), s: S.BOLD_INT },
      { v: Math.round(s.totalPnl), s: S.BOLD_INT },
      null, null,
      null,
      { v: s.simpleReturn, s: S.PCT },
      null,
      { v: Math.round(s.totalDeposits), s: S.BOLD_INT },
      { v: Math.round(s.totalWithdrawals), s: S.BOLD_INT },
      { v: Math.round(s.totalFees), s: S.BOLD_INT }
    ]);

    var sheets = [{
      name: '종합요약',
      colWidths: [26, 14, 14, 14, 10, 14, 14, 15, 15, 14, 14, 14, 12, 14],
      rows: summaryRows
    }];

    // 종합 성과 지수 일별 시계열
    if (comp.series.length) {
      var idxRows = [[
        { v: '일자', s: S.HEAD }, { v: '일간 수익률', s: S.HEAD }, { v: '성과 지수', s: S.HEAD }
      ]];
      comp.series.forEach(function (r) {
        idxRows.push([{ v: r.date }, { v: r.ret, s: S.PCT }, { v: r.index, s: S.DEC }]);
      });
      sheets.push({ name: '종합지수', colWidths: [12, 12, 12], rows: idxRows });
    }

    var usedNames = { '종합요약': true, '종합지수': true };
    result.processed.forEach(function (p, i) {
      var base = XlsxWriter.sanitizeSheetName(p.name, '계좌' + (i + 1));
      var name = base, n = 2;
      while (usedNames[name]) name = (base.slice(0, 28) + '(' + (n++) + ')');
      usedNames[name] = true;

      var rows = [[
        { v: '일자', s: S.HEAD }, { v: '구분', s: S.HEAD }, { v: '금액', s: S.HEAD },
        { v: '좌수 증감', s: S.HEAD }, { v: '좌수', s: S.HEAD }, { v: '기준가', s: S.HEAD },
        { v: '평가금액', s: S.HEAD }, { v: '원금', s: S.HEAD }, { v: '일간 수익률', s: S.HEAD }
      ]];
      p.history.forEach(function (row) {
        rows.push([
          { v: row.date },
          { v: row.label },
          row.type === 'valuation' ? null : { v: Math.round(row.amount), s: S.INT },
          row.deltaUnits ? { v: Math.round(row.deltaUnits), s: S.INT } : null,
          { v: Math.round(row.units), s: S.INT },
          { v: row.nav, s: S.DEC },
          { v: Math.round(row.eval), s: S.INT },
          { v: Math.round(row.principal), s: S.INT },
          row.dailyReturn === null ? null : { v: row.dailyReturn, s: S.PCT }
        ]);
      });
      sheets.push({ name: name, colWidths: [12, 10, 14, 14, 14, 10, 14, 14, 12], rows: rows });
    });

    return sheets;
  }

  function downloadXlsx() {
    if (!state.accounts.length) { alert('등록된 계좌가 없습니다.'); return; }
    var result = computeAll();
    var bytes = XlsxWriter.build(buildWorkbook(result));
    var blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
    triggerDownload(blob, '자산운용현황_' + todayStr() + '.xlsx');
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- 백업/복원 ----------

  function backupJson() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    triggerDownload(blob, '자산운용백업_' + todayStr() + '.json');
  }

  function restoreJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var parsed = JSON.parse(reader.result);
        if (!parsed || !Array.isArray(parsed.accounts)) throw new Error('형식 오류');
        if (!confirm('현재 데이터를 백업 파일 내용으로 교체할까요?')) return;
        state = parsed;
        selectedAccountId = null;
        saveState();
        loadState();
        render();
      } catch (e) {
        alert('백업 파일을 읽을 수 없습니다: ' + e.message);
      }
    };
    reader.readAsText(file);
  }

  // ---------- 초기화 ----------

  function init() {
    loadState();

    // 계좌 추가 다이얼로그
    var dialog = el('account-dialog');
    el('btn-add-account').addEventListener('click', function () {
      var form = el('form-account');
      form.reset();
      form.elements.date.value = todayStr();
      dialog.showModal();
    });
    el('btn-cancel-account').addEventListener('click', function () { dialog.close(); });
    el('form-account').addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var name = form.elements.name.value.trim();
      var v = readForm(form);
      if (!name) { alert('계좌명을 입력하세요.'); return; }
      if (!v) return;
      if (v.amount <= 0) { alert('초기 원금은 0보다 커야 합니다.'); return; }
      var acc = {
        id: uid(),
        name: name,
        createdDate: v.date,
        events: [{ id: uid(), seq: seqCounter++, type: 'deposit', date: v.date, amount: v.amount }]
      };
      state.accounts.push(acc);
      selectedAccountId = acc.id;
      saveState();
      dialog.close();
      render();
    });

    // 일일 평가금액
    el('form-valuation').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = readForm(e.target);
      if (!v) return;
      addEvent(selectedAccountId, 'valuation', v.date, v.amount);
      e.target.elements.amount.value = '';
    });

    // 입출금 · 전액 출금(해지)
    el('form-flow').elements.type.addEventListener('change', function (e) {
      var isCloseout = e.target.value === 'closeout';
      var amt = el('form-flow').elements.amount;
      amt.disabled = isCloseout;
      amt.required = !isCloseout;
      if (isCloseout) amt.value = '';
      amt.placeholder = isCloseout ? '전액 자동 계산' : '예: 10000000';
    });
    el('form-flow').addEventListener('submit', function (e) {
      e.preventDefault();
      var type = e.target.elements.type.value; // deposit | withdraw | closeout
      if (type === 'closeout') {
        var date = e.target.elements.date.value;
        if (!date) { alert('날짜를 입력하세요.'); return; }
        var pc = computeAll().processed.find(function (x) { return x.id === selectedAccountId; });
        if (!pc || pc.eval <= 0.005) { alert('출금할 잔액이 없습니다.'); return; }
        if (!confirm('현재 평가금액 전액(' + fmtWon(pc.eval) + ')을 출금하고 계좌를 해지 상태로 만듭니다.\n' +
          '해지 시점까지의 성과는 종합 성과 수익률에 그대로 보존됩니다. 진행할까요?')) return;
        addEvent(selectedAccountId, 'closeout', date, 0);
        return;
      }
      var v = readForm(e.target);
      if (!v) return;
      if (type === 'withdraw') {
        var p = computeAll().processed.find(function (x) { return x.id === selectedAccountId; });
        if (p && v.amount > p.eval + 1e-6 &&
            !confirm('출금액이 현재 평가금액(' + fmtWon(p.eval) + ')을 초과합니다. 계속할까요?')) return;
      }
      addEvent(selectedAccountId, type, v.date, v.amount);
      e.target.elements.amount.value = '';
    });

    // 성과보수 수취
    el('form-fee').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = readForm(e.target);
      if (!v) return;
      var p = computeAll().processed.find(function (x) { return x.id === selectedAccountId; });
      if (p && v.amount > p.eval + 1e-6) {
        alert('성과보수가 현재 평가금액(' + fmtWon(p.eval) + ')을 초과할 수 없습니다.');
        return;
      }
      if (!confirm('성과보수 ' + fmtWon(v.amount) + ' 수취 후 기준가 1,000 / 수익률 0%로 초기화됩니다. 진행할까요?')) return;
      addEvent(selectedAccountId, 'fee', v.date, v.amount);
      e.target.elements.amount.value = '';
    });

    // 계좌 삭제
    el('btn-delete-account').addEventListener('click', function () {
      var acc = getAccount(selectedAccountId);
      if (!acc) return;
      if (!confirm('"' + acc.name + '" 계좌와 모든 내역을 삭제할까요? 되돌릴 수 없습니다.')) return;
      state.accounts = state.accounts.filter(function (a) { return a.id !== selectedAccountId; });
      selectedAccountId = null;
      saveState();
      render();
    });

    // 상단 도구
    el('btn-export-xlsx').addEventListener('click', downloadXlsx);
    el('btn-backup').addEventListener('click', backupJson);
    el('btn-restore').addEventListener('click', function () { el('restore-file').click(); });
    el('restore-file').addEventListener('change', function (e) {
      if (e.target.files[0]) restoreJson(e.target.files[0]);
      e.target.value = '';
    });

    // 날짜 기본값
    ['form-valuation', 'form-flow', 'form-fee'].forEach(function (id) {
      el(id).elements.date.value = todayStr();
    });

    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
