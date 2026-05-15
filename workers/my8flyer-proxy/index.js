// My 8flyer — Cloudflare Workers プロキシ
// 役割: GitHub Pages から Bearer トークンで認証し、AviationStack API を代理呼び出し
//
// Cloudflare Secrets（wrangler secret put で設定済み）:
//   ACCESS_TOKEN          ... 家族で共有するアクセストークン（ブラウザのlocalStorageにも保存）
//   AVIATIONSTACK_API_KEY ... AviationStack から発行された API キー（バックエンド専用）

export default {
  async fetch(request, env) {
    // CORS プリフライト対応
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Bearer トークン検証（ここで「家族か否か」を判定）
    const auth = request.headers.get('Authorization') ?? '';
    if (!env.ACCESS_TOKEN || auth !== `Bearer ${env.ACCESS_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url  = new URL(request.url);
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    if (!from || !to) return json({ error: 'from と to が必要です' }, 400);

    // AviationStack API 呼び出し（APIキーはここでしか使わない）
    const apiUrl = `https://api.aviationstack.com/v1/flights` +
      `?dep_iata=${from}&arr_iata=${to}&access_key=${env.AVIATIONSTACK_API_KEY}&limit=10`;

    let raw;
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) return json({ error: `AviationStack エラー: ${res.status}` }, 502);
      raw = await res.json();
    } catch {
      return json({ error: '外部 API 接続エラー' }, 502);
    }

    return new Response(
      JSON.stringify(parseAviationStack(raw, from, to)),
      { headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
    );
  },
};

// AviationStack レスポンス → my8flyer 形式に変換
function parseAviationStack(raw, from, to) {
  const data = Array.isArray(raw?.data) ? raw.data : [];
  const flights = data
    .filter(f => f.departure?.iata === from && f.arrival?.iata === to)
    .map(f => ({
      airline:  f.airline?.name  ?? '',
      iata:     f.airline?.iata  ?? '',
      flightNo: f.flight?.iata   ?? '',
      dep: toHHMM(f.departure?.scheduled),
      arr: toHHMM(f.arrival?.scheduled),
    }))
    .filter(f => f.iata && f.dep && f.arr)
    // 重複フライト番号を除去（同日複数便があれば代表1件）
    .filter((f, i, arr) => arr.findIndex(x => x.flightNo === f.flightNo) === i);

  return { flights, from, to };
}

// ISO8601 → "HH:MM"
function toHHMM(iso) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('ja-JP', {
      hour: '2-digit', minute: '2-digit', hour12: false,
      timeZone: 'Asia/Tokyo'
    });
  } catch { return null; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

// GitHub Pages からのリクエストのみ許可
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  'https://kreva605-design.github.io',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}
