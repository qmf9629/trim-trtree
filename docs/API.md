# TrTree HTTP API 契约（v1）

后端：Go 1.27，单二进制，默认监听 Unix Socket `${TRIM_APPDEST}/app.sock`（fnOS 统一网关 `/app/trtree`）。
本地开发：`PORT=18080 ./trtree`，接口路径不变。

- 所有响应 `Content-Type: application/json; charset=utf-8`（导出接口除外）。
- 错误响应：HTTP 4xx/5xx，body `{"error":"人类可读信息"}`。
- 金额/大小单位：字节（number，int64 范围）。
- 时间：Unix 毫秒（number）。
- 所有 `/api/*` 在正式环境要求网关注入 `X-Trim-Isadmin: true`；非管理员返回 403。
  本地开发（无该 Header）视为管理员。
- 路径统一使用绝对路径，服务端会 `filepath.Clean`。

## 1. GET /api/health

```json
{"ok":true,"app":"trtree","version":"1.0.2","time":1750000000000}
```

## 2. GET /api/context

页面初始化时调用一次。

```json
{
  "app": "trtree",
  "version": "1.0.2",
  "isAdmin": true,
  "user": "qmf",
  "sysVersion": "1.2.0800",
  "arch": "amd64",
  "dataDir": "/vol1/@appdata/trtree",
  "shareDir": "/vol1/@appshare/trtree",
  "gatewayPrefix": "/app/trtree",
  "maxScanNodes": 8000000
}
```

## 3. GET /api/volumes

返回可分析的存储空间、快捷根目录，以及最近扫描历史（最多 10 条）。

```json
{
  "volumes": [
    {
      "id": "/vol1",
      "label": "存储空间 1",
      "path": "/vol1",
      "fs": "btrfs",
      "device": "/dev/mapper/trim-...",
      "total": 4100000000000,
      "used": 3100000000000,
      "free": 1000000000000,
      "system": false,
      "accessible": true
    }
  ],
  "roots": [
    {"label": "存储空间 1", "path": "/vol1", "kind": "volume"},
    {"label": "系统盘", "path": "/", "kind": "system"},
    {"label": "用户目录", "path": "/vol1/1000", "kind": "home"}
  ],
  "history": [
    {
      "id": "s_1750000000000_ab12",
      "path": "/vol1",
      "status": "done",
      "startedAt": 1750000000000,
      "finishedAt": 1750000012345,
      "durationMs": 12345,
      "files": 123456,
      "dirs": 7890,
      "size": 123456789,
      "alloc": 123456789,
      "errors": 0,
      "error": null
    }
  ]
}
```

规则：
- `volumes` 仅包含真实块设备/网络文件系统（ext4、btrfs、xfs、f2fs、vfat、exfat、ntfs3、fuseblk、cifs、nfs、nfs4、zfs、trimafs），排除 proc/sys/dev/tmpfs/overlay 等。
- `system=true` 表示挂载点为 `/` 或系统分区。
- `accessible` 为服务端能否 `stat` 该路径。
- 扫描历史来自 `${TRIM_PKGVAR}/history.json`，最新在前；扫描完成后写入。

## 4. GET /api/browse?path=/vol1

用于「选择目录」弹窗，只列目录，不递归。

```json
{
  "path": "/vol1",
  "parent": "/",
  "roots": [{"label": "存储空间 1", "path": "/vol1", "kind": "volume"}],
  "dirs": [
    {"name": "1000", "path": "/vol1/1000", "mtime": 1750000000000, "readable": true}
  ],
  "truncated": false,
  "error": null
}
```

- 无权限时返回 200，`dirs: []`，`error: "permission denied"`（前端可直接展示）。
- 条目按名称排序，最多 2000 条，超出 `truncated: true`。

## 5. 扫描任务

### POST /api/scans

```json
{"path": "/vol1", "oneFilesystem": true}
```

- `path`：必填，绝对路径。
- `oneFilesystem`：默认 `true`，不跨 `st_dev` 边界（挂载点记录为 0 字节目录）。
- 返回 `202 {"id":"s_...","status":"running"}`。
- 已有扫描在跑时返回 `409 {"error":"已有扫描任务正在运行"}`。
- 同一时刻只允许一个扫描任务。

### GET /api/scans

```json
{"scans": [Summary...], "active": "s_..." | null}
```

Summary 字段见第 3 节 `history` 条目。

### GET /api/scans/{id}

返回 Summary 外加根节点：

```json
{
  "id": "s_...",
  "path": "/vol1",
  "status": "done",
  "startedAt": 0,
  "finishedAt": 0,
  "durationMs": 0,
  "files": 0,
  "dirs": 0,
  "size": 0,
  "alloc": 0,
  "errors": 0,
  "error": null,
  "root": { NodeDTO }
}
```

`status`: `running` | `done` | `cancelled` | `error`。

### GET /api/scans/{id}/progress

```json
{
  "id": "s_...",
  "status": "running",
  "files": 1000,
  "dirs": 100,
  "size": 123,
  "alloc": 456,
  "currentPath": "/vol1/1000/Photos/2024",
  "elapsedMs": 1234,
  "errors": 0
}
```

前端在 `status=running` 时每 400ms 轮询该接口。

### POST /api/scans/{id}/cancel

`{"ok":true}`。取消后继续聚合已扫描部分，`status=cancelled`，结果仍可查看。

### DELETE /api/scans/{id}

释放该扫描占用的内存（不再出现在 `GET /api/scans`），`{"ok":true}`。
不影响已在 `history.json` 中的历史摘要，要清除历史请用下面的接口。

### DELETE /api/history?path=/vol1/1000

清除某个路径下的全部历史扫描记录（同一目录多次扫描会一起删除）。
只清理持久化的历史列表，不删除磁盘上的文件，也不释放内存中仍可查看的结果。

```json
{"ok": true, "removed": 2, "path": "/vol1/1000"}
```

- `path` 必填，末尾斜杠会被忽略（`/vol1/1000/` 等价于 `/vol1/1000`）
- 缺少 `path` → `400`；没有匹配到记录 → `404`
- 删除后立即写回 `history.json`，重启应用不会复活

## 6. NodeDTO

所有树/列表/搜索接口统一节点结构：

```json
{
  "id": 12,
  "name": "Photos",
  "path": "/vol1/1000/Photos",
  "type": "dir",
  "size": 123456789,
  "alloc": 120000000,
  "mtime": 1750000000000,
  "count": 4321,
  "childCount": 12,
  "ext": "",
  "mount": false
}
```

- `type`: `dir` | `file` | `link` | `other`。
- `size`：逻辑大小（目录为子树内文件逻辑大小之和）。
- `alloc`：占用磁盘空间（`st_blocks * 512` 之和）。
- `count`：递归条目数（文件为 1）。
- `childCount`：直接子项数。
- `ext`：文件扩展名小写（不含点），无扩展名为 `""`；目录恒为 `""`。
- `path`：扫描根为根节点 `path`（即扫描路径），其余为绝对路径。
- `mount`：该目录是跨文件系统挂载点且未扫描其内容。

## 7. GET /api/scans/{id}/tree

参数：`node`（默认 0）、`depth`（默认 1，最大 3）、`limit`（默认 2000，最大 5000）、`sort`（`size` 默认 / `name` / `mtime` / `alloc` / `count`）、`dir`（`desc` 默认 / `asc`）。

```json
{
  "node": { "id": 0, "name": "vol1", "path": "/vol1", "type": "dir", "size": 0, "alloc": 0, "mtime": 0, "count": 0, "childCount": 0, "ext": "", "mount": false },
  "children": [NodeDTO...],
  "total": 42,
  "truncated": false,
  "ancestors": [NodeDTO...]
}
```

- `children` 是该节点直接子项的排序后前 `limit` 个。
- `ancestors` 从根到父节点（不含 `node`），用于面包屑。
- `depth>1` 时子项自身也带 `children` 字段（同样结构），最多展开到 depth 层；`truncated` 表示某层是否截断。

## 7.1 GET /api/scans/{id}/treemap

WizTree 式嵌套 Treemap 数据：从 `node` 开始按「大目录优先」逐层展开，直到节点预算用完。
前端据此在目录块内部绘制子块。

| 参数 | 说明 |
| --- | --- |
| `node` | 起始节点，默认 0 |
| `budget` | 最多返回的节点数，默认 16000，最大 60000 |
| `area` | 画布面积（CSS px²），用于推算可见阈值；默认 1,500,000 |

```json
{
  "node": { NodeDTO },
  "children": [
    {
      "id": 3, "name": "Photos", "type": "dir", "size": 123, "alloc": 120, "mtime": 0,
      "count": 42, "childCount": 12, "parentId": 0, "hidden": 4,
      "children": [ { "id": 9, "name": "a.jpg", "type": "file", "ext": "jpg", "size": 10, "...": "..." } ]
    }
  ],
  "hidden": 0,
  "nodes": 10233,
  "budgetHit": false,
  "minSize": 12
}
```

- 节点结构为精简版 NodeDTO：不含 `path`（前端用父路径 + `name` 拼接），`ext`/`mount`/`hidden` 为空时省略。
- 小于 `size(node) × 3 / area` 字节（约 3 px²）的子项不返回，计入父节点 `hidden`；它们的大小仍包含在父节点 `size` 中，前端绘制为「其他 N 个小项」。
- 小于约 120 px² 的目录、挂载点、超过 48 层的目录不再展开；单个目录最多展开 4000 个子项。
- `budgetHit=true` 表示预算用尽，部分大目录未展开（仍会显示为单个目录块）。
- 客户端声明 `Accept-Encoding: gzip` 且响应超过 16 KB 时以 gzip 返回（通常可压缩约 7 倍）。

## 8. GET /api/scans/{id}/children

分页的「文件列表」。参数：`node=0`、`offset=0`、`limit=100`（最大 1000）、`sort`、`dir`、`q`（名称包含，忽略大小写）、`kind`（`all` / `file` / `dir`）。

```json
{"node": NodeDTO, "total": 1234, "offset": 0, "limit": 100, "items": [NodeDTO...]}
```

`total` 为过滤后的总数；`items` 不含 `children`。

## 9. GET /api/scans/{id}/search

参数：`q`（必填，≥1 字符，名称包含，忽略大小写）、`kind`（`all`/`file`/`dir`）、`minSize`（字节，默认 0）、`limit`（默认 200，最大 1000）。

```json
{"total": 87, "truncated": false, "items": [NodeDTO...]}
```

- 匹配总数最多统计到 20000 条（`truncated=true` 表示还有更多）。
- `items` 按 `size` 降序。
- 路径在服务端补全。

## 10. GET /api/scans/{id}/top

参数 `limit`（默认 100，最大 1000）。最大的文件（不含目录），`size` 降序。

```json
{"items": [NodeDTO...]}
```

## 11. GET /api/scans/{id}/extensions

```json
{
  "items": [
    {"ext": "mp4", "size": 123, "alloc": 456, "count": 7, "pct": 0.42}
  ]
}
```

- 按 `size` 降序，最多 50 项；`pct` 为该扩展名逻辑大小占全部文件逻辑大小的比例（0~1）。
- 无扩展名使用 `""`（前端显示「无扩展名」）。

## 12. GET /api/scans/{id}/errors

参数 `offset`、`limit`（默认 100，最大 1000）。

```json
{"total": 3, "items": [{"path": "/vol1/secret", "error": "permission denied"}]}
```

## 13. GET /api/scans/{id}/locate?node=123

```json
{"node": NodeDTO, "ancestors": [NodeDTO...]}
```

用于从搜索结果/大文件列表跳转到树中位置。若节点不存在返回 404。

## 14. GET /api/scans/{id}/open

返回条目所在目录的 fnOS 文件管理器深链。

| 参数 | 说明 |
| --- | --- |
| `node` | 节点 id（文件或目录） |

```json
{
  "path": "/vol1/1000/Photos/a.jpg",
  "type": "file",
  "dir": "/vol1/1000/Photos",
  "openable": true,
  "app": "files",
  "view": "user",
  "admin": false,
  "uid": 1000
}
```

`view` / `admin` 决定桌面壳用哪种界面打开：

| 目标目录 | view | 说明 |
| --- | --- | --- |
| `/volN/<自己的uid>/…` | `user` | 普通"我的文件"视角，与用户平时看到的一致 |
| 普通目录、非 `/volN` 路径 | `user` | 用户视角 |
| `/volN/<其他uid>/…` | `admin` | 别人的共享目录，普通用户不可见 |
| `/volN/@team/…` | `admin` | 团队文件 |
| `/volN/@appshare`、`/volN/@appdata` 等 | `admin` | 系统 / 应用目录 |

判定规则与 fnOS 桌面壳自身的路由一致（壳的 `uQ` 助手）：
只有当路径不属于普通用户可见范围时才升级为管理员"全部文件"视角，
避免让用户在管理员界面里误操作。

**唤不起文件管理器的常见错误**：fnOS 文件管理器无法通过普通 URL 深链打开
（`/#/app/files?path=…` 这类写法在新标签页里无效）。正确做法是在微应用 iframe 内
调用桌面壳（Trim App）的桥接方法：

```js
// 由 src/web/js/host.js 封装，与 fnOS 官方 web-app.js(TrimApp) 协议一致
const host = await connectParent();              // Penpal 握手 SYN → SYN-ACK → ACK
await host.methods.openFileManager(dir, { isAdmin: res.admin });   // 按上面表格取值
```

`isAdmin=false` 走 FileManager（my-files/other-files），`isAdmin=true` 才走 AllFileManager（all-files）。
壳收到后会自行切到文件管理器，并把去掉前导 `/` 的 `path` 作为目录参数带入。
后端因此只返回应当打开的绝对目录 `dir`，不再返回任何 URL。

`openable=false` 表示该路径不在 `/volN/<共享目录>` 下（如系统目录），前端会退化为复制目录路径。

## 15. DELETE /api/scans/{id}/nodes

永久删除磁盘上的条目（文件或整个目录），路径取自扫描树，客户端无法指定任意路径。

| 参数 | 说明 |
| --- | --- |
| `node` | 节点 id；不能为扫描根目录或存储空间根目录 |

成功返回：

```json
{"ok": true, "id": 42, "path": "/vol1/1000/Photos/a.jpg", "type": "file", "size": 1024, "alloc": 4096, "rescanNeeded": true}
```

失败：`403`（根目录 / 系统保留目录 / 无权限）、`404`（条目已不存在）、`409`（扫描未完成）。
删除成功后该扫描结果立即失效（后续 `/api/scans/{id}` 返回 404），前端需重新分析。

## 16. GET /api/scans/{id}/export

参数：`format`（`csv`，默认）、`kind`（`all` 默认 / `files` / `dirs`）、`sort`（`size` 默认 / `name`）。

响应：`text/csv; charset=utf-8`，`Content-Disposition: attachment; filename="trtree-vol1-20251028-0123.csv"`。
CSV 表头：`path,type,size,alloc,mtime,count`，逐行流式输出；`mtime` 为 ISO 8601 本地时间。

## 17. GET /api/scans/{id}/export.json

返回完整汇总 JSON（供脚本/二次分析），结构：

```json
{
  "root": NodeDTO,
  "summary": Summary,
  "children": [NodeDTO...],
  "extensions": [{"ext":"","size":0,"alloc":0,"count":0}],
  "topFiles": [NodeDTO...]
}
```

`children` 最多 5000 条（按 size 降序）。

## 18. 静态资源

- `/app/trtree` → 302 到 `/app/trtree/`
- `/app/trtree/` → `index.html`
- `/app/trtree/<asset>` → `web/` 内静态文件
- 本地开发根路径 `/` 同样映射到 `web/`
- 不存在的资源返回 `index.html`（SPA 回退），仅对无扩展名路径。

## 19. 静态文件清单（前端产物）

```
web/
├── index.html
├── css/app.css
└── js/
    ├── api.js
    ├── app.js
    ├── treemap.js
    ├── format.js
    └── table.js
```

无构建步骤、无外部 CDN、无第三方库；ES modules。
