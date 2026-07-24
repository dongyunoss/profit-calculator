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
    lastResult = result;
    renderSummary(result);
    renderChart(result);
    renderAccountsTable(result);
    renderDetail(result);
  }

  // ---------- 수익률 추이 차트 ----------

  // 계좌별 카테고리 색상 (dataviz 검증 팔레트, 고정 순서로 배정)
  var SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
  var COMPOSITE_COLOR = '#2456c6';
  var chartMode = 'composite';
  var lastResult = null;

  // 계좌별 누적 수익률 시계열: daily(순수 기준가 수익률)를 체인링크 (보수 리셋 무관, 개설 이후 누적)
  function accountReturnSeries(p) {
    var idx = Engine.NAV_BASE, pts = [{ x: p.createdDate || (p.daily[0] && p.daily[0].date), y: 0 }];
    if (!pts[0].x && p.daily.length) pts[0].x = p.daily[0].date;
    p.daily.forEach(function (d) {
      idx *= (1 + d.ret);
      pts.push({ x: d.date, y: idx / Engine.NAV_BASE - 1 });
    });
    return pts;
  }

  function renderChart(result) {
    var panel = el('chart-panel');
    var processed = result.processed;
    var hasData = result.composite.series.length > 0 ||
      processed.some(function (p) { return p.daily.length > 0; });
    panel.hidden = !hasData;
    if (!hasData) return;

    // 토글 활성화 상태
    Array.prototype.forEach.call(el('chart-toggle').querySelectorAll('.chip'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-mode') === chartMode);
    });

    var legend = el('chart-legend');
    legend.innerHTML = '';
    var note = el('chart-note');

    if (chartMode === 'composite') {
      var comp = result.composite;
      var pts = [{ x: comp.series.length ? firstDate(processed) : '', y: 0 }].filter(function (p) { return p.x; });
      comp.series.forEach(function (s) { pts.push({ x: s.date, y: s.index / Engine.NAV_BASE - 1 }); });
      var cats = pts.map(function (p) { return p.x; });
      Chart.renderLineChart(el('chart-area'), {
        series: [{ name: '종합 성과 수익률', color: COMPOSITE_COLOR, points: pts, emphasis: true }],
        categories: cats
      });
      note.textContent = '전 계좌를 자산가중으로 합산한 종합 성과 지수(1,000 시작)의 누적 수익률입니다. 입출금·성과보수의 영향을 배제한 순수 운용 성과입니다.';
    } else {
      // 평가 데이터가 있는 계좌만
      var active = processed.filter(function (p) { return p.daily.length > 0; });
      var dateSet = {};
      var seriesList = active.map(function (p, i) {
        var pts = accountReturnSeries(p);
        pts.forEach(function (pt) { if (pt.x) dateSet[pt.x] = 1; });
        var color = SERIES_COLORS[i % SERIES_COLORS.length];
        // 범례
        legend.appendChild(h('span', { class: 'legend-item' }, [
          h('span', { class: 'legend-swatch', style: 'background:' + color }),
          h('span', { text: p.name + (p.isClosed ? ' (해지)' : '') })
        ]));
        return { name: p.name, color: color, points: pts };
      });
      var cats = Object.keys(dateSet).sort();
      Chart.renderLineChart(el('chart-area'), { series: seriesList, categories: cats });
      note.textContent = '계좌별 개설 이후 누적 수익률(기준가 방식)입니다. 성과보수 수취로 인한 리셋과 무관하게 순수 성과가 이어집니다.';
    }
  }

  function firstDate(processed) {
    var dates = [];
    processed.forEach(function (p) {
      if (p.createdDate) dates.push(p.createdDate);
      if (p.daily[0]) dates.push(p.daily[0].date);
    });
    return dates.sort()[0] || '';
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

    renderLedgerTable(p);
    renderDailyTable(p);

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
        h('td', { text: row.type === 'valuation' && row.principal > 0 ? fmtPct((row.eval - row.principal) / row.principal) : '-',
          class: 'num ' + (row.type === 'valuation' && row.principal > 0 ? pctClass((row.eval - row.principal) / row.principal) : '') }),
        h('td', { text: row.dailyReturn === null ? '-' : fmtPct(row.dailyReturn), class: 'num ' + (row.dailyReturn === null ? '' : pctClass(row.dailyReturn)) }),
        h('td', {}, [delBtn])
      ]));
    });
  }

  // 원금 원장: 원금(최초) → [추가입금, 원금합] 반복 → 현재 원금
  function renderLedgerTable(p) {
    var tbody = el('ledger-table').querySelector('tbody');
    tbody.innerHTML = '';
    var flows = p.history.filter(function (r) { return FLOW_TYPES[r.type]; });
    flows.forEach(function (f, i) {
      if (i === 0) {
        tbody.appendChild(h('tr', { class: 'lg-principal' }, [
          h('td', { text: '원금' }),
          h('td', { text: '', class: 'date' }),
          h('td', { text: fmtWon(f.amount), class: 'num' })
        ]));
      } else {
        var isDep = f.type === 'deposit';
        tbody.appendChild(h('tr', {}, [
          h('td', { text: isDep ? '추가입금' : (f.type === 'closeout' ? '전액출금' : '출금') }),
          h('td', { text: f.date, class: 'date' }),
          h('td', { text: (isDep ? '+' : '−') + fmtWon(f.amount), class: 'num ' + (isDep ? 'pos' : 'neg') })
        ]));
      }
    });
    tbody.appendChild(h('tr', { class: 'lg-final' }, [
      h('td', { text: '현재 원금' }),
      h('td', { text: '', class: 'date' }),
      h('td', { text: fmtWon(p.principal), class: 'num' })
    ]));
    if (!flows.length) {
      tbody.appendChild(h('tr', {}, [h('td', { text: '내역 없음', class: 'empty small', colspan: '3' })]));
    }
  }

  // 일별 평가·수익률: 일자 · 평가금액 · 원금대비 수익률 · 일간 수익률
  function renderDailyTable(p) {
    var tbody = el('daily-table').querySelector('tbody');
    tbody.innerHTML = '';
    var vals = p.history.filter(function (r) { return r.type === 'valuation'; });
    vals.slice().reverse().forEach(function (row) {
      var pr = row.principal > 0 ? (row.eval - row.principal) / row.principal : null;
      tbody.appendChild(h('tr', {}, [
        h('td', { text: row.date, class: 'date' }),
        h('td', { text: fmtWon(row.eval), class: 'num' }),
        h('td', { text: pr === null ? '-' : fmtPct(pr), class: 'num ' + (pr === null ? '' : pctClass(pr)) }),
        h('td', { text: fmtPct(row.nav / Engine.NAV_BASE - 1), class: 'num ' + pctClass(row.nav / Engine.NAV_BASE - 1) }),
        h('td', { text: fmtNum(row.nav, 2), class: 'num' }),
        h('td', { text: fmtNum(row.units, 0), class: 'num' })
      ]));
    });
    if (!vals.length) {
      tbody.appendChild(h('tr', {}, [h('td', { text: '평가 내역 없음 — 일일 평가금액을 입력하세요.', class: 'empty small', colspan: '6' })]));
    }
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

    // 원금 원장 (계좌를 열별로 나열: 원금 → 추가입금 → 원금합)
    if (result.processed.length) {
      sheets.push(buildLedgerSheet(result.processed, S));
    }

    var usedNames = { '종합요약': true, '종합지수': true, '원금원장': true };
    result.processed.forEach(function (p, i) {
      var base = XlsxWriter.sanitizeSheetName(p.name, '계좌' + (i + 1));
      var name = base, n = 2;
      while (usedNames[name]) name = (base.slice(0, 28) + '(' + (n++) + ')');
      usedNames[name] = true;

      var rows = [[
        { v: '일자', s: S.HEAD }, { v: '구분', s: S.HEAD }, { v: '금액', s: S.HEAD },
        { v: '좌수 증감', s: S.HEAD }, { v: '좌수', s: S.HEAD }, { v: '기준가', s: S.HEAD },
        { v: '평가금액', s: S.HEAD }, { v: '원금', s: S.HEAD },
        { v: '원금대비 수익률', s: S.HEAD }, { v: '일간 수익률', s: S.HEAD }
      ]];
      p.history.forEach(function (row) {
        var pr = (row.type === 'valuation' && row.principal > 0) ? (row.eval - row.principal) / row.principal : null;
        rows.push([
          { v: row.date },
          { v: row.label },
          row.type === 'valuation' ? null : { v: Math.round(row.amount), s: S.INT },
          row.deltaUnits ? { v: Math.round(row.deltaUnits), s: S.INT } : null,
          { v: Math.round(row.units), s: S.INT },
          { v: row.nav, s: S.DEC },
          { v: Math.round(row.eval), s: S.INT },
          { v: Math.round(row.principal), s: S.INT },
          pr === null ? null : { v: pr, s: S.PCT },
          row.dailyReturn === null ? null : { v: row.dailyReturn, s: S.PCT }
        ]);
      });
      sheets.push({ name: name, colWidths: [12, 10, 14, 14, 14, 10, 14, 14, 14, 12], rows: rows });
    });

    return sheets;
  }

  // 원금 원장 시트: 각 계좌를 [구분, 일자, 금액] 3열 블록으로 나란히 배치
  function buildLedgerSheet(processed, S) {
    // 계좌별 원장 행 데이터 만들기
    var columns = processed.map(function (p) {
      var flows = p.history.filter(function (r) { return FLOW_TYPES[r.type]; });
      var lines = []; // {k, date, amount, signed, isSum, isFinal, type}
      flows.forEach(function (f, i) {
        if (i === 0) {
          lines.push({ k: '원금', date: '', amount: f.amount, isPrincipal: true });
        } else {
          var isDep = f.type === 'deposit';
          lines.push({ k: isDep ? '추가입금' : (f.type === 'closeout' ? '전액출금' : '출금'),
            date: f.date, amount: (isDep ? 1 : -1) * f.amount, signed: true });
        }
      });
      lines.push({ k: '현재 원금', date: '', amount: p.principal, isFinal: true });
      return { p: p, lines: lines };
    });

    var maxLines = columns.reduce(function (m, c) { return Math.max(m, c.lines.length); }, 0);
    var rows = [];

    // 1행: 계좌명 + 원금대비 수익률
    var titleRow = [];
    columns.forEach(function (c, i) {
      if (i > 0) titleRow.push(null); // 블록 사이 간격 열
      titleRow.push({ v: c.p.name + (c.p.isClosed ? ' (해지)' : ''), s: S.BOLD });
      titleRow.push({ v: '원금대비', s: S.HEAD });
      titleRow.push({ v: c.p.principalReturn, s: S.PCT });
    });
    rows.push(titleRow);

    // 2행: 헤더
    var headRow = [];
    columns.forEach(function (c, i) {
      if (i > 0) headRow.push(null);
      headRow.push({ v: '구분', s: S.HEAD });
      headRow.push({ v: '일자', s: S.HEAD });
      headRow.push({ v: '금액', s: S.HEAD });
    });
    rows.push(headRow);

    // 데이터 행
    for (var r = 0; r < maxLines; r++) {
      var row = [];
      columns.forEach(function (c, i) {
        if (i > 0) row.push(null);
        var ln = c.lines[r];
        if (!ln) { row.push(null, null, null); return; }
        var style = (ln.isPrincipal || ln.isFinal) ? S.BOLD_INT : (ln.isSum ? S.BOLD_INT : S.INT);
        row.push({ v: ln.k, s: (ln.isPrincipal || ln.isFinal) ? S.BOLD : S.TEXT });
        row.push({ v: ln.date });
        row.push({ v: Math.round(ln.amount), s: style });
      });
      rows.push(row);
    }

    // 열 너비
    var widths = [];
    columns.forEach(function (c, i) {
      if (i > 0) widths.push(3);
      widths.push(10, 12, 16);
    });

    return { name: '원금원장', colWidths: widths, rows: rows };
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

  // ---------- 원금 입출금 내역 ----------

  // 원금 흐름에 해당하는 이벤트만 추출 (입금·출금·전액출금). 성과보수는 원금 흐름이 아님.
  var FLOW_TYPES = { deposit: 1, withdraw: 1, closeout: 1 };

  function flowSign(type) { return type === 'deposit' ? 1 : -1; }

  function collectFlows(p) {
    return p.history.filter(function (r) { return FLOW_TYPES[r.type]; }).map(function (r) {
      return {
        date: r.date, type: r.type, label: r.label,
        amount: r.amount, signed: flowSign(r.type) * r.amount,
        principal: r.principal, accountId: p.id, accountName: p.name
      };
    });
  }

  function openCashflow() {
    var processed = computeAll().processed;

    // 계좌별 원금 흐름 + 전체 집계
    var perAccount = processed.map(function (p) {
      var flows = collectFlows(p);
      var dep = 0, wd = 0;
      flows.forEach(function (f) {
        if (f.type === 'deposit') dep += f.amount; else wd += f.amount;
      });
      return { p: p, flows: flows, deposits: dep, withdrawals: wd, net: dep - wd };
    });

    var totalDep = 0, totalWd = 0;
    perAccount.forEach(function (a) { totalDep += a.deposits; totalWd += a.withdrawals; });

    // 요약 카드
    var cards = el('cashflow-cards');
    cards.innerHTML = '';
    cards.appendChild(card('총 입금', fmtWon(totalDep), '전 계좌 누적'));
    cards.appendChild(card('총 출금', fmtWon(totalWd), '전액출금(해지) 포함'));
    cards.appendChild(card('순 원금 (입금−출금)', fmtWon(totalDep - totalWd), '현재 투입 원금 합계'));
    cards.appendChild(card('계좌 수', String(processed.length) + '개',
      processed.filter(function (p) { return p.isClosed; }).length + '개 해지'));

    var body = el('cashflow-body');
    body.innerHTML = '';

    if (!processed.length) {
      body.appendChild(h('p', { class: 'empty', text: '등록된 계좌가 없습니다.' }));
      el('cashflow-dialog').showModal();
      return;
    }

    // ── 전체 통합 내역 (일자순) ──
    var allFlows = [];
    perAccount.forEach(function (a) { allFlows = allFlows.concat(a.flows); });
    allFlows.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });

    body.appendChild(h('h4', { class: 'cashflow-title', text: '전체 통합 내역' }));
    if (allFlows.length) {
      var runningNet = 0;
      var totalRows = allFlows.map(function (f) {
        runningNet += f.signed;
        return h('tr', {}, [
          h('td', { text: f.date, class: 'date' }),
          h('td', { text: f.accountName, class: 'name' }),
          h('td', {}, [h('span', { class: 'tag tag-' + f.type, text: f.label })]),
          h('td', { text: (f.signed >= 0 ? '+' : '−') + fmtWon(f.amount), class: 'num ' + (f.type === 'deposit' ? 'pos' : 'neg') }),
          h('td', { text: fmtWon(runningNet), class: 'num' })
        ]);
      });
      body.appendChild(flowTable(['일자', '계좌', '구분', '입출금액', '누적 순원금'], totalRows));
    } else {
      body.appendChild(h('p', { class: 'empty', text: '원금 입출금 내역이 없습니다.' }));
    }

    // ── 계좌별 원금 원장 (원금 → 추가입금 → 원금합) ──
    body.appendChild(h('h4', { class: 'cashflow-title', text: '계좌별 원금 원장' }));
    var grid = h('div', { class: 'ledger-grid' });
    perAccount.forEach(function (a) {
      grid.appendChild(ledgerColumn(a.p, a.flows));
    });
    body.appendChild(grid);

    el('cashflow-dialog').showModal();
  }

  // 한 계좌의 원금 원장 열: 원금(최초) → [추가입금, 원금합] 반복
  function ledgerColumn(p, flows) {
    var rows = [];
    flows.forEach(function (f, i) {
      if (i === 0) {
        // 최초 원금 (출금으로 시작하는 경우는 없음)
        rows.push(h('tr', { class: 'lg-principal' }, [
          h('td', { text: '원금', class: 'lg-k' }),
          h('td', { text: '', class: 'lg-d' }),
          h('td', { text: fmtWon(f.amount), class: 'num lg-v' })
        ]));
      } else {
        var isDep = f.type === 'deposit';
        rows.push(h('tr', { class: 'lg-add' }, [
          h('td', { text: isDep ? '추가입금' : (f.type === 'closeout' ? '전액출금' : '출금'), class: 'lg-k' }),
          h('td', { text: f.date, class: 'lg-d' }),
          h('td', { text: (isDep ? '+' : '−') + fmtWon(f.amount), class: 'num lg-v ' + (isDep ? 'pos' : 'neg') })
        ]));
      }
    });
    // 현재 원금 (합계, 강조)
    rows.push(h('tr', { class: 'lg-final' }, [
      h('td', { text: '현재 원금', class: 'lg-k' }),
      h('td', { text: '', class: 'lg-d' }),
      h('td', { text: fmtWon(p.principal), class: 'num lg-v' })
    ]));

    return h('div', { class: 'ledger-col' }, [
      h('div', { class: 'ledger-head' }, [
        h('div', { class: 'ledger-name', text: p.name + (p.isClosed ? ' (해지)' : '') }),
        h('div', { class: 'ledger-ret ' + pctClass(p.principalReturn),
          text: '원금대비 ' + fmtPct(p.principalReturn) })
      ]),
      h('table', { class: 'ledger-table' }, [h('tbody', {}, rows)])
    ]);
  }

  function flowTable(headers, rows) {
    var thead = h('thead', {}, [
      h('tr', {}, headers.map(function (t, i) {
        return h('th', { text: t, class: i === 0 || i === 1 ? '' : (i >= 2 ? 'num' : '') });
      }))
    ]);
    var tbody = h('tbody', {}, rows);
    return h('div', { class: 'table-wrap' }, [h('table', { class: 'grid' }, [thead, tbody])]);
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

  // ---------- 엑셀 임포트 ----------

  var importedAccounts = null;

  function parseImportXlsx(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var workbook = XLSX.read(reader.result, { type: 'array' });
        var accounts = extractAccountsFromXlsx(workbook);
        if (accounts.length === 0) {
          alert('계좌 데이터를 찾을 수 없습니다.');
          return;
        }
        importedAccounts = accounts;
        showImportPreview(accounts);
        el('import-dialog').showModal();
      } catch (e) {
        alert('엑셀 파일을 읽을 수 없습니다: ' + e.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function extractAccountsFromXlsx(workbook) {
    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return [];
    var rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    var accountMap = {};
    rows.forEach(function (row, idx) {
      var accName = String(row['계좌명'] || row['name'] || '').trim();
      var dateStr = String(row['일자'] || row['date'] || '').trim();
      var typeStr = String(row['구분'] || row['type'] || '').trim();
      var amtStr = String(row['금액'] || row['amount'] || '').trim();

      if (!accName || !dateStr || !typeStr || !amtStr) return;

      var date = parseDate(dateStr);
      if (!date) return;

      var type = normalizeType(typeStr);
      if (!type) return;

      var amount = parseFloat(amtStr);
      if (isNaN(amount) || amount < 0) return;

      if (!accountMap[accName]) {
        accountMap[accName] = { name: accName, events: [] };
      }
      accountMap[accName].events.push({ date: date, type: type, amount: amount });
    });

    // 계좌 생성
    var accounts = [];
    Object.keys(accountMap).forEach(function (name) {
      var data = accountMap[name];
      if (data.events.length === 0) return;

      // 날짜별로 정렬
      data.events.sort(function (a, b) {
        return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
      });

      // 계좌 생성
      var events = [];
      var seq = 1;
      var createdDate = data.events[0].date;

      data.events.forEach(function (ev) {
        events.push({
          id: 'ev' + seq,
          seq: seq,
          type: ev.type,
          date: ev.date,
          amount: ev.amount
        });
        seq++;
      });

      accounts.push({
        id: uid(),
        name: data.name,
        createdDate: createdDate,
        events: events
      });
    });

    return accounts;
  }

  function parseDate(str) {
    var match = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!match) return null;
    var y = parseInt(match[1], 10);
    var m = parseInt(match[2], 10);
    var d = parseInt(match[3], 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function normalizeType(str) {
    var m = str.toLowerCase();
    if (m.includes('입금') || m === 'deposit') return 'deposit';
    if (m.includes('출금') || m === 'withdraw') return 'withdraw';
    if (m.includes('해지') || m === 'closeout') return 'closeout';
    if (m.includes('평가') || m === 'valuation') return 'valuation';
    if (m.includes('보수') || m === 'fee') return 'fee';
    return null;
  }

  function showImportPreview(accounts) {
    var container = el('import-preview');
    container.innerHTML = '';

    var summary = h('div', { style: 'padding: 8px 0; border-bottom: 1px solid #ccc; margin-bottom: 12px;' }, [
      h('p', { text: '등록할 계좌 수: ' + accounts.length, style: 'margin: 0;' })
    ]);
    container.appendChild(summary);

    accounts.forEach(function (acc) {
      var proc = Engine.processAccount(acc);
      var card = h('div', { style: 'padding: 12px; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 12px;' }, [
        h('div', { style: 'font-weight: bold; margin-bottom: 8px;', text: acc.name }),
        h('div', { style: 'font-size: 0.9em; color: #666;' }, [
          h('div', { text: '이벤트: ' + acc.events.length + '건' }),
          h('div', { text: '원금: ' + fmtWon(proc.principal) }),
          h('div', { text: '평가금액: ' + fmtWon(proc.eval) }),
          h('div', { text: '기준가: ' + proc.nav.toFixed(2) })
        ])
      ]);
      container.appendChild(card);
    });
  }

  function confirmImportXlsx() {
    if (!importedAccounts) return;
    if (!confirm('이 계좌들을 추가하시겠습니까?')) return;

    importedAccounts.forEach(function (acc) {
      state.accounts.push(acc);
    });

    saveState();
    selectedAccountId = null;
    render();
    el('import-dialog').close();
    importedAccounts = null;
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

    // 수익률 추이 차트 토글
    el('chart-toggle').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      chartMode = btn.getAttribute('data-mode');
      if (lastResult) renderChart(lastResult);
    });
    // 창 크기 변경 시 차트 리플로우
    var resizeTimer;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { if (lastResult) renderChart(lastResult); }, 150);
    });

    // 상단 도구
    el('btn-cashflow').addEventListener('click', openCashflow);
    el('btn-close-cashflow').addEventListener('click', function () { el('cashflow-dialog').close(); });
    el('btn-export-xlsx').addEventListener('click', downloadXlsx);
    el('btn-import-xlsx').addEventListener('click', function () { el('import-file').click(); });
    el('import-file').addEventListener('change', function (e) {
      if (e.target.files[0]) parseImportXlsx(e.target.files[0]);
      e.target.value = '';
    });
    el('btn-close-import').addEventListener('click', function () { el('import-dialog').close(); });
    el('btn-import-confirm').addEventListener('click', confirmImportXlsx);
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
