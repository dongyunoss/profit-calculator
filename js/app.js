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
    // 음수 부호는 화면 전체에서 '−'(U+2212)로 통일한다 (하이픈과 섞이지 않게)
    return Math.round(n).toLocaleString('ko-KR').replace(/^-/, '−') + '원';
  }

  // 모바일(증권사 MTS 관례): 억/만 단위로 축약 — "55,967,232,129원" → "559억 6,723만원".
  // 좁은 화면에서 자릿수 많은 원화 금액을 한눈에 읽히게 한다.
  function fmtWonShort(n) {
    var neg = n < 0;
    var v = Math.round(Math.abs(n));
    var eok = Math.floor(v / 1e8);
    var man = Math.round((v % 1e8) / 1e4);
    if (man >= 10000) { eok += 1; man -= 10000; } // 반올림 캐리(예: 9999.6만 → +1억)
    var s;
    if (eok > 0) {
      s = eok.toLocaleString('ko-KR') + '억' + (man > 0 ? ' ' + man.toLocaleString('ko-KR') + '만' : '');
    } else if (man > 0) {
      s = man.toLocaleString('ko-KR') + '만';
    } else {
      s = v.toLocaleString('ko-KR');
    }
    return (neg ? '−' : '') + s + '원';
  }

  // 화면 폭이 모바일 브레이크포인트(css의 @media max-width:640px)와 같은 기준을 쓴다.
  // matchMedia는 실제 리사이즈/회전 시 'change' 이벤트를 주므로 아래에서 재렌더링에 사용한다.
  var MOBILE_MQ = (typeof window !== 'undefined' && window.matchMedia)
    ? window.matchMedia('(max-width: 640px)') : null;
  function isMobile() { return !!(MOBILE_MQ && MOBILE_MQ.matches); }

  // 카드·레일·계좌 목록처럼 "한눈에 보는" 자리에서만 모바일 축약 표기를 쓴다.
  // 원금 원장·거래 이력처럼 대사(reconciliation)가 필요한 표는 항상 fmtWon(전체 자릿수) 그대로.
  function fmtWonAuto(n) { return isMobile() ? fmtWonShort(n) : fmtWon(n); }

  function fmtNum(n, digits) {
    return n.toLocaleString('ko-KR', {
      minimumFractionDigits: digits, maximumFractionDigits: digits
    });
  }

  function fmtPct(r) {
    // 음수 부호는 fmtWon과 같이 '−'(U+2212)로 통일
    return (r * 100).toFixed(2).replace(/^-/, '−') + '%';
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

  // ---------- 알림·확인·입력 (네이티브 alert/confirm/prompt 대체) ----------

  // 결과 피드백은 흐름을 끊지 않는 토스트로. type: 'info' | 'ok' | 'warn' | 'error'
  function toast(message, type) {
    var host = el('toast-host');
    if (!host) return;
    var node = h('div', { class: 'toast ' + (type || 'info'), text: message });
    host.appendChild(node);
    // 트랜지션이 걸리도록 다음 프레임에 표시 클래스를 준다
    requestAnimationFrame(function () { node.classList.add('show'); });
    var life = (type === 'error' || type === 'warn') ? 5200 : 3000;
    var timer = setTimeout(close, life);
    node.addEventListener('click', close);
    function close() {
      clearTimeout(timer);
      if (!node.parentNode) return;
      node.classList.remove('show');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
    }
  }

  // <dialog>가 없는(구형) 환경에서는 네이티브로 폴백해 기능이 막히지 않게 한다
  function dialogSupported(dlg) { return dlg && typeof dlg.showModal === 'function'; }

  // confirm() 대체. 되돌릴 수 없는 작업은 danger:true로 확인 버튼을 경고색으로.
  function confirmDialog(opts) {
    var o = typeof opts === 'string' ? { body: opts } : (opts || {});
    var dlg = el('confirm-dialog');
    if (!dialogSupported(dlg)) {
      return Promise.resolve(window.confirm((o.title ? o.title + '\n\n' : '') + (o.body || '')));
    }
    el('confirm-title').textContent = o.title || '확인';
    el('confirm-body').textContent = o.body || '';
    var ok = el('btn-confirm-ok');
    ok.textContent = o.okText || '확인';
    ok.classList.toggle('danger', !!o.danger);
    ok.classList.toggle('primary', !o.danger);
    el('btn-confirm-cancel').textContent = o.cancelText || '취소';

    return new Promise(function (resolve) {
      function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok');
      }
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
      ok.focus();
    });
  }

  // prompt() 대체. 취소하면 null, 확인하면 입력값(공백 제거) 반환.
  function promptDialog(opts) {
    var o = opts || {};
    var dlg = el('prompt-dialog');
    if (!dialogSupported(dlg)) {
      var v = window.prompt(o.title || '', o.value || '');
      return Promise.resolve(v === null ? null : v.trim());
    }
    el('prompt-title').textContent = o.title || '입력';
    var form = el('form-prompt');
    var input = form.elements.value;
    el('prompt-label').childNodes[0].nodeValue = (o.label || '값') + ' ';
    input.value = o.value == null ? '' : o.value;
    input.placeholder = o.placeholder || '';

    return new Promise(function (resolve) {
      function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
      }
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
      input.select();
    });
  }

  // 다이얼로그 공통 버튼 배선 (한 번만)
  function wireDialogs() {
    var cdlg = el('confirm-dialog');
    if (dialogSupported(cdlg)) {
      // 확인 버튼은 value="ok" — method="dialog" 폼이 returnValue를 'ok'로 채운다
      el('btn-confirm-cancel').addEventListener('click', function () { cdlg.close(''); });
    }
    var pdlg = el('prompt-dialog');
    if (dialogSupported(pdlg)) {
      el('form-prompt').addEventListener('submit', function (e) {
        e.preventDefault();
        pdlg.close('ok');
      });
      el('btn-prompt-cancel').addEventListener('click', function () { pdlg.close(''); });
    }
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
    renderRail(result);
    renderChart(result);
    renderAccountsTable(result);
    renderDetail(result);
  }

  // ---------- 수익률 추이 차트 ----------

  // 계좌별 카테고리 색상 (dataviz 검증 팔레트, 고정 순서로 배정)
  // 다크 배경에서 구분되는 계좌별 라인 색
  var SERIES_COLORS = ['#4fb3c9', '#f0885a', '#7ddba0', '#e8c06a', '#e88bb4', '#6ba8ff', '#b28cf0', '#ff8080'];
  var COMPOSITE_COLOR = '#4fb3c9';
  var chartMode = 'composite';
  var selectedChartAccountId = null; // '계좌별 누적 수익률'에서 단일 계좌만 볼 때
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

  // ---------- 벤치마크 지수 (코스피 등) ----------

  var BENCHMARK_COLOR = '#5d6472';

  // '2026.01.02' / '2026/01/02' / '20260102' / '2026-1-2' → '2026-01-02'
  function normalizeDate(raw) {
    var t = String(raw).trim().replace(/["']/g, '');
    var m = t.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})$/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return null;
  }

  // 붙여넣은 텍스트를 {date, value} 배열로.
  // 한 줄에서 "날짜 + 그 뒤의 첫 숫자"를 뽑는다. 천 단위 쉼표(2,540.11)가 구분자로
  // 오인되지 않도록 구분자 분해 대신 정규식으로 통째로 읽는다.
  var BM_LINE = /^\s*["']?\s*(\d{4}(?:[.\/-]\d{1,2}){2}|\d{8})\s*["']?\s*[,;\t|\s]\s*["']?\s*(\d[\d,\s]*(?:\.\d+)?)/;

  function parseBenchmarkText(text) {
    var pts = [], bad = 0;
    String(text).split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var m = line.match(BM_LINE);
      var date = m && normalizeDate(m[1]);
      var value = m ? parseFloat(m[2].replace(/[,\s]/g, '')) : NaN;
      if (date && isFinite(value) && value > 0) pts.push({ date: date, value: value });
      else bad++;
    });
    pts.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    // 같은 날짜가 여러 번이면 마지막 값으로
    var out = [];
    pts.forEach(function (p) {
      if (out.length && out[out.length - 1].date === p.date) out[out.length - 1] = p;
      else out.push(p);
    });
    return { points: out, skipped: bad };
  }

  // 해당 일자 이하의 마지막 지수값 (휴장일·평가일 불일치 대응)
  function benchmarkValueAt(points, date) {
    var v = null;
    for (var i = 0; i < points.length; i++) {
      if (points[i].date > date) break;
      v = points[i].value;
    }
    return v;
  }

  // 차트 x축(cats)에 맞춰 첫 시점을 0%로 정규화한 시리즈
  function benchmarkSeries(cats) {
    var bm = state.benchmark;
    if (!bm || !bm.points || bm.points.length < 2 || !cats.length) return null;
    var base = null, pts = [];
    cats.forEach(function (c) {
      var v = benchmarkValueAt(bm.points, c);
      if (v === null) return;          // 벤치마크 데이터가 시작되기 전 구간은 건너뛴다
      if (base === null) base = v;
      pts.push({ x: c, y: v / base - 1 });
    });
    if (pts.length < 2) return null;
    return { name: bm.name || '벤치마크', color: BENCHMARK_COLOR, points: pts, dashed: true };
  }

  function legendItem(name, color, dashed, value, valueCls) {
    return h('span', { class: 'legend-item' }, [
      h('span', { class: 'legend-swatch' + (dashed ? ' dashed' : ''), style: 'background:' + color }),
      h('span', { text: name }),
      value ? h('b', { class: 'legend-value ' + (valueCls || ''), text: value }) : null
    ]);
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
      var seriesList = [{ name: '종합 성과 수익률', color: COMPOSITE_COLOR, points: pts, emphasis: true }];
      var bm = benchmarkSeries(cats);
      if (bm) seriesList.push(bm);
      Chart.renderLineChart(el('chart-area'), { series: seriesList, categories: cats });
      var lastY = pts.length ? pts[pts.length - 1].y : 0;
      legend.appendChild(legendItem('종합 성과 지수', COMPOSITE_COLOR, false, fmtPct(lastY), pctClass(lastY)));
      if (bm) {
        var bmLast = bm.points[bm.points.length - 1].y;
        legend.appendChild(legendItem(bm.name, bm.color, true, fmtPct(bmLast), pctClass(bmLast)));
      }
      note.textContent = '종합 성과 지수는 계좌별 일간 기준가 수익률을 직전 평가금액 가중으로 체인링크한 값입니다(1,000 시작). 입출금·성과보수의 영향을 배제한 순수 운용 성과입니다.'
        + (bm ? ' 벤치마크는 차트 시작 시점을 0%로 맞춰 비교합니다.' : '');
    } else {
      // 평가 데이터가 있는 계좌만
      var active = processed.filter(function (p) { return p.daily.length > 0; });
      // 색상은 전체 기준 고정 배정 → 단일 계좌만 봐도 색이 바뀌지 않음
      var colorOf = {};
      active.forEach(function (p, i) { colorOf[p.id] = SERIES_COLORS[i % SERIES_COLORS.length]; });
      // 선택했던 계좌가 사라졌으면 선택 해제
      if (selectedChartAccountId && !active.some(function (p) { return p.id === selectedChartAccountId; })) {
        selectedChartAccountId = null;
      }
      var shown = selectedChartAccountId
        ? active.filter(function (p) { return p.id === selectedChartAccountId; })
        : active;

      var dateSet = {};
      var seriesList = shown.map(function (p) {
        var pts = accountReturnSeries(p);
        pts.forEach(function (pt) { if (pt.x) dateSet[pt.x] = 1; });
        return { name: p.name, color: colorOf[p.id], points: pts, emphasis: !!selectedChartAccountId };
      });

      // 범례: 전체 계좌를 항상 표시. 클릭하면 해당 계좌만 보기(다시 클릭 시 전체)
      active.forEach(function (p) {
        var isActive = !selectedChartAccountId || selectedChartAccountId === p.id;
        legend.appendChild(h('span', {
          class: 'legend-item clickable' + (isActive ? '' : ' dimmed'),
          title: selectedChartAccountId === p.id ? '전체 계좌 보기' : '이 계좌만 보기',
          onclick: function () {
            selectedChartAccountId = (selectedChartAccountId === p.id) ? null : p.id;
            if (lastResult) renderChart(lastResult);
          }
        }, [
          h('span', { class: 'legend-swatch', style: 'background:' + colorOf[p.id] }),
          h('span', { text: p.name + (p.isClosed ? ' (해지)' : '') })
        ]));
      });

      var cats = Object.keys(dateSet).sort();
      var bmA = benchmarkSeries(cats);
      if (bmA) {
        seriesList.push(bmA);
        legend.appendChild(legendItem(bmA.name, bmA.color, true));
      }
      Chart.renderLineChart(el('chart-area'), { series: seriesList, categories: cats });
      note.textContent = selectedChartAccountId
        ? '선택한 계좌의 개설 이후 누적 수익률입니다. 범례에서 계좌명을 다시 누르면 전체 계좌를 함께 봅니다.'
        : '계좌별 개설 이후 누적 수익률(기준가 방식)입니다. 범례에서 계좌명을 누르면 해당 계좌만 볼 수 있습니다. 성과보수 수취로 인한 리셋과 무관하게 순수 성과가 이어집니다.';
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

  function metric(label, value, sub, cls) {
    return h('div', { class: 'metric' }, [
      h('div', { class: 'metric-label', text: label }),
      h('div', { class: 'metric-value' + (cls ? ' ' + cls : ''), text: value }),
      h('div', { class: 'metric-sub', text: sub || '' })
    ]);
  }

  // 전 계좌 중 가장 최근 평가일 — 헤더 기준일 배지
  function latestValuationDate(processed) {
    var d = '';
    processed.forEach(function (p) {
      if (p.lastValuationDate && p.lastValuationDate > d) d = p.lastValuationDate;
    });
    return d;
  }

  function renderSummary(result) {
    var s = result.summary, comp = result.composite;
    var wrap = el('summary-cards');
    wrap.innerHTML = '';
    // 계좌가 없으면 전부 0원인 카드가 화면을 채우기만 하므로 숨긴다
    wrap.hidden = !result.processed.length;
    if (wrap.hidden) { el('as-of-badge').hidden = true; return; }
    // 전체 성과는 원금 흐름(입금 − 출금) 기준 — 개별 계좌의 계약원금 재설정과 무관하다
    wrap.appendChild(card('총 원금', fmtWonAuto(s.totalPrincipal),
      '원금 흐름 기준 · 입금 ' + fmtWonAuto(s.totalDeposits) + ' − 출금 ' + fmtWonAuto(s.totalWithdrawals)));
    wrap.appendChild(card('총 평가금액', fmtWonAuto(s.totalEval), '평가손익 ' + fmtWonAuto(s.totalPnl), pctClass(s.totalPnl)));
    wrap.appendChild(card('종합 성과 수익률', fmtPct(comp.ret), '기준가 방식 · 지수 ' + fmtNum(comp.index, 2), pctClass(comp.ret)));
    wrap.appendChild(card('원금대비 단순 수익률', fmtPct(s.simpleReturn), '총수익 기준 — 지급된 배당·보수를 되살려 계산', pctClass(s.simpleReturn)));

    var badge = el('as-of-badge');
    var asOf = latestValuationDate(result.processed);
    badge.hidden = !asOf;
    badge.textContent = asOf ? '기준일 ' + asOf : '';
  }

  // 계좌 선택(레일·표 공통). 같은 계좌를 다시 누르면 선택 해제.
  // 좁은 화면에서는 상세 패널이 화면 밖에 있어 "눌렀는데 아무 반응이 없는" 것처럼 보이므로
  // 선택된 경우에만 상세로 부드럽게 스크롤한다.
  function toggleAccount(id) {
    var opening = selectedAccountId !== id;
    selectedAccountId = opening ? id : null;
    tableExpanded = { daily: false, history: false }; // 계좌를 바꾸면 다시 최근 건만
    render();
    if (!opening) return;
    var panel = el('detail-panel');
    if (!panel || panel.hidden) return;
    var top = panel.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.7) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // Enter/Space로도 선택되게 (div·tr은 기본적으로 키보드 조작이 안 된다)
  function onSelectKey(id) {
    return function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      e.preventDefault();
      toggleAccount(id);
    };
  }

  function attachSelectable(node, id, label) {
    node.setAttribute('tabindex', '0');
    // <tr>에 role="button"을 주면 표 구조가 깨지므로 행에는 aria-selected만 쓴다
    if (node.tagName === 'TR') {
      node.setAttribute('aria-selected', selectedAccountId === id ? 'true' : 'false');
    } else {
      node.setAttribute('role', 'button');
      node.setAttribute('aria-pressed', selectedAccountId === id ? 'true' : 'false');
      if (label) node.setAttribute('aria-label', label);
    }
    node.addEventListener('keydown', onSelectKey(id));
    return node;
  }

  // 좌측 계좌 레일 — 계좌 선택을 표에서 사이드바로 옮겨 상세 진입이 항상 한 클릭
  function renderRail(result) {
    var list = el('rail-list');
    list.innerHTML = '';
    if (!result.processed.length) {
      list.appendChild(h('div', { class: 'rail-empty' }, [
        h('p', { text: '등록된 계좌가 없습니다.' }),
        h('button', {
          class: 'btn tiny', type: 'button', text: '+ 계좌 추가',
          onclick: function () { el('btn-add-account').click(); }
        })
      ]));
      el('rail-foot').hidden = true;
      return;
    }
    result.processed.forEach(function (p) {
      var cls = 'rail-item';
      if (p.id === selectedAccountId) cls += ' selected';
      if (p.isClosed) cls += ' closed';
      var showRet = p.contractPrincipal > 0;
      var item = h('div', {
        class: cls,
        onclick: function () { toggleAccount(p.id); }
      }, [
        h('div', { class: 'rail-row' }, [
          h('span', { class: 'rail-name' }, [
            h('span', { text: p.name }),
            p.isClosed ? h('span', { class: 'rail-badge', text: '해지' }) : null,
            (!p.isClosed && p.isMatured) ? h('span', { class: 'rail-badge', text: '만기' }) : null
          ]),
          h('span', {
            class: 'rail-ret ' + (showRet ? pctClass(p.contractReturn) : ''),
            text: showRet ? fmtPct(p.contractReturn) : '—'
          })
        ]),
        h('div', { class: 'rail-row' }, [
          h('span', { class: 'rail-eval', text: fmtWonAuto(p.eval) }),
          h('span', { class: 'rail-nav', text: '기준가 ' + fmtNum(p.nav, 2) })
        ])
      ]);
      list.appendChild(attachSelectable(item, p.id, p.name + ' 상세 보기'));
    });

    var s = result.summary;
    var foot = el('rail-foot');
    foot.hidden = false;
    foot.innerHTML = '';
    foot.appendChild(h('div', { class: 'rail-sum-label', text: '누적 성과보수' }));
    foot.appendChild(h('div', { class: 'rail-sum-value', text: fmtWonAuto(s.totalFees) }));
    if (s.totalPayouts > 0) {
      foot.appendChild(h('div', { class: 'rail-sum-sub', text: '누적 이익지급 ' + fmtWonAuto(s.totalPayouts) }));
    }
  }

  // 원금대비 수익률 열: 최대 절대값 대비 폭의 미니 바 + 수치
  function returnCell(ret, maxAbs) {
    var cls = pctClass(ret);
    var w = maxAbs > 0 ? Math.min(100, Math.abs(ret) / maxAbs * 100) : 0;
    return h('td', { class: 'num' }, [
      h('div', { class: 'ret-cell' }, [
        h('span', { class: 'ret-track' }, [
          h('span', { class: 'ret-fill ' + cls, style: 'width:' + w.toFixed(1) + '%' })
        ]),
        h('span', { class: 'ret-value ' + cls, text: fmtPct(ret) })
      ])
    ]);
  }

  function renderAccountsTable(result) {
    var tbody = el('accounts-table').querySelector('tbody');
    tbody.innerHTML = '';
    el('accounts-empty').hidden = state.accounts.length > 0;
    el('accounts-table').hidden = state.accounts.length === 0;

    var closedCount = result.processed.filter(function (p) { return p.isClosed; }).length;
    el('accounts-count').textContent = result.processed.length
      ? result.processed.length + '개 · 운용 ' + (result.processed.length - closedCount) + ' / 해지 ' + closedCount
      : '';

    var maxAbs = 0;
    result.processed.forEach(function (p) {
      if (Math.abs(p.contractReturn) > maxAbs) maxAbs = Math.abs(p.contractReturn);
    });

    result.processed.forEach(function (p) {
      var nameCell = h('td', { class: 'name' }, [
        h('span', { text: p.name }),
        p.isClosed ? h('span', { class: 'tag tag-closed', text: '해지' }) : null,
        (!p.isClosed && p.isMatured) ? h('span', { class: 'tag tag-matured', text: '만기' }) : null
      ]);
      var rowCls = p.id === selectedAccountId ? 'selected' : '';
      if (p.isClosed) rowCls += (rowCls ? ' ' : '') + 'closed';
      var tr = h('tr', {
        class: rowCls,
        'data-id': p.id,
        draggable: 'true',
        onclick: function () { toggleAccount(p.id); }
      }, [
        nameCell,
        h('td', { text: fmtWon(p.contractPrincipal), class: 'num' }),
        h('td', { text: fmtWonAuto(p.eval), class: 'num eval' }),
        h('td', { text: fmtWonAuto(p.contractPnl), class: 'num ' + pctClass(p.contractPnl) }),
        h('td', { text: fmtNum(p.nav, 2), class: 'num' }),
        h('td', { text: fmtNum(p.units, 0), class: 'num' }),
        h('td', { text: fmtPct(p.navReturn), class: 'num ' + pctClass(p.navReturn) }),
        returnCell(p.contractReturn, maxAbs),
        h('td', { text: p.lastValuationDate || '-', class: 'date' }),
        h('td', { class: 'drag-cell', title: '끌어서 순서 변경' }, [
          h('span', { class: 'drag-handle', text: '⠿' })
        ])
      ]);
      attachRowDrag(tr, p.id);
      attachSelectable(tr, p.id, p.name + ' 상세 보기');
      tbody.appendChild(tr);
    });
  }

  // 계좌 이름 변경
  function renameAccount(id) {
    var acc = getAccount(id);
    if (!acc) return;
    promptDialog({ title: '계좌명 변경', label: '계좌명', value: acc.name }).then(function (name) {
      if (name === null) return; // 취소
      if (!name) { toast('계좌명을 입력하세요.', 'warn'); return; }
      acc.name = name;
      saveState();
      render();
      toast('계좌명을 "' + name + '"(으)로 변경했습니다.', 'ok');
    });
  }

  // ── 계좌 목록 드래그 순서 변경 ──
  var dragSrcId = null;

  function clearDragMarks(tbody) {
    if (!tbody) return; // drop 후 재렌더로 행이 분리된 경우
    Array.prototype.forEach.call(
      tbody.querySelectorAll('.drag-over-top, .drag-over-bottom'),
      function (r) { r.classList.remove('drag-over-top', 'drag-over-bottom'); }
    );
  }

  function attachRowDrag(tr, id) {
    tr.addEventListener('dragstart', function (e) {
      dragSrcId = id;
      tr.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', id); } catch (_) { /* IE 등 */ }
    });
    tr.addEventListener('dragend', function () {
      dragSrcId = null;
      tr.classList.remove('dragging');
      clearDragMarks(tr.parentNode);
    });
    tr.addEventListener('dragover', function (e) {
      if (dragSrcId === null || dragSrcId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var rect = tr.getBoundingClientRect();
      var after = (e.clientY - rect.top) > rect.height / 2;
      tr.classList.toggle('drag-over-bottom', after);
      tr.classList.toggle('drag-over-top', !after);
    });
    tr.addEventListener('dragleave', function () {
      tr.classList.remove('drag-over-top', 'drag-over-bottom');
    });
    tr.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var after = tr.classList.contains('drag-over-bottom');
      tr.classList.remove('drag-over-top', 'drag-over-bottom');
      if (dragSrcId === null || dragSrcId === id) return;
      reorderAccounts(dragSrcId, id, after);
    });
  }

  function reorderAccounts(srcId, targetId, after) {
    var accts = state.accounts;
    var from = accts.findIndex(function (a) { return a.id === srcId; });
    if (from < 0) return;
    var moved = accts.splice(from, 1)[0];
    // splice 후 인덱스가 변동됐을 수 있으니 target을 다시 찾는다
    var t = accts.findIndex(function (a) { return a.id === targetId; });
    if (t < 0) { accts.splice(from, 0, moved); return; } // 안전 복구
    accts.splice(after ? t + 1 : t, 0, moved);
    saveState();
    render();
  }

  // 기준가 수익률의 기산 시점 안내 (보수 수취 / 재계약으로 초기화됨)
  function resetNote(p) {
    if (!p.lastResetDate) return '개설 이후';
    var label = p.lastResetKind === 'rollover' ? '재계약' : '보수수취';
    return label + '(' + p.lastResetDate + ') 이후';
  }

  function renderDetail(result) {
    var panel = el('detail-panel');
    var p = result.processed.find(function (x) { return x.id === selectedAccountId; });
    if (!p) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    el('detail-title').textContent = p.name +
      (p.isClosed ? ' (해지)' : (p.isMatured ? ' (만기 도래)' : ''));
    el('detail-meta').textContent = (p.createdDate ? '개설 ' + p.createdDate : '') +
      (p.lastValuationDate ? ' · 최근 평가 ' + p.lastValuationDate : '');

    // 개별 계좌는 계약 기준으로 본다 — 보수 수취·재계약 시 평가금액을 새 계약 원금으로 승계.
    // 전체 성과(종합 요약)는 원금 흐름 기준이므로, 둘이 갈리면 원금 흐름도 함께 보여준다.
    var carried = Math.abs(p.contractPrincipal - p.principal) > 0.5;
    var paidOutNow = (p.contractFees || 0) + (p.contractPayouts || 0);
    var showFlowRet = carried || (p.totalFees + (p.totalPayouts || 0)) > 0.5;

    // 4열 헤어라인 그리드 — 항상 8칸으로 채워 행 높이가 들쭉날쭉하지 않게 한다
    var cards = el('detail-cards');
    cards.innerHTML = '';
    cards.appendChild(metric('기준가', fmtNum(p.nav, 2), '1,000좌 기준'));
    cards.appendChild(metric('좌수', fmtNum(p.units, 0), ''));
    cards.appendChild(metric('원금', fmtWonAuto(p.contractPrincipal),
      carried ? '계약 기준 · 원금흐름 ' + fmtWonAuto(p.principal) : '계약 기준'));
    cards.appendChild(metric('평가금액', fmtWonAuto(p.eval), '평가손익 ' + fmtWonAuto(p.contractPnl), pctClass(p.contractPnl)));
    cards.appendChild(metric('기준가 수익률', fmtPct(p.navReturn), resetNote(p), pctClass(p.navReturn)));
    cards.appendChild(metric('원금대비 수익률', fmtPct(p.contractReturn),
      paidOutNow > 0.5 ? '지급분 ' + fmtWonAuto(paidOutNow) + ' 포함(총수익)' : resetNote(p),
      pctClass(p.contractReturn)));
    cards.appendChild(showFlowRet
      ? metric('원금흐름대비 수익률', fmtPct(p.principalReturn), '전체 성과와 같은 기준 · 개설 이후', pctClass(p.principalReturn))
      : metric('누적 성과 수익률', fmtPct(p.cumReturn), '보수수취·재계약 무관, 개설 이후', pctClass(p.cumReturn)));
    cards.appendChild(metric('누적 성과보수', fmtWonAuto(p.totalFees),
      p.totalPayouts > 0 ? '누적 이익지급 ' + fmtWonAuto(p.totalPayouts) : ''));
    if (showFlowRet) {
      cards.appendChild(metric('누적 성과 수익률', fmtPct(p.cumReturn), '보수수취·재계약 무관, 개설 이후', pctClass(p.cumReturn)));
      if (p.totalPayouts > 0 || p.lastMaturityDate) {
        cards.appendChild(metric('누적 이익지급', fmtWonAuto(p.totalPayouts || 0),
          p.lastMaturityDate ? '최근 만기 ' + p.lastMaturityDate : '이자·쿠폰·배당'));
      }
    }

    var warnBox = el('detail-warnings');
    warnBox.innerHTML = '';
    p.warnings.forEach(function (w) {
      warnBox.appendChild(h('div', { class: 'warning', text: '⚠ ' + w }));
    });

    renderLedgerTable(p);
    renderDailyTable(p);

    var tbody = el('history-table').querySelector('tbody');
    tbody.innerHTML = '';
    var hist = tableExpanded.history ? p.history : p.history.slice(-TABLE_PAGE);
    renderMoreToggle('history-more', 'history', hist.length, p.history.length, '건');
    hist.slice().reverse().forEach(function (row) {
      var delBtn = h('button', {
        class: 'btn tiny danger', text: '삭제',
        onclick: function (e) {
          e.stopPropagation();
          confirmDialog({
            title: '내역 삭제',
            body: row.date + ' ' + row.label + ' 내역을 삭제합니다. 이후 수치가 다시 계산됩니다.',
            okText: '삭제', danger: true
          }).then(function (ok) {
            if (!ok) return;
            var acc = getAccount(p.id);
            acc.events = acc.events.filter(function (ev) { return ev.id !== row.id; });
            saveState();
            render();
            toast(row.date + ' ' + row.label + ' 내역을 삭제했습니다.', 'ok');
          });
        }
      });
      tbody.appendChild(h('tr', {}, [
        h('td', { text: row.date, class: 'date' }),
        h('td', {}, [h('span', { class: 'tag tag-' + row.type, text: row.label })]),
        h('td', { text: VALUATION_TYPES[row.type] ? '-' : fmtWon(row.amount), class: 'num' }),
        h('td', { text: row.deltaUnits ? fmtNum(row.deltaUnits, 0) : '-', class: 'num' }),
        h('td', { text: fmtNum(row.units, 0), class: 'num' }),
        h('td', { text: fmtNum(row.nav, 2), class: 'num' }),
        h('td', { text: fmtWon(row.eval), class: 'num' }),
        h('td', { text: fmtWon(row.contractPrincipal), class: 'num' }),
        h('td', { text: rowRet(row) === null ? '-' : fmtPct(rowRet(row)),
          class: 'num ' + (rowRet(row) === null ? '' : pctClass(rowRet(row))) }),
        h('td', { text: row.dailyReturn === null ? '-' : fmtPct(row.dailyReturn), class: 'num ' + (row.dailyReturn === null ? '' : pctClass(row.dailyReturn)) }),
        h('td', {}, [delBtn])
      ]));
    });
  }

  // 평가 행의 원금대비 수익률 — 엔진이 계산한 계약 기준 총수익 수익률
  // (배당·이익지급으로 나간 금액이 되살아나 있어 지급 때문에 수익률이 꺾이지 않는다)
  function rowRet(row) {
    return VALUATION_TYPES[row.type] ? (row.contractReturn === undefined ? null : row.contractReturn) : null;
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
        var d = flowDelta(f), note = closeoutNote(f);
        tbody.appendChild(h('tr', {}, [
          h('td', {}, [
            h('span', { text: flowLabel(f) }),
            note ? h('span', { class: 'lg-sub', text: note }) : null
          ]),
          h('td', { text: f.date, class: 'date' }),
          h('td', { text: (d >= 0 ? '+' : '−') + fmtWon(Math.abs(d)), class: 'num ' + (d >= 0 ? 'pos' : 'neg') })
        ]));
      }
    });
    tbody.appendChild(h('tr', { class: 'lg-final' }, [
      h('td', { text: '현재 원금(원금 흐름)' }),
      h('td', { text: '', class: 'date' }),
      h('td', { text: fmtWon(p.principal), class: 'num' })
    ]));
    if (!flows.length) {
      tbody.appendChild(h('tr', {}, [h('td', { text: '내역 없음', class: 'empty small', colspan: '3' })]));
    }
  }

  // 일별 평가·수익률: 일자 · 평가금액 · 원금대비 수익률 · 일간 수익률
  // 평가일이 수백 건이면 상세 화면이 끝없이 길어져 아래 내용을 찾을 수 없다.
  // 기본은 최신 PAGE건만 보여주고, 필요할 때 펼치게 한다.
  var TABLE_PAGE = 30;
  var tableExpanded = { daily: false, history: false };

  // more 영역에 "더 보기 / 접기" 버튼을 그린다. total <= PAGE면 아무것도 그리지 않는다.
  function renderMoreToggle(hostId, key, shown, total, noun) {
    var host = el(hostId);
    host.innerHTML = '';
    if (total <= TABLE_PAGE) { host.hidden = true; return; }
    host.hidden = false;
    var expanded = tableExpanded[key];
    host.appendChild(h('button', {
      type: 'button', class: 'btn tiny',
      text: expanded ? '최근 ' + TABLE_PAGE + '건만 보기' : '이전 ' + (total - shown) + '건 더 보기',
      onclick: function () {
        tableExpanded[key] = !tableExpanded[key];
        if (lastResult) renderDetail(lastResult);
      }
    }));
    host.appendChild(h('span', {
      class: 'table-more-count',
      text: shown + ' / ' + total + noun
    }));
  }

  function renderDailyTable(p) {
    var tbody = el('daily-table').querySelector('tbody');
    tbody.innerHTML = '';
    var all = p.history.filter(function (r) { return VALUATION_TYPES[r.type]; });
    var vals = tableExpanded.daily ? all : all.slice(-TABLE_PAGE);
    renderMoreToggle('daily-more', 'daily', vals.length, all.length, '건');
    vals.slice().reverse().forEach(function (row) {
      var pr = rowRet(row);
      tbody.appendChild(h('tr', {}, [
        h('td', { text: row.date, class: 'date' }),
        h('td', { text: fmtWon(row.eval), class: 'num' }),
        h('td', { text: pr === null ? '-' : fmtPct(pr), class: 'num ' + (pr === null ? '' : pctClass(pr)) }),
        h('td', { text: fmtPct(row.nav / Engine.NAV_BASE - 1), class: 'num ' + pctClass(row.nav / Engine.NAV_BASE - 1) }),
        h('td', { text: fmtNum(row.nav, 2), class: 'num' }),
        h('td', { text: fmtNum(row.units, 0), class: 'num' })
      ]));
    });
    if (!all.length) {
      tbody.appendChild(h('tr', {}, [h('td', { text: '평가 내역 없음 — 일일 평가금액을 입력하세요.', class: 'empty small', colspan: '6' })]));
    }
  }

  // ---------- 이벤트 추가 ----------

  function addEvent(accountId, type, date, amount, extra) {
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
    var event = { id: uid(), seq: seqCounter++, type: type, date: date, amount: amount };
    if (extra) Object.keys(extra).forEach(function (k) { event[k] = extra[k]; });
    acc.events.push(event);
    saveState();
    render();
  }

  function readForm(form) {
    var date = form.elements.date.value;
    var amount = parseFloat(form.elements.amount.value);
    if (!date) { toast('날짜를 입력하세요.', 'warn'); return null; }
    if (!isFinite(amount) || amount < 0) { toast('금액을 올바르게 입력하세요.', 'warn'); return null; }
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
      [{ v: '총 평가손익 (현재 보유 기준)' }, { v: Math.round(s.totalPnl), s: S.INT }],
      [{ v: '총 성과 (지급된 배당·보수 포함)' }, { v: Math.round(s.grossPnl), s: S.INT }],
      [{ v: '원금대비 단순 수익률' }, { v: s.simpleReturn, s: S.PCT }],
      [{ v: '종합 성과 수익률 (기준가 방식)' }, { v: comp.ret, s: S.PCT }],
      [{ v: '종합 성과 지수 (1,000 시작)' }, { v: comp.index, s: S.DEC }],
      [{ v: '누적 입금' }, { v: Math.round(s.totalDeposits), s: S.INT }],
      [{ v: '누적 출금' }, { v: Math.round(s.totalWithdrawals), s: S.INT }],
      [{ v: '누적 성과보수' }, { v: Math.round(s.totalFees), s: S.INT }],
      [{ v: '누적 이익지급(이자·쿠폰·배당)' }, { v: Math.round(s.totalPayouts || 0), s: S.INT }],
      [],
      [
        { v: '계좌명', s: S.HEAD }, { v: '원금(계약 기준)', s: S.HEAD }, { v: '원금(흐름 기준)', s: S.HEAD },
        { v: '평가금액', s: S.HEAD },
        { v: '평가손익', s: S.HEAD }, { v: '기준가', s: S.HEAD }, { v: '좌수', s: S.HEAD },
        { v: '기준가 수익률', s: S.HEAD }, { v: '원금대비 수익률', s: S.HEAD },
        { v: '원금흐름대비 수익률', s: S.HEAD },
        { v: '누적 성과 수익률', s: S.HEAD }, { v: '누적입금', s: S.HEAD },
        { v: '누적출금', s: S.HEAD }, { v: '누적 성과보수', s: S.HEAD },
        { v: '누적 이익지급', s: S.HEAD },
        { v: '최근 평가일', s: S.HEAD }, { v: '최근 초기화일', s: S.HEAD }
      ]
    ];
    result.processed.forEach(function (p) {
      summaryRows.push([
        { v: p.name + (p.isClosed ? ' (해지)' : (p.isMatured ? ' (만기)' : '')) },
        { v: Math.round(p.contractPrincipal), s: S.INT },
        { v: Math.round(p.principal), s: S.INT },
        { v: Math.round(p.eval), s: S.INT },
        { v: Math.round(p.contractPnl), s: S.INT },
        { v: p.nav, s: S.DEC },
        { v: Math.round(p.units), s: S.INT },
        { v: p.navReturn, s: S.PCT },
        { v: p.contractReturn, s: S.PCT },
        { v: p.principalReturn, s: S.PCT },
        { v: p.cumReturn, s: S.PCT },
        { v: Math.round(p.totalDeposits), s: S.INT },
        { v: Math.round(p.totalWithdrawals), s: S.INT },
        { v: Math.round(p.totalFees), s: S.INT },
        { v: Math.round(p.totalPayouts || 0), s: S.INT },
        { v: p.lastValuationDate || '-' },
        { v: p.lastResetDate || '-' }
      ]);
    });
    summaryRows.push([
      { v: '합계', s: S.BOLD },
      null,
      { v: Math.round(s.totalPrincipal), s: S.BOLD_INT },
      { v: Math.round(s.totalEval), s: S.BOLD_INT },
      { v: Math.round(s.totalPnl), s: S.BOLD_INT },
      null, null,
      null, null,
      { v: s.simpleReturn, s: S.PCT },
      null,
      { v: Math.round(s.totalDeposits), s: S.BOLD_INT },
      { v: Math.round(s.totalWithdrawals), s: S.BOLD_INT },
      { v: Math.round(s.totalFees), s: S.BOLD_INT },
      { v: Math.round(s.totalPayouts || 0), s: S.BOLD_INT }
    ]);

    var sheets = [];

    // 종합 시트 — 전 계좌 원금 원장 + 일자별 평가·수익률을 한 장에
    if (result.processed.length) {
      sheets.push(buildOverviewSheet(result.processed, S));
    }

    sheets.push({
      name: '종합요약',
      colWidths: [26, 14, 14, 14, 14, 10, 14, 14, 15, 16, 15, 14, 14, 14, 14, 12, 14],
      rows: summaryRows
    });

    // 종합 성과 지수 일별 시계열
    if (comp.series.length) {
      var bm = state.benchmark;
      var bmName = bm && bm.points && bm.points.length ? (bm.name || '벤치마크') : null;
      var bmBase = null;
      var idxHead = [
        { v: '일자', s: S.HEAD }, { v: '일간 수익률', s: S.HEAD }, { v: '성과 지수', s: S.HEAD }
      ];
      if (bmName) idxHead.push({ v: bmName, s: S.HEAD }, { v: bmName + ' 누적', s: S.HEAD });
      var idxRows = [idxHead];
      comp.series.forEach(function (r) {
        var row = [{ v: r.date }, { v: r.ret, s: S.PCT }, { v: r.index, s: S.DEC }];
        if (bmName) {
          var v = benchmarkValueAt(bm.points, r.date);
          if (v !== null && bmBase === null) bmBase = v;
          row.push(v === null ? null : { v: v, s: S.DEC });
          row.push(v === null || !bmBase ? null : { v: v / bmBase - 1, s: S.PCT });
        }
        idxRows.push(row);
      });
      sheets.push({ name: '종합지수', colWidths: bmName ? [12, 12, 12, 12, 14] : [12, 12, 12], rows: idxRows });
    }

    // 원금 원장 (계좌를 열별로 나열: 원금 → 추가입금 → 원금합)
    if (result.processed.length) {
      sheets.push(buildLedgerSheet(result.processed, S));
    }

    var usedNames = { '종합': true, '종합요약': true, '종합지수': true, '원금원장': true };
    result.processed.forEach(function (p, i) {
      var base = XlsxWriter.sanitizeSheetName(p.name, '계좌' + (i + 1));
      var name = base, n = 2;
      while (usedNames[name]) name = (base.slice(0, 28) + '(' + (n++) + ')');
      usedNames[name] = true;

      var rows = [[
        { v: '일자', s: S.HEAD }, { v: '구분', s: S.HEAD }, { v: '금액', s: S.HEAD },
        { v: '좌수 증감', s: S.HEAD }, { v: '좌수', s: S.HEAD }, { v: '기준가', s: S.HEAD },
        { v: '평가금액', s: S.HEAD }, { v: '원금(계약)', s: S.HEAD },
        { v: '원금대비 수익률', s: S.HEAD }, { v: '일간 수익률', s: S.HEAD }
      ]];
      p.history.forEach(function (row) {
        var pr = rowRet(row);
        rows.push([
          { v: row.date },
          { v: row.label },
          VALUATION_TYPES[row.type] ? null : { v: Math.round(row.amount), s: S.INT },
          row.deltaUnits ? { v: Math.round(row.deltaUnits), s: S.INT } : null,
          { v: Math.round(row.units), s: S.INT },
          { v: row.nav, s: S.DEC },
          { v: Math.round(row.eval), s: S.INT },
          { v: Math.round(row.contractPrincipal), s: S.INT },
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
          var note = closeoutNote(f);
          lines.push({ k: flowLabel(f) + (note ? ' (' + note + ')' : ''),
            date: f.date, amount: flowDelta(f), signed: true });
        }
      });
      lines.push({ k: '현재 원금(원금 흐름)', date: '', amount: p.principal, isFinal: true });
      return { p: p, lines: lines };
    });

    var maxLines = columns.reduce(function (m, c) { return Math.max(m, c.lines.length); }, 0);
    var rows = [];

    // 1행: 계좌명 + 원금흐름대비 수익률 (원금 원장은 입출금 내역이므로 흐름 기준으로 표시)
    var titleRow = [];
    columns.forEach(function (c, i) {
      if (i > 0) titleRow.push(null); // 블록 사이 간격 열
      titleRow.push({ v: c.p.name + (c.p.isClosed ? ' (해지)' : ''), s: S.BOLD });
      titleRow.push({ v: '원금흐름대비', s: S.HEAD });
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

  /*
   * 종합 시트: 전 계좌를 한 장에 가로로 나란히 놓는다.
   *   윗단 — 계좌별 원금 원장 (원금 → 추가입금 → 원금합), 최종 원금합은 노랑 강조
   *   아랫단 — 일자별 평가금액·원금대비 수익률 매트릭스, 입출금이 있던 날은 분홍 강조
   * 두 단 모두 계좌마다 [구분 | 일자 | 금액 | 수익률] 4열 블록을 쓰고 사이에 간격 열을 둔다.
   */
  function buildOverviewSheet(processed, S) {
    var GAP = 1;                 // 계좌 블록 사이 간격 열 수
    var BLOCK = 4;               // 구분 · 일자 · 금액 · 수익률
    function blank(n) { var a = []; for (var i = 0; i < n; i++) a.push(null); return a; }

    // ── 윗단: 계좌별 원금 원장 ──
    // 각 계좌를 {k, date, amount, style} 줄로 펼친 뒤, 가장 긴 계좌 길이에 맞춰 행을 만든다.
    var ledgers = processed.map(function (p) {
      var flows = p.history.filter(function (r) { return FLOW_TYPES[r.type]; });
      var lines = [], running = 0;
      flows.forEach(function (f, i) {
        var d = flowDelta(f);
        running += d;
        if (i === 0) {
          lines.push({ k: '원금', date: '', amount: d, bold: true });
        } else {
          var note = closeoutNote(f);
          lines.push({ k: flowLabel(f) + (note ? ' (' + note + ')' : ''), date: f.date, amount: d });
          lines.push({ k: '원금합', date: '', amount: running, sum: true });
        }
      });
      if (!lines.length) lines.push({ k: '원금', date: '', amount: 0, bold: true });
      lines[lines.length - 1].last = true; // 마지막 원금합 → 노랑 강조
      return { p: p, lines: lines };
    });

    var rows = [];
    var headRow = [];
    ledgers.forEach(function (c, i) {
      if (i > 0) headRow = headRow.concat(blank(GAP));
      headRow.push({ v: '구분', s: S.HEAD }, { v: '입출금일', s: S.HEAD },
        { v: c.p.name + (c.p.isClosed ? ' (해지)' : ''), s: S.HEAD }, { v: '수익률', s: S.HEAD });
    });
    rows.push(headRow);

    var maxLines = ledgers.reduce(function (m, c) { return Math.max(m, c.lines.length); }, 0);
    for (var r = 0; r < maxLines; r++) {
      var row = [];
      ledgers.forEach(function (c, i) {
        if (i > 0) row = row.concat(blank(GAP));
        var ln = c.lines[r];
        if (!ln) { row = row.concat(blank(BLOCK)); return; }
        var hl = ln.last;
        row.push({ v: ln.k, s: hl ? S.YEL : (ln.bold || ln.sum ? S.BOLD : S.TEXT) });
        row.push({ v: ln.date });
        row.push({ v: Math.round(ln.amount), s: hl ? S.YEL_INT : (ln.bold || ln.sum ? S.BOLD_INT : S.INT) });
        // 수익률 열은 마지막 원금합 행에만 — 그 계좌의 최종 원금대비 수익률.
        // 원금이 0 이하(이익까지 인출)면 분모가 없어 수익률을 표시하지 않는다.
        row.push(hl && c.p.principal > 0 ? { v: c.p.principalReturn, s: S.PCT } : null);
      });
      rows.push(row);
    }

    rows.push([]); // 두 단 사이 빈 줄

    // ── 아랫단: 일자별 평가금액 · 원금대비 수익률 ──
    // 계좌별 평가 행을 일자로 인덱싱하고, 평가가 없는 날은 직전 값을 이어 쓴다.
    var dateSet = {};
    var byDate = processed.map(function (p) {
      var m = {};
      p.history.forEach(function (r) {
        if (VALUATION_TYPES[r.type]) { m[r.date] = r; dateSet[r.date] = 1; }
      });
      return m;
    });
    // 입출금이 있던 날 (분홍 강조 대상)
    var flowDates = {};
    processed.forEach(function (p) {
      p.history.forEach(function (r) { if (FLOW_TYPES[r.type]) flowDates[r.date] = 1; });
    });
    var dates = Object.keys(dateSet).sort();

    if (dates.length) {
      var dHead = [];
      processed.forEach(function (p, i) {
        if (i > 0) dHead = dHead.concat(blank(GAP));
        dHead.push({ v: '일자', s: S.HEAD }, { v: '', s: S.HEAD },
          { v: p.name + (p.isClosed ? ' (해지)' : ''), s: S.HEAD }, { v: '수익률', s: S.HEAD });
      });
      rows.push(dHead);

      var last = processed.map(function () { return null; });
      dates.forEach(function (date) {
        var pink = !!flowDates[date];
        var row = [];
        processed.forEach(function (p, i) {
          if (i > 0) row = row.concat(blank(GAP));
          var rec = byDate[i][date];
          if (rec) last[i] = rec;
          var cur = rec || last[i];
          row.push({ v: date, s: pink ? S.PINK : S.TEXT });
          row.push(pink ? { v: '', s: S.PINK } : null);
          row.push(cur ? { v: Math.round(cur.eval), s: pink ? S.PINK_INT : S.INT } : (pink ? { v: '', s: S.PINK } : null));
          var ret = cur ? cur.principalReturn : null;
          row.push(ret === null || ret === undefined
            ? (pink ? { v: '', s: S.PINK } : null)
            : { v: ret, s: pink ? S.PINK_PCT : S.PCT });
        });
        rows.push(row);
      });
    }

    var widths = [];
    processed.forEach(function (p, i) {
      if (i > 0) widths.push(2);
      widths.push(22, 12, 18, 10);
    });

    return { name: '종합', colWidths: widths, rows: rows };
  }

  function downloadXlsx() {
    if (!state.accounts.length) { toast('등록된 계좌가 없습니다.', 'warn'); return; }
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
  // 평가 성격의 이벤트(평가금액이 곧 금액인 행) — 만기는 만기 시점 원리금 평가다
  var VALUATION_TYPES = { valuation: 1, maturity: 1 };

  function flowSign(type) { return type === 'deposit' ? 1 : -1; }

  // 원금 흐름이 실제로 움직인 금액. 전액출금(해지)은 인출 현금이 아니라
  // "남은 원금"만큼 차감되므로 기입 금액(amount)과 다를 수 있다.
  function flowDelta(f) {
    if (f.principalDelta !== undefined && f.principalDelta !== null) return f.principalDelta;
    return flowSign(f.type) * f.amount;
  }

  function flowLabel(f) {
    if (f.type === 'deposit') return '추가입금';
    return f.type === 'closeout' ? '전액출금' : '출금';
  }

  // 해지 행의 근거: 원금 차감액 = 인출 현금 ± 손익 정리분
  function closeoutNote(f) {
    if (f.type !== 'closeout' || !f.settleAdj || Math.abs(f.settleAdj) < 0.5) return '';
    return '인출 ' + fmtWon(f.cashOut) +
      (f.settleAdj > 0 ? ' + 손실정리 ' : ' − 이익정리 ') + fmtWon(Math.abs(f.settleAdj));
  }

  function collectFlows(p) {
    return p.history.filter(function (r) { return FLOW_TYPES[r.type]; }).map(function (r) {
      return {
        date: r.date, type: r.type, label: r.label,
        amount: r.amount, signed: flowDelta(r),
        principalDelta: r.principalDelta, cashOut: r.cashOut, settleAdj: r.settleAdj,
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
        var d = flowDelta(f);
        if (d >= 0) dep += d; else wd += -d;
      });
      return { p: p, flows: flows, deposits: dep, withdrawals: wd, net: dep - wd };
    });

    var totalDep = 0, totalWd = 0;
    perAccount.forEach(function (a) { totalDep += a.deposits; totalWd += a.withdrawals; });

    // 요약 카드
    var cards = el('cashflow-cards');
    cards.innerHTML = '';
    cards.appendChild(card('총 입금', fmtWonAuto(totalDep), '전 계좌 누적'));
    cards.appendChild(card('총 출금', fmtWonAuto(totalWd), '해지 시 남은 원금 차감 포함'));
    cards.appendChild(card('순 원금 (입금−출금)', fmtWonAuto(totalDep - totalWd), '전 계좌 원금 흐름 합계'));
    cards.appendChild(card('계좌 수', String(processed.length) + '개',
      processed.filter(function (p) { return p.isClosed; }).length + '개 해지'));

    var body = el('cashflow-body');
    body.innerHTML = '';

    if (!processed.length) {
      body.appendChild(h('p', { class: 'empty', text: '등록된 계좌가 없습니다.' }));
      el('cashflow-dialog').showModal();
      return;
    }

    // ── 계좌별 원금 원장 (원금 → 추가입금 → 원금합) ──
    body.appendChild(h('h4', { class: 'cashflow-title', text: '계좌별 원금 원장' }));
    var grid = h('div', { class: 'ledger-grid' });
    perAccount.forEach(function (a) {
      grid.appendChild(ledgerColumn(a.p, a.flows));
    });
    body.appendChild(grid);

    // ── 전체 통합 내역 (일자순) ──
    var allFlows = [];
    perAccount.forEach(function (a) { allFlows = allFlows.concat(a.flows); });
    allFlows.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });

    body.appendChild(h('h4', { class: 'cashflow-title', text: '전체 통합 내역' }));
    if (allFlows.length) {
      var runningNet = 0;
      var prevDate = null;
      var totalRows = allFlows.map(function (f) {
        // 표시 금액과 누적을 같은 기준(원금 차감액)으로 맞춘다 — 해지는 인출 현금과 다르다
        runningNet += f.signed;
        var note = closeoutNote(f);
        var sameDay = f.date === prevDate; // 같은 날 연속 행은 일자를 반복하지 않는다
        prevDate = f.date;
        return h('tr', { class: 'compact' }, [
          h('td', { text: sameDay ? '' : f.date, class: 'date' }),
          h('td', { text: f.accountName, class: 'name' }),
          h('td', {}, [h('span', { class: 'tag tag-' + f.type, text: f.label })]),
          h('td', {
            text: (f.signed >= 0 ? '+' : '−') + fmtWon(Math.abs(f.signed)),
            class: 'num ' + (f.signed >= 0 ? 'pos' : 'neg'),
            title: note || undefined
          }),
          h('td', { text: fmtWon(runningNet), class: 'num muted-num' })
        ]);
      });
      body.appendChild(flowTable(['일자', '계좌', '구분', '원금 증감', '누적 순원금'], totalRows));
      body.appendChild(h('p', { class: 'cashflow-hint',
        text: '해지 행의 금액은 실제 인출 현금이 아니라 원금 차감액입니다. 자세한 내역은 위의 계좌별 원장을 보세요.' }));
    } else {
      body.appendChild(h('p', { class: 'empty', text: '원금 입출금 내역이 없습니다.' }));
    }

    el('cashflow-dialog').showModal();
  }

  // 한 계좌의 원금 원장 열: 원금(최초) → [추가입금·출금, 원금합] 반복 → 현재 원금
  // 엑셀 '종합' 시트의 윗단과 같은 구조로, 행을 그대로 더하면 현재 원금이 나온다.
  function ledgerColumn(p, flows) {
    var rows = [], running = 0;
    flows.forEach(function (f, i) {
      var d = flowDelta(f);
      running += d;
      if (i === 0) {
        rows.push(h('tr', { class: 'lg-principal' }, [
          h('td', { text: '원금', class: 'lg-k' }),
          h('td', { text: '', class: 'lg-d' }),
          h('td', { text: fmtWon(d), class: 'num lg-v' })
        ]));
        return;
      }
      rows.push(h('tr', { class: 'lg-add' }, [
        h('td', { text: flowLabel(f), class: 'lg-k' }),
        h('td', { text: f.date, class: 'lg-d' }),
        h('td', { text: (d >= 0 ? '+' : '−') + fmtWon(Math.abs(d)),
          class: 'num lg-v ' + (d >= 0 ? 'pos' : 'neg') })
      ]));
      // 해지 행은 인출 현금과 원금 차감액이 다르므로 근거를 한 줄로 덧붙인다
      var note = closeoutNote(f);
      if (note) {
        rows.push(h('tr', { class: 'lg-note' }, [
          h('td', { text: note, colspan: '3' })
        ]));
      }
      rows.push(h('tr', { class: 'lg-sum' }, [
        h('td', { text: '원금합', class: 'lg-k' }),
        h('td', { text: '', class: 'lg-d' }),
        h('td', { text: fmtWon(running), class: 'num lg-v' })
      ]));
    });
    if (!flows.length) {
      rows.push(h('tr', {}, [h('td', { text: '내역 없음', class: 'empty small', colspan: '3' })]));
    }
    rows.push(h('tr', { class: 'lg-final' }, [
      h('td', { text: '현재 원금', class: 'lg-k' }),
      h('td', { text: '', class: 'lg-d' }),
      h('td', { text: fmtWon(p.principal), class: 'num lg-v' })
    ]));

    // 원금이 0 이하(이익까지 인출)면 분모가 없어 수익률을 표시하지 않는다
    var showRet = p.principal > 0;
    return h('div', { class: 'ledger-col' }, [
      h('div', { class: 'ledger-head' }, [
        h('div', { class: 'ledger-name', text: p.name + (p.isClosed ? ' (해지)' : '') }),
        h('div', { class: 'ledger-ret ' + (showRet ? pctClass(p.principalReturn) : 'muted'),
          text: showRet ? '원금대비 ' + fmtPct(p.principalReturn) : '원금 소진' })
      ]),
      h('table', { class: 'ledger-table' }, [h('tbody', {}, rows)])
    ]);
  }

  // 마지막 두 열(금액)만 우측 정렬 — 구분 열은 태그라 좌측 정렬이어야 한다
  function flowTable(headers, rows) {
    var numFrom = headers.length - 2;
    var thead = h('thead', {}, [
      h('tr', {}, headers.map(function (t, i) {
        return h('th', { text: t, class: i >= numFrom ? 'num' : '' });
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
        confirmDialog({
          title: '백업 복원',
          body: '현재 데이터를 백업 파일 내용(계좌 ' + parsed.accounts.length + '개)으로 교체합니다. 현재 데이터는 사라집니다.',
          okText: '교체', danger: true
        }).then(function (ok) {
          if (!ok) return;
          state = parsed;
          selectedAccountId = null;
          saveState();
          loadState();
          render();
          toast('백업을 복원했습니다. 계좌 ' + state.accounts.length + '개', 'ok');
        });
      } catch (e) {
        toast('백업 파일을 읽을 수 없습니다: ' + e.message, 'error');
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
          toast('계좌 데이터를 찾을 수 없습니다.', 'error');
          return;
        }
        importedAccounts = accounts;
        showImportPreview(accounts);
        el('import-dialog').showModal();
      } catch (e) {
        toast('엑셀 파일을 읽을 수 없습니다: ' + e.message, 'error');
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
      var imported = { date: date, type: type, amount: amount };
      // 재계약은 지급액이 기록돼 있으면 '원금만 재계약(이익 지급)', 없으면 '원리금 재계약'
      if (type === 'rollover') imported.mode = amount > 0 ? 'payout' : 'compound';
      accountMap[accName].events.push(imported);
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
        var out = {
          id: 'ev' + seq,
          seq: seq,
          type: ev.type,
          date: ev.date,
          amount: ev.amount
        };
        if (ev.mode) out.mode = ev.mode;
        events.push(out);
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
    // '전액출금'은 '출금'을 포함하므로 해지 판정을 먼저 한다
    if (m.includes('전액') || m.includes('해지') || m === 'closeout') return 'closeout';
    if (m.includes('입금') || m === 'deposit') return 'deposit';
    if (m.includes('출금') || m === 'withdraw') return 'withdraw';
    if (m.includes('만기') || m === 'maturity') return 'maturity';
    if (m.includes('재계약') || m.includes('롤오버') || m === 'rollover') return 'rollover';
    if (m.includes('이익지급') || m.includes('이자') || m.includes('쿠폰') ||
        m.includes('배당') || m === 'payout') return 'payout';
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
    // 확인 다이얼로그는 비동기이고 아래에서 importedAccounts를 비우므로 목록을 미리 잡아둔다
    var pending = importedAccounts, n = pending.length;
    confirmDialog({
      title: '계좌 등록',
      body: '엑셀에서 읽은 계좌 ' + n + '개를 현재 목록에 추가합니다.',
      okText: '등록'
    }).then(function (ok) {
      if (!ok) return;
      pending.forEach(function (acc) {
        state.accounts.push(acc);
      });

      saveState();
      selectedAccountId = null;
      render();
      el('import-dialog').close();
      toast('계좌 ' + n + '개를 등록했습니다.', 'ok');
    });
    importedAccounts = null;
  }

  // ---------- 초기화 ----------

  function init() {
    loadState();
    wireDialogs();

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
      if (!name) { toast('계좌명을 입력하세요.', 'warn'); return; }
      if (!v) return;
      if (v.amount <= 0) { toast('초기 원금은 0보다 커야 합니다.', 'warn'); return; }
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
      toast('"' + name + '" 계좌를 만들었습니다.', 'ok');
    });

    // 일일 평가금액
    el('form-valuation').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = readForm(e.target);
      if (!v) return;
      addEvent(selectedAccountId, 'valuation', v.date, v.amount);
      e.target.elements.amount.value = '';
      toast(v.date + ' 평가금액 ' + fmtWon(v.amount) + ' 저장', 'ok');
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
        if (!date) { toast('날짜를 입력하세요.', 'warn'); return; }
        var pc = computeAll().processed.find(function (x) { return x.id === selectedAccountId; });
        if (!pc || pc.eval <= 0.005) { toast('출금할 잔액이 없습니다.', 'warn'); return; }
        var closeId = selectedAccountId;
        confirmDialog({
          title: '전액 출금 · 해지',
          body: '현재 평가금액 전액(' + fmtWon(pc.eval) + ')을 출금하고 계좌를 해지 상태로 만듭니다. ' +
            '해지 시점까지의 성과는 종합 성과 수익률에 그대로 보존됩니다.',
          okText: '해지', danger: true
        }).then(function (ok) {
          if (!ok) return;
          addEvent(closeId, 'closeout', date, 0);
          toast('해지 처리했습니다. 출금 ' + fmtWon(pc.eval), 'ok');
        });
        return;
      }
      var v = readForm(e.target);
      if (!v) return;
      var form = e.target, accId = selectedAccountId;
      var commit = function () {
        addEvent(accId, type, v.date, v.amount);
        form.elements.amount.value = '';
        toast((type === 'deposit' ? '입금' : '출금') + ' ' + fmtWon(v.amount) + ' 반영했습니다.', 'ok');
      };
      if (type === 'withdraw') {
        var p = computeAll().processed.find(function (x) { return x.id === accId; });
        if (p && v.amount > p.eval + 1e-6) {
          confirmDialog({
            title: '평가금액 초과 출금',
            body: '출금액이 현재 평가금액(' + fmtWon(p.eval) + ')을 초과합니다. 그대로 진행하면 잔여 좌수가 0으로 정리됩니다.',
            okText: '계속', danger: true
          }).then(function (ok) { if (ok) commit(); });
          return;
        }
      }
      commit();
    });

    // 성과보수 수취
    el('form-fee').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = readForm(e.target);
      if (!v) return;
      var p = computeAll().processed.find(function (x) { return x.id === selectedAccountId; });
      if (p && v.amount > p.eval + 1e-6) {
        toast('성과보수가 현재 평가금액(' + fmtWon(p.eval) + ')을 초과할 수 없습니다.', 'error');
        return;
      }
      var after = p ? p.eval - v.amount : 0;
      var feeForm = e.target, feeAccId = selectedAccountId;
      confirmDialog({
        title: '성과보수 수취',
        body: '성과보수 ' + fmtWon(v.amount) + ' 수취 후 기준가 1,000 / 수익률 0%로 초기화됩니다. ' +
          '보수 차감 후 평가금액(' + fmtWon(after) + ')이 새 계약의 원금으로 승계되며, ' +
          '원금 흐름(입금−출금)과 전체 성과 수익률은 그대로 유지됩니다.',
        okText: '수취'
      }).then(function (ok) {
        if (!ok) return;
        addEvent(feeAccId, 'fee', v.date, v.amount);
        feeForm.elements.amount.value = '';
        toast('성과보수 ' + fmtWon(v.amount) + ' 수취 — 기준가 1,000으로 재설정', 'ok');
      });
    });

    // 계좌 이름 변경 (상세 창 제목 옆 연필 아이콘)
    el('btn-rename-account').addEventListener('click', function () {
      renameAccount(selectedAccountId);
    });

    // 계좌 삭제
    el('btn-delete-account').addEventListener('click', function () {
      var acc = getAccount(selectedAccountId);
      if (!acc) return;
      var delId = acc.id, delName = acc.name;
      confirmDialog({
        title: '계좌 삭제',
        body: '"' + delName + '" 계좌와 모든 내역을 삭제합니다. 되돌릴 수 없습니다.',
        okText: '삭제', danger: true
      }).then(function (ok) {
        if (!ok) return;
        state.accounts = state.accounts.filter(function (a) { return a.id !== delId; });
        if (selectedAccountId === delId) selectedAccountId = null;
        saveState();
        render();
        toast('"' + delName + '" 계좌를 삭제했습니다.', 'ok');
      });
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
    el('btn-rail-add').addEventListener('click', function () { el('btn-add-account').click(); });
    el('btn-empty-add').addEventListener('click', function () { el('btn-add-account').click(); });
    el('btn-empty-restore').addEventListener('click', function () { el('btn-restore').click(); });
    el('btn-cashflow').addEventListener('click', openCashflow);
    el('btn-close-cashflow').addEventListener('click', function () { el('cashflow-dialog').close(); });

    // 벤치마크 지수 입력
    el('btn-benchmark').addEventListener('click', function () {
      var f = el('form-benchmark'), bm = state.benchmark;
      f.elements.name.value = (bm && bm.name) || '코스피';
      f.elements.data.value = bm && bm.points
        ? bm.points.map(function (p) { return p.date + '\t' + p.value; }).join('\n') : '';
      el('benchmark-dialog').showModal();
    });
    el('btn-cancel-benchmark').addEventListener('click', function () { el('benchmark-dialog').close(); });
    el('btn-delete-benchmark').addEventListener('click', function () {
      if (!state.benchmark) { el('benchmark-dialog').close(); return; }
      confirmDialog({
        title: '벤치마크 삭제',
        body: '저장된 벤치마크 지수(' + (state.benchmark.name || '벤치마크') + ')를 삭제합니다.',
        okText: '삭제', danger: true
      }).then(function (ok) {
        if (!ok) return;
        delete state.benchmark;
        saveState();
        el('benchmark-dialog').close();
        render();
        toast('벤치마크를 삭제했습니다.', 'ok');
      });
    });
    el('form-benchmark').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var text = f.elements.data.value;
      if (!text.trim()) {
        delete state.benchmark;
        toast('벤치마크를 비웠습니다.', 'ok');
      } else {
        var parsed = parseBenchmarkText(text);
        if (parsed.points.length < 2) {
          toast('일자와 지수를 인식하지 못했습니다. 「2026-01-02  2650.12」처럼 일자와 숫자 두 열을 붙여넣어 주세요.', 'error');
          return;
        }
        state.benchmark = { name: f.elements.name.value.trim() || '벤치마크', points: parsed.points };
        if (parsed.skipped) {
          toast(parsed.points.length + '개를 저장했습니다. 인식하지 못한 ' + parsed.skipped + '줄은 건너뛰었습니다.', 'warn');
        } else {
          toast(state.benchmark.name + ' ' + parsed.points.length + '개 일자를 저장했습니다.', 'ok');
        }
      }
      saveState();
      el('benchmark-dialog').close();
      render();
    });
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

    // 모바일 브레이크포인트를 넘나들 때(창 크기 조절·화면 회전) 축약 표기(fmtWonAuto)가
    // 바로 반영되도록 다시 그린다. matchMedia는 기준을 실제로 넘을 때만 이벤트를 준다.
    if (MOBILE_MQ) {
      var onMqChange = function () { render(); };
      if (MOBILE_MQ.addEventListener) MOBILE_MQ.addEventListener('change', onMqChange);
      else if (MOBILE_MQ.addListener) MOBILE_MQ.addListener(onMqChange); // 구형 Safari
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
