// kit.js — ドラム画面のドラムセットを SVG で描く（依存なし・画像ファイルなし）
//
// 設計（docs/03_設計書.md §5.10）
//  - ドラマーの席から見下ろした配置（右利き標準）。上段にクラッシュ・ライド、
//    左にハイハット、中央にタム 2 つ、左下スネア、右下フロアタム、手前中央にバスドラム
//  - 太鼓：シェル（胴）→ ラグ → クロームのフープ → テンションボルト → コーテッドヘッド
//  - シンバル：ブロンズの放射グラデーション → 旋盤の溝（同心円）→ 反射 → カップ → フェルトとナット
//  - バスドラムは手前から見たフロントヘッド（黒）とポートホール
//  - 各パーツは <g class="kit-piece" data-type="..."> で、叩く処理は app.js が付ける

const VIEW_W = 400;
const VIEW_H = 430;

// 配置（viewBox 400 × 430）。数値は当たり判定の重なりが最小になるよう調整してある
const LAYOUT = {
  crash: { cx: 76, cy: 72, r: 70 },
  ride: { cx: 330, cy: 74, r: 68 },
  hihat: { cx: 50, cy: 202, r: 48 },
  tomHigh: { cx: 154, cy: 152, r: 50 },
  tomMid: { cx: 262, cy: 152, r: 53 },
  snare: { cx: 100, cy: 302, r: 60 },
  tomFloor: { cx: 318, cy: 296, r: 64 },
  kick: { cx: 210, cy: 372, r: 52 },
};

// シェルの色（ワインレッドのラッカー）
const SHELL = { light: '#9b2335', mid: '#6e1423', dark: '#3d0a14' };

const f = (n) => Math.round(n * 100) / 100;

function defs() {
  return `
  <defs>
    <radialGradient id="kg-stage" cx="50%" cy="55%" r="70%">
      <stop offset="0" stop-color="#34343a"/><stop offset="0.6" stop-color="#1b1b1f"/><stop offset="1" stop-color="#0c0c0e"/>
    </radialGradient>
    <radialGradient id="kg-shell" cx="35%" cy="30%" r="75%">
      <stop offset="0" stop-color="${SHELL.light}"/><stop offset="0.55" stop-color="${SHELL.mid}"/><stop offset="1" stop-color="${SHELL.dark}"/>
    </radialGradient>
    <linearGradient id="kg-chrome" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.25" stop-color="#c9ccd1"/><stop offset="0.5" stop-color="#8b9097"/>
      <stop offset="0.7" stop-color="#e6e8eb"/><stop offset="1" stop-color="#6d7279"/>
    </linearGradient>
    <radialGradient id="kg-head" cx="42%" cy="38%" r="70%">
      <stop offset="0" stop-color="#fbf9f4"/><stop offset="0.7" stop-color="#ebe6db"/><stop offset="1" stop-color="#cfc8b8"/>
    </radialGradient>
    <radialGradient id="kg-kickhead" cx="40%" cy="35%" r="75%">
      <stop offset="0" stop-color="#2c2c30"/><stop offset="0.7" stop-color="#141416"/><stop offset="1" stop-color="#050506"/>
    </radialGradient>
    <linearGradient id="kg-wood" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#c58b4c"/><stop offset="0.5" stop-color="#8a5a2b"/><stop offset="1" stop-color="#5e3a19"/>
    </linearGradient>
    <radialGradient id="kg-bronze" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#f3d27a"/><stop offset="0.28" stop-color="#e2b24f"/><stop offset="0.3" stop-color="#c9963a"/>
      <stop offset="0.75" stop-color="#b9862e"/><stop offset="1" stop-color="#8f6520"/>
    </radialGradient>
    <radialGradient id="kg-bronze-dark" cx="50%" cy="50%" r="50%">
      <stop offset="0" stop-color="#e5c271"/><stop offset="0.28" stop-color="#c9993f"/><stop offset="0.3" stop-color="#a97b2c"/>
      <stop offset="0.75" stop-color="#946a24"/><stop offset="1" stop-color="#6e4d17"/>
    </radialGradient>
    <linearGradient id="kg-sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.42" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.38"/><stop offset="0.58" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="kg-bell" cx="40%" cy="38%" r="65%">
      <stop offset="0" stop-color="#fff2c4"/><stop offset="0.5" stop-color="#e8c060"/><stop offset="1" stop-color="#b98a2e"/>
    </radialGradient>
    <filter id="kf-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="4"/><feOffset dx="2" dy="5" result="b"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.6"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;
}

/** 太鼓（上から見たタム・スネア・フロアタム） */
function drum({ cx, cy, r }, type, label, opts = {}) {
  const lugs = opts.lugs || (r >= 58 ? 10 : 8);
  const parts = [];
  // シェル
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#kg-shell)"/>`);
  // ラグ（シェルの外周にのぞくクロームの金具）
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2 + Math.PI / lugs;
    const x = cx + Math.cos(a) * r * 0.97, y = cy + Math.sin(a) * r * 0.97;
    const w = r * 0.13, h = r * 0.075;
    parts.push(`<rect x="${f(x - w / 2)}" y="${f(y - h / 2)}" width="${f(w)}" height="${f(h)}" rx="${f(h / 2)}" fill="url(#kg-chrome)" transform="rotate(${f((a * 180) / Math.PI + 90)} ${f(x)} ${f(y)})"/>`);
  }
  // フープ
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.9)}" fill="url(#kg-chrome)"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.9)}" fill="none" stroke="#4b4f55" stroke-width="0.8" opacity="0.6"/>`);
  // テンションボルト
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2 + Math.PI / lugs;
    const x = cx + Math.cos(a) * r * 0.86, y = cy + Math.sin(a) * r * 0.86;
    parts.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.035)}" fill="#3a3d42"/>`);
  }
  // ヘッド（コーテッド）
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.8)}" fill="url(#kg-head)"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.8)}" fill="none" stroke="#b9b1a0" stroke-width="1"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.74)}" fill="none" stroke="#d8d1c2" stroke-width="0.6" opacity="0.8"/>`);
  if (opts.snare) {
    // スネア：ストレイナー（レバー）と、裏の響き線を示す淡い線
    const x = cx + r * 0.98, y = cy;
    parts.push(`<rect x="${f(x - 3)}" y="${f(y - r * 0.12)}" width="${f(r * 0.14)}" height="${f(r * 0.24)}" rx="2" fill="url(#kg-chrome)"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.06)}" fill="none" stroke="#c4bba8" stroke-width="0.8" opacity="0.7"/>`);
  }
  if (opts.mount) {
    // タムのマウント（ホルダーの金具）
    parts.push(`<rect x="${f(cx - r * 0.09)}" y="${f(cy - r * 1.06)}" width="${f(r * 0.18)}" height="${f(r * 0.16)}" rx="2" fill="url(#kg-chrome)"/>`);
  }
  return `<g class="kit-piece drum-piece" data-type="${type}" role="button" aria-label="${label}" filter="url(#kf-shadow)">${parts.join('')}</g>`;
}

/** バスドラム（手前から見たフロントヘッド） */
function kick({ cx, cy, r }) {
  const parts = [];
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#kg-shell)"/>`);
  // 木製フープ
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.94)}" fill="url(#kg-wood)"/>`);
  // クロー（フープを留める金具）
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / n;
    const x = cx + Math.cos(a) * r * 0.9, y = cy + Math.sin(a) * r * 0.9;
    parts.push(`<rect x="${f(x - r * 0.05)}" y="${f(y - r * 0.09)}" width="${f(r * 0.1)}" height="${f(r * 0.18)}" rx="1.5" fill="url(#kg-chrome)" transform="rotate(${f((a * 180) / Math.PI + 90)} ${f(x)} ${f(y)})"/>`);
  }
  // フロントヘッド（黒）とロゴ用のリング、ポートホール
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.8)}" fill="url(#kg-kickhead)"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.5)}" fill="none" stroke="#9a9aa0" stroke-width="1" opacity="0.35"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.46)}" fill="none" stroke="#9a9aa0" stroke-width="0.6" opacity="0.25"/>`);
  const px = cx - r * 0.38, py = cy + r * 0.34;
  parts.push(`<circle cx="${f(px)}" cy="${f(py)}" r="${f(r * 0.17)}" fill="url(#kg-chrome)"/>`);
  parts.push(`<circle cx="${f(px)}" cy="${f(py)}" r="${f(r * 0.14)}" fill="#020203"/>`);
  // 映り込み
  parts.push(`<ellipse cx="${f(cx - r * 0.25)}" cy="${f(cy - r * 0.38)}" rx="${f(r * 0.3)}" ry="${f(r * 0.1)}" fill="#fff" opacity="0.08" transform="rotate(-25 ${f(cx - r * 0.25)} ${f(cy - r * 0.38)})"/>`);
  return `<g class="kit-piece drum-piece" data-type="kick" role="button" aria-label="バスドラム" filter="url(#kf-shadow)">${parts.join('')}</g>`;
}

/** シンバル（上から見た円） */
function cymbal({ cx, cy, r }, type, label, opts = {}) {
  const fill = opts.dark ? 'url(#kg-bronze-dark)' : 'url(#kg-bronze)';
  const parts = [];
  if (opts.hihat) {
    // 下のシンバル（少しずれて縁がのぞく）
    parts.push(`<circle cx="${f(cx + 2)}" cy="${f(cy + 3)}" r="${r}" fill="#8f6520"/>`);
  }
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`);
  // 旋盤の溝
  const grooves = Math.round(r / 3.2);
  for (let i = 0; i < grooves; i++) {
    const rr = r * 0.3 + ((r * 0.97 - r * 0.3) * i) / (grooves - 1);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(rr)}" fill="none" stroke="${i % 2 ? '#5a3c0c' : '#fff4cf'}" stroke-width="0.55" opacity="${i % 2 ? 0.22 : 0.14}"/>`);
  }
  // 反射（斜めの光の帯 2 本）
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#kg-sheen)"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#kg-sheen)" transform="rotate(90 ${cx} ${cy})" opacity="0.55"/>`);
  // 縁
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r - 0.5)}" fill="none" stroke="#6b4a14" stroke-width="1" opacity="0.6"/>`);
  // カップ
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.24)}" fill="url(#kg-bell)"/>`);
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.24)}" fill="none" stroke="#8a6420" stroke-width="0.8" opacity="0.6"/>`);
  // フェルトとナット（ハイハットはクラッチ）
  if (opts.hihat) {
    parts.push(`<rect x="${f(cx - r * 0.1)}" y="${f(cy - r * 0.1)}" width="${f(r * 0.2)}" height="${f(r * 0.2)}" rx="2" fill="url(#kg-chrome)"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.05)}" fill="#2a2c30"/>`);
  } else {
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.08)}" fill="#3b2a2a"/>`);
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${f(r * 0.045)}" fill="url(#kg-chrome)"/>`);
  }
  return `<g class="kit-piece cymbal-piece" data-type="${type}" role="button" aria-label="${label}" filter="url(#kf-shadow)">${parts.join('')}</g>`;
}

/** スタンド類（パーツの下に描く飾り） */
function hardware() {
  const L = LAYOUT;
  const chrome = 'stroke="url(#kg-chrome)" stroke-width="5" stroke-linecap="round"';
  return `<g opacity="0.9">
    <line x1="${L.crash.cx}" y1="${L.crash.cy}" x2="18" y2="140" ${chrome}/>
    <line x1="${L.ride.cx}" y1="${L.ride.cy}" x2="388" y2="190" ${chrome}/>
    <line x1="${L.tomHigh.cx + 30}" y1="${L.tomHigh.cy - 40}" x2="${L.tomMid.cx - 30}" y2="${L.tomMid.cy - 40}" ${chrome}/>
    <line x1="${(L.tomHigh.cx + L.tomMid.cx) / 2}" y1="${L.tomHigh.cy - 40}" x2="${(L.tomHigh.cx + L.tomMid.cx) / 2}" y2="${L.kick.cy - L.kick.r}" ${chrome}/>
  </g>`;
}

export function renderKit(svg) {
  const L = LAYOUT;
  svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.innerHTML = [
    defs(),
    `<rect x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" rx="18" fill="url(#kg-stage)"/>`,
    hardware(),
    // 下にあるものから順に描く（後のものほど上に重なり、タップも優先される）
    kick(L.kick),
    drum(L.snare, 'snare', 'スネア', { snare: true }),
    drum(L.tomFloor, 'tomFloor', 'フロアタム', { lugs: 10 }),
    drum(L.tomHigh, 'tomHigh', 'タム（たかい）', { mount: true }),
    drum(L.tomMid, 'tomMid', 'タム（ひくい）', { mount: true }),
    cymbal(L.hihat, 'hihat', 'ハイハット', { hihat: true }),
    cymbal(L.crash, 'crash', 'クラッシュ'),
    cymbal(L.ride, 'ride', 'ライド', { dark: true }),
  ].join('');
}
