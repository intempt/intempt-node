export { Intempt, IntemptClient } from './client';
export { IntemptApiError } from './transport';
export { ApiKeyCredentials } from './credentials';
export { COMMERCE_EVENTS } from './ecommerce';
export { IDENTIFY_EVENT } from './ingest';
export { LIB_NAME, LIB_VERSION } from './stamp';
export type { FlagContext, FlagDetail, FlagReason } from './flags';

/** @deprecated Use `Intempt.init()`. Removed in 3.0.0. */
export { SDK } from './legacy';

export type {
  AliasOptions,
  BatchOptions,
  ConsentOptions,
  GroupOptions,
  Identifiers,
  IdentifyOptions,
  IntemptConfig,
  Logger,
  ProductLine,
  Properties,
  RecommendOptions,
  TrackEvent,
  TrackOptions,
} from './types';
