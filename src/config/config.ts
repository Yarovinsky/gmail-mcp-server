/**
 * Configuration types (HLD §10). The Zod schema in `configSchema.ts` is the
 * single source of truth; the sub-types here are derived from the inferred
 * `Config` so they can never drift from the schema.
 */

import type { Config, ConfigInput } from './configSchema.js';

export type { Config, ConfigInput };

export type OAuthConfig = Config['oauth'];
export type FeaturesConfig = Config['features'];
export type LimitsConfig = Config['limits'];
export type DownloadsConfig = Config['downloads'];
export type SafetyConfig = Config['safety'];
export type LoggingConfig = Config['logging'];

/** A feature-flag name (key of the §9.3 `features` object). */
export type FeatureFlag = keyof FeaturesConfig;

/** Attachment collision policy (§15.3). */
export type CollisionPolicy = DownloadsConfig['collisionPolicy'];

/** Transport kind (§8). */
export type TransportKind = Config['transport'];

/** Log level. */
export type LogLevel = LoggingConfig['level'];
