# TrTree 架构与实现说明

## 1. 目标

在 fnOS（飞牛 NAS）上提供一个类似 Windows WizTree 的原生磁盘空间分析应用：

- 秒级扫描指定目录/存储空间，展示每个目录、文件的大小与磁盘占用；
- 以 Treemap 树状图 + 可排序表格为核心，支持逐层钻取；
- 搜索、大文件排行、扩展名统计、CSV/JSON 导出；
- 纯只读，不删除、不修改任何被扫描文件；
- 通过 fnOS 统一网关访问，复用系统登录态，不额外暴露端口。

## 2. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 后端 | Go 1.27（CGO_ENABLED=0 静态二进制） | 扫描千万级文件性能/内存远优于脚本运行时；单文件部署；无运行时依赖，避免 `install_dep_apps` 兼容性问题 |
| 前端 | 原生 HTML/CSS/JS（ES modules） | 无构建、无依赖、体积小、离线可用；Canvas 高性能 Treemap |
| 打包 | fnpack 1.2.3 → `.fpk` | fnOS 官方应用包格式 |
| 访问 | Unix Socket + 统一网关 `/app/trtree` | 接入 fnOS 登录态、无端口冲突、支持 WebSocket |
| 权限 | `run-as: root` | 磁盘分析必须遍历全盘；只读、仅元数据；接口仅管理员可用（`X-Trim-Isadmin`） |

## 3. 目录结构

```
TrTree-fn/
├── main.go                  # 入口：环境、监听、优雅退出
├── internal/
│   ├── scan/                # 扫描引擎（紧凑树、并发遍历、聚合）
│   ├── api/                 # HTTP 路由、任务管理、DTO、导出
│   ├── sysinfo/             # 挂载点/容量/系统信息
│   └── version/             # 版本号
├── web/                     # 内嵌前端（go:embed）
├── packaging/               # fnpack 打包目录（manifest/config/cmd/app）
├── scripts/                 # build/pack/dev/test/图标
├── tests/                   # Go 测试、E2E 脚本
├── docs/                    # API、前端规范、架构、打包说明
├── .tools/                  # 本地工具链（go、fnpack、playwright，git 忽略）
└── dist/                    # 构建产物（二进制、fpk）
```

## 4. 扫描引擎

### 4.1 数据结构（紧凑数组）

```go
type Tree struct {
    Names       []string // 节点名
    Parent      []int32
    Size        []int64  // 逻辑大小
    Alloc       []int64  // 磁盘占用 st_blocks*512
    Mtime       []int64  // unix ms
    Type        []uint8  // 0 file, 1 dir, 2 link, 3 other
    FirstChild  []int32
    NextSibling []int32
    LastChild   []int32
    Count       []uint32 // 递归条目数
    Root        int32
}
```

- 索引即节点 ID；父节点索引恒小于子节点，因此**逆序聚合**可在 O(n) 完成：
  `size[parent] += size[i]; alloc[parent] += alloc[i]; count[parent] += count[i]`。
- 子节点用 firstChild/nextSibling 链表，不需要每目录分配 slice。
- 1M 节点内存约 80–120MB（名字字符串占主要部分）。

### 4.2 遍历

- 广度优先、目录级并发：`worker = min(32, NumCPU*4)`；`os.File.ReadDir(-1)` 避免排序开销；`DirEntry.Info()` 一次 lstat 获取类型/大小/时间。
- 每处理完一个目录，在互斥锁内批量追加子节点（每次锁粒度=一个目录，避免逐文件加锁）。
- 符号链接不跟随（记录 link 本身，size=0），防止环形遍历。
- 默认 `oneFilesystem=true`：子目录 `st_dev` 与根不同则标记 `mount=true`，不递归。
- 跳过虚拟文件系统根：`/proc`、`/sys`、`/dev`、`/run` 等（若扫描 `/`）。
- 权限错误不中断，记录到 errors（最多 1000 条），计数继续。
- 取消：`context` 在每个目录开始时检查；取消后照常聚合已扫部分。

### 4.3 进度

原子计数器（files/dirs/size/alloc/errors）+ `atomic.Value` 当前路径；API 每 400ms 读取。扫描完成后再做一次 O(n) 后处理：Top 1000 大文件、扩展名统计（避免扫描时全局锁）。

### 4.4 查询与缓存

- 子节点排序：按需遍历兄弟链表 → 排序 → 缓存 `map[int32][]int32`（互斥保护），避免重复排序。
- 路径重建：沿 parent 上溯，按需生成（搜索/定位/导出时）。
- 搜索：O(n) 名称包含（`strings.Contains` + 预小写？直接 `strings.EqualFold` 较慢；用 `strings.ToLower` 逐项，1M 约 50–100ms）。
- 单扫描任务上限 800 万节点（可配置），防止 OOM；达到上限后停止深入并标记 truncated。

## 5. HTTP 服务

- 监听：优先 `TRTREE_SOCKET`（cmd/main 传入 `${TRIM_APPDEST}/app.sock`），否则 `TRTREE_PORT`（开发）。
- 路由：标准库 `http.ServeMux`，前缀同时兼容 `/app/trtree` 与 `/`（本地）。
- 网关身份：读取 `X-Trim-Userid/Username/Isadmin`；`Isadmin != true` 时 `/api/*`（除 health）返回 403。
- 静态资源：`embed.FS`，ETag/Last-Modified、gzip（可选）、SPA 回退。
- 任务管理：内存中最多保留 5 个扫描结果；同一时刻仅 1 个运行任务；历史摘要写入 `${TRIM_PKGVAR}/history.json`。
- 导出：`bufio.Writer` 流式 CSV，避免大字符串。
- 安全：不提供文件内容读取、删除、执行；静态文件只从 embed FS 取；路径参数只用于扫描/浏览（受 OS 权限与 root 只读约束）。

## 6. fnOS 集成

- `manifest`：`micro_app=true` 启用统一网关；`checkport=false`；`os_min_version=1.2.0401`。
- `app/ui/config`：`type=iframe`、`gatewayPrefix=/app/trtree`、`gatewaySocket=app.sock`、`allUsers=false`（仅管理员可见）、`url=/app/trtree`。
- `cmd/main`：start/stop/status/restart，兼容 `TRIM_APPDEST` 两种布局，按 `uname -m` 选择 amd64/arm64 二进制，健康检查 `curl --unix-socket ... /api/health`。
- `config/privilege`：`run-as: root`（只读分析）；`config/resource`：声明 `trtree` 共享目录用于导出。
- 图标：256 画布圆角 48px（18.75%），深色底 + Treemap 彩色方块。

## 7. 构建/发布

```bash
scripts/build.sh   # 编译 amd64+arm64 → dist/，同步 web 到 packaging
scripts/pack.sh    # 生成 dist/trtree-1.0.2.fpk
scripts/install-remote.sh  # scp 到 NAS 并用 appcenter-cli 安装（需 sudo）
```

要求：`CGO_ENABLED=0`、`-trimpath`、`-ldflags="-s -w"`；产物约 6–8MB/架构。

## 8. 测试

- Go 单测：squarify 无关；扫描树构建/聚合/取消/权限错误/大文件；API 契约测试（httptest）。
- 前端：无浏览器环境下用 Playwright（项目内 Chromium）做截图与关键交互冒烟。
- 真机：在 fnOS 1.2.0800（N100/3.6GB）上安装 fpk，验证启动、网关访问、全盘扫描性能与内存。

## 9. 已知取舍

- 不读取 NTFS MFT（WizTree 的“秒扫”依赖 NTFS 主文件表；Linux/btrfs 无对应结构），因此速度取决于目录遍历 + stat，但通过并发可达到“可用”级别。
- 硬链接按目录项重复计算（与大多数 Linux 工具一致）；稀疏文件同时展示逻辑大小与磁盘占用。
- 扫描结果仅内存保存，应用重启后需重扫；历史摘要保留。
