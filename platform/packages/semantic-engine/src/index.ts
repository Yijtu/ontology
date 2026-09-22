/**
 * @ontology/semantic-engine — semantic services.
 *
 * The layer owns canonical facts, identity decisions and rule evaluation. It receives
 * every capability — control persistence, blob access, time — by construction injection,
 * so it imports no adapter, extension, industry pack or SDK/driver (INV-02).
 */
export * from './definitions'
export * from './mapping'
export * from './identity'
export * from './publication'
