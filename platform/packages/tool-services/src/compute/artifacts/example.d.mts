import type { ComputeOperationHandler, OperationRef, Sha256Digest, VersionRef } from '@ontology/contracts'
export declare const EXAMPLE_OPERATION_REF: OperationRef
export declare const EXAMPLE_INPUT_SCHEMA_VERSION: string
export declare const EXAMPLE_RESULT_MEDIA_TYPE: string
export declare function exampleAlgorithmRef(handlerDigest: Sha256Digest): VersionRef
export declare function createHandlers(handlerDigest: Sha256Digest): readonly ComputeOperationHandler[]
