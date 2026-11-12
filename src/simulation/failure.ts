import type { RandomSource } from "../types";
import { drawUnit } from "./random";

/**
 * Decides whether ONE request should be intentionally failed.
 *
 * `0` never fails and `1` always fails (neither consumes randomness). For any
 * rate in between, a number is drawn uniformly from [0, 1) and the request
 * fails when it is strictly below the rate, so P(fail) equals the rate.
 * Every call is an independent draw.
 */
export function shouldFail(failureRate: number, random: RandomSource): boolean {
  if (!(failureRate > 0)) return false;
  if (failureRate >= 1) return true;
  return drawUnit(random) < failureRate;
}
