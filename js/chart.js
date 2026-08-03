/*
 * chart.js — 의존성 없는 인라인 SVG 라인 차트 (수익률 추이 시각화)
 *
 * renderLineChart(container, opts)
 *   opts.series : [{ name, color, points:[{x:'2026-07-01', y:0.05}] }]
 *   opts.categories : x축에 표시할 정렬된 라벨 배열 (모든 시리즈 공통)
 *   opts.formatY : y값 → 문자열 (기본: 퍼센트)
 *   opts.baselineY : 기준선을 그릴 y값 (기본 0)
 *
 * x축은 categories 순서의 균등 간격(범주형). 영업일이 드문드문해도 정렬돼 보인다.
 */
(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';
  // 화면용 다크 팔레트 / 인쇄용 라이트 팔레트.
  // 인쇄는 흰 종이에 배경색 없이 나가는 것을 전제로 선·글자만으로 읽히게 잡았다.
  var THEMES = {
    dark:  { muted: '#8b929e', grid: '#262b33', axis: '#39404b', marker: '#1b1e24', fill: '#4fb3c9' },
    light: { muted: '#4b5563', grid: '#dfe3e8', axis: '#9aa2ad', marker: '#ffffff', fill: '#0e7490' }
  };
  var MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

  function svg(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function defaultFmtPct(v) { return (v * 100).toFixed(2) + '%'; }

  function niceTicks(min, max, count) {
    if (min === max) { min -= 0.01; max += 0.01; }
    var span = max - min;
    var step = Math.pow(10, Math.floor(Math.log10(span / count)));
    var err = (span / count) / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var start = Math.ceil(min / step) * step;
    var ticks = [];
    for (var t = start; t <= max + step * 1e-6; t += step) ticks.push(Math.round(t / step) * step);
    return ticks;
  }

  var fillSeq = 0; // 그라디언트 id 충돌 방지 (한 문서에 차트가 여럿일 때)

  function renderLineChart(container, opts) {
    container.innerHTML = '';
    var series = opts.series || [];
    var cats = opts.categories || [];
    var fmtY = opts.formatY || defaultFmtPct;
    var baselineY = opts.baselineY == null ? 0 : opts.baselineY;
    var T = THEMES[opts.theme] || THEMES.dark;
    var FILL_ID = 'areaFill' + (++fillSeq);

    if (!series.length || cats.length < 2) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '표시할 평가 데이터가 아직 없습니다. 계좌에 일일 평가금액을 2일 이상 입력하면 추이가 그려집니다.';
      container.appendChild(p);
      return;
    }

    // 모바일처럼 컨테이너가 좁으면 여백·높이·눈금 수를 줄여 플롯 영역을 넓게 확보한다.
    // (데스크톱은 container.clientWidth가 항상 480을 넘으므로 이 분기의 영향을 받지 않는다)
    var W = container.clientWidth || 720;
    var isNarrow = W < 480;

    // 값 범위
    var allY = [baselineY];
    series.forEach(function (s) { s.points.forEach(function (pt) { allY.push(pt.y); }); });
    var minY = Math.min.apply(null, allY), maxY = Math.max.apply(null, allY);
    var pad = (maxY - minY) * 0.12 || 0.01;
    minY -= pad; maxY += pad;
    var ticks = niceTicks(minY, maxY, isNarrow ? 3 : 4);
    minY = Math.min(minY, ticks[0]); maxY = Math.max(maxY, ticks[ticks.length - 1]);

    // 레이아웃
    var H = opts.height || (isNarrow ? 220 : 280);
    var mL = isNarrow ? 38 : 54, mR = isNarrow ? 56 : 74, mT = isNarrow ? 12 : 18, mB = isNarrow ? 26 : 34;
    var plotW = W - mL - mR, plotH = H - mT - mB;
    var catIndex = {};
    cats.forEach(function (c, i) { catIndex[c] = i; });
    var xOf = function (cat) { return mL + (cats.length === 1 ? plotW / 2 : plotW * catIndex[cat] / (cats.length - 1)); };
    var yOf = function (v) { return mT + plotH * (1 - (v - minY) / (maxY - minY)); };

    var root = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
      role: 'img', 'font-family': MONO
    });

    // 주 시리즈 하단 영역 그라디언트
    var defs = svg('defs', {});
    var grad = svg('linearGradient', { id: FILL_ID, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.appendChild(svg('stop', { offset: '0%', 'stop-color': T.fill, 'stop-opacity': '.24' }));
    grad.appendChild(svg('stop', { offset: '100%', 'stop-color': T.fill, 'stop-opacity': '0' }));
    defs.appendChild(grad);
    root.appendChild(defs);

    // y 격자 + 라벨
    // 좁은 화면에서는 "100.00%" 같은 긴 라벨이 y축 여백을 넘어 잘리므로 정수%로 축약한다
    // (끝점 라벨·범례 등 다른 곳의 표시는 그대로 두 자리 소수를 유지한다)
    var fmtYAxis = isNarrow ? function (v) { return Math.round(v * 100) + '%'; } : fmtY;
    ticks.forEach(function (t) {
      var y = yOf(t);
      var isBase = Math.abs(t - baselineY) < 1e-9;
      var gridLine = { x1: mL, y1: y, x2: mL + plotW, y2: y, stroke: isBase ? T.axis : T.grid, 'stroke-width': 1 };
      if (!isBase) gridLine['stroke-dasharray'] = '2 4';
      root.appendChild(svg('line', gridLine));
      var lbl = svg('text', { x: mL - (isNarrow ? 6 : 8), y: y + 4, 'text-anchor': 'end', 'font-size': isNarrow ? 10 : 11, fill: T.muted });
      lbl.textContent = fmtYAxis(t);
      root.appendChild(lbl);
    });

    // x 라벨 (너무 많으면 솎아내기)
    var stepEvery = Math.ceil(cats.length / (isNarrow ? 4 : 9));
    cats.forEach(function (c, i) {
      if (i % stepEvery !== 0 && i !== cats.length - 1) return;
      var x = xOf(c);
      var lbl = svg('text', { x: x, y: mT + plotH + 20, 'text-anchor': 'middle', 'font-size': 11, fill: T.muted });
      lbl.textContent = c.slice(5).replace('-', '/'); // MM/DD
      root.appendChild(lbl);
    });

    // 시리즈 라인 + 끝점 직접 라벨
    series.forEach(function (s) {
      var d = '';
      s.points.forEach(function (pt, i) {
        var x = xOf(pt.x), y = yOf(pt.y);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      });
      // 강조 시리즈는 선 아래를 그라디언트로 채워 면적을 읽히게 한다
      if (s.emphasis && s.points.length > 1) {
        var yFloor = yOf(ticks[0]);
        var lastX = xOf(s.points[s.points.length - 1].x);
        root.appendChild(svg('path', {
          d: d.trim() + ' L ' + lastX.toFixed(1) + ' ' + yFloor.toFixed(1) +
             ' L ' + xOf(s.points[0].x).toFixed(1) + ' ' + yFloor.toFixed(1) + ' Z',
          fill: 'url(#' + FILL_ID + ')', stroke: 'none'
        }));
      }
      var pathAttrs = {
        d: d.trim(), fill: 'none', stroke: s.color,
        'stroke-width': s.emphasis ? 2.25 : (s.dashed ? 1.75 : 2),
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      };
      // 벤치마크처럼 비교용 선은 점선으로 구분한다
      if (s.dashed) pathAttrs['stroke-dasharray'] = '5 4';
      root.appendChild(svg('path', pathAttrs));
      // 마지막 점 마커 + 라벨
      var last = s.points[s.points.length - 1];
      var lx = xOf(last.x), ly = yOf(last.y);
      root.appendChild(svg('circle', { cx: lx, cy: ly, r: 3.5, fill: s.color, stroke: T.marker, 'stroke-width': 2 }));
      var tl = svg('text', { x: Math.min(lx + 8, W - 4), y: ly + 4, 'text-anchor': 'start', 'font-size': isNarrow ? 10.5 : 11.5, 'font-weight': 600, fill: s.color });
      tl.textContent = fmtY(last.y);
      root.appendChild(tl);
    });

    // ---- 호버 레이어 (크로스헤어 + 툴팁) ----
    // 인쇄용 정적 차트(interactive:false)는 툴팁 DOM을 만들지 않는다
    if (opts.interactive === false) { container.appendChild(root); return; }
    var hoverLine = svg('line', { y1: mT, y2: mT + plotH, stroke: T.axis, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
    root.appendChild(hoverLine);
    var hoverDots = series.map(function (s) {
      var c = svg('circle', { r: 4, fill: s.color, stroke: T.marker, 'stroke-width': 2, visibility: 'hidden' });
      root.appendChild(c);
      return c;
    });
    container.style.position = 'relative';
    var tip = document.createElement('div');
    tip.className = 'chart-tooltip';
    tip.style.display = 'none';
    container.appendChild(tip);

    var overlay = svg('rect', { x: mL, y: mT, width: plotW, height: plotH, fill: 'transparent' });
    root.appendChild(overlay);

    function nearestCat(px) {
      var rel = (px - mL) / (plotW || 1);
      var idx = Math.round(rel * (cats.length - 1));
      return Math.max(0, Math.min(cats.length - 1, idx));
    }

    overlay.addEventListener('mousemove', function (ev) {
      var rect = root.getBoundingClientRect();
      var px = (ev.clientX - rect.left) * (W / rect.width);
      var idx = nearestCat(px);
      var cat = cats[idx];
      var cx = xOf(cat);
      hoverLine.setAttribute('x1', cx); hoverLine.setAttribute('x2', cx);
      hoverLine.setAttribute('visibility', 'visible');
      var rows = '<div class="tt-date">' + cat + '</div>';
      series.forEach(function (s, si) {
        var pt = s.points.find(function (p) { return p.x === cat; });
        if (pt) {
          hoverDots[si].setAttribute('cx', cx);
          hoverDots[si].setAttribute('cy', yOf(pt.y));
          hoverDots[si].setAttribute('visibility', 'visible');
          rows += '<div class="tt-row"><span class="tt-swatch" style="background:' + s.color + '"></span>' +
            '<span class="tt-name">' + s.name + '</span><span class="tt-val">' + fmtY(pt.y) + '</span></div>';
        } else {
          hoverDots[si].setAttribute('visibility', 'hidden');
        }
      });
      tip.innerHTML = rows;
      tip.style.display = 'block';
      var tipX = cx * (rect.width / W) + 12;
      if (tipX > rect.width - 150) tipX = cx * (rect.width / W) - 12 - tip.offsetWidth;
      tip.style.left = tipX + 'px';
      tip.style.top = '8px';
    });
    overlay.addEventListener('mouseleave', function () {
      hoverLine.setAttribute('visibility', 'hidden');
      hoverDots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); });
      tip.style.display = 'none';
    });

    container.appendChild(root);
  }

  var api = { renderLineChart: renderLineChart };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.Chart = api;
})(typeof window !== 'undefined' ? window : globalThis);
