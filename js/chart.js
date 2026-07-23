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
  var INK = '#52514e', MUTED = '#898781', GRID = '#e1e0d9', AXIS = '#c3c2b7', PRIMARY_TEXT = '#0b0b0b';

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

  function renderLineChart(container, opts) {
    container.innerHTML = '';
    var series = opts.series || [];
    var cats = opts.categories || [];
    var fmtY = opts.formatY || defaultFmtPct;
    var baselineY = opts.baselineY == null ? 0 : opts.baselineY;

    if (!series.length || cats.length < 2) {
      var p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '표시할 평가 데이터가 아직 없습니다. 계좌에 일일 평가금액을 2일 이상 입력하면 추이가 그려집니다.';
      container.appendChild(p);
      return;
    }

    // 값 범위
    var allY = [baselineY];
    series.forEach(function (s) { s.points.forEach(function (pt) { allY.push(pt.y); }); });
    var minY = Math.min.apply(null, allY), maxY = Math.max.apply(null, allY);
    var pad = (maxY - minY) * 0.12 || 0.01;
    minY -= pad; maxY += pad;
    var ticks = niceTicks(minY, maxY, 4);
    minY = Math.min(minY, ticks[0]); maxY = Math.max(maxY, ticks[ticks.length - 1]);

    // 레이아웃
    var W = container.clientWidth || 720, H = 320;
    var mL = 56, mR = 96, mT = 14, mB = 40;
    var plotW = W - mL - mR, plotH = H - mT - mB;
    var catIndex = {};
    cats.forEach(function (c, i) { catIndex[c] = i; });
    var xOf = function (cat) { return mL + (cats.length === 1 ? plotW / 2 : plotW * catIndex[cat] / (cats.length - 1)); };
    var yOf = function (v) { return mT + plotH * (1 - (v - minY) / (maxY - minY)); };

    var root = svg('svg', {
      viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H,
      role: 'img', 'font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif'
    });

    // y 격자 + 라벨
    ticks.forEach(function (t) {
      var y = yOf(t);
      var isBase = Math.abs(t - baselineY) < 1e-9;
      root.appendChild(svg('line', { x1: mL, y1: y, x2: mL + plotW, y2: y, stroke: isBase ? AXIS : GRID, 'stroke-width': isBase ? 1.5 : 1 }));
      var lbl = svg('text', { x: mL - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: MUTED });
      lbl.textContent = fmtY(t);
      root.appendChild(lbl);
    });

    // x 라벨 (너무 많으면 솎아내기)
    var stepEvery = Math.ceil(cats.length / 8);
    cats.forEach(function (c, i) {
      if (i % stepEvery !== 0 && i !== cats.length - 1) return;
      var x = xOf(c);
      var lbl = svg('text', { x: x, y: mT + plotH + 20, 'text-anchor': 'middle', 'font-size': 10.5, fill: MUTED });
      lbl.textContent = c.slice(5); // MM-DD
      root.appendChild(lbl);
    });

    // 시리즈 라인 + 끝점 직접 라벨
    series.forEach(function (s) {
      var d = '';
      s.points.forEach(function (pt, i) {
        var x = xOf(pt.x), y = yOf(pt.y);
        d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
      });
      root.appendChild(svg('path', { d: d.trim(), fill: 'none', stroke: s.color, 'stroke-width': s.emphasis ? 2.75 : 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      // 마지막 점 마커 + 라벨
      var last = s.points[s.points.length - 1];
      var lx = xOf(last.x), ly = yOf(last.y);
      root.appendChild(svg('circle', { cx: lx, cy: ly, r: 3.5, fill: s.color, stroke: '#fff', 'stroke-width': 1.5 }));
      var tl = svg('text', { x: Math.min(lx + 8, W - 4), y: ly + 4, 'text-anchor': 'start', 'font-size': 11, 'font-weight': 600, fill: s.color });
      tl.textContent = fmtY(last.y);
      root.appendChild(tl);
    });

    // ---- 호버 레이어 (크로스헤어 + 툴팁) ----
    var hoverLine = svg('line', { y1: mT, y2: mT + plotH, stroke: AXIS, 'stroke-width': 1, 'stroke-dasharray': '3 3', visibility: 'hidden' });
    root.appendChild(hoverLine);
    var hoverDots = series.map(function (s) {
      var c = svg('circle', { r: 4, fill: s.color, stroke: '#fff', 'stroke-width': 1.5, visibility: 'hidden' });
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
