/**
 * Vercel Edge Middleware — Basic Auth
 *
 * Vercel ダッシュボード → Settings → Environment Variables に設定:
 *   AUTH_USER = aki
 *   AUTH_PASS = （自分で決めたパスワード）
 *
 * 両方未設定の場合は認証をスキップする（ローカル開発用）。
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
}

export default function middleware(request) {
  const AUTH_USER = process.env.AUTH_USER
  const AUTH_PASS = process.env.AUTH_PASS

  // 環境変数が未設定 = 開発環境 → 認証スキップ
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
