import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The compiled main process resolves pages from `dist/assets`, so the static pages must travel with
// the build. They are plain files, not bundled, so copying is the whole step.
const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, '..', 'src', 'assets')
const target = join(here, '..', 'dist', 'assets')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`copied desktop assets to ${target}`)
