import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function digest(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel)
}

/** Only a trusted build entry and explicitly controlled source roots; never scan the workspace. */
export async function buildComputeArtifact({ root, entryPoint, allowedSourceRoots }) {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2023',
    minifyWhitespace: true,
    minifyIdentifiers: true,
    legalComments: 'none',
    sourcemap: false,
    write: false,
    logLevel: 'silent',
    metafile: true,
    plugins: [{
      name: 'controlled-compute-closure',
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, (args) => {
          const path = args.kind === 'entry-point' ? resolve(root, args.path) : resolve(args.resolveDir, args.path)
          if ((args.kind !== 'entry-point' && !args.path.startsWith('.')) ||
            !allowedSourceRoots.some((allowed) => inside(resolve(root, allowed), path))) {
            throw new Error(`compute artifact imports outside the controlled source closure: ${args.path}`)
          }
          return undefined
        })
      },
    }],
  })
  const output = result.outputFiles[0]
  if (output === undefined || result.outputFiles.length !== 1 ||
    Object.values(result.metafile.outputs).some((entry) => entry.imports.length !== 0)) {
    throw new Error('compute artifact must be one closed ESM bundle without runtime imports')
  }
  const dependencies = await Promise.all(Object.keys(result.metafile.inputs).sort().map(async (sourceId) => ({
    sourceId: sourceId.replaceAll('\\', '/'),
    digest: digest((await readFile(resolve(root, sourceId), 'utf8')).replaceAll('\r\n', '\n')),
  })))
  if (dependencies.some((entry) => !allowedSourceRoots.some((allowed) => inside(resolve(root, allowed), resolve(root, entry.sourceId))))) {
    throw new Error('compute artifact resolved outside its controlled source roots')
  }
  dependencies.sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0)
  const body = {
    schemaVersion: 'compute-build-artifact@1',
    format: 'esm-bundle',
    target: 'es2023',
    bundleDigest: digest(output.contents),
    byteLength: output.contents.byteLength,
    dependencies,
  }
  return { content: output.contents, manifest: { ...body, handlerDigest: digest(canonical(body)) } }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const artifact = await buildComputeArtifact({
    root,
    entryPoint: 'packages/tool-services/src/compute/example-handler.ts',
    allowedSourceRoots: ['packages/tool-services/src/compute'],
  })
  const destination = resolve(root, 'packages/tool-services/src/compute/artifacts')
  const files = [
    ['example.mjs', artifact.content],
    ['example.manifest.json', `${JSON.stringify(artifact.manifest, null, 2)}\n`],
    ['example.d.mts', "import type { ComputeOperationHandler, OperationRef, Sha256Digest, VersionRef } from '@ontology/contracts'\nexport declare const EXAMPLE_OPERATION_REF: OperationRef\nexport declare const EXAMPLE_INPUT_SCHEMA_VERSION: string\nexport declare const EXAMPLE_RESULT_MEDIA_TYPE: string\nexport declare function exampleAlgorithmRef(handlerDigest: Sha256Digest): VersionRef\nexport declare function createHandlers(handlerDigest: Sha256Digest): readonly ComputeOperationHandler[]\n"],
  ]
  if (process.argv.includes('--check')) {
    for (const [name, expected] of files) {
      const actual = await readFile(resolve(destination, name))
      if (!actual.equals(Buffer.from(expected))) throw new Error(`stale compute build artifact: ${name}; run pnpm run build:compute`)
    }
    process.stdout.write(`compute artifact reproducible: ${artifact.manifest.handlerDigest}\n`)
    return
  }
  await mkdir(destination, { recursive: true })
  for (const [name, content] of files) await writeFile(resolve(destination, name), content)
  process.stdout.write(`built compute artifact: ${artifact.manifest.handlerDigest}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
