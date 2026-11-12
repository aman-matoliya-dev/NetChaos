import type { NetworkProfile } from "../types";
import { PROFILE_DEFINITIONS, type ProfileDefinition } from "./defaults";

export { PROFILE_DEFINITIONS, type ProfileDefinition };

/** All built-in profile names. */
export const PROFILE_NAMES: readonly NetworkProfile[] = Object.freeze(
  Object.keys(PROFILE_DEFINITIONS) as NetworkProfile[],
);

/** Type guard: is `value` the name of a built-in profile? */
export function isProfileName(value: unknown): value is NetworkProfile {
  return typeof value === "string" && (PROFILE_NAMES as readonly string[]).includes(value);
}

/** Returns the (frozen) definition of a built-in profile. */
export function getProfileDefinition(name: NetworkProfile): ProfileDefinition {
  return PROFILE_DEFINITIONS[name];
}
