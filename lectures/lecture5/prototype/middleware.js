/**
 * Vercel Edge Middleware
 *
 * 現在は認証なし — プロトタイプ UI は誰でも閲覧可能。
 * タスクデータは localhost:3001（ローカルサーバー）からのみ取得するため、
 * 自分のPC以外からはデータに一切アクセスできない。
 *
 * もし将来的に UI 自体も非公開にしたい場合:
 *   AUTH_USER と AUTH_PASS を Vercel 環境変数に設定して
 *   下のコメントアウト部分を有効にする。
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}

export default function middleware(_request) {
  // 現在は全リクエストをそのまま通す
  return
}

/*
── Basic Auth を有効にする場合 ─────────────────────────────────
Vercel ダッシュボード → Settings → Environment Variables に設定:
  AUTH_USER = aki
  AUTH_PASS = （ランダムな文字列）

そして上の middleware 関数を以下に差し替える:

export default function middleware(request) {
  const AUTH_USER = process.env.AUTH_USER
  const AUTH_PASS = process.env.AUTH_PASS
  if (!AUTH_USER || !AUTH_PASS) return

  const authHeader = request.headers.get('authorization')
  if (authHeader && authHeader.startsWith('Basic ')) {
    const [user, pass] = atob(authHeader.slice(6)).split(':')
    if (user === AUTH_USER && pass === AUTH_PASS) return
  }
  return new Response('このページは非公開です。', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Private"' },
  })
}
─────────────────────────────────────────────────────────────── */
