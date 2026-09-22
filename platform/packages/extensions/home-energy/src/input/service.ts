import type { ImmutableArtifactWriter, TelemetryPort, ToolContext } from '@ontology/contracts'
import type { DeclaredConversions } from './conversions'
import { normalizeEnergyInput } from './normalize'
import { publishEnergyInputSnapshot } from './snapshot'
import { readObservationSeries, type ObservationReadSpec } from './telemetry'
import type {
  EnergyInputBundle,
  EnergyInputSnapshot,
  ForecastSeriesInput,
  NormalizeEnergyInputRequest,
  NormalizedEnergyInput,
} from './types'

/**
 * The energy input service: reads bounded observation series through `TelemetryPort`, normalises
 * them together with the supplied forecast inputs, and archives an immutable snapshot. It holds
 * only ports — telemetry, declared conversions and the artifact writer — so it never reaches a
 * database, a runtime or an MCP transport directly.
 */

export interface BuildEnergyInputRequest extends NormalizeEnergyInputRequest {
  readonly observationRequests: readonly ObservationReadSpec[]
}

export interface EnergyInputServiceDependencies {
  readonly telemetry: TelemetryPort
  readonly conversions: DeclaredConversions
  readonly artifacts: ImmutableArtifactWriter
}

export class EnergyInputService {
  readonly #telemetry: TelemetryPort
  readonly #conversions: DeclaredConversions
  readonly #artifacts: ImmutableArtifactWriter

  constructor(dependencies: EnergyInputServiceDependencies) {
    this.#telemetry = dependencies.telemetry
    this.#conversions = dependencies.conversions
    this.#artifacts = dependencies.artifacts
  }

  /** Read the requested observation series and normalise them with the given forecasts. */
  async normalize(
    request: BuildEnergyInputRequest,
    forecasts: readonly ForecastSeriesInput[],
    ctx: ToolContext,
  ): Promise<NormalizedEnergyInput> {
    const observations = await readObservationSeries(this.#telemetry, request.observationRequests, ctx)
    const bundle: EnergyInputBundle = { observations, forecasts }
    return normalizeEnergyInput(request, bundle, { conversions: this.#conversions })
  }

  /** Normalise and archive the content-addressed input snapshot. */
  async buildSnapshot(
    request: BuildEnergyInputRequest,
    forecasts: readonly ForecastSeriesInput[],
    ctx: ToolContext,
  ): Promise<EnergyInputSnapshot> {
    const normalized = await this.normalize(request, forecasts, ctx)
    return publishEnergyInputSnapshot(normalized, { artifacts: this.#artifacts }, ctx)
  }
}
