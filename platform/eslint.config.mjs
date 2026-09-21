import { readFileSync } from 'node:fs'
import tseslint from 'typescript-eslint'

const config = JSON.parse(
  readFileSync(new URL('./tests/architecture/boundaries.config.json', import.meta.url), 'utf8'),
)

const layerFiles = {
  contracts: ['packages/contracts/**/*.ts'],
  core: ['packages/core/**/*.ts'],
  application: ['packages/application/**/*.ts'],
  services: [
    'packages/tool-services/**/*.ts',
    'packages/semantic-engine/**/*.ts',
    'packages/provenance/**/*.ts',
  ],
  adapters: ['packages/adapters/**/*.ts'],
  extensions: ['packages/extensions/**/*.ts'],
  'industry-packs': ['industry-packs/**/*.ts'],
  apps: ['apps/**/*.ts'],
}

const layerNames = Object.keys(config.layers)

const restrictedPatternsFor = (layer) => {
  const allowed = config.layers[layer]
  const groups = []

  for (const other of layerNames) {
    if (allowed === '*' || allowed.includes(other)) continue
    for (const glob of config.layerPackageGlobs[other]) {
      groups.push(glob, `${glob}/**`)
    }
  }

  if (config.sdkRestrictedLayers.includes(layer)) {
    groups.push(...config.sdkDenylist)
  }

  return groups.map((group) => ({
    group: [group],
    message: `${layer} 层禁止该导入，依赖方向见 tests/architecture/boundaries.config.json`,
  }))
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'tests/architecture/fixtures/**',
    ],
  },
  ...tseslint.configs.recommended,
  ...layerNames.map((layer) => ({
    files: layerFiles[layer],
    rules:
      restrictedPatternsFor(layer).length === 0
        ? {}
        : {
            '@typescript-eslint/no-restricted-imports': [
              'error',
              { patterns: restrictedPatternsFor(layer) },
            ],
          },
  })),
)
