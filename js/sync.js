/*
 * sync.js — 계좌 데이터를 서버(/api/state)와 맞추는 계층
 *
 * 설계 원칙
 *  1. localStorage는 계속 쓴다 — 서버가 원본이고, 로컬은 캐시다.
 *     네트워크가 끊겨도 화면은 그대로 뜨고, 입력한 내용이 사라지지 않는다.
 *  2. 조용한 유실을 만들지 않는다 — 다른 곳에서 먼저 저장했으면 덮어쓰지 않고
 *     충돌로 알린다. 어느 쪽을 살릴지는 사람이 정한다.
 *  3. API가 없으면(로컬 파일로 열기·서버 미배포) 로컬 전용으로 조용히 동작한다.
 *     기존 사용 방식이 그대로 유지된다.
 */
(function (global) {
  'use strict';

  var ENDPOINT = '/api/state';
  var DEBOUNCE_MS = 800;      // 연속 입력을 한 번의 저장으로 묶는다
  var RETRY_MS = [2000, 5000, 15000, 30000, 60000];

  var state = {
    mode: 'unknown',          // unknown | remote | local | offline
    status: 'idle',           // idle | loading | saving | saved | offline | conflict | local
    version: 0,
    updatedAt: null,
    updatedBy: null,
    lastError: null
  };

  var pending = null;         // 저장 대기 중인 데이터
  var timer = null;
  var retryIndex = 0;
  var inFlight = false;

  var handlers = { status: null, conflict: null };

  function setStatus(s, err) {
    state.status = s;
    state.lastError = err || null;
    if (handlers.status) {
      try { handlers.status(s, state); } catch (e) { /* UI 오류가 저장을 막지 않게 */ }
    }
  }

  function request(method, body) {
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(ENDPOINT, opts);
  }

  /*
   * 첫 로드. 반환값:
   *   { mode:'local' }                        API 없음 — 로컬 전용으로 동작
   *   { mode:'remote', exists:false }         서버가 비어 있음 — 로컬 데이터를 올려야 함
   *   { mode:'remote', exists:true, data }    서버 데이터를 쓰면 됨
   *   { mode:'offline' }                      API는 있는데 지금 닿지 않음 — 캐시로 동작
   */
  function load() {
    setStatus('loading');
    return request('GET').then(function (res) {
      // Function이 배포돼 있지 않으면 정적 서버가 index.html을 돌려준다(404 또는 HTML 200).
      var ctype = res.headers.get('Content-Type') || '';
      if (res.status === 404 || ctype.indexOf('application/json') === -1) {
        state.mode = 'local';
        setStatus('local');
        return { mode: 'local' };
      }
      return res.json().then(function (body) {
        if (!res.ok) {
          // 401(인증)·500(설정 누락)은 사용자가 고쳐야 하는 상태다. 캐시로 계속 보여주되 알린다.
          state.mode = 'offline';
          setStatus('offline', body.error || ('HTTP ' + res.status));
          return { mode: 'offline', error: body.error };
        }
        state.mode = 'remote';
        state.version = body.version || 0;
        state.updatedAt = body.updatedAt || null;
        state.updatedBy = body.updatedBy || null;
        setStatus('saved');
        return {
          mode: 'remote',
          exists: !!body.exists,
          data: body.data,
          version: state.version,
          updatedAt: state.updatedAt,
          updatedBy: state.updatedBy
        };
      });
    }).catch(function (e) {
      state.mode = 'offline';
      setStatus('offline', e.message);
      return { mode: 'offline', error: e.message };
    });
  }

  // 디바운스 저장 예약. 로컬 전용 모드면 아무 일도 하지 않는다.
  function save(data) {
    if (state.mode === 'local') return;
    pending = data;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; push(); }, DEBOUNCE_MS);
  }

  function push() {
    if (inFlight || pending === null) return Promise.resolve();
    if (state.mode === 'local') { pending = null; return Promise.resolve(); }

    var payload = pending;
    pending = null;
    inFlight = true;
    setStatus('saving');

    return request('PUT', { data: payload, version: state.version })
      .then(function (res) {
        return res.json().then(function (body) { return { res: res, body: body }; });
      })
      .then(function (r) {
        inFlight = false;
        if (r.res.status === 409) {
          // 다른 곳에서 먼저 저장됨 — 덮어쓰지 않는다.
          // 되돌려 넣으면 재시도하며 계속 충돌하므로 대기열에서 뺀다.
          setStatus('conflict');
          if (handlers.conflict) {
            try { handlers.conflict(r.body); } catch (e) { /* 무시 */ }
          }
          return;
        }
        if (!r.res.ok) throw new Error(r.body.error || ('HTTP ' + r.res.status));

        state.mode = 'remote';
        state.version = r.body.version;
        state.updatedAt = r.body.updatedAt;
        state.updatedBy = r.body.updatedBy;
        retryIndex = 0;
        setStatus('saved');
        if (pending !== null) push(); // 저장하는 동안 또 바뀌었으면 이어서
      })
      .catch(function (e) {
        inFlight = false;
        // 실패한 데이터는 버리지 않는다 — 더 최신이 없을 때만 되돌려 넣고 재시도한다.
        if (pending === null) pending = payload;
        setStatus('offline', e.message);
        var wait = RETRY_MS[Math.min(retryIndex, RETRY_MS.length - 1)];
        retryIndex++;
        setTimeout(function () { push(); }, wait);
      });
  }

  // 즉시 저장(대기 중인 것 포함). 페이지를 떠나기 전에 부른다.
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    return push();
  }

  // 충돌을 사람이 해결한 뒤(서버 것을 받아들임) 버전을 맞춰 준다.
  function adoptVersion(v) {
    state.version = v;
    retryIndex = 0;
    setStatus('saved');
  }

  global.Sync = {
    load: load,
    save: save,
    flush: flush,
    adoptVersion: adoptVersion,
    state: state,
    on: function (name, fn) { handlers[name] = fn; },
    isRemote: function () { return state.mode === 'remote'; },
    isLocalOnly: function () { return state.mode === 'local'; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
