/**
 * Feature-flag helpers (HLD §9.3, §10). Derives the list of enabled features from
 * the config `features` object — used by `health` and `gmail_get_profile` to report
 * `enabledFeatures` (§12.1).
 */

import type { FeatureFlag, FeaturesConfig } from './config.js';

/** The names of all enabled feature flags, in declaration order. */
export function listEnabledFeatures(features: FeaturesConfig): FeatureFlag[] {
  return (Object.entries(features) as [FeatureFlag, boolean][])
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}
