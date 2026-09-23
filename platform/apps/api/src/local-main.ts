import { startLocalProduct } from './local-product'

const product = await startLocalProduct()
process.stdout.write(`Ontology POC Core API: ${product.origin}\n`)
const shutdown = (): void => { void product.close().then(() => process.exit(0), (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'shutdown failed'}\n`); process.exit(1) }) }
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
