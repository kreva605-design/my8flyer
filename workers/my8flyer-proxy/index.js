// My 8flyer — Cloudflare Workers プロキシ
// 役割: GitHub Pages から Bearer トークンで認証し、FlyStack API を代理呼び出し
//
// 環境変数（wrangler secret put で設定）:
//   ACCESS_TOKEN   ... 家族で共有するアクセストークン（自分で決める文字列）
//   FLYSTACK_API_KEY ... FlyStack から発行される API キー

export default {
  async fetch(request, env) {
    // CORS プリフライト対応
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    // Bearer トークン検証
    const auth = request.headers.get('Authorization') ?? '';
    if (!env.ACCESS_TOKEN || auth !== `Bearer ${env.ACCESS_TOKEN}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }

    const url = new URL(request.url);
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');

    if (!from || !to) {
      return new Response(JSON.stringify({ error: 'from と to パラメータが必要です' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }

    // FlyStack API を呼び出し
    // TODO: FlyStack API の正式エンドポイント・パラメータ名を確認後に修正
    const apiUrl = buildFlyStackUrl(from, to, env.FLYSTACK_API_KEY);
    let flyData;
    try {
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'my8flyer/1.0' },
      });
      if (!res.ok) {
        return new Response(JSON.stringify({ error: `FlyStack API エラー: ${res.status}` }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
        });
      }
      flyData = await res.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: '外部 API 接続エラー' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
      });
    }

    // FlyStack レスポンスを my8flyer 形式に変換して返す
    const result = parseFlyStackResponse(flyData, from, to);
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
    });
  },
};

// FlyStack API URL 構築
// TODO: API 登録後に正式エンドポイント・パラメータ名を確認して修正
function buildFlyStackUrl(from, to, apiKey) {
  const base = 'https://api.flightstack.io/v1/routes'; // 仮エンドポイント
  return `${base}?dep_iata=${from}&arr_iata=${to}&access_key=${apiKey}`;
}

// FlyStack レスポンスを my8flyer が期待する形式に変換
// TODO: 実際のレスポンス構造を確認後に修正
function parseFlyStackResponse(raw, from, to) {
  // 期待する出力形式:
  // { flights: [{ airline, iata, flightNo, dep, arr }] }
  //
  // FlyStack の実際のフィールド名に合わせて変換する
  const flights = (raw?.data ?? raw?.routes ?? []).map(r => ({
    airline:  r.airline_name  ?? r.airline  ?? '',
    iata:     r.airline_iata  ?? r.iata     ?? '',
    flightNo: r.flight_number ?? r.flightNo ?? '',
    dep:      r.dep_time      ?? r.departure ?? '',
    arr:      r.arr_time      ?? r.arrival   ?? '',
  })).filter(f => f.iata);

  return { flights, from, to };
}

// CORS ヘッダー（GitHub Pages からのリクエストのみ許可）
function corsHeaders(env) {
  const origin = env.ALLOWED_ORIGIN || 'https://kreva605-design.github.io';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}
