/*
 * /api/state — 계좌 데이터 읽기·쓰기 (Cloudflare Pages Functions + D1)
 *
 *   GET  /api/state              → { exists, data, version, updatedAt, updatedBy }
 *   PUT  /api/state              body: { data, version }
 *        · 200 { version }        저장 완료
 *        · 409 { serverVersion, data, updatedBy, updatedAt }
 *                                 다른 곳에서 먼저 저장됨 — 덮어쓰지 않고 거부
 *
 * 인증:
 *   Cloudflare Access가 사이트 전체를 막고 있으므로 여기까지 온 요청은 이미 통과한 것이다.
 *   그래도 Access가 잘못 설정되거나 나중에 커스텀 도메인을 붙이면서 보호가 빠지는 경우를
 *   대비해, 헤더를 믿지 않고 JWT 서명을 직접 검증한다(고객 자산 데이터라 이중으로 막는다).
 *   ACCESS_TEAM_DOMAIN / ACCESS_AUD 가 없으면 열어 두지 않고 거부한다(fail-closed).
 *
 * 필요한 바인딩 (Pages 프로젝트 설정):
 *   DB                  D1 데이터베이스
 *   ACCESS_TEAM_DOMAIN  예) myteam.cloudflareaccess.com
 *   ACCESS_AUD          Access 애플리케이션의 Audience(AUD) 태그
 */

const STATE_ID = 'default';
const HISTORY_KEEP = 30;      // 되돌리기용으로 남겨 두는 스냅샷 개수
const MAX_BODY = 8 * 1024 * 1024;

// ---------- Access JWT 검증 ----------

// 공개키는 자주 바뀌지 않는다. isolate가 살아 있는 동안 재사용한다.
let certsCache = { keys: null, at: 0 };
const CERTS_TTL = 60 * 60 * 1000;

async function accessKeys(teamDomain) {
  const now = Date.now();
  if (certsCache.keys && now - certsCache.at < CERTS_TTL) return certsCache.keys;
  const res = await fetch('https://' + teamDomain + '/cdn-cgi/access/certs');
  if (!res.ok) throw new Error('Access 공개키를 가져오지 못했습니다 (' + res.status + ')');
  const body = await res.json();
  if (!body.keys || !body.keys.length) throw new Error('Access 공개키가 비어 있습니다');
  certsCache = { keys: body.keys, at: now };
  return body.keys;
}

function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function verifyAccessJwt(token, teamDomain, aud) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('토큰 형식이 올바르지 않습니다');

  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);

  const jwk = (await accessKeys(teamDomain)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('토큰에 해당하는 공개키가 없습니다');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed);
  if (!ok) throw new Error('서명이 올바르지 않습니다');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('만료된 토큰입니다');
  if (payload.nbf && payload.nbf > now + 60) throw new Error('아직 유효하지 않은 토큰입니다');

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) throw new Error('이 애플리케이션용 토큰이 아닙니다');

  return payload;
}

function cookie(request, name) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  const hit = raw.split(';')
    .map((s) => s.trim())
    .find((s) => s.slice(0, name.length + 1) === name + '=');
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

async function requireUser(request, env) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    // 설정이 빠졌을 때 통과시키면 데이터가 그대로 열린다 — 반드시 막는다.
    throw httpError(500,
      'ACCESS_TEAM_DOMAIN / ACCESS_AUD 가 설정되지 않았습니다. ' +
      'Pages 프로젝트 설정에서 환경 변수를 등록하세요.');
  }
  // Access는 보통 헤더로 넣어 주지만, 경로에 따라 CF_Authorization 쿠키만 오는 경우가 있다.
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) {
    throw httpError(401, 'Access 인증 정보가 없습니다. 이 사이트가 Cloudflare Access로 보호되고 있는지 확인하세요.');
  }
  let payload;
  try {
    payload = await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  } catch (e) {
    throw httpError(401, '인증 실패: ' + e.message);
  }
  return payload.email || payload.sub || 'unknown';
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

async function handlePut(request, env, email) {
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

  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO app_state (id, data, version, updated_at, updated_by) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET data=excluded.data, version=excluded.version, ' +
      'updated_at=excluded.updated_at, updated_by=excluded.updated_by'
    ).bind(STATE_ID, dataStr, nextVersion, nowIso, email),
    env.DB.prepare(
      'INSERT INTO app_state_history (version, data, updated_at, updated_by) VALUES (?, ?, ?, ?)'
    ).bind(nextVersion, dataStr, nowIso, email),
    env.DB.prepare(
      'DELETE FROM app_state_history WHERE id NOT IN ' +
      '(SELECT id FROM app_state_history ORDER BY id DESC LIMIT ?)'
    ).bind(HISTORY_KEEP)
  ]);

  return json({ ok: true, version: nextVersion, updatedAt: nowIso, updatedBy: email });
}

export async function onRequest(context) {
  const { request, env } = context;

  try {
    if (!env.DB) throw httpError(500, 'D1 바인딩(DB)이 설정되지 않았습니다.');

    const email = await requireUser(request, env);

    if (request.method === 'GET') return await handleGet(env);
    if (request.method === 'PUT') return await handlePut(request, env, email);

    return json({ error: '지원하지 않는 메서드입니다.' }, 405);
  } catch (e) {
    return json({ error: e.message || String(e) }, e.status || 500);
  }
}
