import type {
  ForecastPort,
  ImmutableArtifactWriter,
  TelemetryPort,
  ToolContext,
} from '@ontology/contracts'
import type { DeclaredConversions } from './conversions'
import { readForecastSeries, type ForecastReadSpec } from './forecast'
import { normalizeEnergyInput } from './normalize'
import { publishEnergyInputSnapshot } from './snapshot'
import { readObservationSeries, type ObservationReadSpec } from './telemetry'
import type {
  EnergyInputBundle,
  EnergyInputSnapshot,
  NormalizeEnergyInputRequest,
  NormalizedEnergyInput,
} from './types'

/**
 * The energy input service: reads bounded observation series through `TelemetryPort`, reads
 * forecasts through the injected `ForecastPort`, normalises them together and archives an
 * immutable snapshot. It holds only ports — telemetry, the optional forecast port, declared
 * conversions and the artifact writer — so it never reaches a database, a runtime or an MCP
 * transport directly.
 *
 * When `forecast` is absent but forecasts were requested, the normaliser records an explicit
 * `not_configured` outcome and a `forecast_not_configured` missing input. It never fabricates a
 * forecast to fill the gap.
 */

export interface BuildEnergyInputRequest extends NormalizeEnergyInputRequest {
  readonly observationRequests: readonly ObservationReadSpec[]
  /** Forecasts to read through `ForecastPort`. Empty when the run needs none. */
  readonly forecastRequests: readonly ForecastReadSpec[]
}

export interface EnergyInputServiceDependencies {
  readonly telemetry: TelemetryPort
  readonly conversions: DeclaredConversions
  readonly artifacts: ImmutableArtifactWriter
  /** Absent means the forecast capability is explicitly not configured. */
  readonly forecast?: ForecastPort
}

export class EnergyInputService {
  readonly #telemetry: TelemetryPort
  readonly #conversions: DeclaredConversions
  readonly #artifacts: ImmutableArtifactWriter
  readonly #forecast: ForecastPort | undefined

  constructor(dependencies: EnergyInputServiceDependencies) {
    this.#telemetry = dependencies.telemetry
    this.#conversions = dependencies.conversions
    this.#artifacts = dependencies.artifacts
    this.#forecast = dependencies.forecast
  }

  /** Read the requested observation and forecast series and normalise them together. */
  async normalize(
    request: BuildEnergyInputRequest,
    ctx: ToolContext,
  ): Promise<NormalizedEnergyInput> {
    const observations = await readObservationSeries(this.#telemetry, request.observationRequests, ctx)
    const forecast = this.#forecast
    const forecasts =
      forecast === undefined
        ? []
        : await readForecastSeries(forecast, request.forecastRequests, request.evaluationClock, ctx)
    const bundle: EnergyInputBundle = {
      observations,
      forecasts,
      forecastConfigured: forecast !== undefined,
      requestedForecasts: request.forecastRequests.map((spec) => ({
        measurementPointRef: spec.measurementPointRef,
        metric: spec.metric,
      })),
    }
    return normalizeEnergyInput(request, bundle, { conversions: this.#conversions })
  }

  /** Normalise and archive the content-addressed input snapshot. */
  async buildSnapshot(
    request: BuildEnergyInputRequest,
    ctx: ToolContext,
  ): Promise<EnergyInputSnapshot> {
    const normalized = await this.normalize(request, ctx)
    return publishEnergyInputSnapshot(normalized, { artifacts: this.#artifacts }, ctx)
  }
}
