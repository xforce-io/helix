export type {
  BindingSetCardMapping,
  BudgetAndAuth,
  CapabilityCard,
  CardDoc,
  CardEffectSummary,
  CardKind,
  CardRef,
  CardReplay,
  CatalogPinsSlice,
  EffectClass,
  InjectionTarget,
  NormativePayload,
  RegistrationScope,
  SurfaceEntry,
} from './types.js'
export {
  ALLOWED_KERNEL_NS_PREFIXES,
  EFFECT_CLASSES,
  HARNESS_CONTROL_NAMESPACES,
} from './types.js'

export type {
  CatalogErrorCode,
  CatalogValidationFail,
  CatalogValidationOk,
  CatalogValidationResult,
} from './errors.js'
export {
  CatalogError,
  catalogError,
  validationFail,
  validationOk,
} from './errors.js'

export { checkOccupancy, defaultOccupies, resolveOccupies } from './occupancy.js'

export {
  assertEffectClassesMatchSurface,
  channelMetaKey,
  deriveEffectClasses,
  extractNormativePayload,
  normalizeCard,
  normativePayloadKey,
  validateCardStructure,
  validateFixtureCard,
  validateProductionAdmission,
} from './validate.js'

export {
  CapabilityCatalogRegistry,
  getDefaultRegistry,
  getProductionCard,
  listProductionCards,
  registerCard,
  setDefaultRegistryForTests,
} from './registry.js'

export { renderCardDoc, renderCardDocFromCard } from './render.js'

export type {
  CapabilityCardResolved,
  RuntimeCapabilitySetId,
} from './binding-set-map.js'
export {
  CATALOG_BINDING_SET_MAPPING_VERSION,
  isRuntimeCapabilitySetId,
  resolveCapabilitySet,
  resolveCardRefs,
  RUNTIME_CAPABILITY_SETS,
} from './binding-set-map.js'
