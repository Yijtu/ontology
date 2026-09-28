import type { ControlReadProjectionRequest, Sha256Digest, ScopeRef, VersionRef } from '@ontology/contracts'
import { sha256DigestOf } from '../definitions/canonical'
import type { RuleFact } from './types'
import { unitOf } from './values'

/**
 * Canonical proposition identity (SPEC D5). A proposition key is not a field name: two otherwise
 * identical propositions that differ in subject, unit, validity interval or tenant/space scope
 * are distinct and must never be merged into one another.
 */
export interface PropositionQualifiers {
  readonly predicate: string
  /** Stable rule/entity-qualified conclusion identity, when the caller already has one. */
  readonly propositionKey?: string
  readonly subject?: string
  readonly objectId?: string
  readonly schemaRef?: VersionRef
  readonly unitCode?: string
  readonly validFrom?: string
  readonly validTo?: string
  readonly scopeRef: ScopeRef
}

export function qualifiedPropositionKey(qualifiers: PropositionQualifiers): Sha256Digest {
  return sha256DigestOf({
    propositionKey: qualifiers.propositionKey ?? null,
    subject: qualifiers.subject ?? null,
    predicate: qualifiers.predicate,
    objectId: qualifiers.objectId ?? null,
    schemaRef: qualifiers.schemaRef ?? null,
    unit: qualifiers.unitCode ?? null,
    validFrom: qualifiers.validFrom ?? null,
    validTo: qualifiers.validTo ?? null,
    tenantId: qualifiers.scopeRef.tenantId,
    spaceId: qualifiers.scopeRef.spaceId,
  })
}

/** The qualified identity of one fact version, including its unit and half-open validity. */
export function factQualifiedKey(fact: RuleFact, scopeRef: ScopeRef): Sha256Digest {
  const unitCode = unitOf(fact.value)
  return qualifiedPropositionKey({
    predicate: fact.predicate,
    subject: fact.subject,
    ...(fact.objectId === undefined ? {} : { objectId: fact.objectId }),
    ...(fact.schemaRef === undefined ? {} : { schemaRef: fact.schemaRef }),
    ...(unitCode === undefined ? {} : { unitCode }),
    validFrom: fact.validity.validFrom,
    ...(fact.validity.validTo === undefined ? {} : { validTo: fact.validity.validTo }),
    scopeRef,
  })
}

/** The qualified identity of a rule conclusion read at one bitemporal view. */
export function conclusionQualifiedKey(
  predicate: string,
  request: ControlReadProjectionRequest,
  schemaRef?: VersionRef,
  propositionKey?: string,
): Sha256Digest {
  return qualifiedPropositionKey({
    predicate,
    ...(propositionKey === undefined ? {} : { propositionKey }),
    ...(schemaRef === undefined ? {} : { schemaRef }),
    ...(request.validAt === undefined ? {} : { validFrom: request.validAt }),
    scopeRef: request.scopeRef,
  })
}
