import { BrowserWindow, Menu, app, dialog, ipcMain, session, shell } from 'electron'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearConfig, loadConfig, saveConfig } from './config'
import type { DesktopConfig } from './config'
import { probeServer } from './health'
import { isAllowedNavigation, isExternalWebUrl, isLoopbackUrl, shouldAttachToken, validateServerUrl } from './shared'
import { clearToken, loadToken, saveToken } from './token'

/**
 * `persist:core` is the session that owns the remote UI. Its webRequest hook attaches the bearer
 * token in the main process, so the renderer never sees the credential.
 */
const REMOTE_PARTITION = 'persist:core'
const RETRY_MS = 5_000

let config: DesktopConfig | undefined
let token: string | undefined
let mainWindow: BrowserWindow | undefined
let setupWindow: BrowserWindow | undefined
let retryTimer: NodeJS.Timeout | undefined

function asset(name: string): string {
  return join(__dirname, 'assets', name)
}

function attachTokenInjection(): void {
  session.fromPartition(REMOTE_PARTITION).webRequest.onBeforeSendHeaders((details, callback) => {
    const current = config
    const credential = token
    if (current !== undefined && credential !== undefined && shouldAttachToken(details.url, current.serverUrl)) {
      details.requestHeaders['Authorization'] = `Bearer ${credential}`
    }
    callback({ requestHeaders: details.requestHeaders })
  })
}

function openExternalSafely(url: string): void {
  // Only web content leaves the app; file:, javascript: and custom protocols are refused.
  if (isExternalWebUrl(url)) void shell.openExternal(url)
}

function scheduleRetry(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = undefined
    void loadRemote()
  }, RETRY_MS)
}

function cancelRetry(): void {
  if (retryTimer !== undefined) clearTimeout(retryTimer)
  retryTimer = undefined
}

async function loadRemote(): Promise<void> {
  const current = config
  if (current === undefined || mainWindow === undefined) return
  try {
    await mainWindow.loadURL(current.serverUrl)
  } catch {
    await mainWindow.loadFile(asset('offline.html'), { query: { target: current.serverUrl } }).catch(() => undefined)
    scheduleRetry()
  }
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#0f172a',
    webPreferences: {
      partition: REMOTE_PARTITION,
      // Remote content runs with no Node, no preload bridge and no ability to escape its origin.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => window.show())

  const contents = window.webContents
  contents.on('will-navigate', (event, url) => {
    const current = config
    if (current !== undefined && isAllowedNavigation(url, current.serverUrl)) return
    event.preventDefault()
    openExternalSafely(url)
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return
    // -3 is ABORTED, which happens on normal redirects/cancels and must not show the offline page.
    if (errorCode === -3) return
    void window.loadFile(asset('offline.html'), { query: { target: config?.serverUrl ?? '' } }).catch(() => undefined)
    scheduleRetry()
  })
  contents.on('did-finish-load', () => cancelRetry())

  return window
}

function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '重新连接', click: () => void loadRemote() },
        { label: '重新配置服务端…', click: () => openSetup({ replaceMain: true }) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]))
}

function openSetup(options: { replaceMain: boolean }): void {
  cancelRetry()
  if (setupWindow !== undefined && !setupWindow.isDestroyed()) {
    setupWindow.focus()
    return
  }
  const window = new BrowserWindow({
    width: 620,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '连接 Ontology Core',
    show: false,
    webPreferences: {
      // The setup page is local and needs exactly one bridge: save/probe. It is never used for
      // remote content.
      preload: join(__dirname, 'preload-setup.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    setupWindow = undefined
    // Closing setup without connecting must not leave the app invisible.
    if (mainWindow !== undefined && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show()
  })
  void window.loadFile(asset('setup.html'))
  setupWindow = window

  if (options.replaceMain && mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.hide()
  }
}

async function enterMain(serverUrl: string, credential: string | undefined): Promise<void> {
  const result = await probeServer(serverUrl, credential)
  if (!result.ok) throw new Error(result.message)

  saveConfig({ serverUrl })
  // A loopback server started without `CORE_API_TOKEN` needs no credential; remember "none" by
  // clearing the stored secret rather than sealing an empty string.
  if (credential === undefined || credential.length === 0) clearToken()
  else saveToken(credential)
  config = { serverUrl }
  token = credential === undefined || credential.length === 0 ? undefined : credential

  // Create the main window BEFORE closing setup. Closing the only window emits
  // `window-all-closed`, which quits the app: doing it in the other order raced with that event and
  // made the shell exit the moment "connect" was pressed.
  if (mainWindow === undefined || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow()
  } else {
    mainWindow.show()
  }
  if (setupWindow !== undefined && !setupWindow.isDestroyed()) {
    const closing = setupWindow
    setupWindow = undefined
    closing.destroy()
  }
  await loadRemote()
}

/**
 * Normalize the setup token. Returns `undefined` for "no credential" (allowed only for a loopback
 * server, where Core may run without `CORE_API_TOKEN`), or `null` when a credential is required but
 * missing — so the caller can tell "leave it empty" apart from "reject".
 */
function readSetupToken(serverUrl: string, value: unknown): string | undefined | null {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token.length > 0) return token
  return isLoopbackUrl(serverUrl) ? undefined : null
}

function registerIpc(): void {
  ipcMain.handle('setup:current', () => ({ serverUrl: config?.serverUrl }))

  ipcMain.handle('setup:probe', async (_event, payload: unknown) => {
    const input = payload as { serverUrl?: unknown; token?: unknown }
    const validated = validateServerUrl(input.serverUrl)
    if (!validated.ok || validated.url === undefined) return { ok: false, message: validated.reason ?? '地址无效' }
    const credential = readSetupToken(validated.url, input.token)
    if (credential === null) return { ok: false, message: '请输入访问令牌（本机服务端可留空）' }
    return probeServer(validated.url, credential)
  })

  ipcMain.handle('setup:connect', async (_event, payload: unknown) => {
    const input = payload as { serverUrl?: unknown; token?: unknown }
    const validated = validateServerUrl(input.serverUrl)
    if (!validated.ok || validated.url === undefined) return { ok: false, message: validated.reason ?? '地址无效' }
    const credential = readSetupToken(validated.url, input.token)
    if (credential === null) return { ok: false, message: '请输入访问令牌（本机服务端可留空）' }
    try {
      await enterMain(validated.url, credential)
      return { ok: true, message: '已连接' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '连接失败' }
    }
  })

  ipcMain.handle('setup:forget', () => {
    clearToken()
    clearConfig()
    config = undefined
    token = undefined
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.destroy()
      mainWindow = undefined
    }
    return { ok: true }
  })
}

function bootstrap(): void {
  attachTokenInjection()
  buildMenu()
  registerIpc()

  const loaded = loadConfig()
  const credential = loaded === undefined ? undefined : loadToken()
  if (loaded !== undefined && credential !== undefined) {
    config = loaded
    token = credential
    mainWindow = createMainWindow()
    void loadRemote()
    return
  }
  // A configured server whose token cannot be opened (another OS user, keychain reset) must not
  // silently run unauthenticated: show the setup page with the address prefilled.
  if (loaded !== undefined) config = loaded
  openSetup({ replaceMain: false })
}

/**
 * Last-resort diagnostics. A crash in the main process closes the window with no message otherwise,
 * which is indistinguishable from "the app just disappeared". The log deliberately records only the
 * stack: never the token, never request headers.
 */
function logCrash(kind: string, error: unknown): void {
  try {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    appendFileSync(
      join(app.getPath('userData'), 'crash.log'),
      `[${new Date().toISOString()}] ${kind}: ${message}\n`,
      'utf8',
    )
  } catch {
    // Diagnostics must never become a second failure.
  }
}

process.on('uncaughtException', (error) => logCrash('uncaughtException', error))
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))

app.whenReady().then(bootstrap).catch((error: unknown) => {
  void dialog.showErrorBox('无法启动', error instanceof Error ? error.message : String(error))
  app.quit()
})

app.on('window-all-closed', () => {
  // Only quit when the app really has no windows left: during a healthy "connect" the setup window
  // closes while the main window exists, and an unconditional quit here closes the whole app.
  if (BrowserWindow.getAllWindows().length > 0) return
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.show()
  else if (setupWindow === undefined || setupWindow.isDestroyed()) openSetup({ replaceMain: false })
})
