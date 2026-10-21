# Ontology Core 桌面客户端（Electron）

一个**壳**：加载已部署 Core 服务端托管的同一份 UI，负责窗口、服务端配置、凭据与故障提示。业务逻辑、审核与数据都不在客户端里。

设计见 [`tasks/design-electron-client-2026-10-21.md`](../../tasks/design-electron-client-2026-10-21.md)。

## 先决条件

服务端必须已经按 README 的「作为服务端共享（远程客户端）」段落启动：

- `CORE_API_HOST` 放开监听（例如 `0.0.0.0`）
- `CORE_API_TOKEN` 配置好访问令牌
- 已执行 `pnpm run build:web`（API 会托管 UI）

## 运行

本目录是**独立的 pnpm 项目**，不在 `platform/` 的 workspace 里——这样 Core 的 CI 不会为了跑测试下载约 100 MB 的 Electron 运行时。

```powershell
cd client\desktop
pnpm install
pnpm start          # 编译后启动
```

首次启动会打开「连接 Ontology Core」：填服务端地址与访问令牌，可先「测试连接」。连接成功后令牌加密保存到系统凭据存储（Windows DPAPI），之后直接进入工作台。

打包 Windows 安装包：

```powershell
pnpm run dist       # 输出到 release/
```

## 安全边界（不要在后续修改中放宽）

- 远程内容运行在 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false` 的窗口里，**没有 preload**，拿不到任何 Node 或 IPC 能力。
- 访问令牌只保存在主进程；由 `webRequest.onBeforeSendHeaders` 附加到**配置源**的请求上，渲染进程看不到令牌。
- 导航只允许留在配置的服务端源；其他链接交给系统浏览器，且只放行 `http(s)`。
- 远程服务端必须使用 `https`；只有回环地址允许 `http`。**不处理 `certificate-error`**，即不会忽略证书错误。
- 未连接时显示本地「连接中断」页并自动重试，不缓存业务数据。

## 结构

```
src/main.ts            主进程：窗口、菜单、令牌注入、导航守卫、探活与重试
src/config.ts          服务端地址（明文配置，不含令牌）
src/token.ts           safeStorage 加密的令牌
src/health.ts          /healthz 与带令牌的业务接口探活
src/shared.ts          纯 URL 规则（可单测）
src/preload-setup.ts   仅本地设置页使用的桥
src/assets/            本地设置页与离线页
test/                  node --test 覆盖 URL 规则
```
