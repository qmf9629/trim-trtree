/**
 * theme.js — Material You（Material 3）动态配色
 *
 * 用 OKLCH 近似 M3 的 HCT 色调体系：给定种子色相，生成 primary / secondary /
 * tertiary / neutral 各套色调（tone 0–100），再按 M3 规范映射为浅色 / 深色方案，
 * 写入 :root 的 CSS 变量（--md-*）。Treemap 也用同一套色调函数取色。
 *
 * 导出：
 *   initTheme()                 读取本地偏好并应用（模块加载时自动调用）
 *   getTheme()                  { mode, resolved, seed, hue }
 *   setThemeMode(mode)          'system' | 'light' | 'dark'
 *   setThemeSeed(hex)           种子色（#rrggbb）
 *   onThemeChange(fn)           订阅主题变化，返回取消函数
 *   toneColor(hue, chroma, tone) -> [r,g,b]（0–255，已做色域映射）
 *   SEED_PRESETS                预设种子色
 */

const STORE_KEY = 'trtree.theme.v1';

export const SEED_PRESETS = [
  { name: '飞牛蓝', hex: '#3b82f6' },
  { name: '湖青', hex: '#0891b2' },
  { name: '松绿', hex: '#16a34a' },
  { name: '暮紫', hex: '#7c3aed' },
  { name: '樱粉', hex: '#db2777' },
  { name: '琥珀', hex: '#d97706' },
];

/* ------------------------------------------------------------------ */
/* OKLCH <-> sRGB                                                      */
/* ------------------------------------------------------------------ */

function linToSrgb(x) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

function srgbToLin(x) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

/** OKLab -> 线性 sRGB（未裁剪） */
function oklabToLinear(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut(rgb) {
  const e = 1e-4;
  return rgb[0] >= -e && rgb[0] <= 1 + e && rgb[1] >= -e && rgb[1] <= 1 + e && rgb[2] >= -e && rgb[2] <= 1 + e;
}

/** M3 tone（≈ CIE L*）转 OKLab L：中性色下 OK L ≈ Y^(1/3) = (L*+16)/116 */
function toneToL(tone) {
  if (tone <= 0) return 0;
  if (tone >= 100) return 1;
  return Math.min(1, (tone + 16) / 116);
}

const colorCache = new Map();

/**
 * 取指定色相 / 彩度 / 色调的 sRGB 颜色；超出色域时降低彩度（保持色相与明度）。
 * @param {number} hue 0–360（OKLCH 色相）
 * @param {number} chroma OKLCH 彩度，常用 0–0.2
 * @param {number} tone 0–100
 * @returns {number[]} [r,g,b] 0–255
 */
export function toneColor(hue, chroma, tone) {
  const key = `${Math.round(hue * 2)}|${Math.round(chroma * 1000)}|${Math.round(tone * 4)}`;
  const hit = colorCache.get(key);
  if (hit) return hit;
  const L = toneToL(tone);
  const hr = (hue * Math.PI) / 180;
  const ca = Math.cos(hr);
  const sa = Math.sin(hr);
  let c = Math.max(0, chroma);
  let rgb = oklabToLinear(L, c * ca, c * sa);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = c;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      const t = oklabToLinear(L, mid * ca, mid * sa);
      if (inGamut(t)) {
        lo = mid;
        rgb = t;
      } else {
        hi = mid;
      }
    }
    if (!inGamut(rgb)) rgb = oklabToLinear(L, 0, 0);
  }
  const out = rgb.map((v) => Math.round(Math.min(1, Math.max(0, linToSrgb(Math.min(1, Math.max(0, v))))) * 255));
  if (colorCache.size > 20000) colorCache.clear();
  colorCache.set(key, out);
  return out;
}

export function rgbCss(rgb, alpha) {
  if (alpha === undefined || alpha >= 1) return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

function hexOf(rgb) {
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** #rrggbb -> { L, C, H }（OKLCH） */
export function hexToOklch(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = srgbToLin(((n >> 16) & 255) / 255);
  const g = srgbToLin(((n >> 8) & 255) / 255);
  const b = srgbToLin((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
  const C = Math.sqrt(A * A + B * B);
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}

/* ------------------------------------------------------------------ */
/* M3 配色方案                                                          */
/* ------------------------------------------------------------------ */

function palettes(seedHex) {
  const lch = hexToOklch(seedHex) || { L: 0.6, C: 0.15, H: 260 };
  const h = lch.H;
  // tonal spot：主色保留种子彩度（有上下限），其余色板依次降低彩度
  const pc = Math.min(0.16, Math.max(0.07, lch.C * 0.9));
  return {
    hue: h,
    p: (t) => toneColor(h, pc, t),
    s: (t) => toneColor(h, pc * 0.32, t),
    t: (t) => toneColor((h + 60) % 360, pc * 0.6, t),
    n: (t) => toneColor(h, 0.008, t),
    nv: (t) => toneColor(h, 0.018, t),
    e: (t) => toneColor(27, 0.16, t),
    w: (t) => toneColor(75, 0.13, t),
    ok: (t) => toneColor(150, 0.12, t),
  };
}

function buildScheme(seedHex, dark) {
  const P = palettes(seedHex);
  const role = (pal, light, darkTone) => P[pal](dark ? darkTone : light);
  const s = {
    primary: role('p', 40, 80),
    'on-primary': role('p', 100, 20),
    'primary-container': role('p', 90, 30),
    'on-primary-container': role('p', 10, 90),
    'inverse-primary': role('p', 80, 40),
    secondary: role('s', 40, 80),
    'on-secondary': role('s', 100, 20),
    'secondary-container': role('s', 90, 30),
    'on-secondary-container': role('s', 10, 90),
    tertiary: role('t', 40, 80),
    'on-tertiary': role('t', 100, 20),
    'tertiary-container': role('t', 90, 30),
    'on-tertiary-container': role('t', 10, 90),
    error: role('e', 40, 80),
    'on-error': role('e', 100, 20),
    'error-container': role('e', 90, 30),
    'on-error-container': role('e', 10, 90),
    warn: role('w', 45, 82),
    'warn-container': role('w', 92, 28),
    'on-warn-container': role('w', 12, 90),
    ok: role('ok', 42, 80),
    'ok-container': role('ok', 92, 28),
    'on-ok-container': role('ok', 10, 90),
    surface: role('n', 98, 6),
    'surface-dim': role('n', 87, 6),
    'surface-bright': role('n', 98, 24),
    'surface-container-lowest': role('n', 100, 4),
    'surface-container-low': role('n', 96, 10),
    'surface-container': role('n', 94, 12),
    'surface-container-high': role('n', 92, 17),
    'surface-container-highest': role('n', 90, 22),
    'on-surface': role('n', 10, 90),
    'on-surface-variant': role('nv', 30, 80),
    outline: role('nv', 50, 60),
    'outline-variant': role('nv', 80, 30),
    'inverse-surface': role('n', 20, 90),
    'inverse-on-surface': role('n', 95, 20),
    scrim: P.n(0),
    shadow: P.n(0),
  };
  return { scheme: s, hue: P.hue };
}

/* ------------------------------------------------------------------ */
/* 偏好与应用                                                           */
/* ------------------------------------------------------------------ */

const listeners = new Set();
const current = { mode: 'system', seed: SEED_PRESETS[0].hex, resolved: 'dark', hue: 260 };
let mql = null;

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v && ['system', 'light', 'dark'].includes(v.mode)) current.mode = v.mode;
    if (v && hexToOklch(v.seed)) current.seed = v.seed;
  } catch (_) { /* 隐私模式等忽略 */ }
}

function savePrefs() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ mode: current.mode, seed: current.seed }));
  } catch (_) { /* ignore */ }
}

function systemDark() {
  try {
    return !window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (_) {
    return true;
  }
}

function apply() {
  const dark = current.mode === 'dark' || (current.mode === 'system' && systemDark());
  current.resolved = dark ? 'dark' : 'light';
  const { scheme, hue } = buildScheme(current.seed, dark);
  current.hue = hue;
  const root = document.documentElement;
  const style = root.style;
  for (const [k, rgb] of Object.entries(scheme)) {
    style.setProperty('--md-' + k, hexOf(rgb));
    style.setProperty('--md-' + k + '-rgb', rgb.join(' '));
  }
  root.dataset.theme = current.resolved;
  style.colorScheme = current.resolved;
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute('content', current.resolved);
  const tc = document.querySelector('meta[name="theme-color"]');
  if (tc) tc.setAttribute('content', hexOf(scheme['surface-container']));
  for (const fn of listeners) {
    try { fn(getTheme()); } catch (_) { /* 订阅者错误不影响其他 */ }
  }
}

export function getTheme() {
  return { mode: current.mode, resolved: current.resolved, seed: current.seed, hue: current.hue };
}

export function setThemeMode(mode) {
  if (!['system', 'light', 'dark'].includes(mode) || mode === current.mode) return;
  current.mode = mode;
  savePrefs();
  apply();
}

export function setThemeSeed(hex) {
  if (!hexToOklch(hex)) return;
  current.seed = hex.toLowerCase();
  savePrefs();
  apply();
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  loadPrefs();
  // ?theme=light|dark|system&seed=%23rrggbb：临时覆盖（截图 / 演示用，不写入偏好）
  try {
    const q = new URLSearchParams(location.search);
    const m = q.get('theme');
    if (['system', 'light', 'dark'].includes(m)) current.mode = m;
    const sd = q.get('seed');
    if (sd && hexToOklch(sd)) current.seed = sd.toLowerCase();
  } catch (_) { /* ignore */ }
  if (!mql && window.matchMedia) {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onSys = () => { if (current.mode === 'system') apply(); };
    if (mql.addEventListener) mql.addEventListener('change', onSys);
    else if (mql.addListener) mql.addListener(onSys);
  }
  apply();
}

initTheme();
