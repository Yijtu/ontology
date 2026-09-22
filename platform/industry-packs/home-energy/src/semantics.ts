import type {
  HomeEnergyAttributeDefinition,
  HomeEnergyDefinitionContent,
  HomeEnergyObjectDefinition,
} from './types'

/**
 * Pure, declarative semantic checks for the `home-energy` pack (SPEC E2/E3, §7; INV-10).
 *
 * The definition validator already rejects a dangling reference, a missing unit or an
 * invalid enum. These checks cover the distinctions the home-energy model must not blur,
 * so a pack that conflates them is rejected with a precise path instead of producing a
 * plan that silently mixes a rate with an amount or a forecast with a measurement.
 *
 * The function is pure and has no I/O, so it runs at declaration time and in tests.
 */

export type HomeEnergySemanticIssueCode =
  | 'MISSING_OBJECT'
  | 'MISSING_IDENTITY_SCOPE'
  | 'CONFLATED_DEVICE_SENSOR'
  | 'CONFLATED_POWER_ENERGY'
  | 'CONFLATED_FORECAST_OBSERVED'

export interface HomeEnergySemanticIssue {
  readonly code: HomeEnergySemanticIssueCode
  readonly path: string
  readonly message: string
}

/** Objects every home-energy declaration version must define. */
export const HOME_ENERGY_REQUIRED_OBJECTS: readonly string[] = [
  'site',
  'device',
  'sensor',
  'load_group',
  'tariff',
  'observation_series',
  'forecast_series',
  'energy_constraint',
  'energy_plan',
]

const SPEC_ATTRIBUTE_SUFFIXES: readonly string[] = ['_kw', '_kwh']

function attributesOf(
  content: HomeEnergyDefinitionContent,
  objectId: string,
): readonly HomeEnergyAttributeDefinition[] {
  return content.attributes.filter((attribute) => attribute.objectId === objectId)
}

function attributeById(
  content: HomeEnergyDefinitionContent,
  objectId: string,
  attributeId: string,
): HomeEnergyAttributeDefinition | undefined {
  return content.attributes.find(
    (attribute) => attribute.objectId === objectId && attribute.id === attributeId,
  )
}

function objectById(
  content: HomeEnergyDefinitionContent,
  objectId: string,
): HomeEnergyObjectDefinition | undefined {
  return content.objects.find((object) => object.id === objectId)
}

function enumValuesOf(attribute: HomeEnergyAttributeDefinition | undefined): readonly string[] {
  return attribute?.enumValues ?? []
}

function hasSpecAttribute(attributes: readonly HomeEnergyAttributeDefinition[]): boolean {
  return attributes.some(
    (attribute) =>
      attribute.valueType === 'quantity' &&
      SPEC_ATTRIBUTE_SUFFIXES.some((suffix) => attribute.id.endsWith(suffix)),
  )
}

function checkPowerEnergyUnits(
  content: HomeEnergyDefinitionContent,
  out: HomeEnergySemanticIssue[],
): void {
  content.attributes.forEach((attribute, index) => {
    const isPower = attribute.id.endsWith('_kw')
    const isEnergy = attribute.id.endsWith('_kwh')
    const isPrice = attribute.id.endsWith('_price')
    if (!isPower && !isEnergy && !isPrice) return
    const pointer = `$.attributes[${index}]`
    if (attribute.valueType !== 'quantity' || attribute.unit === undefined) {
      out.push({
        code: 'CONFLATED_POWER_ENERGY',
        path: pointer,
        message: `"${attribute.id}" encodes a physical unit in its name and must be a quantity with an explicit unit`,
      })
      return
    }
    const unitMatches =
      (isPower && attribute.unit.unitCode === 'kW' && attribute.unit.dimension === 'power') ||
      (isEnergy && attribute.unit.unitCode === 'kWh' && attribute.unit.dimension === 'energy') ||
      (isPrice && attribute.unit.dimension === 'price')
    if (!unitMatches) {
      const expected = isPower ? 'kW/power' : isEnergy ? 'kWh/energy' : 'a price dimension'
      out.push({
        code: 'CONFLATED_POWER_ENERGY',
        path: `${pointer}.unit`,
        message: `"${attribute.id}" must declare ${expected}, not ${attribute.unit.unitCode}/${attribute.unit.dimension}`,
      })
    }
  })
}

function checkDeviceSensor(
  content: HomeEnergyDefinitionContent,
  out: HomeEnergySemanticIssue[],
): void {
  const deviceAttributes = attributesOf(content, 'device')
  const sensorAttributes = attributesOf(content, 'sensor')

  const device = objectById(content, 'device')
  const sensor = objectById(content, 'sensor')
  if (device === undefined || sensor === undefined) return

  if (device.identityScopeId === sensor.identityScopeId) {
    out.push({
      code: 'CONFLATED_DEVICE_SENSOR',
      path: '$.objects',
      message: 'a device and a measurement point (sensor) must use distinct identity scopes',
    })
  }

  if (!hasSpecAttribute(deviceAttributes)) {
    out.push({
      code: 'CONFLATED_DEVICE_SENSOR',
      path: '$.attributes',
      message: 'a device must declare at least one physical specification (rated_power_kw or energy_capacity_kwh)',
    })
  }

  const monitoredDevice = attributeById(content, 'sensor', 'monitored_device')
  if (
    monitoredDevice === undefined ||
    monitoredDevice.valueType !== 'reference' ||
    monitoredDevice.referencesObjectId !== 'device'
  ) {
    out.push({
      code: 'CONFLATED_DEVICE_SENSOR',
      path: '$.attributes',
      message: 'a sensor must reference the device it monitors; a device is not its own sensor entity',
    })
  }

  if (hasSpecAttribute(sensorAttributes)) {
    out.push({
      code: 'CONFLATED_DEVICE_SENSOR',
      path: '$.attributes',
      message: 'a sensor measures; it must not declare device specification attributes (rated_power_kw / energy_capacity_kwh)',
    })
  }

  if (attributeById(content, 'device', 'sensor_metric') !== undefined) {
    out.push({
      code: 'CONFLATED_DEVICE_SENSOR',
      path: '$.attributes',
      message: 'a device must not declare measurement-point attributes such as sensor_metric',
    })
  }
}

function checkForecastObserved(
  content: HomeEnergyDefinitionContent,
  out: HomeEnergySemanticIssue[],
): void {
  const observed = objectById(content, 'observation_series')
  const forecast = objectById(content, 'forecast_series')
  if (observed === undefined || forecast === undefined) return

  if (observed.identityScopeId === forecast.identityScopeId) {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.objects',
      message: 'an observation series and a forecast series must use distinct identity scopes',
    })
  }

  const recordedAt = attributeById(content, 'observation_series', 'recorded_at')
  if (recordedAt?.valueType !== 'timestamp') {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.attributes',
      message: 'an observation series must record the time it was measured (recorded_at timestamp)',
    })
  }
  const observedMode = enumValuesOf(attributeById(content, 'observation_series', 'observation_data_mode'))
  if (!observedMode.includes('observed') || observedMode.includes('forecast')) {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.attributes',
      message: 'observation_data_mode must include "observed" and must never include "forecast"',
    })
  }
  if (attributeById(content, 'observation_series', 'issued_at') !== undefined) {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.attributes',
      message: 'an observation series is recorded, not issued; issued_at belongs to a forecast series',
    })
  }

  const issuedAt = attributeById(content, 'forecast_series', 'issued_at')
  if (issuedAt?.valueType !== 'timestamp') {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.attributes',
      message: 'a forecast series must record when it was issued (issued_at timestamp)',
    })
  }
  const forecastMode = enumValuesOf(attributeById(content, 'forecast_series', 'forecast_data_mode'))
  if (!forecastMode.includes('forecast') || forecastMode.includes('observed')) {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.attributes',
      message: 'forecast_data_mode must include "forecast" and must never include "observed"',
    })
  }
  if (attributeById(content, 'forecast_series', 'recorded_at') !== undefined) {
    out.push({
      code: 'CONFLATED_FORECAST_OBSERVED',
      path: '$.attributes',
      message: 'a forecast series is issued, not recorded; recorded_at belongs to an observation series',
    })
  }
}

export function checkHomeEnergySemantics(
  content: HomeEnergyDefinitionContent,
): HomeEnergySemanticIssue[] {
  const out: HomeEnergySemanticIssue[] = []

  for (const objectId of HOME_ENERGY_REQUIRED_OBJECTS) {
    const object = objectById(content, objectId)
    if (object === undefined) {
      out.push({
        code: 'MISSING_OBJECT',
        path: '$.objects',
        message: `home-energy must define the "${objectId}" object`,
      })
      continue
    }
    if (!content.identityScopes.some((scope) => scope.objectId === objectId)) {
      out.push({
        code: 'MISSING_IDENTITY_SCOPE',
        path: '$.identityScopes',
        message: `"${objectId}" must declare an identity scope`,
      })
    }
  }

  checkPowerEnergyUnits(content, out)
  checkDeviceSensor(content, out)
  checkForecastObserved(content, out)

  return out
}
