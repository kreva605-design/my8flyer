// My 8flyer — Cloudflare Workers プロキシ
//
// エンドポイント:
//   GET  /saved-routes              保存ルート一覧を KV から取得
//   PUT  /saved-routes              保存ルート一覧を KV に書き込み
//   GET  /routes?from=HND&to=CDG   AviationStack API でフライト確認
//
// Secrets（wrangler secret put で設定済み）:
//   ACCESS_TOKEN          ... 家族共有アクセストークン
//   AVIATIONSTACK_API_KEY ... AviationStack API キー
//
// KV バインディング（wrangler.toml で設定済み）:
//   SAVED_ROUTES          ... 保存ルート用 KV namespace

export default {
  async fetch(request, env) {
    // CORS プリフライト対応
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Bearer トークン検証（全エンドポイント共通）
    const auth = request.headers.get('Authorization') ?? '';
    if (!env.ACCESS_TOKEN || auth !== `Bearer ${env.ACCESS_TOKEN}`) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ===== 保存ルート: 取得 =====
    if (path === '/saved-routes' && request.method === 'GET') {
      const data = await env.SAVED_ROUTES.get('routes');
      return new Response(data || '[]', {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // ===== 保存ルート: 書き込み =====
    if (path === '/saved-routes' && request.method === 'PUT') {
      const body = await request.text();
      // 簡易バリデーション（JSONであること・配列であること）
      try {
        const parsed = JSON.parse(body);
        if (!Array.isArray(parsed)) throw new Error('not array');
      } catch {
        return json({ error: '不正なデータ形式です' }, 400);
      }
      await env.SAVED_ROUTES.put('routes', body);
      return json({ ok: true });
    }

    // ===== フライト確認: AviationStack API 呼び出し =====
    const from = url.searchParams.get('from');
    const to   = url.searchParams.get('to');
    if (!from || !to) return json({ error: 'from と to が必要です' }, 400);

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

    // AviationStack は HTTP 200 でも body に error を返すケースがある
    // 例: usage_limit_reached（無料プラン月間上限到達）、invalid_access_key 等
    // 無音失敗を防ぐため明示的に検知して 502 に変換する
    if (raw && raw.error) {
      const code = raw.error.code || raw.error.type || 'unknown';
      const msg  = raw.error.message || raw.error.info || '';
      return json({
        error: `AviationStack: ${code} — ${msg}`,
        upstream: raw.error,
      }, 502);
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
    .filter((f, i, arr) => arr.findIndex(x => x.flightNo === f.flightNo) === i);

  return { flights, from, to };
}

// ISO8601 → "HH:MM"（ローカル空港時刻をそのまま抽出）
// AviationStack はローカル時刻を UTC オフセット（+00:00）で誤って返す場合があるため
// タイムゾーン変換を行わず "T" 以降の HH:MM を直接使用する
function toHHMM(iso) {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  'https://kreva605-design.github.io',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Max-Age':       '86400',
  };
}
