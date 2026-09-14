// つながる便の組み合わせ。
//
// 区間ごとの便リストを突き合わせて「実際に乗り継げる組み合わせ」を作る。
// ★ここは純粋な計算だけを置く（DOM・fetch を触らない）。画面から切り離して検算できるようにするため。
//
// 設計の決めごと（2026-09-15 ユーザー承認・Vault combo-mock.html）:
//   1. 出す案は性格ごとに3つ（最短／乗り継ぎに余裕／長く滞在）
//   2. 途中降機の場所は 8flyer で選んだ街に固定する
//   3. 日ずらしは前後2日まで
//   4. 乗り継ぎの必要時間は
//        日本国内の空港 … ANA公式（data/mct-ana.json の values）→ **下回ったら落とす**
//        海外の空港     … 8flyer の既定値（同 defaults）    → **下回っても落とさず印を付ける**
//      既定値は MCT（成立の最低ライン）ではなく余裕をみた推奨値なので、落とす根拠にしない。
//   5. 区間ごとの便リストは消さない。これは「上乗せ」。

const DAY = 1440;

/** "07:35" / "17:55+1" → 分（+N は N*1440 を足す） */
export function toMin(hhmm) {
  const m = /^(\d{1,2}):(\d{2})(?:\+(\d+))?$/.exec(String(hhmm ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) * DAY : 0);
}

/** 到着が何日ずれるか（"17:55+1" → 1） */
export function arrDayShift(hhmm) {
  const m = /\+(\d+)$/.exec(String(hhmm ?? '').trim());
  return m ? Number(m[1]) : 0;
}

/** 便名の先頭2文字＝運航会社コード */
export const carrierOf = (no) => String(no ?? '').slice(0, 2);

// ---------------------------------------------------------------- 乗り継ぎ必要時間

// ANA公式の表に載っている日本の空港。載っていない空港は「公式の定めなし」として扱う
const JP_KEY = { NRT: 'nrt', HND: 'hnd', KIX: 'kix', NGO: 'ngo' };

/**
 * 乗り継ぎ地 via での必要時間を決める。
 * 戻り値 { minutes, source:'official'|'default', label, hard }
 *   hard=true … 下回ったら落とす（ANA公式）
 *   hard=false… 下回っても落とさない（8flyerの既定値）
 *
 * ★羽田の国内→国際は出発ターミナルで 55分／70分 に分かれるが、便データに
 *   ターミナルが入っていない。**分からないときは厳しいほう（70分）を使う**。
 *   ゆるいほうを使うと、実際には乗れない組み合わせを「乗れます」と出してしまう。
 */
export function connectRule(via, prevIntl, nextIntl, mct, isJapan) {
  const off = (rule) => {
    const hit = Object.values(mct?.values ?? {}).find((v) => v.rule === rule);
    return hit ? hit.value : null;
  };
  const def = (key) => mct?.defaults?.values?.[key]?.value ?? null;

  if (isJapan(via)) {
    const k = JP_KEY[via];
    if (k) {
      if (!prevIntl && nextIntl) {
        // 羽田はターミナルが分からないので厳しいほう（第3・70分）
        const v = k === 'hnd' ? off('mct.dom_to_intl.hnd_t3') : off(`mct.dom_to_intl.${k}`);
        if (v != null) return { minutes: v, source: 'official', hard: true, label: '国内線→国際線' };
      }
      if (prevIntl && !nextIntl) {
        const v = k === 'hnd' ? off('mct.intl_to_dom.hnd_t2') : off(`mct.intl_to_dom.${k}`);
        if (v != null) return { minutes: v, source: 'official', hard: true, label: '国際線→国内線' };
      }
      if (prevIntl && nextIntl) {
        const v = off(`mct.intl_to_intl.${k}`);
        if (v != null) return { minutes: v, source: 'official', hard: true, label: '国際線→国際線' };
      }
    }
    if (!prevIntl && !nextIntl) {
      const key = via === 'HND' ? 'hnd'
                : (via === 'ITM' || via === 'KIX') ? 'itm_kix'
                : via === 'OKA' ? 'oka' : 'other';
      const v = off(`mct.dom_to_dom.ana.${key}`);
      if (v != null) return { minutes: v, source: 'official', hard: true, label: '国内線→国内線' };
    }
    // 表に載っていない日本の空港（例：福岡での国内→国際）。
    // 公式に定めが無いので落とさない。既定値で印だけ付ける
    return { minutes: def('overseas.intl_to_intl'), source: 'default', hard: false,
             label: 'ANA公式の定めなし' };
  }

  // 海外の空港。ANAは公表していないので 8flyer の既定値
  const key = (prevIntl && nextIntl) ? 'overseas.intl_to_intl' : 'overseas.with_immigration';
  return { minutes: def(key), source: 'default', hard: false, label: '海外の空港' };
}

// ---------------------------------------------------------------- 組み合わせ

/**
 * ★**片道ぶん**（出発地→目的地、または 目的地→帰着地）を1回で組む。
 *   往復をひとつなぎで組むと、目的地での滞在（ふつう数日）が「途中降機」と判定されてしまう。
 *   目的地は折り返し地点であって乗り継ぎ地ではないので、方向ごとに分けて組む。
 *
 * @param {object} p
 *   legs        [{from, to, eligible:[IATA...]}] その方向の区間を順に
 *   flights     FLIGHTS_DB.legs（'HND-CDG' → {status, flights:[{no,dep,arr,min,days}]}）
 *   mct         mct-ana.json
 *   isJapan     (iata) => boolean
 *   stopovers   Set<iata> 24時間以上とまる予定の都市
 *   maxDayShift 既定 2
 *   cap         組み合わせ数の上限（安全弁）
 */
export function buildCombos({ legs, flights, mct, isJapan, stopovers = new Set(),
                              maxDayShift = 2, cap = 20000 }) {
  const notes = [];
  const counts = { candidates: 0, afterMct: 0, afterStopover: 0, capped: false };

  // --- 区間ごとに「乗れる便」を集める ---
  const perLeg = legs.map((l) => {
    const rec = flights?.[`${l.from}-${l.to}`];
    if (!rec || rec.status !== 'ok') return { leg: l, flights: [], why: '便データがない' };
    const elig = new Set(l.eligible ?? []);
    const usable = (rec.flights ?? []).filter((f) => elig.has(carrierOf(f.no)) && toMin(f.dep) != null);
    return { leg: l, flights: usable, why: usable.length ? null : 'この特典で乗れる便がない' };
  });

  const missing = perLeg.filter((x) => !x.flights.length);
  if (missing.length) {
    return { ok: false, plans: [], counts, notes,
             reason: missing.map((m) => `${m.leg.from}→${m.leg.to}：${m.why}`) };
  }

  // --- 総当たり（日ずらし込み）。**成り立たない枝はその場で切る** ---
  // 切らないと 6区間で25万通りになり、上限で打ち切った分だけ偏った結果が出る。
  // 切れる根拠は2つ：
  //   ① 乗り継ぎ地が「とまる予定の街」でないなら、24時間以上あく組は最初から要らない
  //   ② ANA公式の必要時間を下回る組は、あとで落とすのだから先に落としてよい
  const intlOf = (l) => !isJapan(l.from) || !isJapan(l.to);
  const results = [];
  const walk = (i, chosen) => {
    if (results.length >= cap) { counts.capped = true; return; }
    if (i === perLeg.length) { counts.candidates++; results.push(chosen.slice()); return; }

    for (const f of perLeg[i].flights) {
      if (i === 0) {
        chosen.push({ ...f, ...perLeg[0].leg, depDay: 0 });
        walk(1, chosen);
        chosen.pop();
        if (results.length >= cap) return;
        continue;
      }
      const prev = chosen[chosen.length - 1];
      const prevArrDay = prev.depDay + arrDayShift(prev.arr);
      const prevArrAbs = prev.depDay * DAY + toMin(prev.arr);
      const via = prev.to;
      const canStay = stopovers.has(via);
      const rule = connectRule(via, intlOf(prev), intlOf(perLeg[i].leg), mct, isJapan);

      for (let s = 0; s <= maxDayShift; s++) {
        const dDay = prevArrDay + s;
        const gap = dDay * DAY + toMin(f.dep) - prevArrAbs;
        if (gap < 0) continue;
        // ①とまる予定でない街で1日以上あく枝は切る
        if (!canStay && gap >= DAY) break;
        // ②ANA公式を下回る枝は切る（既定値どまりのものは落とさない＝印を付けて残す）
        if (rule.hard && rule.minutes != null && gap < rule.minutes) continue;
        chosen.push({ ...f, ...perLeg[i].leg, depDay: dDay });
        walk(i + 1, chosen);
        chosen.pop();
        if (results.length >= cap) return;
      }
    }
  };
  walk(0, []);

  // --- 判定 ---
  const plans = [];
  for (const chosen of results) {
    const conns = [];
    let hardNg = false;
    for (let i = 1; i < chosen.length; i++) {
      const prev = chosen[i - 1], cur = chosen[i];
      const via = prev.to;
      const minutes = cur.depDay * DAY + toMin(cur.dep) - (prev.depDay * DAY + toMin(prev.arr));
      const rule = connectRule(via, intlOf(prev), intlOf(cur), mct, isJapan);
      const isStopover = minutes >= DAY;
      const ok = minutes >= (rule.minutes ?? 0);
      if (!ok && rule.hard && !isStopover) hardNg = true;
      conns.push({ via, minutes, need: rule.minutes, source: rule.source,
                   hard: rule.hard, label: rule.label, ok, isStopover });
    }
    if (hardNg) continue;
    counts.afterMct++;

    // ★途中降機の場所は 8flyer が決めたものに固定する。
    //   選んだ街以外で24時間を超える組は、旅程の意味が変わるので落とす。
    //   選んだ街が24時間に届かない組も、その旅程ではないので落とす。
    const soHit = new Set(conns.filter((c) => c.isStopover).map((c) => c.via));
    const want = new Set([...stopovers]);
    const extra = [...soHit].filter((v) => !want.has(v));
    const short = [...want].filter((v) => !soHit.has(v));
    if (extra.length || short.length) continue;
    counts.afterStopover++;

    const flyMin = chosen.reduce((a, f) => a + (f.min ?? 0), 0);
    const connMin = conns.reduce((a, c) => a + c.minutes, 0);
    const realConns = conns.filter((c) => !c.isStopover);
    plans.push({
      legs: chosen.map((f) => ({ no: f.no, dep: f.dep, arr: f.arr, min: f.min,
                                 from: f.from, to: f.to, depDay: f.depDay, days: f.days })),
      conns,
      totalMin: flyMin + connMin,
      flyMin,
      stopoverMin: conns.filter((c) => c.isStopover).reduce((a, c) => a + c.minutes, 0),
      // 余裕＝いちばん短い乗り継ぎが必要時間をどれだけ上回っているか
      slackMin: realConns.length
        ? Math.min(...realConns.map((c) => c.minutes - (c.need ?? 0))) : Infinity,
      softNg: conns.some((c) => !c.ok && !c.hard && !c.isStopover),
      days: Math.max(...chosen.map((f) => f.depDay + arrDayShift(f.arr))) + 1,
    });
  }

  if (counts.capped) notes.push(`組み合わせが多すぎるため ${cap} 件で打ち切りました`);

  return { ok: true, plans, counts, notes, picked: pickThree(plans) };
}

// 「余裕がある」で見る余裕の上限。これを超えても“もっと余裕がある”とは数えない。
// ★上限を付けないと、羽田で23時間待つ案が「いちばん余裕がある」として選ばれる。
//   それは余裕ではなく空港で1泊するということで、利用者が求めているものではない
//   （2026-09-15・実画面で確認）。上限を超えたぶんは同点にして、合計が短いほうを採る。
export const SLACK_CAP = 240;   // 4時間

/** 性格の違う3案を選ぶ。同じものが選ばれたら重複を除く */
export function pickThree(plans) {
  if (!plans.length) return [];
  const by = (f) => plans.slice().sort(f)[0];
  const cappedSlack = (p) => Math.min(p.slackMin, SLACK_CAP);
  const cands = [
    { kind: 'shortest', label: '最短で着く',
      plan: by((a, b) => a.totalMin - b.totalMin || a.slackMin - b.slackMin) },
    { kind: 'relaxed', label: '乗り継ぎに余裕がある',
      plan: by((a, b) => cappedSlack(b) - cappedSlack(a) || a.totalMin - b.totalMin) },
    { kind: 'longest', label: '寄り道に長くいられる',
      plan: by((a, b) => b.stopoverMin - a.stopoverMin || a.totalMin - b.totalMin) },
  ];
  const seen = new Set(), out = [];
  for (const c of cands) {
    const key = c.plan.legs.map((l) => `${l.no}@${l.depDay}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out;
}

/** 分 → 「1日2時間45分」 */
export function fmtDur(min) {
  if (min == null) return '—';
  const d = Math.floor(min / DAY), h = Math.floor((min % DAY) / 60), m = min % 60;
  return (d ? `${d}日` : '') + (h ? `${h}時間` : '') + (m || (!d && !h) ? `${m}分` : '');
}
