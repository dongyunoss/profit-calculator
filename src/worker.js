/*
 * Worker 진입점 — Cloudflare가 Git 연동 배포를 Pages가 아닌
 * "정적 자산이 딸린 Worker"(wrangler deploy) 방식으로 처리하면서 필요해졌다.
 * 이 형태에서는 functions/ 아래 파일 기반 라우팅(Pages Functions)이 자동으로
 * 동작하지 않으므로, /api/state만 직접 연결하고 나머지는 정적 자산으로 넘긴다.
 */
import { onRequest as stateHandler } from '../functions/api/state.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/state') {
      return stateHandler({ request, env, ctx });
    }
    return env.ASSETS.fetch(request);
  }
};
