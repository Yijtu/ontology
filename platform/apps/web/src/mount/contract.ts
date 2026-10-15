import type { ComponentType } from 'react'
import type {
  DomainResultStatus,
  ProjectRevisionRef,
  ResourceRef,
  Uuid,
  VersionRef,
} from '@ontology/contracts'

/**
 * Public scenario mount contract (SPEC v0.3a asset-data-ui §9.3, A-ADR-09).
 *
 * React ComponentType and every prop below live only in apps/web. `contracts` keeps the
 * data-only `UiCapabilityMetadata` half (mount.schema.json): a registered module ref, the task
 * bindings it offers and the capabilities it needs. A module is mounted from the trusted build
 * composition — never loaded from an API response, an industry pack, uploaded content or a URL.
 * The full data/confirm/run/export wiring is delivered by V03-020/040/041/045; this file fixes
 * the slot shapes so a neutral scenario can be assembled today without any business logic.
 */

/** One task entry a scenario module offers. `taskBindingRef` pins the published task version. */
export interface ScenarioTaskEntry {
  readonly taskBindingRef: VersionRef
  readonly label: string
  readonly iconKey?: string
}

/**
 * One export entry. The formatter runs server-side in the V03-041 chain; a browser module can
 * only request the export after the API re-checks scope, answer/result digest and permission.
 * An exporter declaration never carries a formatter implementation, amount or template body.
 */
export interface ScenarioExporter {
  readonly id: string
  readonly label: string
  readonly format: string
  readonly exportCapabilityRef: VersionRef
}

/** A field change the scenario form proposes; the value stays unknown until schema-validated. */
export interface ScenarioFieldChange {
  readonly fieldRef: string
  readonly fieldSchemaRef: VersionRef
  readonly valueKind: string
  readonly proposedValue: unknown
  readonly sourceRefs: readonly ResourceRef[]
  readonly reasonCode: string
}

/**
 * Per-assistant draft bridge. The shell scopes it to the active assistant so switching
 * assistants keeps each unsubmitted edit separate (SPEC v0.3a §9.1).
 */
export interface ScenarioDraftStore {
  get(key: string): string
  set(key: string, value: string): void
}

export interface ScenarioParameterProps {
  readonly moduleRef: VersionRef
  readonly taskBindingRef: VersionRef
  readonly projectRevisionRef: ProjectRevisionRef
  readonly readOnly: boolean
  readonly drafts: ScenarioDraftStore
  readonly onProposeChange: (change: ScenarioFieldChange) => void
  readonly onOpenSource: (ref: ResourceRef) => void
}

/**
 * Controlled, legal projection of an already-verified result. A module renderer reads only
 * these fields; raw compute JSON and unverified artifact URLs are never part of it. The typed
 * manifest and paged table descriptors arrive with the V03-032/040 data chain.
 */
export interface ScenarioVerifiedResult {
  readonly answerId: Uuid
  readonly runId: Uuid
  readonly domainStatus: DomainResultStatus
  readonly limitations: readonly string[]
  readonly currentValidity: 'current' | 'superseded' | 'withdrawn' | 'unverifiable'
}

export interface ScenarioResultProps {
  readonly moduleRef: VersionRef
  readonly projectRevisionRef: ProjectRevisionRef
  readonly publishedAnswerRef?: ResourceRef
  readonly verifiedResult: ScenarioVerifiedResult
  readonly onOpenEvidence: (ref: ResourceRef) => void
  readonly onRequestExport: (exporterId: string) => void
}

/**
 * A trusted, build-registered scenario module. `ref` is the moduleRef the deployment/industry
 * declaration points at; the registry resolves it to this compiled object.
 */
export interface FrontendScenarioModule {
  readonly ref: VersionRef
  readonly capabilityRequirements: readonly string[]
  readonly taskEntries: readonly ScenarioTaskEntry[]
  readonly ParameterPanel?: ComponentType<ScenarioParameterProps>
  readonly ResultRenderer?: ComponentType<ScenarioResultProps>
  readonly exporters?: readonly ScenarioExporter[]
}

/**
 * Data-only projection of a registered module. It is the only module data the public framework
 * observes: no component code, HTML, JS path or remote import leaks through it.
 */
export interface ScenarioModuleView {
  readonly moduleRef: VersionRef
  readonly taskEntries: readonly ScenarioTaskEntry[]
  readonly capabilityRequirements: readonly string[]
  readonly exporters: readonly ScenarioExporter[]
  readonly hasParameterPanel: boolean
  readonly hasResultRenderer: boolean
}
