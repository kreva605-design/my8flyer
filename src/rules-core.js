// =====================================================================
// rules-core — 特典航空券の旅程がANAの規約に適合するかを判定する純粋関数
// =====================================================================
// 副作用なし・DOM 非依存・グローバル状態非依存。
// ブラウザ（index.html から dynamic import）と Node（テスト）の両方で動く。
//
// 規約の数値（乗り換え上限・途中降機の可否）は **ここにハードコードしない**。
// data/award-rules.json（出典URL・原文・有効期間つきの正本）を
// buildAwardRules() で読み込んで cfg にしてから渡すこと。
//
// ⚠️ ANAの『ご利用条件』ページは1つのURLに新旧2版がタブで同居し、
//    aria-selected='true' が付くのは古い版のほう。値を更新するときは
//    /scrape-guard を通し、award-rules.json の locator を必ず確認する。
// =====================================================================

// ===== ゾーン必要マイル順位（第1条・第4条の大小比較用） =====
// 低い数字 = 出発地に近い（マイル少）、高い数字 = 遠い（マイル多）
export const ZONE_RANK = { 1:0, 2:1, 3:2, 4:3, 5:4, 10:5, 6:6, 7:7, 8:8, 9:9 };

// ===== ゾーン → エリア対応（提携航空会社 ご利用条件 第6条 準拠） =====
// エリア1: 北米・中米・南米・ハワイ（Zone 5,6,9）
// エリア2: 欧州・中東・アフリカ・ロシア（ウラル以西）（Zone 7,8）
// エリア3: 日本・韓国・中国・東南アジア・南アジア・南西太平洋・ロシア（ウラル以東）（Zone 1,2,3,4,10）
export const ZONE_TO_AREA = {
  1: 3,  2: 3,  3: 3,  4: 3,  10: 3,
  5: 1,  6: 1,  9: 1,
  7: 2,  8: 2,
};
export const zoneToArea = (zone) => ZONE_TO_AREA[zone] ?? null;

// ===== 各エリアごとの乗り換え制限（提携航空会社・第3条） =====
// FORBIDDEN_TRANSIT_AREAS[出発地エリア][目的地エリア] = 乗り換えに使えないエリア配列
export const FORBIDDEN_TRANSIT_AREAS = {
  1: { 1: [2,3], 2: [3],   3: [2]   },
  2: { 1: [3],   2: [1,3], 3: [1]   },
  3: { 1: [2],   2: [1],   3: [1,2] },
};

// ===== 特典タイプごとに適用する条番号と表示名 =====
// （どの条を適用するかはコード側の対応表。回数の数値は award-rules.json が正本）
export const AWARD_TYPE_META = {
  partner: { label: '提携航空会社特典航空券', clauses: [1,2,3,4,5,6,7] },
  ana:     { label: 'ANA国際線特典航空券',    clauses: [1,2,5,6,7] },  // 第3条・第4条は非適用
};

// =====================================================================
// selectEffectiveValues — 適用日 asOf に有効な規約値だけを rule 名で引ける形に
// =====================================================================
// 旧版（effective_to が asOf より前）と、まだ効いていない版（effective_from が
// asOf より後）は落とす。同じ rule に複数が残るときは effective_from が新しい方。
// =====================================================================
export function selectEffectiveValues(rulesJson, asOf) {
  const values = rulesJson?.values;
  if (!values || typeof values !== 'object') {
    throw new Error('award-rules.json の values が読めません');
  }
  // rule 名 → 有効期間が asOf を含むエントリ（複数あれば effective_from が新しい方）
  const effective = {};
  for (const [key, v] of Object.entries(values)) {
    const name = v?.rule;
    if (!name) throw new Error(`award-rules.json: ${key} に rule がありません`);
    const from = v.effective_from ?? '0000-00-00';
    const to   = v.effective_to;
    if (from > asOf) continue;
    if (to && to < asOf) continue;
    const cur = effective[name];
    if (!cur || from > cur._from) effective[name] = { ...v, _key: key, _from: from };
  }
  return effective;
}

// =====================================================================
// buildAwardRules — award-rules.json から有効な規約値を選び cfg を組む
// =====================================================================
// rulesJson : data/award-rules.json をパースしたオブジェクト
// opts.asOf : 適用日（'YYYY-MM-DD'）。既定は今日。
// 戻り値    : { partner:{...}, ana:{...}, common:{...}, _sources:{...} }
// 必要な規約値が1つでも欠けていたら throw する（不明な上限で「問題なし」を
// 出さないため。fail-safe は必ず厳しい側へ倒す）。
// =====================================================================
export function buildAwardRules(rulesJson, opts = {}) {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const effective = selectEffectiveValues(rulesJson, asOf);

  const need = (name) => {
    const v = effective[name];
    if (!v) throw new Error(`規約値が見つかりません: ${name}（asOf=${asOf}）`);
    return v;
  };

  const cfg = {
    asOf,
    partner: {
      label: AWARD_TYPE_META.partner.label,
      clauses: AWARD_TYPE_META.partner.clauses,
      transitDomMax:        need('partner.roundtrip.transit.domestic').value,
      transitOvsMax:        need('partner.roundtrip.transit.overseas').value,
      stopoverMax:          need('partner.roundtrip.stopover.count').value,
      stopoverJapanAllowed: need('partner.roundtrip.stopover.japan_origin_allowed').value,
    },
    ana: {
      label: AWARD_TYPE_META.ana.label,
      clauses: AWARD_TYPE_META.ana.clauses,
      transitDomMax:        need('ana.roundtrip.transit.domestic').value,
      transitOvsMax:        need('ana.roundtrip.transit.overseas').value,
      stopoverMax:          need('ana.roundtrip.stopover.overseas_origin_count').value,
      stopoverJapanAllowed: need('ana.roundtrip.stopover.japan_origin_allowed').value,
    },
    common: {
      // 目的地は乗り換え回数に含めない
      destinationNotCounted:  need('common.transit.destination_not_counted').value,
      // 地上移動区間は両端の都市を合わせて1回と数える
      surfaceCountsAsOne:     need('common.transit.surface_segment_counts_as_one').value,
      // 途中降機は乗り換え回数に含まれる
      stopoverCountsAsTransit: need('common.stopover.counts_toward_transit').value,
    },
    // どのキー（＝どの版）を採ったかを残す。誤って旧版を拾ったときに追える
    _sources: Object.fromEntries(
      Object.entries(effective).map(([name, v]) => [name, v._key])
    ),
  };
  return cfg;
}

// =====================================================================
// 旅程の正規化
// =====================================================================
// itinerary（index.html の STATE と同じ形。純粋関数にするため引数で受ける）:
//   {
//     departure, destination, arrival, returnDep,
//     outbound: [iata|null, ...], return: [iata|null, ...],
//     outboundSO: [bool,...], returnSO: [bool,...],           // 途中降機
//     outboundSurfaceAfter: [bool,...], returnSurfaceAfter:[] // 次の地点まで地上移動
//   }
// =====================================================================
function pickConns(slots, soFlags, surfFlags) {
  const out = [];
  (slots ?? []).forEach((iata, i) => {
    if (!iata) return;
    out.push({
      iata,
      index: i,
      stopover: !!(soFlags ?? [])[i],
      surfaceAfter: !!(surfFlags ?? [])[i],
    });
  });
  return out;
}

// 地上移動でつながった乗り継ぎ地をひとかたまりにする。
// 「地上移動区間は両端の都市を合わせて1回の乗り換えと数える」（規約の注記）。
// 3都市以上が連なる場合は (n-1) 回として厳しい側に倒す（実運用では起きない想定）。
function groupBySurface(conns, enabled) {
  const groups = [];
  let cur = null;
  conns.forEach((c, i) => {
    const prev = conns[i - 1];
    const linked = enabled && prev && prev.surfaceAfter && prev.index + 1 === c.index;
    if (linked && cur) {
      cur.push(c);
    } else {
      cur = [c];
      groups.push(cur);
    }
  });
  return groups;
}

// 乗り換え回数を国内／海外に分けて数える。
// 途中降機の地点も乗り継ぎ地なのでそのまま1回として数える
// （common.stopover.counts_toward_transit）。
function countTransits(conns, cities, cfg) {
  const findCity = (iata) => cities.find((c) => c.iata === iata);
  const groups = groupBySurface(conns, cfg.common.surfaceCountsAsOne);
  let dom = 0, ovs = 0;
  for (const g of groups) {
    const n = Math.max(1, g.length - (g.length > 1 ? 1 : 0)); // 2都市→1・3都市→2
    const types = new Set(g.map((c) => findCity(c.iata)?.type).filter(Boolean));
    if (types.size === 0) continue;
    if (types.size > 1) {           // 国内と海外が混ざる地上移動は両方に計上（fail-safe）
      dom += n; ovs += n;
    } else if (types.has('domestic')) {
      dom += n;
    } else {
      ovs += n;
    }
  }
  return { dom, ovs };
}

// 実際に「飛ぶ」区間の列を作る（地上移動区間は含めない）
function flightSegments(seq) {
  const segs = [];
  for (let i = 0; i < seq.length - 1; i++) {
    if (seq[i].surfaceAfter) continue;   // 地上移動は飛行区間ではない
    segs.push([seq[i].iata, seq[i + 1].iata]);
  }
  return segs;
}

// =====================================================================
// validateItinerary — 旅程を判定して checks の配列を返す
// =====================================================================
// ctx = { awardType:'partner'|'ana', rules: buildAwardRules() の戻り値, cities: CITIES }
// 戻り値 = { ok, hasNg, warnCount, checks:[{code, ok, msg}], resolved:{...} }
//   ok===true  … 違反なし（警告はありうる）
//   checks[].ok … true=適合 / false=違反 / 'warn'=警告 / 'info'=情報
// =====================================================================
export function validateItinerary(itinerary, ctx) {
  const cities = ctx?.cities;
  const rules  = ctx?.rules;
  if (!Array.isArray(cities)) throw new Error('ctx.cities（都市マスタ）が必要です');
  if (!rules) throw new Error('ctx.rules（buildAwardRules の戻り値）が必要です');

  const awardType = ctx.awardType ?? 'partner';
  const cfg = rules[awardType] ?? rules.partner;
  const common = rules.common;
  const ruleOn = (n) => cfg.clauses.includes(n);
  const findCity = (iata) => cities.find((c) => c.iata === iata) ?? null;

  const checks = [];
  const push = (code, ok, msg) => checks.push({ code, ok, msg });

  const depIata  = itinerary.departure;
  const destIata = itinerary.destination;

  if (!depIata || !destIata) {
    return {
      ok: false, hasNg: true, warnCount: 0, incomplete: true,
      checks: [{ code: 'input.missing', ok: false, msg: '出発地（赤）と目的地（オレンジ）を設定してください' }],
      resolved: null,
    };
  }

  const arrIata    = itinerary.arrival ?? depIata;
  const retDepIata = itinerary.returnDep ?? destIata;
  const isOpenJaw  = !!(itinerary.returnDep && itinerary.returnDep !== destIata);

  const depCity    = findCity(depIata);
  const destCity   = findCity(destIata);
  const arrCity    = findCity(arrIata);
  const retDepCity = findCity(retDepIata);
  if (!depCity || !destCity) {
    return {
      ok: false, hasNg: true, warnCount: 0, incomplete: true,
      checks: [{ code: 'input.unknown_city', ok: false, msg: '都市マスタに無い空港が指定されています' }],
      resolved: null,
    };
  }

  const outConns = pickConns(itinerary.outbound, itinerary.outboundSO, itinerary.outboundSurfaceAfter);
  const retConns = pickConns(itinerary.return,   itinerary.returnSO,   itinerary.returnSurfaceAfter);
  const outIatas = outConns.map((c) => c.iata);
  const retIatas = retConns.map((c) => c.iata);

  // 目的地とオープンジョー復路出発地のうち高い方のゾーン順位
  const maxDestRank = Math.max(
    ZONE_RANK[destCity.zone] ?? 0,
    retDepCity ? (ZONE_RANK[retDepCity.zone] ?? 0) : 0
  );

  // 旅程モード表示（先頭に1行）
  push('meta.type', 'info', `旅程タイプ: ${cfg.label}`);

  // [ツール制限] 日本発着前提（海外発 or 海外帰着の場合は警告）
  if (depCity.type === 'overseas' || (arrCity && arrCity.type === 'overseas')) {
    push('tool.japan_only', 'warn', '※本ツールは日本発着の旅程専用です。海外発の場合は未対応です。');
  }

  // [第1条] 目的地は旅程内で最もマイルが高い地点
  if (ruleOn(1)) {
    if (depCity.type === 'domestic' && destCity.type === 'domestic') {
      push('rule1', false, '[第1条] 国内のみの旅程は本ツール対象外です（国際線特典航空券用）');
    } else if (depCity.type === 'overseas' && destCity.type === 'domestic') {
      // 海外発・国内目的地: ツール制限警告で既に表示済。第1条判定はスキップ
    } else {
      const viol = [...outIatas, ...retIatas]
        .map(findCity)
        .filter((c) => c && c.type === 'overseas' && (ZONE_RANK[c.zone] ?? 0) > maxDestRank);
      if (viol.length > 0) {
        const ns = viol.map((c) => `${c.name}（Zone${c.zone}）`).join('、');
        push('rule1', false, `[第1条] 「${ns}」が目的地より高いゾーン — 目的地は旅程内最高マイル地点である必要があります`);
      } else {
        const destLabel = isOpenJaw
          ? `${destCity.name}（Zone ${destCity.zone}） / ${retDepCity?.name ?? retDepIata}（Zone ${retDepCity?.zone}）`
          : `${destCity.name}（${destCity.iata}） — Zone ${destCity.zone}`;
        push('rule1', true, `[第1条] 目的地: ${destLabel} ✓`);
      }
    }
  }

  // [第2条] 往路・復路の乗り継ぎ地が出発地／目的地／帰着地と重複しないこと
  if (ruleOn(2)) {
    const outBanned = new Set([depIata, destIata]);
    const outOvlp = outIatas.filter((ic) => outBanned.has(ic));
    if (outOvlp.length > 0) {
      const ns = outOvlp.map((ic) => findCity(ic)?.name ?? ic).join('、');
      push('rule2.out', false, `[第2条] 往路乗り継ぎ違反: 「${ns}」は出発地または目的地と同じです`);
    } else {
      push('rule2.out', true, '[第2条] 往路の乗り継ぎ: 重複なし ✓');
    }

    const retBanned = new Set([retDepIata, arrIata]);
    const retOvlp = retIatas.filter((ic) => retBanned.has(ic));
    if (retOvlp.length > 0) {
      const ns = retOvlp.map((ic) => findCity(ic)?.name ?? ic).join('、');
      push('rule2.ret', false, `[第2条] 復路乗り継ぎ違反: 「${ns}」は復路出発地または帰着地と同じです`);
    } else {
      push('rule2.ret', true, '[第2条] 復路の乗り継ぎ: 重複なし ✓');
    }
  }

  // [第3条] 乗り換えエリア制限（提携航空会社のみ）
  if (ruleOn(3) && destCity.type !== 'domestic') {
    const depArea = zoneToArea(depCity.zone);
    const destAreaCity = (retDepCity && (ZONE_RANK[retDepCity.zone] ?? 0) > (ZONE_RANK[destCity.zone] ?? 0))
      ? retDepCity : destCity;
    const destAreaResolved = zoneToArea(destAreaCity.zone);
    const forbidden = (FORBIDDEN_TRANSIT_AREAS[depArea]?.[destAreaResolved]) ?? [];
    if (forbidden.length > 0) {
      const viol = [...outIatas, ...retIatas]
        .map(findCity)
        .filter((c) => c && c.type === 'overseas' && forbidden.includes(zoneToArea(c.zone)));
      if (viol.length > 0) {
        const ns = viol.map((c) => `${c.name}（エリア${zoneToArea(c.zone)}）`).join('、');
        push('rule3', false, `[第3条] 乗り換えエリア違反: 出発地エリア${depArea}→目的地エリア${destAreaResolved}の場合、エリア${forbidden.join('・')}は乗り換え不可。違反: 「${ns}」`);
      } else {
        push('rule3', true, `[第3条] 乗り換えエリア: 許可エリアのみ ✓（出発地エリア${depArea}→目的地エリア${destAreaResolved}）`);
      }
    } else {
      push('rule3', true, `[第3条] 乗り換えエリア: 制限なし ✓（出発地エリア${depArea}→目的地エリア${destAreaResolved}）`);
    }
  }

  // [第4条] 乗り換えゾーン ≤ 目的地ゾーン（オープンジョーは両端の高い方）
  if (ruleOn(4) && destCity.type !== 'domestic') {
    const viol = [...outIatas, ...retIatas]
      .map(findCity)
      .filter((c) => c && c.type === 'overseas' && (ZONE_RANK[c.zone] ?? 0) > maxDestRank);
    if (viol.length > 0) {
      const ns = viol.map((c) => `${c.name}（Zone${c.zone}）`).join('、');
      push('rule4', false, `[第4条] 乗り換えゾーン違反: 「${ns}」は目的地 Zone${destCity.zone} より高いゾーンのため不可`);
    } else {
      push('rule4', true, `[第4条] 乗り換えゾーン: すべて目的地 Zone${destCity.zone} 以下 ✓`);
    }
  }

  // [第5条] 出発地と最終帰着地が異なる場合、同一国内（日本国内）
  if (ruleOn(5) && itinerary.arrival && itinerary.arrival !== itinerary.departure) {
    if (!arrCity || depCity.type !== arrCity.type) {
      push('rule5', false, `[第5条] 出発地（${depCity.name}）と帰着地（${arrCity?.name ?? arrIata}）は同一国（日本国内）である必要があります`);
    } else {
      push('rule5', true, '[第5条] 出発地・帰着地: 同一国（日本国内）✓');
    }
  }

  // [第6条] 出発地≠帰着地 or 往路到着地≠復路出発地の場合、同一エリア内
  if (ruleOn(6)) {
    if (itinerary.arrival && itinerary.arrival !== itinerary.departure) {
      const aDep = zoneToArea(depCity.zone);
      const aArr = arrCity ? zoneToArea(arrCity.zone) : null;
      if (aDep !== aArr) {
        push('rule6.arrival', false, `[第6条] 出発地（${depCity.name}・エリア${aDep}）と帰着地（${arrCity?.name ?? arrIata}・エリア${aArr}）は同一エリア内である必要があります`);
      }
    }
    if (isOpenJaw) {
      if (!retDepCity || retDepCity.type === 'domestic') {
        push('rule6.openjaw', false, '[第6条] 復路出発地は海外都市を選択してください');
      } else {
        const aDest   = zoneToArea(destCity.zone);
        const aRetDep = zoneToArea(retDepCity.zone);
        if (aDest !== aRetDep) {
          push('rule6.openjaw', false, `[第6条] 往路到着地（${destCity.name}・エリア${aDest}）と復路出発地（${retDepCity.name}・エリア${aRetDep}）は同一エリア内である必要があります`);
        } else if (destCity.zone !== retDepCity.zone) {
          push('rule6.openjaw', true, `[第6条] 往路到着地・復路出発地: 同一エリア${aDest}（${destCity.name}・Zone${destCity.zone} / ${retDepCity.name}・Zone${retDepCity.zone}）✓ — 異なるゾーンのため第7条のマイル計算が適用されます`);
        } else {
          push('rule6.openjaw', true, `[第6条] 往路到着地・復路出発地: 同一Zone${destCity.zone}（${destCity.name} / ${retDepCity.name}）✓`);
        }
      }
    }
  }

  // ===== 途中降機（ストップオーバー） =====
  const soIatas = [...outConns, ...retConns].filter((c) => c.stopover).map((c) => c.iata);
  const soMax = cfg.stopoverMax ?? 1;
  if (soIatas.length > soMax) {
    push('stopover.count', false, `ストップオーバーは旅程全体で${soMax}箇所まで（現在${soIatas.length}箇所）`);
  } else if (soIatas.length >= 1) {
    const soCity = findCity(soIatas[0]);
    if (!cfg.stopoverJapanAllowed && depCity.type === 'domestic') {
      push('stopover.japan', false, `[途中降機] ${cfg.label}では日本発の途中降機はできません（${soCity?.name ?? soIatas[0]}）。提携航空会社モードに変更するか、ストップオーバーを解除してください`);
    } else {
      push('stopover.count', true, `[途中降機] ${soIatas.map((i) => findCity(i)?.name ?? i).join('、')} — ${soIatas.length}箇所 ✓`);
    }
  }

  // ===== 乗り換え回数の上限 =====
  // 途中降機の地点も乗り換え1回として数える（common.stopover.counts_toward_transit）。
  // 地上移動でつながった2地点は合わせて1回（common.transit.surface_segment_counts_as_one）。
  // 目的地・帰着地は乗り継ぎ地ではないので最初から数に入っていない
  // （common.transit.destination_not_counted）。
  const outCnt = countTransits(outConns, cities, rules);
  const retCnt = countTransits(retConns, cities, rules);
  const domMax = cfg.transitDomMax;
  const ovsMax = cfg.transitOvsMax;

  const transitCheck = (label, cnt, keyBase) => {
    if (cnt.dom > domMax) {
      push(`${keyBase}.dom`, false, `[乗り換え] ${label} 日本国内 ${cnt.dom}/${domMax} — 日本国内の乗り換えは${domMax}回までです`);
    }
    if (cnt.ovs > ovsMax) {
      const reason = ovsMax === 0
        ? `${cfg.label}では日本以外の乗り換えはできません`
        : `日本以外の乗り換えは${ovsMax}回までです`;
      push(`${keyBase}.ovs`, false, `[乗り換え] ${label} 日本以外 ${cnt.ovs}/${ovsMax} — ${reason}`);
    }
  };
  transitCheck('往路', outCnt, 'transit.out');
  transitCheck('復路', retCnt, 'transit.ret');

  // [非公表ルール] 同一区間 (A→B) の2回利用検出
  // ANA公式7条には明記なし、ただし予約システム（Amadeus Altea PSS）が弾く
  // 出典: 「お得トラベル / ANAマイル講座」YouTube動画（uReA7HRWmos） 05:06〜
  const outSeq = [
    { iata: depIata, surfaceAfter: false },
    ...outConns,
    { iata: destIata, surfaceAfter: false },
  ];
  const retSeq = [
    { iata: isOpenJaw ? retDepIata : destIata, surfaceAfter: false },
    ...retConns,
    { iata: arrIata, surfaceAfter: false },
  ];
  const allSegs = [...flightSegments(outSeq), ...flightSegments(retSeq)];
  const segCount = {};
  allSegs.forEach(([a, b]) => {
    const key = `${a}→${b}`;
    segCount[key] = (segCount[key] || 0) + 1;
  });
  const dupSegs = Object.entries(segCount).filter(([, c]) => c >= 2);
  if (dupSegs.length > 0) {
    const ns = dupSegs.map(([k, c]) => {
      const [a, b] = k.split('→');
      return `${findCity(a)?.name ?? a}→${findCity(b)?.name ?? b}（${c}回）`;
    }).join('、');
    push('unofficial.dup_segment', 'warn',
      `[非公表ルール] 同じ区間を旅程内で2回飛ぶ予約は予約システム上エラーになります: ${ns} — 経由地を別都市に変える、オープンジョーで分割する等で回避可能（ANA公式7条には記載なし）`);
  }

  const hasNg = checks.some((c) => c.ok === false);
  const warnCount = checks.filter((c) => c.ok === 'warn').length;

  return {
    ok: !hasNg,
    hasNg,
    warnCount,
    checks,
    resolved: {
      depIata, destIata, arrIata, retDepIata, isOpenJaw,
      depCity, destCity, arrCity, retDepCity,
      outConns, retConns, soIatas,
      transit: { out: outCnt, ret: retCnt, domMax, ovsMax },
      cfg,
    },
  };
}

// 乗り換えカウンタ表示（UI）からも同じ数え方を使えるように公開する。
// UI 側で数え直すと、片方だけ直したときに判定と表示がずれる。
export function countTransitsFor(itinerary, ctx) {
  const cities = ctx.cities;
  const rules  = ctx.rules;
  const out = pickConns(itinerary.outbound, itinerary.outboundSO, itinerary.outboundSurfaceAfter);
  const ret = pickConns(itinerary.return,   itinerary.returnSO,   itinerary.returnSurfaceAfter);
  return { out: countTransits(out, cities, rules), ret: countTransits(ret, cities, rules) };
}
