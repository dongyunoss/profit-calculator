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
    // 억과 만 사이는 줄바꿈 없는 공백(NBSP) — 좁은 칸에서 "381억 / 2,984만원"으로 갈라지지 않게
    if (eok > 0) {
      s = eok.toLocaleString('ko-KR') + '억' + (man > 0 ? '\u00a0' + man.toLocaleString('ko-KR') + '만' : '');
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

  // ---------- 화면 모드(다크/데이) ----------
  //
  // 색은 전부 CSS 토큰이라 html[data-theme] 하나만 바꾸면 화면은 끝난다.
  // 차트는 SVG를 직접 그리므로 아래 chartPalette()로 같은 토큰을 읽어 넘긴다.

  var THEME_KEY = 'profit-calculator-theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var btn = el('btn-theme');
    if (btn) {
      // 해/달 아이콘 전환은 CSS([data-theme])가 한다. 여기서 textContent를 건드리면
      // 버튼 안의 SVG 두 개가 지워지므로 접근성 라벨만 갱신한다.
      var label = theme === 'dark' ? '데이 모드로 전환' : '다크 모드로 전환';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
    }
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 저장 실패는 무시 */ }
    if (lastResult) renderChart(lastResult); // 차트는 SVG라 다시 그려야 색이 바뀐다
  }

  // CSS 토큰에서 차트 색을 읽는다 — 팔레트를 CSS 한 곳에서만 관리하기 위해
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  // 격자·축·마커 색은 chart.js가 theme 이름으로 자체 관리한다 — 여기선 선 색만 넘긴다
  function chartPalette() {
    var s = [];
    for (var i = 1; i <= 8; i++) s.push(cssVar('--s' + i, '#4fb3c9'));
    return {
      theme: currentTheme(),
      series: s,
      composite: s[0],
      benchmark: cssVar('--benchmark', '#5d6472')
    };
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
    renderIndexBar(result);
    renderAccountsTable(result);
    renderDetail(result);
  }

  // ---------- 수익률 추이 차트 ----------

  // 계좌별 카테고리 색상 (dataviz 검증 팔레트, 고정 순서로 배정)
  // 다크 배경에서 구분되는 계좌별 라인 색
  // 색 값 자체는 CSS의 --s1..--s8 / --benchmark가 갖고 있다(테마별로 다름).
  // 여기서는 chartPalette()로 그때그때 읽어 쓴다.
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
    return { name: bm.name || '벤치마크', color: chartPalette().benchmark, points: pts, dashed: true };
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
      var pal = chartPalette();
      var seriesList = [{ name: '종합 성과 수익률', color: pal.composite, points: pts, emphasis: true }];
      var bm = benchmarkSeries(cats);
      if (bm) seriesList.push(bm);
      Chart.renderLineChart(el('chart-area'), { series: seriesList, categories: cats, theme: pal.theme });
      var lastY = pts.length ? pts[pts.length - 1].y : 0;
      legend.appendChild(legendItem('종합 성과 지수', pal.composite, false, fmtPct(lastY), pctClass(lastY)));
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
      var colorOf = {}, palA = chartPalette();
      active.forEach(function (p, i) { colorOf[p.id] = palA.series[i % palA.series.length]; });
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
      Chart.renderLineChart(el('chart-area'), { series: seriesList, categories: cats, theme: palA.theme });
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

  function card(label, value, sub, cls, title) {
    // cls(pos/neg)를 칸 전체에도 걸어서 좌측에 손익 색 강조선이 붙게 한다 —
    // 값을 읽기 전에도 색으로 먼저 스캔할 수 있게(가시성).
    // title은 스트립을 조밀하게 줄이며 뺀 자세한 설명을 마우스오버로 남겨 둔다.
    var attrs = { class: 'card' + (cls ? ' ' + cls : '') };
    if (title) attrs.title = title;
    return h('div', attrs, [
      h('div', { class: 'card-label', text: label }),
      h('div', { class: 'card-value' + (cls ? ' ' + cls : ''), text: value }),
      sub ? h('div', { class: 'card-sub', text: sub }) : null
    ]);
  }

  // subCls는 "값 자체는 손익이 아니지만 보조 줄이 손익인" 칸(예: 평가금액 → 평가손익)에 쓴다.
  // 잔고에 손익 색을 칠하면 그 금액만큼 벌었다는 뜻으로 읽히므로 색은 손익 줄에만 준다.
  function metric(label, value, sub, cls, subCls) {
    return h('div', { class: 'metric' }, [
      h('div', { class: 'metric-label', text: label }),
      h('div', { class: 'metric-value' + (cls ? ' ' + cls : ''), text: value }),
      h('div', { class: 'metric-sub' + (subCls ? ' ' + subCls : ''), text: sub || '' })
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
    // 원금 대비 평가금액이 몇 배인지 — 손익은 아래 '평가손익' 카드가 따로 맡으므로
    // 여기 서브 텍스트는 겹치지 않게 배율로 보여준다
    var evalMultiple = s.totalPrincipal > 0 ? s.totalEval / s.totalPrincipal : null;
    // 보유 잔고 기준 손익률(그대로 인출·재계약되지 않은 부분) — '원금대비 단순 수익률'과 달리
    // 이미 실현돼 계좌 밖으로 나간 보수·배당은 되살리지 않는다(그래서 두 수익률이 다를 수 있다)
    var pnlRatio = s.totalPrincipal > 0 ? s.totalPnl / s.totalPrincipal : null;

    // 조밀한 스트립에 맞춰 서브 텍스트는 짧게 줄이고, 뺀 설명은 title(마우스오버)로 남긴다.
    wrap.appendChild(card('총 원금', fmtWon(s.totalPrincipal),
      '입금 ' + fmtWon(s.totalDeposits) + ' − 출금 ' + fmtWon(s.totalWithdrawals), null,
      '원금 흐름(입금−출금) 기준 · 개별 계좌의 계약원금 재설정과 무관'));
    wrap.appendChild(card('총 평가금액', fmtWon(s.totalEval),
      evalMultiple === null ? '전 계좌 합계' : '원금 대비 ' + evalMultiple.toFixed(2) + '배'));
    wrap.appendChild(card('평가손익', fmtWon(s.totalPnl),
      pnlRatio === null ? '' : '원금대비 ' + fmtPct(pnlRatio), pctClass(s.totalPnl),
      '보유 잔고 기준 — 이미 지급된 성과보수·배당은 포함하지 않음'));
    wrap.appendChild(card('종합 성과 수익률', fmtPct(comp.ret), '지수 ' + fmtNum(comp.index, 2), pctClass(comp.ret),
      '계좌별 일간 기준가 수익률을 직전 평가금액 가중으로 체인링크'));
    wrap.appendChild(card('원금대비 단순 수익률', fmtPct(s.simpleReturn), '총수익 기준', pctClass(s.simpleReturn),
      '지급된 성과보수·배당을 되살려 계산 — 재계약으로 수익률이 깎여 보이지 않음'));

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

  // 벤치마크 시리즈에 한 점을 추가/갱신한다 (계좌 목록 상단 지수 입력용).
  // state.benchmark는 수익률 추이 차트·PDF 리포트가 함께 읽는 저장소라
  // 여기서 입력하면 둘 다에 그대로 반영된다.
  function upsertBenchmarkPoint(date, value) {
    if (!state.benchmark) state.benchmark = { name: '코스피', points: [] };
    var pts = state.benchmark.points;
    var idx = pts.findIndex(function (pt) { return pt.date === date; });
    if (idx >= 0) pts[idx] = { date: date, value: value };
    else pts.push({ date: date, value: value });
    pts.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }

  // 계좌 목록 상단 지수 바 — 입력 폼은 static(HTML)이라 다시 그리지 않는다
  // (매 render마다 새로 만들면 타이핑 중인 값이 날아간다). 우측 통계만 갱신한다.
  function renderIndexBar(result) {
    var host = el('index-stats');
    host.innerHTML = '';
    var bm = state.benchmark;
    if (!bm || !bm.points.length) {
      host.appendChild(h('span', { class: 'index-hint',
        text: result.processed.length
          ? '지수를 입력하면 계좌 설정일 대비 변동률이 표시됩니다.'
          : '계좌를 등록하면 설정일 대비 변동률도 함께 표시됩니다.' }));
      return;
    }
    var latest = bm.points[bm.points.length - 1];
    host.appendChild(h('span', { class: 'index-current' }, [
      h('span', { class: 'index-current-value', text: fmtNum(latest.value, 2) }),
      h('span', { class: 'index-current-date', text: latest.date })
    ]));

    var baseDate = firstDate(result.processed); // 가장 이른 계좌 설정일(개설일)
    if (baseDate && bm.points.length >= 1) {
      var baseVal = benchmarkValueAt(bm.points, baseDate);
      var exact = baseVal !== null;
      if (!exact) baseVal = bm.points[0].value; // 지수 데이터가 설정일보다 늦게 시작하면 첫 값으로 대체
      var baseUsedDate = exact ? baseDate : bm.points[0].date;
      var chg = baseVal > 0 ? (latest.value / baseVal - 1) : null;
      if (chg !== null) {
        host.appendChild(h('span', { class: 'index-change' }, [
          h('span', { class: 'index-change-label',
            text: (exact ? '설정일(' : '데이터 시작일(') + baseUsedDate + ') 대비' }),
          h('span', { class: 'index-change-value ' + pctClass(chg), text: fmtPct(chg) })
        ]));
      }
    }
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
    cards.appendChild(metric('평가금액', fmtWonAuto(p.eval),
      '평가손익 ' + fmtWonAuto(p.contractPnl), null, pctClass(p.contractPnl)));
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
        h('td', { text: fmtNum(row.nav, 2), class: 'num' }),
        h('td', { text: fmtWon(row.eval), class: 'num' }),
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
        h('td', { text: fmtNum(row.nav, 2), class: 'num' })
      ]));
    });
    if (!all.length) {
      tbody.appendChild(h('tr', {}, [h('td', { text: '평가 내역 없음 — 일일 평가금액을 입력하세요.', class: 'empty small', colspan: '5' })]));
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

  // ---------- PDF 리포트 (A4 한 장에 계좌 여러 개) ----------
  //
  // PDF 바이트를 직접 만들지 않고 브라우저 인쇄(→ "PDF로 저장")를 쓴다.
  // 한글은 PDF에 CJK 폰트를 통째로 심어야 그려지는데(수 MB), 인쇄 경로를 쓰면
  // 화면과 같은 폰트·자간으로 정확히 나가고 페이지 나눔도 브라우저가 처리한다.

  var REPORT_ROWS = 10;         // 표에 싣는 최근 평가일 수
  var REPORT_PER_PAGE = 3;      // A4 한 장에 담는 계좌 수
  var REPORT_FIRST_PAGE = 2;    // 첫 장은 총괄 블록이 들어가 한 계좌 적게

  // PDF에서 뺀 계좌의 id 집합. "선택한 계좌" 대신 "뺀 계좌"로 기억해 두면
  // 새로 만든 계좌는 아무것도 하지 않아도 다음 리포트에 자동으로 포함된다.
  var pdfDeselectedIds = new Set();
  var REPORT_LINE = '#0e7490';  // 인쇄용 차트 선색 — 흑백 출력에서도 뭉개지지 않는 진한 청록

  // 요약 스트립 한 칸
  function rpStat(label, value, cls, sub) {
    return h('div', { class: 'rp-stat' }, [
      h('span', { class: 'rp-stat-label', text: label }),
      h('span', { class: 'rp-stat-value' + (cls ? ' ' + cls : ''), text: value }),
      sub ? h('span', { class: 'rp-stat-sub', text: sub }) : null
    ]);
  }

  // 두 줄짜리 표 머리 — 좁은 칸에서 "원금대비 수익률"이 열 폭을 밀어내지 않게 나눈다
  function rpTh(line1, line2) {
    return h('th', { class: 'num' }, [
      h('span', { text: line1 }),
      line2 ? h('span', { class: 'rp-th-2', text: line2 }) : null
    ]);
  }

  // 계좌 한 개 = 한 블록 (차트 | 최근 평가 표를 좌우로 붙여 높이를 줄인다)
  function reportBlock(p, asOf) {
    var vals = p.history.filter(function (r) { return VALUATION_TYPES[r.type]; });
    var recent = vals.slice(-REPORT_ROWS).slice().reverse(); // 최신이 위
    var navRet = p.nav / Engine.NAV_BASE - 1;
    // 개별 계좌는 계약 기준(보수 수취 시 승계된 원금). 원금 흐름과 갈리면 함께 적는다.
    // 해지 계좌는 원금 흐름이 해지 차감의 잔여값이라 음수로 남을 수 있어 리포트에서는 뺀다.
    var carried = !p.isClosed && Math.abs(p.contractPrincipal - p.principal) > 0.5;
    var status = p.isClosed ? '해지' : (p.isMatured ? '만기' : '운용 중');

    var block = h('article', { class: 'rp-acct' }, [
      h('div', { class: 'rp-acct-head' }, [
        h('h2', { class: 'rp-name', text: p.name }),
        h('span', { class: 'rp-status', text: status }),
        h('span', { class: 'rp-acct-meta',
          text: (p.createdDate ? '개설 ' + p.createdDate : '') +
                (p.lastValuationDate ? '  ·  기준일 ' + p.lastValuationDate : '') })
      ]),

      h('div', { class: 'rp-strip' }, [
        rpStat('원금', fmtWon(p.contractPrincipal), null,
          carried ? '흐름 ' + fmtWon(p.principal) : null),
        rpStat('평가금액', fmtWon(p.eval)),
        rpStat('평가손익', fmtWon(p.contractPnl), pctClass(p.contractPnl)),
        rpStat('원금대비 수익률', fmtPct(p.contractReturn), pctClass(p.contractReturn)),
        rpStat('기준가', fmtNum(p.nav, 2)),
        rpStat('좌수', fmtNum(p.units, 0))
      ]),

      h('div', { class: 'rp-cols' }, [
        h('div', { class: 'rp-col rp-col-chart' }, [
          h('h3', { class: 'rp-title', text: '누적 수익률 · 기준가 기준' }),
          h('div', { class: 'rp-chart' })
        ]),
        h('div', { class: 'rp-col rp-col-table' }, [
          h('h3', { class: 'rp-title', text: '최근 ' + REPORT_ROWS + '일 평가 내역' }),
          h('table', { class: 'rp-table' }, [
            h('thead', {}, [h('tr', {}, [
              h('th', {}, [h('span', { text: '일자' })]),
              rpTh('평가금액'), rpTh('원금대비', '수익률'), rpTh('기준가', '수익률'),
              rpTh('기준가'), rpTh('좌수')
            ])]),
            h('tbody', {}, recent.length ? recent.map(function (row) {
              var pr = rowRet(row), nr = row.nav / Engine.NAV_BASE - 1;
              return h('tr', {}, [
                h('td', { text: row.date }),
                h('td', { text: fmtWon(row.eval), class: 'num' }),
                h('td', { text: pr === null ? '-' : fmtPct(pr), class: 'num ' + (pr === null ? '' : pctClass(pr)) }),
                h('td', { text: fmtPct(nr), class: 'num ' + pctClass(nr) }),
                h('td', { text: fmtNum(row.nav, 2), class: 'num' }),
                h('td', { text: fmtNum(row.units, 0), class: 'num' })
              ]);
            }) : [h('tr', {}, [h('td', { colspan: '6', class: 'rp-none', text: '평가 내역이 없습니다.' })])])
          ])
        ])
      ])
    ]);

    // 차트는 DOM에 붙은 뒤 그려야 컨테이너 폭을 잴 수 있다 — 렌더 함수만 매달아 둔다
    block.__drawChart = function () {
      var host = block.querySelector('.rp-chart');
      var pts = accountReturnSeries(p);
      if (pts.length < 2) {
        host.appendChild(h('p', { class: 'rp-none', text: '평가 데이터 2일 미만 — 추이 없음' }));
        return;
      }
      Chart.renderLineChart(host, {
        series: [{ name: p.name, color: REPORT_LINE, points: pts, emphasis: true }],
        categories: pts.map(function (pt) { return pt.x; }),
        formatY: fmtPct,
        theme: 'light',
        height: 178,   // 오른쪽 표(10행)와 기둥 높이를 맞춰 아래 여백을 남기지 않는다
        interactive: false
      });
    };
    return block;
  }

  function rpLegend(name, color, dashed) {
    return h('span', { class: 'rp-legend-item' }, [
      h('span', { class: 'rp-legend-line' + (dashed ? ' dashed' : ''), style: 'color:' + color }),
      h('span', { text: name })
    ]);
  }

  // 첫 장 최상단 총괄 — 코스피 지수 · 총누적 수익률 · 원금대비 단순 수익률 + 종합 성과 차트
  function reportSummaryBlock(result) {
    var comp = result.composite, sm = result.summary;

    // 종합 성과 지수 시계열 (화면 차트와 같은 계산)
    var pts = [{ x: comp.series.length ? firstDate(result.processed) : '', y: 0 }]
      .filter(function (pt) { return pt.x; });
    comp.series.forEach(function (sr) { pts.push({ x: sr.date, y: sr.index / Engine.NAV_BASE - 1 }); });
    var cats = pts.map(function (pt) { return pt.x; });
    var bm = benchmarkSeries(cats);
    var bmRet = bm ? bm.points[bm.points.length - 1].y : null;
    // 벤치마크 지수의 최신 절대값 — 차트 마지막 날짜 이하의 마지막 지수
    var bmValue = (state.benchmark && cats.length)
      ? benchmarkValueAt(state.benchmark.points, cats[cats.length - 1]) : null;
    var bmName = (state.benchmark && state.benchmark.name) || '코스피';

    var block = h('section', { class: 'rp-summary' }, [
      h('div', { class: 'rp-strip rp-strip-3' }, [
        rpStat(bmName + ' 지수',
          bmValue === null ? '미등록' : fmtNum(bmValue, 2),
          bmRet === null ? null : pctClass(bmRet),
          bmRet === null ? '벤치마크 데이터 없음' : '기간 수익률 ' + fmtPct(bmRet)),
        rpStat('총누적 수익률', fmtPct(comp.ret), pctClass(comp.ret),
          '종합 성과 지수 ' + fmtNum(comp.index, 2)),
        rpStat('원금대비 단순 수익률', fmtPct(sm.simpleReturn), pctClass(sm.simpleReturn),
          '총수익 기준(배당·보수 되살림)')
      ]),
      h('div', { class: 'rp-summary-chart-wrap' }, [
        h('h3', { class: 'rp-title' }, [
          h('span', { text: '종합 성과 지수' + (bm ? ' vs ' + bmName : '') }),
          h('span', { class: 'rp-title-sub', text: '차트 시작 시점 0% 기준' })
        ]),
        // 인쇄물에는 마우스오버가 없으니 실선/점선이 무엇인지 범례로 못박아 둔다
        h('div', { class: 'rp-legend' }, [
          rpLegend('종합 성과 지수', REPORT_LINE, false),
          bm ? rpLegend(bmName, '#6b7280', true) : null
        ]),
        h('div', { class: 'rp-chart rp-summary-chart' })
      ])
    ]);

    block.__drawChart = function () {
      var host = block.querySelector('.rp-chart');
      if (pts.length < 2) {
        host.appendChild(h('p', { class: 'rp-none', text: '평가 데이터가 2일 미만이라 추이를 그릴 수 없습니다.' }));
        return;
      }
      var seriesList = [{ name: '종합 성과 지수', color: REPORT_LINE, points: pts, emphasis: true }];
      if (bm) seriesList.push({ name: bmName, color: '#6b7280', points: bm.points, dashed: true });
      Chart.renderLineChart(host, {
        series: seriesList, categories: cats, formatY: fmtPct,
        theme: 'light', height: 150, interactive: false
      });
    };
    return block;
  }

  // 계좌 블록을 페이지에 담는다. 첫 장은 총괄 블록이 자리를 차지하므로 한 계좌 적게 싣는다.
  function reportPages(result, asOf) {
    var processed = result.processed;
    var pages = [], blocks = [];
    var summary = reportSummaryBlock(result);
    blocks.push(summary);

    // 페이지별 계좌 수를 먼저 확정해야 "n / m" 표기를 채울 수 있다
    var chunks = [], i = 0;
    while (i < processed.length) {
      var take = chunks.length === 0 ? REPORT_FIRST_PAGE : REPORT_PER_PAGE;
      chunks.push(processed.slice(i, i + take));
      i += take;
    }
    if (!chunks.length) chunks.push([]); // 계좌가 없어도 총괄 한 장은 나온다

    chunks.forEach(function (chunk, pi) {
      var body = chunk.map(function (p) { return reportBlock(p, asOf); });
      blocks = blocks.concat(body);
      var head = [
        h('header', { class: 'rp-page-head' }, [
          h('span', { class: 'rp-page-title', text: '계좌 운용 현황' }),
          h('span', { class: 'rp-page-meta',
            text: (asOf ? '기준일 ' + asOf + '  ·  ' : '') + (pi + 1) + ' / ' + chunks.length })
        ])
      ];
      if (pi === 0) head.push(summary);
      pages.push(h('section', { class: 'rp-page' }, head.concat(body).concat([
        h('footer', { class: 'rp-page-foot' }, [
          h('span', { text: '기준가는 1,000좌당 가격이며 계좌 개설 시 1,000.00에서 시작합니다. ' +
            '원금대비 수익률은 지급된 성과보수·배당을 되살린 총수익 기준이고, ' +
            '누적 수익률 차트는 입출금 영향을 제거한 기준가 기준(개설 이후)입니다.' }),
          h('span', { class: 'rp-page-foot-right', text: '자산운용 수익률 관리 · ' + todayStr() })
        ])
      ])));
    });
    return { pages: pages, blocks: blocks };
  }

  // PDF 버튼을 누르면 바로 인쇄하지 않고 계좌 선택 창부터 연다.
  function openPdfSelect() {
    if (!lastResult || !lastResult.processed.length) {
      toast('등록된 계좌가 없습니다.', 'warn');
      return;
    }
    var list = el('pdf-select-list');
    list.innerHTML = '';
    lastResult.processed.forEach(function (p) {
      var checked = !pdfDeselectedIds.has(p.id);
      var status = p.isClosed ? '해지' : (p.isMatured ? '만기' : null);
      var checkAttrs = { type: 'checkbox', value: p.id, class: 'pdf-select-check' };
      if (checked) checkAttrs.checked = 'checked'; // h()는 falsy도 그대로 속성화하므로 참일 때만 넣는다
      list.appendChild(h('label', { class: 'pdf-select-row' }, [
        h('input', checkAttrs),
        h('span', { class: 'pdf-select-name', text: p.name }),
        status ? h('span', { class: 'pdf-select-badge', text: status }) : null,
        h('span', { class: 'pdf-select-ret ' + pctClass(p.contractReturn), text: fmtPct(p.contractReturn) })
      ]));
    });
    updatePdfSelectCount();
    var dlg = el('pdf-select-dialog');
    // 가로 위치는 showModal 전에도 정할 수 있다(폭이 CSS에 300px로 고정돼 있으므로).
    // 세로는 계좌 수에 따라 실제 렌더된 높이를 봐야 하므로 showModal 이후에 잡는다 —
    // 둘 다 같은 동기 실행 안에서 끝나 화면에는 최종 위치로만 그려진다(깜빡임 없음).
    positionPdfSelectDialogX();
    dlg.showModal();
    positionPdfSelectDialogY();
  }

  // PDF 리포트 선택 창을 "PDF 리포트" 버튼 바로 아래, 작은 드롭다운처럼 붙인다.
  function positionPdfSelectDialogX() {
    var btn = el('btn-pdf');
    var dlg = el('pdf-select-dialog');
    var margin = 8;
    var r = btn.getBoundingClientRect();
    var panelWidth = Math.min(300, window.innerWidth - margin * 2);

    var left = r.left; // 기본은 버튼 왼쪽 끝에 맞춘다
    if (left + panelWidth > window.innerWidth - margin) {
      left = r.right - panelWidth; // 오른쪽으로 넘치면 버튼 오른쪽 끝에 맞춰 당긴다
    }
    left = Math.max(margin, left);
    dlg.style.left = left + 'px';
  }

  function positionPdfSelectDialogY() {
    var btn = el('btn-pdf');
    var dlg = el('pdf-select-dialog');
    var margin = 8;
    var r = btn.getBoundingClientRect();

    var top = r.bottom + margin;
    dlg.style.top = top + 'px';

    // 계좌가 많아 목록이 길어지면 버튼 아래 공간을 넘길 수 있다 — 뷰포트 바닥에
    // 맞춰 위로 당기고, 그래도 안 맞으면(버튼이 화면 위쪽에 있고 창이 아주 좁으면)
    // 최소 margin은 지키며 바닥에 붙인다.
    var dlgHeight = dlg.getBoundingClientRect().height;
    if (top + dlgHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - margin - dlgHeight);
      dlg.style.top = top + 'px';
    }
  }

  function pdfCheckboxes() {
    return Array.prototype.slice.call(el('pdf-select-list').querySelectorAll('input[type=checkbox]'));
  }

  function updatePdfSelectCount() {
    var boxes = pdfCheckboxes();
    var checked = boxes.filter(function (b) { return b.checked; }).length;
    el('pdf-select-count').textContent = checked + ' / ' + boxes.length + ' 선택';
  }

  function setAllPdfChecks(checked) {
    pdfCheckboxes().forEach(function (b) { b.checked = checked; });
    updatePdfSelectCount();
  }

  // 선택된 계좌만으로 요약(총괄)·종합 성과 지수를 다시 계산한다 —
  // PDF가 일부 계좌만 담으면 첫 장 총괄도 그 계좌들 기준이어야 앞뒤가 맞는다.
  function buildFilteredResult(ids) {
    var idSet = new Set(ids);
    var processed = lastResult.processed.filter(function (p) { return idSet.has(p.id); });
    return {
      processed: processed,
      summary: Engine.computeSummary(processed),
      composite: Engine.computeComposite(processed)
    };
  }

  function generateReportPdf(selectedIds) {
    var result = buildFilteredResult(selectedIds);
    var host = el('print-report');
    host.innerHTML = '';
    var asOf = latestValuationDate(result.processed);
    var built = reportPages(result, asOf);
    built.pages.forEach(function (pg) { host.appendChild(pg); });
    built.blocks.forEach(function (bl) { bl.__drawChart(); }); // DOM에 붙은 뒤에 그린다

    // 브라우저는 저장 파일명을 document.title에서 가져온다 — 인쇄 동안만 바꿔 둔다
    var prevTitle = document.title;
    document.title = '자산운용_계좌현황_' + todayStr().replace(/-/g, '');

    var restore = function () {
      document.title = prevTitle;
      host.innerHTML = '';
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);

    toast('인쇄 창에서 대상을 "PDF로 저장"으로 선택하세요. 계좌 ' + selectedIds.length +
      '개, A4 한 장에 ' + REPORT_PER_PAGE + '개씩 나옵니다.', 'info');
    window.print();
    // afterprint를 지원하지 않는 브라우저 대비 — 넉넉히 기다렸다가 정리
    setTimeout(restore, 60000);
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

  // 다이얼로그 안 뷰 상태 — 두 섹션을 한 번에 쌓으면 스크롤이 2,300px까지 늘어난다.
  // 탭으로 하나씩 보여주고, 계좌 필터·정렬로 원하는 줄만 좁혀 볼 수 있게 한다.
  var cfView = 'ledger';      // 'ledger' | 'all'
  var cfAccountId = '';       // '' = 전체
  var cfNewestFirst = true;   // 전체 내역 정렬
  var cfData = null;          // openCashflow에서 계산한 결과를 재렌더 때 재사용

  function cfStat(label, value, sub, cls) {
    return h('div', { class: 'cf-stat' }, [
      h('span', { class: 'cf-stat-label', text: label }),
      h('span', { class: 'cf-stat-value' + (cls ? ' ' + cls : ''), text: value }),
      h('span', { class: 'cf-stat-sub', text: sub || '' })
    ]);
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

    // 전체 통합 내역은 일자순으로 한 번만 만들어 두고, 누적 순원금도 이때 확정한다
    // (필터·정렬을 바꿔도 각 행의 "그 시점 누적"은 변하지 않아야 한다)
    var allFlows = [];
    perAccount.forEach(function (a) { allFlows = allFlows.concat(a.flows); });
    allFlows.sort(function (x, y) { return x.date < y.date ? -1 : x.date > y.date ? 1 : 0; });
    var running = 0;
    allFlows.forEach(function (f) { running += f.signed; f.runningNet = running; });

    cfData = { processed: processed, perAccount: perAccount, allFlows: allFlows,
               totalDep: totalDep, totalWd: totalWd };

    // 요약 — 카드 4장(모바일에서 950px)을 컴팩트 스트립으로
    var stats = el('cashflow-stats');
    stats.innerHTML = '';
    stats.appendChild(cfStat('총 입금', fmtWonAuto(totalDep), '전 계좌 누적', 'pos'));
    stats.appendChild(cfStat('총 출금', fmtWonAuto(totalWd), '해지 시 남은 원금 차감 포함', 'neg'));
    stats.appendChild(cfStat('순 원금', fmtWonAuto(totalDep - totalWd), '입금 − 출금'));
    stats.appendChild(cfStat('계좌', processed.length + '개',
      processed.filter(function (p) { return p.isClosed; }).length + '개 해지'));

    // 계좌 필터 옵션 (선택값은 다이얼로그를 다시 열어도 유효하면 유지)
    var sel = el('cashflow-account');
    var keep = cfAccountId;
    sel.innerHTML = '';
    sel.appendChild(h('option', { value: '', text: '전체 (' + processed.length + '개)' }));
    processed.forEach(function (p) {
      sel.appendChild(h('option', { value: p.id, text: p.name + (p.isClosed ? ' (해지)' : '') }));
    });
    cfAccountId = processed.some(function (p) { return p.id === keep; }) ? keep : '';
    sel.value = cfAccountId;

    renderCashflowBody();
    el('cashflow-dialog').showModal();
  }

  function renderCashflowBody() {
    var body = el('cashflow-body');
    body.innerHTML = '';
    if (!cfData) return;

    // 탭·컨트롤 상태 반영
    Array.prototype.forEach.call(el('cashflow-tabs').querySelectorAll('.chip'), function (b) {
      var on = b.getAttribute('data-view') === cfView;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    var sortBtn = el('cashflow-sort');
    sortBtn.hidden = cfView !== 'all';
    sortBtn.textContent = cfNewestFirst ? '최신순 ↓' : '과거순 ↑';
    sortBtn.title = cfNewestFirst ? '과거순으로 보기' : '최신순으로 보기';

    if (!cfData.processed.length) {
      el('cashflow-count').textContent = '';
      body.appendChild(h('p', { class: 'empty', text: '등록된 계좌가 없습니다.' }));
      return;
    }

    if (cfView === 'ledger') renderCashflowLedger(body);
    else renderCashflowAll(body);
  }

  function renderCashflowLedger(body) {
    var cols = cfData.perAccount.filter(function (a) {
      return !cfAccountId || a.p.id === cfAccountId;
    });
    el('cashflow-count').textContent = cols.length + '개 계좌';
    if (!cols.length) {
      body.appendChild(h('p', { class: 'empty', text: '해당 계좌가 없습니다.' }));
      return;
    }
    var grid = h('div', { class: 'ledger-grid' });
    cols.forEach(function (a) { grid.appendChild(ledgerColumn(a.p, a.flows)); });
    body.appendChild(grid);
  }

  function renderCashflowAll(body) {
    var flows = cfData.allFlows.filter(function (f) {
      return !cfAccountId || f.accountId === cfAccountId;
    });
    el('cashflow-count').textContent = flows.length + '건';

    if (!flows.length) {
      body.appendChild(h('p', { class: 'empty', text: '원금 입출금 내역이 없습니다.' }));
      return;
    }

    var view = cfNewestFirst ? flows.slice().reverse() : flows;
    var prevDate = null;
    var rows = view.map(function (f) {
      var note = closeoutNote(f);
      // 같은 날 연속 행은 일자를 반복하지 않는다 (정렬 방향과 무관하게 "직전 행과 같은가"로 판단)
      var sameDay = f.date === prevDate;
      prevDate = f.date;
      return h('tr', { class: 'compact' + (sameDay ? '' : ' cf-daystart') }, [
        h('td', { text: sameDay ? '' : f.date, class: 'date' }),
        h('td', { text: f.accountName, class: 'name' }),
        h('td', {}, [h('span', { class: 'tag tag-' + f.type, text: f.label })]),
        h('td', {
          text: (f.signed >= 0 ? '+' : '−') + fmtWon(Math.abs(f.signed)),
          class: 'num ' + (f.signed >= 0 ? 'pos' : 'neg'),
          title: note || undefined
        }),
        h('td', { text: fmtWon(f.runningNet), class: 'num muted-num' })
      ]);
    });
    body.appendChild(flowTable(['일자', '계좌', '구분', '원금 증감', '누적 순원금'], rows));
    body.appendChild(h('p', { class: 'cashflow-hint',
      text: '해지 행의 금액은 실제 인출 현금이 아니라 원금 차감액입니다. 자세한 내역은 [계좌별 원장] 탭을 보세요.' +
            (cfAccountId ? ' 누적 순원금은 계좌를 걸러도 전 계좌 기준 값입니다.' : '') }));
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

  // ---------- 초기화 ----------

  function init() {
    loadState();
    wireDialogs();
    // <head>의 인라인 스크립트가 이미 data-theme를 세팅했다 — 버튼 라벨만 맞춘다
    applyTheme(currentTheme());
    // 저장된 선택이 없을 때만 OS 설정 변화를 따라간다
    if (window.matchMedia) {
      var osLight = window.matchMedia('(prefers-color-scheme: light)');
      var onOsChange = function (e) {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* 무시 */ }
        if (saved) return;
        applyTheme(e.matches ? 'light' : 'dark');
        if (lastResult) renderChart(lastResult);
      };
      if (osLight.addEventListener) osLight.addEventListener('change', onOsChange);
      else if (osLight.addListener) osLight.addListener(onOsChange);
    }

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
    el('cashflow-tabs').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      cfView = btn.getAttribute('data-view');
      renderCashflowBody();
      el('cashflow-body').scrollTop = 0; // 탭을 바꾸면 위에서부터 보게 한다
    });
    el('cashflow-account').addEventListener('change', function (e) {
      cfAccountId = e.target.value;
      renderCashflowBody();
      el('cashflow-body').scrollTop = 0;
    });
    el('cashflow-sort').addEventListener('click', function () {
      cfNewestFirst = !cfNewestFirst;
      renderCashflowBody();
      el('cashflow-body').scrollTop = 0;
    });

    // 계좌 목록 상단 지수 빠른 입력
    el('form-index').addEventListener('submit', function (e) {
      e.preventDefault();
      var f = e.target;
      var date = f.elements.date.value;
      var value = parseFloat(f.elements.value.value);
      if (!date) { toast('날짜를 입력하세요.', 'warn'); return; }
      if (!isFinite(value) || value <= 0) { toast('지수를 올바르게 입력하세요.', 'warn'); return; }
      upsertBenchmarkPoint(date, value);
      saveState();
      render();
      toast(date + ' 코스피 지수 ' + fmtNum(value, 2) + ' 저장', 'ok');
    });

    el('btn-export-xlsx').addEventListener('click', downloadXlsx);
    el('btn-pdf').addEventListener('click', openPdfSelect);
    el('btn-theme').addEventListener('click', toggleTheme);

    // PDF 리포트 — 계좌 선택
    el('btn-pdf-select-all').addEventListener('click', function () { setAllPdfChecks(true); });
    el('btn-pdf-select-none').addEventListener('click', function () { setAllPdfChecks(false); });
    el('btn-pdf-select-cancel').addEventListener('click', function () { el('pdf-select-dialog').close(); });
    el('pdf-select-list').addEventListener('change', updatePdfSelectCount);
    el('form-pdf-select').addEventListener('submit', function (e) {
      e.preventDefault();
      var boxes = pdfCheckboxes();
      var selected = boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
      if (!selected.length) {
        toast('계좌를 1개 이상 선택하세요.', 'warn');
        return;
      }
      // 다음에 열었을 때도 이번 선택이 이어지도록, "뺀 계좌" 기준으로 뒤집어 저장한다
      var selectedSet = new Set(selected);
      pdfDeselectedIds = new Set(
        boxes.filter(function (b) { return !selectedSet.has(b.value); }).map(function (b) { return b.value; })
      );
      el('pdf-select-dialog').close();
      generateReportPdf(selected);
    });
    el('btn-backup').addEventListener('click', backupJson);
    el('btn-restore').addEventListener('click', function () { el('restore-file').click(); });
    el('restore-file').addEventListener('change', function (e) {
      if (e.target.files[0]) restoreJson(e.target.files[0]);
      e.target.value = '';
    });

    // 날짜 기본값
    ['form-valuation', 'form-flow', 'form-fee', 'form-index'].forEach(function (id) {
      el(id).elements.date.value = todayStr();
    });
    // 지수 입력값은 저장된 마지막 지수로 미리 채워 둔다(수정하기 편하도록)
    if (state.benchmark && state.benchmark.points.length) {
      el('form-index').elements.value.value =
        state.benchmark.points[state.benchmark.points.length - 1].value;
    }

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
