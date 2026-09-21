import type {
  OperationRef,
  OperationRegistry,
  RegisteredOperation,
  Sha256Digest,
} from './generated/contracts'

/**
 * Contract-level resolution of a `data_query.kind=compute` request against the
 * deployment's registered operations.
 *
 * ADR-11: compute may only reference a pre-registered operation. The caller passes the
 * digest of the input schema it validated the parameters against, so a request can
 * never drift from the registered operation contract. Unregistered operations are
 * rejected here even when their parameters are well-formed.
 */
export function findRegisteredOperation(
  registry: OperationRegistry,
  operationRef: OperationRef,
  expectedInputSchemaDigest?: Sha256Digest,
): RegisteredOperation | undefined {
  return registry.operations.find((operation) => {
    if (
      operation.operationRef.id !== operationRef.id ||
      operation.operationRef.version !== operationRef.version
    ) {
      return false
    }
    return (
      expectedInputSchemaDigest === undefined ||
      operation.inputSchemaDigest === expectedInputSchemaDigest
    )
  })
}
