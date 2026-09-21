import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import ts from 'typescript'

export type Layer =
  | 'contracts'
  | 'core'
  | 'application'
  | 'services'
  | 'adapters'
  | 'extensions'
  | 'industry-packs'
  | 'apps'

export type RuleId =
  | 'workspace-dependency'
  | 'forbidden-sdk'
  | 'cross-package-relative-import'

export interface BoundaryConfig {
  readonly workspaceGlobs: readonly string[]
  readonly sourceRoot: string
  readonly layers: Readonly<Record<Layer, readonly Layer[] | '*'>>
  readonly sdkRestrictedLayers: readonly Layer[]
  readonly sdkDenylist: readonly string[]
}

export interface WorkspacePackage {
  readonly name: string
  readonly dir: string
  readonly layer: Layer
}

export interface Violation {
  readonly rule: RuleId
  readonly file: string
  readonly line: number
  readonly specifier: string
  readonly message: string
}

interface ImportRef {
  readonly file: string
  readonly line: number
  readonly specifier: string
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage'])

export function loadConfig(configUrl: URL): BoundaryConfig {
  return JSON.parse(readFileSync(configUrl, 'utf8')) as BoundaryConfig
}

export function layerOf(relDir: string): Layer | undefined {
  const parts = relDir.split('/')
  const head = parts[0]
  if (head === undefined) return undefined

  if (head === 'apps' || head === 'industry-packs') {
    return parts.length === 2 ? head : undefined
  }
  if (head !== 'packages') return undefined

  const group = parts[1]
  if (group === undefined) return undefined

  if (parts.length === 2) {
    switch (group) {
      case 'contracts':
        return 'contracts'
      case 'core':
        return 'core'
      case 'application':
        return 'application'
      case 'tool-services':
      case 'semantic-engine':
      case 'provenance':
        return 'services'
      default:
        return undefined
    }
  }

  if (parts.length === 3) {
    if (group === 'adapters') return 'adapters'
    if (group === 'extensions') return 'extensions'
  }

  return undefined
}

export function discoverPackages(root: string, config: BoundaryConfig): WorkspacePackage[] {
  const matchers = config.workspaceGlobs.map(globToRegExp)
  const packages: WorkspacePackage[] = []

  for (const relManifest of collectPackageManifests(root, 4)) {
    if (!matchers.some((matcher) => matcher.test(relManifest))) continue

    const dir = posix.dirname(relManifest)
    const layer = layerOf(dir)
    if (layer === undefined) continue

    const manifest = JSON.parse(readFileSync(join(root, relManifest), 'utf8')) as { name?: unknown }
    if (typeof manifest.name !== 'string') continue

    packages.push({ name: manifest.name, dir, layer })
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name))
}

export function checkWorkspace(root: string, config: BoundaryConfig): Violation[] {
  const packages = discoverPackages(root, config)
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]))
  const violations: Violation[] = []

  for (const pkg of packages) {
    for (const ref of collectImports(root, pkg, config)) {
      violations.push(...evaluate(config, byName, pkg, ref))
    }
  }

  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

export function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map((v) => `${v.file}:${v.line} [${v.rule}] ${v.specifier} - ${v.message}`)
    .join('\n')
}

function evaluate(
  config: BoundaryConfig,
  byName: ReadonlyMap<string, WorkspacePackage>,
  pkg: WorkspacePackage,
  ref: ImportRef,
): Violation[] {
  const specifier = ref.specifier

  if (specifier.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(ref.file), specifier))
    if (resolved !== pkg.dir && !resolved.startsWith(`${pkg.dir}/`)) {
      return [
        violation(
          'cross-package-relative-import',
          ref,
          `${pkg.name} 的相对导入逃逸包边界，必须改用包名导入`,
        ),
      ]
    }
    return []
  }

  const target = workspaceTarget(byName, specifier)
  if (target !== undefined) {
    if (target.name === pkg.name) return []

    const allowed = config.layers[pkg.layer]
    if (allowed !== '*' && !allowed.includes(target.layer)) {
      return [
        violation(
          'workspace-dependency',
          ref,
          `${pkg.layer} 层禁止依赖 ${target.layer} 层（${target.name}）`,
        ),
      ]
    }
    return []
  }

  if (config.sdkRestrictedLayers.includes(pkg.layer) && matchesDenylist(config.sdkDenylist, specifier)) {
    return [
      violation(
        'forbidden-sdk',
        ref,
        `${pkg.layer} 层禁止直接 import SDK/驱动/UI 框架，须通过端口注入`,
      ),
    ]
  }

  return []
}

function workspaceTarget(
  byName: ReadonlyMap<string, WorkspacePackage>,
  specifier: string,
): WorkspacePackage | undefined {
  const direct = byName.get(specifier)
  if (direct !== undefined) return direct

  const segments = specifier.split('/')
  const packageName = specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0]

  return packageName === undefined || packageName === '' ? undefined : byName.get(packageName)
}

function matchesDenylist(denylist: readonly string[], specifier: string): boolean {
  return denylist.some((name) => specifier === name || specifier.startsWith(`${name}/`))
}

function violation(rule: RuleId, ref: ImportRef, message: string): Violation {
  return { rule, file: ref.file, line: ref.line, specifier: ref.specifier, message }
}

function collectImports(root: string, pkg: WorkspacePackage, config: BoundaryConfig): ImportRef[] {
  const sourceDir = join(root, pkg.dir, config.sourceRoot)
  if (!existsSync(sourceDir)) return []

  const files: string[] = []
  collectSourceFiles(sourceDir, files)

  const refs: ImportRef[] = []
  for (const absFile of files) {
    const text = readFileSync(absFile, 'utf8')
    const kind = absFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const source = ts.createSourceFile(absFile, text, ts.ScriptTarget.Latest, true, kind)
    const relFile = toPosix(relative(root, absFile))

    const visit = (node: ts.Node): void => {
      const specifier = importSpecifierOf(node)
      if (specifier !== undefined) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
        refs.push({ file: relFile, line: line + 1, specifier })
      }
      ts.forEachChild(node, visit)
    }

    visit(source)
  }

  return refs
}

function importSpecifierOf(node: ts.Node): string | undefined {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier
    return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined
  }

  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression
    return ts.isStringLiteral(expression) ? expression.text : undefined
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require'
    const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword
    if (isRequire || isDynamicImport) {
      const argument = node.arguments[0]
      return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined
    }
  }

  return undefined
}

function collectSourceFiles(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collectSourceFiles(abs, out)
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(abs)
    }
  }
}

function collectPackageManifests(root: string, maxDepth: number): string[] {
  const found: string[] = []

  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return

    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      const childAbs = join(dir, entry.name)
      if (existsSync(join(childAbs, 'package.json'))) found.push(`${childRel}/package.json`)
      walk(childAbs, childRel, depth + 1)
    }
  }

  walk(root, '', 1)
  return found
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  return new RegExp(`^${pattern}$`)
}

function toPosix(path: string): string {
  return path.split('\\').join('/')
}
