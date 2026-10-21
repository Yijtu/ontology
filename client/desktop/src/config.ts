import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { validateServerUrl } from './shared'

/** What the shell remembers between launches. The token is never part of this file. */
export interface DesktopConfig {
  readonly serverUrl: string
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): DesktopConfig | undefined {
  const path = configPath()
  if (!existsSync(path)) return undefined
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null) return undefined
    const candidate = (raw as { serverUrl?: unknown }).serverUrl
    const validated = validateServerUrl(candidate)
    if (!validated.ok || validated.url === undefined) return undefined
    return { serverUrl: validated.url }
  } catch {
    // A corrupt config must not trap the user in a broken launch: fall back to setup.
    return undefined
  }
}

export function saveConfig(config: DesktopConfig): void {
  const validated = validateServerUrl(config.serverUrl)
  if (!validated.ok || validated.url === undefined) {
    throw new Error(validated.reason ?? 'the server address is invalid')
  }
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ serverUrl: validated.url }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export function clearConfig(): void {
  rmSync(configPath(), { force: true })
}
