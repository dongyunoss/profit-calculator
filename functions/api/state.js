/*
 * /api/state — 계좌 데이터 읽기·쓰기 (Cloudflare D1)
 *
 *   GET  /api/state              → { exists, data, version, updatedAt, updatedBy }
 *   PUT  /api/state              body: { data, version }
 *        · 200 { version }        저장 완료
 *        · 409 { serverVersion, data, updatedBy, updatedAt }
 *                                 다른 곳에서 먼저 저장됨 — 덮어쓰지 않고 거부
 *
 * 인증:
 *   로그인 화면 없이 "링크 하나로" 접근하는 방식이라, 이메일 인증 대신
 *   공유 비밀 코드(SITE_KEY) 하나로 막는다. 클라이언트는 최초 접속 시 URL의
 *   ?key=... 값을 저장해 두었다가, 매 요청마다 X-Site-Key 헤더로 실어 보낸다
 *   (js/sync.js 참고). SITE_KEY가 없거나 일치하지 않으면 거부한다(fail-closed).
 *
 * 필요한 바인딩 (Pages/Workers 프로젝트 설정):
 *   DB         D1 데이터베이스
 *   SITE_KEY   공유 링크에 붙일 비밀 코드 (Variables and Secrets에 Secret으로 등록)
 */

const STATE_ID = 'default';
const HISTORY_KEEP = 30;      // 되돌리기용으로 남겨 두는 스냅샷 개수
const MAX_BODY = 8 * 1024 * 1024;

// ---------- 접속 코드 확인 ----------

function requireSiteKey(request, env) {
  if (!env.SITE_KEY) {
    // 설정이 빠졌을 때 통과시키면 데이터가 그대로 열린다 — 반드시 막는다.
    throw httpError(500,
      'SITE_KEY가 설정되지 않았습니다. Pages/Workers 프로젝트 설정에서 환경 변수를 등록하세요.');
  }
  const key = request.headers.get('X-Site-Key') || '';
  if (!key || key !== env.SITE_KEY) {
    throw httpError(401, '접속 코드가 없거나 올바르지 않습니다. 공유받은 링크로 다시 들어오세요.');
  }
}

// ---------- 응답 헬퍼 ----------

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 계좌 데이터가 중간 캐시에 남지 않게 한다
      'Cache-Control': 'no-store'
    }
  });
}

// ---------- 핸들러 ----------

async function handleGet(env) {
  const row = await env.DB
    .prepare('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = ?')
    .bind(STATE_ID)
    .first();

  if (!row) return json({ exists: false, data: null, version: 0 });

  return json({
    exists: true,
    data: JSON.parse(row.data),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by
  });
}

async function handlePut(request, env) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) throw httpError(413, '데이터가 너무 큽니다.');

  let body;
  try { body = JSON.parse(raw); } catch (e) { throw httpError(400, '본문이 올바른 JSON이 아닙니다.'); }

  if (!body || typeof body.data !== 'object' || body.data === null || !Array.isArray(body.data.accounts)) {
    throw httpError(400, 'data.accounts 배열이 필요합니다.');
  }
  const clientVersion = Number(body.version);
  if (!Number.isFinite(clientVersion) || clientVersion < 0) {
    throw httpError(400, 'version이 필요합니다.');
  }

  const current = await env.DB
    .prepare('SELECT data, version, updated_at, updated_by FROM app_state WHERE id = ?')
    .bind(STATE_ID)
    .first();

  const serverVersion = current ? current.version : 0;

  // 내가 읽어 간 뒤에 다른 곳에서 저장했다면 덮어쓰지 않는다.
  // (백업 파일 방식과 달리, 여기서는 조용한 유실이 생기지 않아야 한다)
  if (serverVersion !== clientVersion) {
    return json({
      conflict: true,
      serverVersion: serverVersion,
      data: current ? JSON.parse(current.data) : null,
      updatedAt: current ? current.updated_at : null,
      updatedBy: current ? current.updated_by : null
    }, 409);
  }

  const nextVersion = serverVersion + 1;
  const nowIso = new Date().toISOString();
  const dataStr = JSON.stringify(body.data);
  // 공유 코드 하나를 여러 사람이 쓰는 구조라 "누가"는 구분하지 않는다.
  const updatedBy = '';

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO app_state (id, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET data=excluded.data, version=excluded.version, ' +
      'updated_at=excluded.updated_at, updated_by=excluded.updated_by'
    ).bind(STATE_ID, dataStr, nextVersion, nowIso, updatedBy),
    env.DB.prepare(
      'INSERT INTO app_state_history (version, data, updated_at, updated_by) VALUES (?, ?, ?, ?)'
    ).bind(nextVersion, dataStr, nowIso, updatedBy),
    env.DB.prepare(
      'DELETE FROM app_state_history WHERE id NOT IN ' +
      '(SELECT id FROM app_state_history ORDER BY id DESC LIMIT ?)'
    ).bind(HISTORY_KEEP)
  ]);

  return json({ ok: true, version: nextVersion, updatedAt: nowIso, updatedBy: updatedBy });
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.DB) throw httpError(500, 'D1 바인딩(DB)이 설정되지 않았습니다.');

    requireSiteKey(request, env);

    if (request.method === 'GET') return await handleGet(env);
    if (request.method === 'PUT') return await handlePut(request, env);

    return json({ error: '지원하지 않는 메서드입니다.' }, 405);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}
