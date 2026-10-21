# Ontology Core 桌面客户端（Electron）

一个**壳**：加载已部署 Core 服务端托管的同一份 UI，负责窗口、服务端配置、凭据与故障提示。业务逻辑、审核与数据都不在客户端里。

设计见 [`tasks/design-electron-client-2026-10-21.md`](../../tasks/design-electron-client-2026-10-21.md)。

## 打开方式

**双击仓库根目录的 `start-client.cmd`**（或本目录的 `start.cmd`）。脚本会自动安装依赖、编译并启动；出错时窗口会停住并显示原因，不会一闪而过。

首次启动会打开「连接 Ontology Core」：

| 场景 | 地址 | 令牌 |
|---|---|---|
| 本机演示（服务端未配置 `CORE_API_TOKEN`） | `http://127.0.0.1:3001` | **留空** |
| 本机演示（服务端配了令牌） | `http://127.0.0.1:3001` | 填该令牌 |
| 远程/内网服务端 | `https://…` | 必填 |

命令行方式：在本目录执行 `pnpm install` → `pnpm start`。

## 服务端要先准备好

客户端加载的是**服务端托管的 UI**。在仓库 `platform/` 下：

```powershell
pnpm run build:web
```

然后用 `CORE_API_HOST`（本机演示保持默认回环即可）与可选的 `CORE_API_TOKEN` 启动 Core。详见根 README 的「作为服务端共享（远程客户端）」。服务端没构建过 web 产物时，客户端会连不上 UI（`/healthz` 仍可能正常）。

## 本机开发

本目录是**独立的 pnpm 项目**，不在 `platform/` 的 workspace 里——这样 Core 的 CI 不会为了跑测试下载约 100 MB 的 Electron 运行时。

```powershell
cd client\desktop
pnpm install
pnpm start          # 编译后启动
pnpm test           # 编译 + node --test（URL 规则）
pnpm run dist       # 打 Windows 安装包到 release/
```

首次连接成功后，地址写入 `config.json`，令牌用系统凭据存储（Windows DPAPI）加密保存；之后直接进入工作台。

## 安全边界（不要在后续修改中放宽）

- 远程内容运行在 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false` 的窗口里，**没有 preload**，拿不到任何 Node 或 IPC 能力。
- 访问令牌只保存在主进程；由 `webRequest.onBeforeSendHeaders` 附加到**配置源**的请求上，渲染进程看不到令牌。
- 导航只允许留在配置的服务端源；其他链接交给系统浏览器，且只放行 `http(s)`。
- 远程服务端必须使用 `https`；只有回环地址允许 `http`。**不处理 `certificate-error`**，即不会忽略证书错误。
- 未连接时显示本地「连接中断」页并自动重试，不缓存业务数据。

## 结构

```
start.cmd / start.ps1  双击启动（安装依赖、编译、拉起 Electron）
src/main.ts            主进程：窗口、菜单、令牌注入、导航守卫、探活与重试
src/config.ts          服务端地址（明文配置，不含令牌）
src/token.ts           safeStorage 加密的令牌
src/health.ts          /healthz 与带令牌的业务接口探活
src/shared.ts          纯 URL 规则（可单测）
src/preload-setup.ts   仅本地设置页使用的桥
src/assets/            本地设置页与离线页
test/                  node --test 覆盖 URL 规则
```
