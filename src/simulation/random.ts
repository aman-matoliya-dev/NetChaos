import { NetChaosConfigError } from "../errors/NetChaosError";
import type { RandomSource } from "../types";

/**
 * Default randomness: `Math.random`, wrapped so it is called unbound.
 * NetChaos keeps no random state of its own, so instances never influence each
 * other. (`Math.random` itself is the runtime's shared generator.)
 */
export const defaultRandom: RandomSource = () => Math.random();

/**
 * Draws one number from `random` and validates it is within [0, 1). This is the
 * single place randomness is consumed, which keeps the engine easy to make
 * deterministic (for example, seeded) in a future version.
 */
export function drawUnit(random: RandomSource): number {
  const value: unknown = random();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new NetChaosConfigError(
      "Invalid random source: it must return a finite number greater than or equal to 0 and less than 1.",
    );
  }
  return value;
}
