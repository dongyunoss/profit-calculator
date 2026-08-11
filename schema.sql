-- Cloudflare D1 스키마
--
-- 데이터는 {accounts, benchmark} JSON 한 덩어리라 테이블 설계가 필요 없다.
-- 행 하나에 통째로 넣고, 덮어쓰기 사고를 막는 장치만 붙인다.
--
--   wrangler d1 execute profit-calculator --remote --file=./schema.sql

-- 현재 상태 — 항상 id='default' 한 행만 쓴다.
-- 접속 코드(SITE_KEY)를 아는 사람은 모두 같은 데이터를 본다(회사 장부 하나를 공유하는 구조).
CREATE TABLE IF NOT EXISTS app_state (
  id         TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,   -- JSON 문자열
  version    INTEGER NOT NULL,   -- 저장할 때마다 1씩 증가 (동시 편집 충돌 감지용)
  updated_at TEXT    NOT NULL,   -- ISO8601
  updated_by TEXT    NOT NULL    -- 코드 하나를 공유해 쓰는 구조라 항상 빈 문자열
);

-- 저장 이력 — 최근 30개만 남긴다.
-- "실수로 덮어썼다"를 되돌릴 수 있는 안전망이자 누가 언제 고쳤는지의 기록이다.
-- 스냅샷 하나가 현재 약 150KB이므로 30개라도 5MB 남짓 — D1 무료 5GB에 여유가 크다.
CREATE TABLE IF NOT EXISTS app_state_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version    INTEGER NOT NULL,
  data       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL,
  updated_by TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_version ON app_state_history(version DESC);
