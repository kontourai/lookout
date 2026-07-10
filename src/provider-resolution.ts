import { resolve } from "@kontourai/datum";

/** L2 capability seam. L1 accepts this capability but never invokes it. */
export type ProviderResolver = typeof resolve;

export const defaultProviderResolver: ProviderResolver = resolve;
