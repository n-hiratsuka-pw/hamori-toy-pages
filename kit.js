// kit.js — ドラム画面のドラムセットを SVG で描く（依存なし・画像ファイルなし）
//
// 設計（docs/03_設計書.md §5.10）
//  - ドラマーの席の少し上・後ろから見た斜めの立体表示（右利き標準のセッティング）
//  - 太鼓：胴（円柱）の側面に陰影とラグ、上にクロームのフープとテンションボルト、
//    コーテッドヘッド（実行時に canvas で作るまだら模様の質感）
//  - バスドラム：ドラマー側のヘッド（ペダルのビーター付き）と、奥へ伸びる胴
//  - シンバル：ブロンズのグラデーション、旋盤の溝、カップ、フェルトと蝶ナット、スタンド
//  - 影は別レイヤーに 1 回だけぼかしをかける（叩いたときのアニメーションを軽くするため）
//  - 各パーツは <g class="kit-piece" data-type="..."> で、叩く処理は app.js が付ける
//  - デザインはオリジナル（特定の製品の画面を写したものではない）

const VIEW_W = 400;
const VIEW_H = 430;
const f = (n) => Math.round(n * 100) / 100;

// 配置（viewBox 400 × 430）。ry は見下ろす角度による楕円のつぶれ
const L = {
  crash: { cx: 92, cy: 66, rx: 84, ry: 30 },
  ride: { cx: 316, cy: 80, rx: 84, ry: 31 },
  hihat: { cx: 56, cy: 196, rx: 54, ry: 19 },
  tomHigh: { cx: 156, cy: 150, rx: 52, ry: 23, depth: 46 },
  tomMid: { cx: 262, cy: 150, rx: 55, ry: 24, depth: 50 },
  snare: { cx: 98, cy: 298, rx: 66, ry: 29, depth: 30 },
  tomFloor: { cx: 320, cy: 290, rx: 72, ry: 32, depth: 82 },
  kick: { cx: 208, cy: 352, rx: 70, ry: 58, len: 92 },
};

// 胴の色（ワインレッドのラッカー）
const SHELL = ['#2a0710', '#6e1423', '#a8303f', '#c4475a', '#8f2233', '#4a0c18', '#24050c'];

/** コーテッドヘッドのまだら模様を canvas で作り、data URL を返す（失敗したら null） */
function coatedTexture() {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 256, 256);
    let r = 7;
    const rnd = () => { r = (r * 1664525 + 1013904223) >>> 0; return r / 4294967296; };
    for (let i = 0; i < 700; i++) {
      const x0 = rnd() * 256, y0 = rnd() * 256, rad = 3 + rnd() * 16;
      const dark = rnd() < 0.6;
      const col = dark ? `rgba(120,110,95,${0.03 + rnd() * 0.05})` : `rgba(255,255,255,${0.08 + rnd() * 0.1})`;
      for (const ox of [-256, 0, 256]) for (const oy of [-256, 0, 256]) {
        const x = x0 + ox, y = y0 + oy;
        if (x + rad < 0 || x - rad > 256 || y + rad < 0 || y - rad > 256) continue;
        const grad = g.createRadialGradient(x, y, 0, x, y, rad);
        grad.addColorStop(0, col); grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
    }
    g.strokeStyle = 'rgba(110,100,85,0.08)';
    g.lineWidth = 0.6;
    for (let i = 0; i < 70; i++) {
      const x = rnd() * 256, y = rnd() * 256, a = rnd() * Math.PI, l = 6 + rnd() * 22;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    return c.toDataURL('image/png');
  } catch (_) {
    return null;
  }
}

function defs(tex) {
  const shellStops = SHELL.map((c, i) => `<stop offset="${f(i / (SHELL.length - 1))}" stop-color="${c}"/>`).join('');
  return `
  <defs>
    <linearGradient id="kg-stage" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#07080b"/><stop offset="0.55" stop-color="#14161c"/><stop offset="1" stop-color="#2b2f3a"/>
    </linearGradient>
    <linearGradient id="kg-shell" x1="0" y1="0" x2="1" y2="0">${shellStops}</linearGradient>
    <linearGradient id="kg-chrome" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.2" stop-color="#c3c7cd"/><stop offset="0.45" stop-color="#6f747c"/>
      <stop offset="0.6" stop-color="#e9ebee"/><stop offset="0.8" stop-color="#9aa0a8"/><stop offset="1" stop-color="#4c5057"/>
    </linearGradient>
    <linearGradient id="kg-chrome-v" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#5a5f66"/><stop offset="0.35" stop-color="#f4f5f7"/><stop offset="0.6" stop-color="#a9aeb5"/><stop offset="1" stop-color="#4a4e55"/>
    </linearGradient>
    <radialGradient id="kg-head" cx="42%" cy="35%" r="75%">
      <stop offset="0" stop-color="#f6f3ec"/><stop offset="0.65" stop-color="#e2ddd1"/><stop offset="1" stop-color="#b9b2a2"/>
    </radialGradient>
    <radialGradient id="kg-brass" cx="45%" cy="40%" r="62%">
      <stop offset="0" stop-color="#fff1b8"/><stop offset="0.18" stop-color="#e9cd78"/><stop offset="0.5" stop-color="#cfae55"/>
      <stop offset="0.8" stop-color="#b8953e"/><stop offset="1" stop-color="#8d6f27"/>
    </radialGradient>
    <radialGradient id="kg-brass-dark" cx="45%" cy="40%" r="62%">
      <stop offset="0" stop-color="#f2dc98"/><stop offset="0.18" stop-color="#d7b863"/><stop offset="0.5" stop-color="#b8963f"/>
      <stop offset="0.8" stop-color="#9c7c2f"/><stop offset="1" stop-color="#6f561b"/>
    </radialGradient>
    <linearGradient id="kg-sheen" x1="0" y1="0" x2="1" y2="0.35">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.38" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.32"/><stop offset="0.62" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="kg-bell" cx="40%" cy="30%" r="70%">
      <stop offset="0" stop-color="#fff6d2"/><stop offset="0.5" stop-color="#e3c46c"/><stop offset="1" stop-color="#a88634"/>
    </radialGradient>
    <filter id="kf-blur" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
    ${tex ? `<pattern id="kp-coat" patternUnits="userSpaceOnUse" width="120" height="120"><image href="${tex}" width="120" height="120"/></pattern>` : ''}
  </defs>`;
}

/** 太鼓の前面（見えている半周）の上で、角度 a の x・y を返す */
const onEllipse = (p, a, scale = 1) => [p.cx + Math.cos(a) * p.rx * scale, p.cy + Math.sin(a) * p.ry * scale];

/** 斜めから見た太鼓（タム・スネア・フロアタム） */
function drum(p, type, label, opts = {}) {
  const { cx, cy, rx, ry, depth } = p;
  const parts = [];
  // 胴（円柱の側面）
  parts.push(`<path d="M${f(cx - rx)} ${cy} L${f(cx - rx)} ${f(cy + depth)} A${rx} ${ry} 0 0 0 ${f(cx + rx)} ${f(cy + depth)} L${f(cx + rx)} ${cy} Z" fill="url(#kg-shell)"/>`);
  // 下のフープ
  parts.push(`<path d="M${f(cx - rx)} ${f(cy + depth - 3)} A${rx} ${ry} 0 0 0 ${f(cx + rx)} ${f(cy + depth - 3)}" fill="none" stroke="url(#kg-chrome)" stroke-width="5"/>`);
  // ラグ（胴の前面に並ぶ金具）
  const lugs = opts.lugs || 8;
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2 + Math.PI / lugs;
    if (Math.sin(a) < 0.08) continue;                    // 裏側は見えない
    const [x, y] = onEllipse(p, a);
    const w = Math.max(2.5, 7 * Math.sin(a));
    const top = y + depth * (opts.snare ? 0.15 : 0.18), h = depth * (opts.snare ? 0.6 : 0.38);
    parts.push(`<rect x="${f(x - w / 2)}" y="${f(top)}" width="${f(w)}" height="${f(h)}" rx="${f(w / 2)}" fill="url(#kg-chrome-v)"/>`);
    if (!opts.snare) parts.push(`<rect x="${f(x - w / 2)}" y="${f(top + depth * 0.45)}" width="${f(w)}" height="${f(h * 0.6)}" rx="${f(w / 2)}" fill="url(#kg-chrome-v)"/>`);
  }
  if (opts.snare) {
    // ストレイナー
    const [x, y] = onEllipse(p, Math.PI * 0.12);
    parts.push(`<rect x="${f(x - 4)}" y="${f(y + 4)}" width="9" height="${f(depth * 0.75)}" rx="2" fill="url(#kg-chrome-v)"/>`);
  }
  // 上のフープ（クローム）とヘッド
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#kg-chrome)"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${f(cy + 1)}" rx="${f(rx - 4.5)}" ry="${f(ry - 3)}" fill="#3a3d42"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(rx - 5)}" ry="${f(ry - 3.4)}" fill="url(#kg-head)"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(rx - 5)}" ry="${f(ry - 3.4)}" fill="url(#kp-coat)" opacity="0.55"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(rx - 9)}" ry="${f(ry - 6)}" fill="none" stroke="#b8b09e" stroke-width="0.8" opacity="0.7"/>`);
  // テンションボルト（フープの上）
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2 + Math.PI / lugs;
    const [x, y] = onEllipse(p, a, 0.985);
    parts.push(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="3.2" ry="2.2" fill="url(#kg-chrome)" stroke="#2c2f34" stroke-width="0.6"/>`);
  }
  return `<g class="kit-piece drum-piece" data-type="${type}" role="button" aria-label="${label}">${parts.join('')}</g>`;
}

/** バスドラム：横に寝た円柱を後ろ上から見た形。手前（ドラマー側）のヘッドとペダル、奥へ伸びる胴 */
function kick(p) {
  const { cx, cy, rx, ry, len } = p;
  const fy = cy - len, parts = [];
  // 胴：奥のヘッドの縁（上半分）と、手前・奥をつなぐ側面
  parts.push(`<path d="M${f(cx - rx)} ${cy} L${f(cx - rx)} ${f(fy)} A${rx} ${ry} 0 0 1 ${f(cx + rx)} ${f(fy)} L${f(cx + rx)} ${cy} Z" fill="url(#kg-shell)"/>`);
  parts.push(`<path d="M${f(cx - rx)} ${f(fy)} A${rx} ${ry} 0 0 1 ${f(cx + rx)} ${f(fy)}" fill="none" stroke="#4a0c18" stroke-width="8"/>`);
  for (const sx of [-0.95, -0.55, 0.55, 0.95]) {
    const x = cx + sx * rx, w = Math.max(3, 7 * (1 - Math.abs(sx) * 0.5));
    parts.push(`<rect x="${f(x - w / 2)}" y="${f(fy + len * 0.32)}" width="${f(w)}" height="22" rx="${f(w / 2)}" fill="url(#kg-chrome-v)"/>`);
  }
  // 手前のフープ（胴と同じ色）とクロー
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#kg-shell)"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#3a0812" stroke-width="1.2"/>`);
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const x = cx + Math.cos(a) * rx * 0.97, y = cy + Math.sin(a) * ry * 0.97;
    parts.push(`<rect x="${f(x - 3)}" y="${f(y - 6)}" width="6" height="12" rx="2" fill="url(#kg-chrome)" transform="rotate(${f((Math.atan2(Math.sin(a) * ry, Math.cos(a) * rx) * 180) / Math.PI + 90)} ${f(x)} ${f(y)})"/>`);
  }
  // ヘッド
  const hx = rx * 0.86, hy = ry * 0.86;
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(hx)}" ry="${f(hy)}" fill="url(#kg-head)"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(hx)}" ry="${f(hy)}" fill="url(#kp-coat)" opacity="0.55"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f(hx)}" ry="${f(hy)}" fill="none" stroke="#9e9584" stroke-width="1"/>`);
  // ビーターの当たる位置のパッド
  const by = cy + hy * 0.32;
  parts.push(`<ellipse cx="${cx}" cy="${f(by)}" rx="${f(hx * 0.18)}" ry="${f(hy * 0.18)}" fill="#cfc7b6" opacity="0.85"/>`);
  // ペダル（ビーターとシャフト、フットボード）
  parts.push(`<rect x="${f(cx - 2)}" y="${f(by)}" width="4" height="${f(VIEW_H - by)}" fill="url(#kg-chrome-v)"/>`);
  parts.push(`<rect x="${f(cx - 12)}" y="${f(by - 7)}" width="24" height="14" rx="7" fill="#e8e3d8" stroke="#8d877b" stroke-width="1"/>`);
  parts.push(`<path d="M${f(cx - 24)} ${VIEW_H} L${f(cx - 16)} ${f(VIEW_H - 20)} L${f(cx + 16)} ${f(VIEW_H - 20)} L${f(cx + 24)} ${VIEW_H} Z" fill="#26282d" stroke="#55595f" stroke-width="1"/>`);
  return `<g class="kit-piece drum-piece" data-type="kick" role="button" aria-label="バスドラム">${parts.join('')}</g>`;
}

/** 斜めから見たシンバル */
function cymbal(p, type, label, opts = {}) {
  const { cx, cy, rx, ry } = p;
  const fill = opts.dark ? 'url(#kg-brass-dark)' : 'url(#kg-brass)';
  const parts = [];
  if (opts.hihat) {
    // 下のシンバル
    parts.push(`<ellipse cx="${cx}" cy="${f(cy + 6)}" rx="${rx}" ry="${ry}" fill="#8d6f27"/>`);
    parts.push(`<ellipse cx="${cx}" cy="${f(cy + 6)}" rx="${rx}" ry="${ry}" fill="none" stroke="#5e4815" stroke-width="1"/>`);
  }
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>`);
  // 旋盤の溝
  const grooves = Math.round(rx / 2.6);
  for (let i = 0; i < grooves; i++) {
    const k = 0.27 + (0.97 - 0.27) * (i / (grooves - 1));
    parts.push(`<ellipse cx="${cx}" cy="${f(cy - ry * 0.12 * (1 - k))}" rx="${f(rx * k)}" ry="${f(ry * k)}" fill="none" stroke="${i % 2 ? '#6a5016' : '#fff6d6'}" stroke-width="0.5" opacity="${i % 2 ? 0.28 : 0.2}"/>`);
  }
  // 光の反射
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#kg-sheen)"/>`);
  parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#5e4815" stroke-width="1" opacity="0.7"/>`);
  // カップ（少し盛り上がって見えるよう上にずらす）
  const bx = cx, by = cy - ry * 0.18;
  parts.push(`<ellipse cx="${bx}" cy="${f(by + 2)}" rx="${f(rx * 0.25)}" ry="${f(ry * 0.32)}" fill="#7c6020" opacity="0.5"/>`);
  parts.push(`<ellipse cx="${bx}" cy="${f(by)}" rx="${f(rx * 0.24)}" ry="${f(ry * 0.3)}" fill="url(#kg-bell)"/>`);
  // フェルト・蝶ナット（ハイハットはクラッチ）
  if (opts.hihat) {
    parts.push(`<rect x="${f(bx - 4)}" y="${f(by - 30)}" width="8" height="30" rx="2" fill="url(#kg-chrome-v)"/>`);
    parts.push(`<rect x="${f(bx - 7)}" y="${f(by - 12)}" width="14" height="9" rx="2" fill="url(#kg-chrome-v)"/>`);
  } else {
    parts.push(`<ellipse cx="${bx}" cy="${f(by - 2)}" rx="6" ry="3" fill="#1d1d20"/>`);
    parts.push(`<rect x="${f(bx - 1.6)}" y="${f(by - 22)}" width="3.2" height="20" fill="url(#kg-chrome-v)"/>`);
    parts.push(`<path d="M${f(bx - 9)} ${f(by - 13)} L${f(bx + 9)} ${f(by - 13)} L${f(bx + 4)} ${f(by - 8)} L${f(bx - 4)} ${f(by - 8)} Z" fill="url(#kg-chrome)"/>`);
  }
  return `<g class="kit-piece cymbal-piece" data-type="${type}" role="button" aria-label="${label}">${parts.join('')}</g>`;
}

/** スタンドの支柱（パーツの後ろに描く） */
function stands() {
  const pole = (x1, y1, x2, y2, w = 5) => `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="url(#kg-chrome-v)" stroke-width="${w}" stroke-linecap="round"/>`;
  return `<g>
    ${pole(L.crash.cx - 8, L.crash.cy, L.crash.cx - 30, 250)}
    ${pole(L.ride.cx + 10, L.ride.cy, L.ride.cx + 44, 240)}
    ${pole(L.hihat.cx, L.hihat.cy, L.hihat.cx - 4, VIEW_H, 6)}
    ${pole(208, 168, 208, 230, 9)}
    ${pole(208, 176, L.tomHigh.cx + 26, L.tomHigh.cy + 12, 6)}
    ${pole(208, 176, L.tomMid.cx - 26, L.tomMid.cy + 12, 6)}
    ${pole(L.tomFloor.cx + L.tomFloor.rx - 6, L.tomFloor.cy + 30, L.tomFloor.cx + L.tomFloor.rx + 14, VIEW_H - 4, 4)}
    ${pole(L.snare.cx - 30, L.snare.cy + 24, L.snare.cx - 54, VIEW_H - 4, 4)}
    ${pole(L.snare.cx + 20, L.snare.cy + 26, L.snare.cx + 40, VIEW_H - 4, 4)}
  </g>`;
}

/** 床に落ちる影（1 枚のレイヤーにまとめてぼかす） */
function shadows() {
  const sh = (cx, cy, rx, ry, o = 0.55) => `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="#000" opacity="${o}"/>`;
  return `<g filter="url(#kf-blur)">
    ${sh(L.snare.cx + 6, L.snare.cy + L.snare.depth + 14, L.snare.rx, L.snare.ry)}
    ${sh(L.tomFloor.cx + 6, L.tomFloor.cy + L.tomFloor.depth + 12, L.tomFloor.rx, L.tomFloor.ry)}
    ${sh(L.tomHigh.cx + 6, L.tomHigh.cy + L.tomHigh.depth + 10, L.tomHigh.rx, L.tomHigh.ry, 0.4)}
    ${sh(L.tomMid.cx + 6, L.tomMid.cy + L.tomMid.depth + 10, L.tomMid.rx, L.tomMid.ry, 0.4)}
    ${sh(L.crash.cx + 8, L.crash.cy + 18, L.crash.rx * 0.9, L.crash.ry * 0.9, 0.35)}
    ${sh(L.ride.cx + 8, L.ride.cy + 18, L.ride.rx * 0.9, L.ride.ry * 0.9, 0.35)}
    ${sh(L.hihat.cx + 6, L.hihat.cy + 16, L.hihat.rx, L.hihat.ry, 0.4)}
  </g>`;
}

export function renderKit(svg) {
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.innerHTML = [
    defs(coatedTexture()),
    `<rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" rx="18" fill="url(#kg-stage)"/>`,
    shadows(),
    stands(),
    // 奥・下にあるものから順に描く（後のものほど上に重なり、タップも優先される）
    kick(L.kick),
    drum(L.tomHigh, 'tomHigh', 'タム（たかい）'),
    drum(L.tomMid, 'tomMid', 'タム（ひくい）'),
    drum(L.snare, 'snare', 'スネア', { snare: true, lugs: 10 }),
    drum(L.tomFloor, 'tomFloor', 'フロアタム', { lugs: 8 }),
    cymbal(L.crash, 'crash', 'クラッシュ'),
    cymbal(L.ride, 'ride', 'ライド', { dark: true }),
    cymbal(L.hihat, 'hihat', 'ハイハット', { hihat: true }),
  ].join('');
}
