/**
 * `@ontology/industry-pack-home-energy` — the home-energy declaration pack (LOCAL-042).
 *
 * The pack owns semantics and declarative constraints only. It imports `@ontology/contracts`
 * and nothing else: no SDK, no database driver, no Home Assistant client, no connection
 * address, no credential, no physical column name and no executable script. The executable
 * energy formulas and planner belong to `extensions/home-energy`; concrete source naming
 * and units are aligned only through a customer mapping outside the pack.
 */
export {
  HOME_ENERGY_DEFINITION_ID,
  HOME_ENERGY_DEFINITION_VERSION,
  HOME_ENERGY_DEFINITIONS,
  HOME_ENERGY_NAMESPACE,
  HOME_ENERGY_STANDARD_PROVENANCE,
} from './definitions'
export {
  HOME_ENERGY_EXTENSION_REF,
  HOME_ENERGY_IDENTITY_POLICY_REF,
  HOME_ENERGY_QUERY_TEMPLATES_REF,
  HOME_ENERGY_REQUIRED_CAPABILITIES,
  HOME_ENERGY_RULE_POLICY_REF,
  HOME_ENERGY_TEST_SUITE_REF,
  buildHomeEnergyManifest,
} from './manifest'
export {
  HOME_ENERGY_REPRESENTATIVE_QUESTIONS,
} from './questions'
export type { HomeEnergyQuestionIntent, HomeEnergyRepresentativeQuestion } from './questions'
export {
  HOME_ENERGY_REQUIRED_OBJECTS,
  checkHomeEnergySemantics,
} from './semantics'
export type { HomeEnergySemanticIssue, HomeEnergySemanticIssueCode } from './semantics'
export type {
  HomeEnergyAttributeDefinition,
  HomeEnergyAttributeValueType,
  HomeEnergyCardinality,
  HomeEnergyComparisonOperator,
  HomeEnergyDefinitionContent,
  HomeEnergyIdentityScopeDefinition,
  HomeEnergyObjectDefinition,
  HomeEnergyRelationDefinition,
  HomeEnergyRuleConstraintDefinition,
  HomeEnergyRuleExpression,
  HomeEnergyUnitRef,
} from './types'
