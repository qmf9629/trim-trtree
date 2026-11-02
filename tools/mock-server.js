#!/usr/bin/env node
/**
 * TrTree 本地 mock 服务（零 npm 依赖，仅 Node 标准库）
 *
 *   node tools/mock-server.js
 *   → http://127.0.0.1:18080/
 *
 * 提供：
 *   - src/web/ 静态文件（正确 MIME，SPA 回退）
 *   - docs/API.md 定义的全部前端接口
 *   - 一套真实感 fixture：/vol1（3.8 TiB，含 Photos/视频/备份/Docker/下载 等）
 *   - 预置 4 条可打开扫描 + 1 条已释放历史，便于验证历史合并 / 重新分析：
 *       /?scan=s_1750000000000_ab12             /vol1 全盘
 *       /?scan=s_1749980000000_cd34             相册目录（历史中重复 2 次，自动合并）
 *       /?scan=s_1749900000000_ef56             备份目录（已取消）
 *       历史里 /vol1/Documents 一条为"结果已释放"状态（不在内存）
 *   - POST /api/scans 模拟一次约 9 秒的扫描（进度递增到 done）
 *
 * 仅用于本地预览，不参与打包。
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 18080;
const HOST = process.env.HOST || '127.0.0.1';
const WEB_ROOT = path.resolve(__dirname, '..', 'src', 'web');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const TB = 1024 * GB;
const NOW = Date.now();

/* ------------------------------------------------------------------ */
/* 伪随机（确定性 fixture）                                            */
/* ------------------------------------------------------------------ */

let rngState = 0x9e3779b9;
function rand() {
  rngState ^= rngState << 13;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 4294967296;
}
function randInt(min, max) {
  return Math.floor(min + rand() * (max - min + 1));
}
function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

/* ------------------------------------------------------------------ */
/* fixture 定义                                                        */
/* ------------------------------------------------------------------ */

function f(name, size, opts) {
  return Object.assign({ name, type: 'file', size: Math.round(size) }, opts || {});
}
function d(name, children, opts) {
  return Object.assign({ name, type: 'dir', children: children || [] }, opts || {});
}

function photoSet(prefix, n, exts, minMB, maxMB) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ext = exts[i % exts.length];
    out.push(f(`${prefix}_${String(1000 + i).slice(1)}.${ext}`, randInt(minMB, maxMB) * MB));
  }
  return out;
}
function documents(n, exts, minMB, maxMB, prefix = '文档') {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ext = exts[i % exts.length];
    out.push(f(`${prefix}_${2025}_${String(i + 1).padStart(2, '0')}.${ext}`, randInt(minMB, maxMB) * MB));
  }
  return out;
}
function musicSet(n, exts, minMB, maxMB) {
  const names = ['夜行列车', 'Midnight Drive', '海边的风', 'Blue Horizon', '山丘', 'Echoes', '浮光', 'Northern Lights', '旧时光', 'Velvet Sky'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const ext = exts[i % exts.length];
    out.push(f(`${names[i % names.length]}_${String(i + 1).padStart(2, '0')}.${ext}`, randInt(minMB, maxMB) * MB));
  }
  return out;
}
function zipFiles(n, minMB, maxMB) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(f(`archive_${2025}_${String(i + 1).padStart(2, '0')}.zip`, randInt(minMB, maxMB) * MB));
  return out;
}

const movieNames = [
  '沙丘2.2024.2160p.WEB-DL.mkv',
  '奥本海默.2023.1080p.BluRay.mkv',
  '流浪地球2.2023.2160p.mkv',
  '星际穿越.2014.1080p.mkv',
  '银翼杀手2049.2017.2160p.mkv',
  '疯狂的麦克斯.2024.1080p.mkv',
  '盗梦空间.2010.1080p.mkv',
  '降临.2016.1080p.mkv',
];

const SPEC = d('vol1', [
  d('1000', [
    d('Photos', [
      d('2024', [
        ...photoSet('IMG_2024', 13, ['jpg', 'heic', 'heic', 'jpg'], 3, 14),
        f('VID_20240812_183022.mp4', 96 * MB),
      ]),
      d('2023', photoSet('IMG_2023', 12, ['jpg', 'heic'], 3, 16)),
      d('2022', photoSet('IMG_2022', 9, ['jpg', 'raw'], 4, 22)),
      d('截图', photoSet('Screenshot', 18, ['png'], 1, 3)),
      d('相机', [...photoSet('DSC', 6, ['raw'], 24, 48), ...photoSet('DSC', 3, ['jpg'], 6, 12)]),
      d('家庭', photoSet('FAMILY', 5, ['jpg'], 3, 9)),
      d('旧的导入', []),
    ]),
    d('视频', [
      d('电影', movieNames.map((n) => f(n, randInt(7000, 16000) * MB))),
      d('剧集', Array.from({ length: 12 }, (_, i) => f(`S01E${String(i + 1).padStart(2, '0')}_1080p.mkv`, randInt(700, 1900) * MB))),
      d('家庭录像', Array.from({ length: 4 }, (_, i) => f(`MOV_20240${i + 1}.mov`, randInt(500, 1900) * MB))),
      d('纪录片', Array.from({ length: 4 }, (_, i) => f(`Documentary.S0${i + 1}.2160p.mkv`, randInt(20000, 32000) * MB))),
      d('4K原盘', [f('Dune.Part.Two.2024.2160p.REMUX.mkv', 42 * GB), f('Oppenheimer.2023.2160p.REMUX.mkv', 38 * GB)]),
    ]),
    d('下载', [
      f('ubuntu-24.04.1-desktop-amd64.iso', 5.1 * GB),
      f('debian-12.7.0-amd64-DVD-1.iso', 3.8 * GB),
      f('fnos-1.2.0800-amd64.iso', 2.4 * GB),
      f('linux-6.12.tar.xz', 148 * MB),
      ...zipFiles(6, 80, 1800),
      f('photos-backup-20250930.tar.gz', 1640 * MB),
      f('nextcloud.tar.gz', 420 * MB),
      f("<script>alert('xss')</script>.txt", 12 * 1024),
      f('README.md', 18 * 1024),
      f('ubuntu-24.04.1-live-server-amd64.iso', 2.7 * GB),
      f('docker-images-2025-10.tar', 8.4 * GB),
      f('家庭相册-2024.zip', 3.2 * GB),
    ]),
    d('Documents', documents(14, ['pdf', 'docx', 'xlsx', 'pptx', 'txt'], 0.2, 42)),
    d('Music', musicSet(16, ['flac', 'flac', 'mp3'], 8, 62)),
    d('Docker', [
      d('volumes', [
        f('postgres_data.db', 3.4 * GB),
        f('nextcloud_data.db', 2.1 * GB),
        f('redis_dump.rdb', 620 * MB),
        f('immich_upload.cache', 1.4 * GB),
        f('mysql_ibdata1.db', 2.8 * GB),
      ]),
      d('containers', [
        f('container-7f3c9a.log', 640 * MB),
        f('container-b81d2e.log', 380 * MB),
        f('container-2ac7f1.json', 24 * MB),
        f('overlay2.meta', 96 * MB),
        f('image-layer.tar', 1.2 * GB),
      ]),
    ]),
    d('.config', [
      f('settings.json', 24 * 1024),
      f('history.sqlite', 3.4 * MB),
      f('trtree.log', 840 * 1024),
    ]),
    d('手机备份', [
      f('iPhone-2025-10-20.tar', 250 * GB),
      f('iPhone-2024-09-30.tar', 180 * GB),
      f('HUAWEI-2025-06-12.tar', 70 * GB),
    ]),
  ]),
  d('@appdata', [
    d('trtree', [f('history.json', 96 * 1024), f('trtree.log', 4 * MB), f('trtree.db', 18 * MB), f('settings.json', 12 * 1024)]),
    d('trim', [f('trim.log', 22 * MB), f('trim.db', 64 * MB), f('gateway.log', 8 * MB), f('appcenter.json', 96 * 1024)]),
    d('docker', [f('daemon.json', 24 * 1024), f('container.meta', 320 * MB), f('image.db', 2.4 * GB), f('volumes.meta', 680 * MB)]),
    d('remote-share', [], { mount: true }),
  ]),
  d('@appshare', [
    d('public', [f('fnos-logo.png', 420 * 1024), f('welcome.jpg', 2.1 * MB), f('manual.pdf', 18 * MB), f('demo.mp4', 220 * MB), f('readme.txt', 12 * 1024)]),
    d('media', [f('family-2024.mp4', 1.8 * GB), f('travel-2023.mov', 940 * MB), f('party.mkv', 1.2 * GB), f('cover.jpg', 3.4 * MB)]),
  ]),
  d('备份', [
    d('2025-10', [
      f('vol1-full-2025-10-01.tar.zst', 160 * GB),
      f('vol1-full-2025-10-15.tar.zst', 140 * GB),
      f('vol1-incr-2025-10-26.tar.zst', 90 * GB),
    ], { mtime: NOW - 2 * DAY }),
    d('2025-09', [
      f('vol1-full-2025-09-01.tar.zst', 130 * GB),
      f('vol1-full-2025-09-15.tar.zst', 110 * GB),
      f('vol1-incr-2025-09-28.tar.zst', 70 * GB),
    ]),
    d('system-backup', [
      f('fnos-system-2025-09-30.img', 160 * GB),
    ]),
    d('远程副本', [], { mount: true }),
  ]),
  d('Docker', [
    d('overlay2', [
      d('7f3c9a2b', [f('diff.tar', 160 * GB), f('link', 0), f('lower', 64 * KB)]),
      d('b81d2e44', [f('layer.tar', 110 * GB), f('metadata.json', 128 * KB)]),
      d('2ac7f10d', [f('layer.tar', 70 * GB), f('metadata.json', 96 * KB)]),
    ]),
    d('volumes', [
      f('metube_downloads.db', 4.6 * GB),
      f('jellyfin_config.db', 880 * MB),
      f('qbittorrent_data.db', 6.2 * GB),
      f('immich_postgres.db', 1.9 * GB),
    ]),
  ]),
  d('视频', [
    d('Movies', [
      f('The.Matrix.1999.2160p.mkv', 5.8 * GB),
      f('Interstellar.2014.1080p.mp4', 4.2 * GB),
      f('Arrival.2016.1080p.mkv', 2.8 * GB),
      f('Blade.Runner.2049.2017.mkv', 6.1 * GB),
    ]),
    d('Clips', Array.from({ length: 5 }, (_, i) => f(`clip_${String(i + 1).padStart(2, '0')}.mov`, randInt(300, 1600) * MB))),
  ]),
  d('Photos', photoSet('PXL_2025', 9, ['jpg', 'heic'], 4, 18)),
  d('下载', [
    f('wiztree-setup.exe', 96 * MB),
    f('Photoshop.2025.dmg', 4.8 * GB),
    f('fnos-1.2.0800-update.pkg', 1.2 * GB),
    f('some-archive.7z', 780 * MB),
    ...zipFiles(4, 40, 600),
    f('dataset-2025.tar.gz', 2.2 * GB),
    f('虚拟机镜像.qcow2', 80 * GB),
    f('win11-24h2.qcow2', 60 * GB),
    f('fnos-full-backup-2025.tar.zst', 90 * GB),
  ]),
  d('Documents', documents(8, ['pdf', 'xlsx', 'docx'], 0.4, 56, '工作')),
  d('Media', [
    d('Movies', [
      f('demo-reel.mkv', 2.2 * GB), f('wedding.mp4', 3.4 * GB), f('travel.mp4', 1.6 * GB),
      ...Array.from({ length: 4 }, (_, i) => f(`concert-2024-0${i + 1}.mkv`, randInt(8000, 18000) * MB)),
    ]),
    d('Concerts', [f('live-2023-berlin.mkv', 30 * GB), f('live-2024-tokyo.mkv', 28 * GB)]),
    d('Music', musicSet(3, ['flac'], 20, 55)),
  ]),
  d('empty-dir', []),
  d('lost+found', []),
  d('.recycle', [f('deleted-photo.jpg', 6.2 * MB), f('old-document.pdf', 1.4 * MB)]),
]);

const ERRORS = [
  { path: '/vol1/lost+found', error: 'permission denied' },
  { path: '/vol1/备份/远程副本', error: 'mount point is not accessible' },
  { path: '/vol1/@appdata/docker/overlay2/7f3c9a2b/diff', error: 'permission denied' },
];

/* ------------------------------------------------------------------ */
/* 构建内存树                                                          */
/* ------------------------------------------------------------------ */

function joinPath(parent, name) {
  if (!parent || parent === '/') return '/' + name;
  return parent.replace(/\/+$/, '') + '/' + name;
}
function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}
function cleanPath(p) {
  if (!p) return '/';
  let out = String(p).trim();
  if (!out.startsWith('/')) out = '/' + out;
  out = out.replace(/\/{2,}/g, '/');
  if (out.length > 1) out = out.replace(/\/+$/, '');
  return out || '/';
}
function parentPath(p) {
  const c = cleanPath(p);
  if (c === '/') return null;
  const i = c.lastIndexOf('/');
  return i <= 0 ? '/' : c.slice(0, i);
}

const nodes = [];

function buildNode(spec, parent, parentPathValue) {
  const id = nodes.length;
  const p = joinPath(parentPathValue, spec.name);
  const node = {
    id,
    name: spec.name,
    path: p,
    parent,
    children: [],
    type: spec.type,
    size: 0,
    alloc: 0,
    count: 0,
    mtime: 0,
    ext: '',
    mount: !!spec.mount,
  };
  nodes.push(node);
  if (parent !== null) nodes[parent].children.push(id);

  if (spec.type === 'file') {
    node.size = Math.max(0, Math.round(spec.size || 0));
    node.alloc = Math.round(node.size * 1.03);
    node.count = 1;
    node.ext = extOf(spec.name);
    node.mtime = spec.mtime || (NOW - randInt(2, 420) * DAY - randInt(0, 23) * HOUR);
    return node;
  }

  let maxMtime = spec.mtime || 0;
  for (const childSpec of spec.children || []) {
    const child = buildNode(childSpec, id, p);
    if (child.mtime > maxMtime) maxMtime = child.mtime;
  }
  node.children.sort((a, b) => nodes[a].name.localeCompare(nodes[b].name, 'zh-CN'));
  node.size = node.children.reduce((s, cid) => s + nodes[cid].size, 0);
  node.alloc = node.children.reduce((s, cid) => s + nodes[cid].alloc, 0);
  node.count = node.children.reduce((s, cid) => s + nodes[cid].count, 1);
  node.childCount = node.children.length;
  node.mtime = maxMtime || (NOW - 120 * DAY);
  node.ext = '';
  return node;
}

buildNode(SPEC, null, '');

const ROOT_ID = 0;

const byPath = new Map();
const byId = new Map();
for (const n of nodes) {
  byPath.set(n.path, n);
  byId.set(n.id, n);
}

function descendantIds(rootId) {
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    out.push(id);
    for (const c of nodes[id].children) stack.push(c);
  }
  return out;
}
function isDescendant(node, rootId) {
  let cur = node;
  while (cur) {
    if (cur.id === rootId) return true;
    cur = cur.parent === null ? null : nodes[cur.parent];
  }
  return false;
}
function ancestorsOf(node, rootId) {
  const out = [];
  let cur = node.parent === null ? null : nodes[node.parent];
  while (cur) {
    out.push(cur);
    if (cur.id === rootId) break;
    cur = cur.parent === null ? null : nodes[cur.parent];
  }
  out.reverse();
  return out;
}
function subtreeStats(rootId) {
  let files = 0;
  let dirs = 0;
  for (const id of descendantIds(rootId)) {
    const n = nodes[id];
    if (n.type === 'dir') dirs++;
    else files++;
  }
  const root = nodes[rootId];
  const errors = ERRORS.filter((e) => e.path === root.path || e.path.startsWith(root.path + '/')).length;
  return { files, dirs, size: root.size, alloc: root.alloc, errors };
}

function nodeDTO(n) {
  return {
    id: n.id,
    name: n.name,
    path: n.path,
    type: n.type,
    size: n.size,
    alloc: n.alloc,
    mtime: n.mtime,
    count: n.count,
    childCount: n.children.length,
    ext: n.ext,
    mount: !!n.mount,
  };
}

function sortIds(ids, sort, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  const arr = ids.slice();
  arr.sort((a, b) => {
    const A = nodes[a];
    const B = nodes[b];
    let r = 0;
    switch (sort) {
      case 'name': r = A.name.localeCompare(B.name, 'zh-CN'); break;
      case 'mtime': r = A.mtime - B.mtime; break;
      case 'alloc': r = A.alloc - B.alloc; break;
      case 'count': r = A.count - B.count; break;
      default: r = A.size - B.size;
    }
    if (r === 0) r = A.name.localeCompare(B.name, 'zh-CN');
    return r * mul;
  });
  return arr;
}

/* ------------------------------------------------------------------ */
/* 扫描任务                                                            */
/* ------------------------------------------------------------------ */

const scans = new Map();

function summaryOf(scan) {
  return {
    id: scan.id,
    path: scan.path,
    status: scan.status,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt || null,
    durationMs: scan.durationMs || 0,
    files: scan.files || 0,
    dirs: scan.dirs || 0,
    size: scan.size || 0,
    alloc: scan.alloc || 0,
    errors: scan.errors || 0,
    error: scan.error || null,
  };
}

function createSeededScan(id, pathValue, status, startedAt, durationMs, error) {
  const root = byPath.get(pathValue);
  if (!root) throw new Error('fixture path not found: ' + pathValue);
  const stats = subtreeStats(root.id);
  const scan = {
    id,
    rootId: root.id,
    path: root.path,
    status,
    startedAt,
    finishedAt: startedAt + durationMs,
    durationMs,
    files: stats.files,
    dirs: stats.dirs,
    size: stats.size,
    alloc: stats.alloc,
    errors: stats.errors,
    error: error || null,
    seeded: true,
  };
  scans.set(id, scan);
  return scan;
}

const SEED_FULL = createSeededScan('s_1750000000000_ab12', '/vol1', 'done', NOW - 42 * 60 * 1000, 12840);
const SEED_PHOTOS = createSeededScan('s_1749980000000_cd34', '/vol1/1000/Photos', 'done', NOW - 6 * HOUR, 860);
const SEED_BACKUP = createSeededScan('s_1749900000000_ef56', '/vol1/备份', 'cancelled', NOW - 3 * DAY, 4210);
const SEED_PHOTOS_OLD = createSeededScan('s_1749960000000_cd35', '/vol1/1000/Photos', 'done', NOW - 2 * DAY, 920);

// 仅在历史里出现、已不在内存中的扫描，用来验证"结果已释放 → 重新分析"交互
const docsNode = byPath.get('/vol1/Documents');
const STALE_HISTORY = {
  id: 's_1700000000000_dead',
  path: '/vol1/Documents',
  status: 'done',
  startedAt: NOW - 9 * DAY,
  finishedAt: NOW - 9 * DAY + 1200,
  durationMs: 1200,
  files: docsNode ? docsNode.count - 1 : 0,
  dirs: 1,
  size: docsNode ? docsNode.size : 0,
  alloc: docsNode ? docsNode.alloc : 0,
  errors: 0,
  error: null,
};

/**
 * 与后端 needAdminView 一致：判断某个目录要用管理员"全部文件"视角还是普通用户视角。
 * 自己的共享目录 volN/<uid>/、普通目录 → 用户视角；
 * 别人的共享目录、团队文件 volN/@team/、系统目录 → 管理员视角。
 */
function needAdminView(dir, uid = 1000) {
  const parts = String(dir || '').replace(/^\/+/, '').split('/');
  if (parts.length < 2 || !/^vol\d+$/.test(parts[0])) return false;
  if (parts[1] === '@team') return true;
  if (/^\d+$/.test(parts[1])) {
    const owner = Number(parts[1]);
    return owner > 0 && uid > 0 && owner !== uid;
  }
  return parts[1].startsWith('@');
}

// 历史记录是可变的，删除接口需要能真正清掉条目
let historyStore = null;

function historyPayload() {
  if (!historyStore) {
    historyStore = [
      summaryOf(SEED_FULL),
      summaryOf(SEED_PHOTOS),
      summaryOf(SEED_PHOTOS_OLD),
      summaryOf(SEED_BACKUP),
      Object.assign({}, STALE_HISTORY),
    ].sort((a, b) => b.startedAt - a.startedAt);
  }
  return historyStore;
}

/** 与后端一致：按路径（忽略末尾斜杠）清除历史记录 */
function deleteHistory(path) {
  const target = String(path || '').trim().replace(/\/+$/, '') || '/';
  const list = historyPayload();
  const before = list.length;
  historyStore = list.filter((h) => (String(h.path || '').trim().replace(/\/+$/, '') || '/') !== target);
  return before - historyStore.length;
}

let activeScanId = null;

function totalDuration(scan) {
  return scan.seeded ? scan.durationMs : 9000;
}

function dirPathList(rootId) {
  const out = [];
  for (const id of descendantIds(rootId)) {
    if (nodes[id].type === 'dir') out.push(nodes[id].path);
  }
  return out.length ? out : [nodes[rootId].path];
}

function finalizeScan(scan) {
  if (scan.status !== 'running') return;
  const stats = subtreeStats(scan.rootId);
  scan.status = 'done';
  scan.finishedAt = scan.startedAt + totalDuration(scan);
  scan.durationMs = totalDuration(scan);
  scan.files = stats.files;
  scan.dirs = stats.dirs;
  scan.size = stats.size;
  scan.alloc = stats.alloc;
  scan.errors = stats.errors;
  if (activeScanId === scan.id) activeScanId = null;
}

function ensureScan(scan) {
  if (!scan || scan.status !== 'running') return scan;
  const elapsed = Date.now() - scan.startedAt;
  if (elapsed >= totalDuration(scan)) finalizeScan(scan);
  return scan;
}

function progressOf(scan) {
  ensureScan(scan);
  if (scan.status !== 'running') {
    return {
      id: scan.id,
      status: scan.status,
      files: scan.files,
      dirs: scan.dirs,
      size: scan.size,
      alloc: scan.alloc,
      currentPath: scan.path,
      elapsedMs: scan.durationMs || (scan.finishedAt ? scan.finishedAt - scan.startedAt : 0),
      errors: scan.errors,
    };
  }
  const elapsed = Date.now() - scan.startedAt;
  const dur = totalDuration(scan);
  const frac = Math.min(0.985, elapsed / dur);
  const stats = subtreeStats(scan.rootId);
  const paths = dirPathList(scan.rootId);
  const currentPath = paths[Math.floor((elapsed / 260) % paths.length)];
  return {
    id: scan.id,
    status: 'running',
    files: stats.files > 0 ? Math.max(1, Math.round(stats.files * frac)) : 0,
    dirs: stats.dirs > 0 ? Math.max(1, Math.round(stats.dirs * frac)) : 0,
    size: Math.floor(stats.size * frac),
    alloc: Math.floor(stats.alloc * frac),
    currentPath,
    elapsedMs: elapsed,
    errors: Math.round(stats.errors * frac),
  };
}

function createScan(requestedPath) {
  if (activeScanId) {
    const active = scans.get(activeScanId);
    ensureScan(active);
    if (active && active.status === 'running') {
      const e = new Error('已有扫描任务正在运行');
      e.status = 409;
      throw e;
    }
    activeScanId = null;
  }
  const root = byPath.get(requestedPath);
  if (!root) {
    const e = new Error('目录不存在或无权访问：' + requestedPath);
    e.status = 400;
    throw e;
  }
  if (root.type !== 'dir') {
    const e = new Error('只能扫描目录：' + requestedPath);
    e.status = 400;
    throw e;
  }
  const id = `s_${Date.now()}_${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}`;
  const stats = subtreeStats(root.id);
  const scan = {
    id,
    rootId: root.id,
    path: root.path,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    durationMs: 0,
    files: 0,
    dirs: 0,
    size: 0,
    alloc: 0,
    errors: 0,
    error: null,
    totals: stats,
  };
  scans.set(id, scan);
  activeScanId = id;
  console.log(`[mock] 开始模拟扫描 ${id} → ${root.path}（9 秒）`);
  return scan;
}

/* ------------------------------------------------------------------ */
/* 查询辅助                                                            */
/* ------------------------------------------------------------------ */

function scanNodes(scan) {
  return descendantIds(scan.rootId).map((id) => nodes[id]);
}

function resolveNode(scan, rawNode) {
  const id = Number(rawNode);
  if (!rawNode || rawNode === '0' || id === 0 || Number.isNaN(id)) return nodes[scan.rootId];
  const n = byId.get(id);
  if (!n) return null;
  if (!isDescendant(n, scan.rootId)) return null;
  return n;
}

function scanSummary(scan) {
  ensureScan(scan);
  const s = summaryOf(scan);
  if (scan.status === 'running') {
    const p = progressOf(scan);
    s.files = p.files;
    s.dirs = p.dirs;
    s.size = p.size;
    s.alloc = p.alloc;
    s.errors = p.errors;
  }
  return s;
}

function allScanSummaries() {
  const list = [];
  for (const scan of scans.values()) {
    if (scan.seeded) list.push(summaryOf(scan));
    else list.push(scanSummary(scan));
  }
  list.sort((a, b) => b.startedAt - a.startedAt);
  return list;
}

function currentActiveScan() {
  if (!activeScanId) return null;
  const scan = scans.get(activeScanId);
  ensureScan(scan);
  if (!scan || scan.status !== 'running') {
    activeScanId = null;
    return null;
  }
  return scan;
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function json(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  }, extraHeaders || {}));
  res.end(body);
}

function fail(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function fmtLocalStamp(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function csvCell(value) {
  const s = String(value == null ? '' : value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ------------------------------------------------------------------ */
/* API 路由                                                            */
/* ------------------------------------------------------------------ */

function volumesPayload() {
  const total = Math.round(3.8 * TB);
  const used = Math.round(2.9 * TB);
  return {
    volumes: [
      {
        id: '/vol1',
        label: '存储空间 1',
        path: '/vol1',
        fs: 'btrfs',
        device: '/dev/mapper/trim-8f3c9a2b',
        total,
        used,
        free: total - used,
        system: false,
        accessible: true,
      },
      {
        id: '/',
        label: '系统盘',
        path: '/',
        fs: 'ext4',
        device: '/dev/nvme0n1p2',
        total: Math.round(120 * GB),
        used: Math.round(76 * GB),
        free: Math.round(44 * GB),
        system: true,
        accessible: true,
      },
    ],
    roots: [
      { label: '存储空间 1', path: '/vol1', kind: 'volume' },
      { label: '用户目录', path: '/vol1/1000', kind: 'home' },
      { label: '系统盘', path: '/', kind: 'system' },
    ],
    history: historyPayload(),
  };
}

function browsePayload(rawPath) {
  const p = cleanPath(rawPath || '/vol1');
  const roots = volumesPayload().roots;
  const parent = parentPath(p);

  if (p === '/') {
    return {
      path: '/',
      parent: null,
      roots,
      dirs: [
        { name: 'vol1', path: '/vol1', mtime: nodes[ROOT_ID].mtime, readable: true },
      ],
      truncated: false,
      error: null,
    };
  }

  const node = byPath.get(p);
  if (!node || node.type !== 'dir') {
    return { path: p, parent, roots, dirs: [], truncated: false, error: '目录不存在：' + p };
  }

  let error = null;
  let readable = true;
  if (p === '/vol1/lost+found' || p.startsWith('/vol1/lost+found/')) {
    error = 'permission denied';
    readable = false;
  } else if (node.mount) {
    error = 'mount point is not accessible';
    readable = false;
  }

  const dirs = node.children
    .map((id) => nodes[id])
    .filter((n) => n.type === 'dir')
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .slice(0, 2000)
    .map((n) => ({ name: n.name, path: n.path, mtime: n.mtime, readable: !n.mount && n.path !== '/vol1/lost+found' }));

  return {
    path: p,
    parent,
    roots,
    dirs: error ? [] : dirs,
    truncated: node.children.length > 2000,
    error,
    readable,
  };
}

/* ------------------------------------------------------------------ */
/* 请求处理                                                            */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, pathname, query) {
  const method = req.method || 'GET';

  /* ---- 基础信息 ---- */
  if (pathname === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, app: 'trtree', version: '1.1.0', time: Date.now() });
  }
  if (pathname === '/api/context' && method === 'GET') {
    return json(res, 200, {
      app: 'trtree',
      version: '1.0.0',
      isAdmin: true,
      user: 'qmf',
      sysVersion: '1.2.0800',
      arch: 'amd64',
      dataDir: '/vol1/@appdata/trtree',
      shareDir: '/vol1/@appshare/trtree',
      gatewayPrefix: '/app/trtree',
      maxScanNodes: 8000000,
    });
  }
  if (pathname === '/api/volumes' && method === 'GET') {
    return json(res, 200, volumesPayload());
  }
  if (pathname === '/api/browse' && method === 'GET') {
    return json(res, 200, browsePayload(query.get('path')));
  }

  /* ---- 历史记录 ---- */
  if (pathname === '/api/history' && method === 'DELETE') {
    const p = query.get('path');
    if (!p) return fail(res, 400, '缺少路径参数 path');
    const removed = deleteHistory(p);
    if (!removed) return fail(res, 404, '历史记录不存在');
    return json(res, 200, { ok: true, removed, path: p });
  }

  /* ---- 扫描集合 ---- */
  if (pathname === '/api/scans') {
    if (method === 'POST') {
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        return fail(res, 400, err.message);
      }
      const requested = cleanPath(body.path || '');
      if (!body.path || !String(body.path).startsWith('/')) {
        return fail(res, 400, 'path 必须是绝对路径');
      }
      try {
        const scan = createScan(requested);
        return json(res, 202, { id: scan.id, status: 'running' });
      } catch (err) {
        return fail(res, err.status || 500, err.message);
      }
    }
    if (method === 'GET') {
      const active = currentActiveScan();
      return json(res, 200, { scans: allScanSummaries(), active: active ? active.id : null });
    }
    return fail(res, 405, 'method not allowed');
  }

  /* ---- 单个扫描 ---- */
  const m = pathname.match(/^\/api\/scans\/([^/]+)(?:\/([^/]+))?$/);
  if (m) {
    const id = m[1];
    const action = m[2] || '';
    const scan = scans.get(id);
    if (!scan) return fail(res, 404, '扫描不存在：' + id);
    ensureScan(scan);

    if (!action) {
      if (method === 'GET') {
        const summary = summaryOf(scan);
        if (scan.status === 'running') {
          const p = progressOf(scan);
          summary.files = p.files;
          summary.dirs = p.dirs;
          summary.size = p.size;
          summary.alloc = p.alloc;
          summary.errors = p.errors;
        }
        return json(res, 200, Object.assign({}, summary, { root: nodeDTO(nodes[scan.rootId]) }));
      }
      if (method === 'DELETE') {
        if (currentActiveScan() && currentActiveScan().id === id) {
          return fail(res, 409, '扫描正在运行，无法删除');
        }
        scans.delete(id);
        return json(res, 200, { ok: true });
      }
      return fail(res, 405, 'method not allowed');
    }

    if (action === 'progress' && method === 'GET') {
      return json(res, 200, progressOf(scan));
    }

    if (action === 'cancel' && method === 'POST') {
      if (scan.status === 'running') {
        const elapsed = Math.max(1, Date.now() - scan.startedAt);
        const dur = totalDuration(scan);
        const frac = Math.min(0.985, elapsed / dur);
        const stats = subtreeStats(scan.rootId);
        scan.status = 'cancelled';
        scan.finishedAt = Date.now();
        scan.durationMs = elapsed;
        scan.files = stats.files > 0 ? Math.max(1, Math.round(stats.files * frac)) : 0;
        scan.dirs = stats.dirs > 0 ? Math.max(1, Math.round(stats.dirs * frac)) : 0;
        scan.size = Math.floor(stats.size * frac);
        scan.alloc = Math.floor(stats.alloc * frac);
        scan.errors = Math.round(stats.errors * frac);
        if (activeScanId === scan.id) activeScanId = null;
        console.log(`[mock] 扫描已取消 ${scan.id}`);
      }
      return json(res, 200, { ok: true });
    }

    if (action === 'tree' && method === 'GET') {
      const node = resolveNode(scan, query.get('node'));
      if (!node) return fail(res, 404, '节点不存在');
      const depth = Math.max(1, Math.min(3, Number(query.get('depth')) || 1));
      const limit = Math.max(1, Math.min(5000, Number(query.get('limit')) || 2000));
      const sort = query.get('sort') || 'size';
      const dir = query.get('dir') === 'asc' ? 'asc' : 'desc';
      const ids = sortIds(node.children, sort, dir);
      const truncated = ids.length > limit;
      const children = ids.slice(0, limit).map((cid) => {
        const dto = nodeDTO(nodes[cid]);
        if (depth > 1) {
          dto.children = sortIds(nodes[cid].children, sort, dir).slice(0, limit).map((gid) => nodeDTO(nodes[gid]));
        }
        return dto;
      });
      return json(res, 200, {
        node: nodeDTO(node),
        children,
        total: node.children.length,
        truncated,
        ancestors: ancestorsOf(node, scan.rootId).map(nodeDTO),
      });
    }

    if (action === 'children' && method === 'GET') {
      const node = resolveNode(scan, query.get('node'));
      if (!node) return fail(res, 404, '节点不存在');
      const offset = Math.max(0, Number(query.get('offset')) || 0);
      const limit = Math.max(1, Math.min(1000, Number(query.get('limit')) || 100));
      const sort = query.get('sort') || 'size';
      const dir = query.get('dir') === 'asc' ? 'asc' : 'desc';
      const q = (query.get('q') || '').trim().toLowerCase();
      const kind = query.get('kind') || 'all';
      let ids = node.children.slice();
      if (kind === 'file' || kind === 'dir') {
        ids = ids.filter((id) => {
          const t = nodes[id].type;
          return kind === 'dir' ? t === 'dir' : t !== 'dir';
        });
      }
      if (q) ids = ids.filter((id) => nodes[id].name.toLowerCase().includes(q));
      ids = sortIds(ids, sort, dir);
      const total = ids.length;
      const items = ids.slice(offset, offset + limit).map((id) => nodeDTO(nodes[id]));
      return json(res, 200, { node: nodeDTO(node), total, offset, limit, items });
    }

    if (action === 'search' && method === 'GET') {
      const q = (query.get('q') || '').trim().toLowerCase();
      if (!q) return fail(res, 400, 'q 不能为空');
      const kind = query.get('kind') || 'all';
      const minSize = Math.max(0, Number(query.get('minSize')) || 0);
      const limit = Math.max(1, Math.min(1000, Number(query.get('limit')) || 200));
      const all = scanNodes(scan).filter((n) => n.id !== scan.rootId);
      const matches = [];
      for (const n of all) {
        if (!n.name.toLowerCase().includes(q)) continue;
        if (kind === 'file' && n.type === 'dir') continue;
        if (kind === 'dir' && n.type !== 'dir') continue;
        if (minSize > 0 && n.size < minSize) continue;
        matches.push(n);
      }
      const total = matches.length;
      matches.sort((a, b) => b.size - a.size);
      const items = matches.slice(0, limit).map(nodeDTO);
      return json(res, 200, {
        total: Math.min(total, 20000),
        truncated: total > 20000 || total > limit,
        items,
      });
    }

    if (action === 'top' && method === 'GET') {
      const limit = Math.max(1, Math.min(1000, Number(query.get('limit')) || 100));
      const files = scanNodes(scan).filter((n) => n.type !== 'dir');
      files.sort((a, b) => b.size - a.size);
      return json(res, 200, { items: files.slice(0, limit).map(nodeDTO) });
    }

    if (action === 'extensions' && method === 'GET') {
      const map = new Map();
      let fileTotal = 0;
      for (const n of scanNodes(scan)) {
        if (n.type === 'dir') continue;
        const key = n.ext || '';
        const item = map.get(key) || { ext: key, size: 0, alloc: 0, count: 0 };
        item.size += n.size;
        item.alloc += n.alloc;
        item.count += 1;
        fileTotal += n.size;
        map.set(key, item);
      }
      const items = [...map.values()].sort((a, b) => b.size - a.size).slice(0, 50);
      for (const item of items) item.pct = fileTotal > 0 ? item.size / fileTotal : 0;
      return json(res, 200, { items });
    }

    if (action === 'errors' && method === 'GET') {
      const offset = Math.max(0, Number(query.get('offset')) || 0);
      const limit = Math.max(1, Math.min(1000, Number(query.get('limit')) || 100));
      const root = nodes[scan.rootId];
      const items = ERRORS.filter((e) => e.path === root.path || e.path.startsWith(root.path + '/'));
      return json(res, 200, {
        total: items.length,
        items: items.slice(offset, offset + limit),
      });
    }

    if (action === 'locate' && method === 'GET') {
      const node = resolveNode(scan, query.get('node'));
      if (!node) return fail(res, 404, '节点不存在');
      return json(res, 200, { node: nodeDTO(node), ancestors: ancestorsOf(node, scan.rootId).map(nodeDTO) });
    }

    if (action === 'open' && method === 'GET') {
      const node = resolveNode(scan, query.get('node'));
      if (!node) return fail(res, 404, '节点不存在');
      const dir = node.type === 'dir' ? node.path : node.path.replace(/\/[^/]*$/, '') || '/';
      const openable = /^\/vol\d+\//.test(dir);
      const admin = needAdminView(dir, 1000);
      return json(res, 200, {
        path: node.path,
        type: node.type,
        dir,
        openable,
        app: 'files',
        view: admin ? 'admin' : 'user',
        admin,
        uid: 1000,
      });
    }

    if (action === 'nodes' && method === 'DELETE') {
      // 模拟删除：返回成功后让该扫描失效，前端应回到概览页
      const node = resolveNode(scan, query.get('node'));
      if (!node) return fail(res, 404, '节点不存在');
      // 删除后该扫描失效：从内存结果中移除，历史里保留一条"某路径已删除"的记录
      scans.delete(scan.id);
      STALE_HISTORY.id = scan.id;
      STALE_HISTORY.path = scan.path;
      STALE_HISTORY.startedAt = scan.startedAt;
      STALE_HISTORY.size = 0;
      STALE_HISTORY.alloc = 0;
      return json(res, 200, { ok: true, id: node.id, path: node.path, type: node.type, rescanNeeded: true });
    }

    if (action === 'export' && method === 'GET') {
      const format = (query.get('format') || 'csv').toLowerCase();
      const kind = query.get('kind') || 'all';
      const sort = query.get('sort') || 'size';
      if (format !== 'csv') return fail(res, 400, '仅支持 csv 格式');
      let list = scanNodes(scan);
      if (kind === 'files') list = list.filter((n) => n.type !== 'dir');
      else if (kind === 'dirs') list = list.filter((n) => n.type === 'dir');
      if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      else list.sort((a, b) => b.size - a.size);
      const base = (nodes[scan.rootId].path.replace(/^\/+/, '') || 'root').replace(/[^\w.-]+/g, '_');
      const filename = `trtree-${base}-${fmtLocalStamp(Date.now())}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      });
      res.write('path,type,size,alloc,mtime,count\n');
      for (const n of list) {
        res.write([
          csvCell(n.path),
          csvCell(n.type),
          n.size,
          n.alloc,
          csvCell(new Date(n.mtime).toISOString()),
          n.count,
        ].join(',') + '\n');
      }
      return res.end();
    }

    if (action === 'export.json' && method === 'GET') {
      const root = nodes[scan.rootId];
      const children = sortIds(root.children, 'size', 'desc').slice(0, 5000).map(nodeDTO);
      const files = scanNodes(scan).filter((n) => n.type !== 'dir').sort((a, b) => b.size - a.size);
      return json(res, 200, {
        root: nodeDTO(root),
        summary: summaryOf(scan),
        children,
        extensions: (() => {
          const map = new Map();
          for (const n of scanNodes(scan)) {
            if (n.type === 'dir') continue;
            const key = n.ext || '';
            const item = map.get(key) || { ext: key, size: 0, alloc: 0, count: 0 };
            item.size += n.size;
            item.alloc += n.alloc;
            item.count += 1;
            map.set(key, item);
          }
          return [...map.values()].sort((a, b) => b.size - a.size).slice(0, 50);
        })(),
        topFiles: files.slice(0, 100).map(nodeDTO),
      });
    }

    return fail(res, 404, '未知接口：' + action);
  }

  return fail(res, 404, '未知 API：' + pathname);
}

/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let rel = pathname;
  if (rel === '/' || rel === '') rel = '/index.html';
  let filePath = path.resolve(WEB_ROOT, '.' + rel);
  if (!filePath.startsWith(WEB_ROOT + path.sep) && filePath !== path.join(WEB_ROOT, 'index.html')) {
    return fail(res, 403, 'forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (!err && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      return sendFile(req, res, filePath);
    }
    if (err || !stat.isFile()) {
      // SPA 回退：无扩展名路径返回 index.html
      if (!path.extname(rel)) return sendFile(req, res, path.join(WEB_ROOT, 'index.html'));
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + pathname);
    }
    return sendFile(req, res, filePath);
  });
}

function sendFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch (_) {
    pathname = url.pathname;
  }
  if (pathname.startsWith('/app/trtree')) {
    pathname = pathname.slice('/app/trtree'.length) || '/';
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    try {
      return await handleApi(req, res, pathname, url.searchParams);
    } catch (err) {
      console.error('[mock] API error:', err);
      if (!res.headersSent) return fail(res, 500, 'mock server error: ' + err.message);
      return res.end();
    }
  }

  return serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  const photos = byPath.get('/vol1/1000/Photos');
  console.log('┌──────────────────────────────────────────────────────────────┐');
  console.log('│  TrTree mock server                                          │');
  console.log('└──────────────────────────────────────────────────────────────┘');
  console.log(`  页面        http://${HOST}:${PORT}/`);
  console.log(`  全盘结果    http://${HOST}:${PORT}/?scan=${SEED_FULL.id}`);
  console.log(`  相册结果    http://${HOST}:${PORT}/?scan=${SEED_PHOTOS.id}`);
  console.log(`  备份结果    http://${HOST}:${PORT}/?scan=${SEED_BACKUP.id}`);
  if (photos) console.log(`  钻取示例    http://${HOST}:${PORT}/?scan=${SEED_FULL.id}&node=${photos.id}`);
  console.log(`  扫描预览    http://${HOST}:${PORT}/?view=scanning`);
  console.log(`  目录弹窗    http://${HOST}:${PORT}/?scan=${SEED_FULL.id}&picker=1`);
  console.log(`  节点总数    ${nodes.length}（扫描根 ${nodes[ROOT_ID].path}，${(nodes[ROOT_ID].size / TB).toFixed(2)} TiB）`);
  console.log('');
});
