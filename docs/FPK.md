# fnOS 打包与安装说明

## 1. 目录

```
packaging/
├── manifest
├── ICON.PNG                 # 64×64
├── ICON_256.PNG             # 256×256
├── app/
│   ├── server/
│   │   ├── trtree-linux-amd64
│   │   └── trtree-linux-arm64
│   └── ui/
│       ├── config
│       └── images/{icon_64,icon_128,icon_256}.png
├── cmd/                     # 9 个生命周期脚本，全部必需
├── config/{privilege,resource}
└── wizard/                  # 空目录即可
```

## 2. manifest

```ini
appname                    = trtree
version                    = 1.0.2
display_name               = TrTree 磁盘分析
desc                       = ...
platform                   = all
source                     = thirdparty
maintainer                 = qmf9629
maintainer_url             = https://github.com/qmf9629
distributor                = qmf9629
distributor_url            = https://github.com/qmf9629/trim-trtree
desktop_uidir              = ui
desktop_applaunchname      = trtree.Application
micro_app                  = true
os_min_version             = 1.2.0401
checkport                  = false
ctl_stop                   = true
disable_authorization_path = true
```

要点：

- `micro_app=true`：注册统一网关（`/app/{appname}`），fnOS 1.2.x 必需。
- `platform=all`：包内同时包含 amd64/arm64 二进制，`cmd/main` 运行时按 `uname -m` 选择。
- 不声明 `service_port`、`install_dep_apps`（Go 单二进制无运行时依赖，规避验证器兼容问题）。
- `os_min_version=1.2.0401`：与现有网关类第三方应用一致；实际测试设备为 1.2.0800。

## 3. config/privilege

```json
{
    "defaults":
    {
        "run-as": "root"
    }
}
```

原因：磁盘分析需要遍历所有用户/共享目录；`/vol1` 权限为 000，`/vol1/1000` 仅 owner + ACL，包用户无法枚举。应用只读、不提供文件内容/删除/执行接口，API 仅管理员可用。若希望以包用户运行，将 `run-as` 改为 `package` 并在应用设置中授权目录（本应用未适配授权目录流程）。

## 4. config/resource

```json
{
    "data-share": {
        "shares": [
            {
                "name": "trtree"
            }
        ]
    }
}
```

## 5. app/ui/config

```json
{
    ".url": {
        "trtree.Application": {
            "title": "TrTree",
            "icon": "images/icon_{0}.png",
            "type": "iframe",
            "protocol": "",
            "gatewayPrefix": "/app/trtree",
            "gatewaySocket": "app.sock",
            "url": "/app/trtree",
            "allUsers": false,
            "control": {
                "accessPerm": "editable"
            }
        }
    }
}
```

## 6. 生命周期脚本

`cmd/main`：

- `TRIM_APPDEST` 兼容：`${TRIM_APPDEST}/server` 或 `${TRIM_APPDEST}/target/server`。
- 按 `uname -m` 选择 `trtree-linux-amd64` / `trtree-linux-arm64`。
- 环境：`TRTREE_SOCKET=${TRIM_APPDEST}/app.sock`、`TRTREE_DATA_DIR=${TRIM_PKGVAR}`、
  `TRTREE_SHARE_DIR=${TRIM_DATA_SHARE_PATHS%%:*}`、`TRTREE_GATEWAY_PREFIX=/app/trtree`。
- 启停：PID 文件 + TERM/KILL；启动后最多等 10s 健康检查（`curl --unix-socket`）。
- `status` 退出码：运行 0，停止 3（**停止分支必须返回非 0**，否则 fnOS 不会自动 start）。
- `restart`：stop + start。

其余 8 个脚本：`install_init` / `install_callback` / `config_init` / `config_callback` / `upgrade_init` / `upgrade_callback` / `uninstall_init` / `uninstall_callback` 全部存在；`install_callback` 负责 `chmod 0755` 二进制，其余 `exit 0`。

## 7. 图标规范

- 画布 256×256，圆角 48px（18.75%），RGBA PNG。
- `ICON.PNG` 64×64、`ICON_256.PNG` 256×256；`app/ui/images/` 下 64/128/256。
- 视觉：深蓝渐变底 + 彩色 Treemap 方块（青/蓝/橙/紫），象征空间分析。

## 8. 构建

```bash
scripts/build.sh          # Go 双架构 + 图标 + 同步 packaging
scripts/pack.sh           # fnpack build --directory packaging → dist/trtree-1.0.2.fpk
```

注意：

- 打包前统一权限：目录 755、文件 644、`cmd/*` 755，否则 fnpack 可能报错。
- fnpack 会校验 `manifest`、`config/privilege`、`config/resource`、`ICON.PNG`、`ICON_256.PNG`、`app/`、`cmd/`、`wizard/`、`app/ui/` 是否存在。
- 生成的 fpk 在 `packaging/` 或 `dist/`（以 fnpack 实际输出为准）。

## 9. 安装/升级/卸载（真机）

```bash
# 上传
scp dist/trtree-1.0.2.fpk qmf@NAS:/tmp/

# 安装（需 sudo 密码；1.2.0800 支持 install-fpk）
sudo appcenter-cli install-fpk /tmp/trtree-1.1.3.fpk

# 或 App Center → 手动安装

# 状态 / 启停
sudo appcenter-cli status trtree
sudo appcenter-cli start trtree
sudo appcenter-cli stop trtree

# 卸载
sudo appcenter-cli uninstall trtree
```

安装后访问：`https://<NAS>:5667/app/trtree/`（需管理员登录；入口默认仅管理员可见）。

## 10. 排障

- 应用起不来：`/var/log/apps/trtree.log`、`<TRIM_PKGVAR>/app.log`。
- 网关 502：确认 `${TRIM_APPDEST}/app.sock` 存在且 `curl --unix-socket` 可访问；`ui/config` 的 `gatewaySocket` 必须为文件名 `app.sock`。
- 安装被拒：「应用包不符合系统要求」优先检查 manifest 字段、`config/*` JSON 缩进/合法性、9 个 cmd 脚本是否齐全、图标是否为 RGBA PNG。
- 端口模式调试：`PORT=18080 ./trtree`，浏览器访问 `http://127.0.0.1:18080/`（本地开发无网关 Header 时视为管理员）。
