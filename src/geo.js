// =====================================================================
// geo — 経路の「遠回り度合い」を距離で測る
// =====================================================================
// 特典航空券は、寄り道を1つ足しても必要マイルが変わらないことが多い
// （日本のゾーンが 1-A から 1-B へ上がる分だけで、寄り道先の遠近は効かない）。
// 実測では広島→パリの寄り道26都市が**全部 +7,000マイル**だった。
//
// つまりマイルでは「魅力のない、しんどいルート」を落とせない。
// 落とすには**実際に飛ぶ距離**が要る。パリからの帰りに仙台へ寄るために
// ソウルと上海を経由する案と、羽田で乗り継いで那覇へ降りる案は、
// 必要マイルが同じでも旅としてまったく別物である。
//
// 座標の出どころは data/airports.json（OurAirports・public domain）。
// 利用者に座標そのものは見せない。並び替えと足切りにだけ使う。
// =====================================================================

const R_KM = 6371.0088;   // 地球の平均半径
const rad = (d) => (d * Math.PI) / 180;

// 2地点の大圏距離（km）
export function greatCircleKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

// 空港コードの並び（実際に飛ぶ順）から総飛行距離を出す。
// 座標が1つでも欠けていたら null を返す（0 を返すと最短に見えてしまう）。
export function pathDistanceKm(iatas, coords) {
  let sum = 0;
  for (let i = 0; i < iatas.length - 1; i++) {
    const a = coords[iatas[i]], b = coords[iatas[i + 1]];
    if (!a || !b) return null;
    sum += greatCircleKm(a, b);
  }
  return sum;
}
