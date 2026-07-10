import {
  canonicalValueKey,
  type DiffKernelError,
  type DiffResult,
  type IdentityResult,
} from "./canonical-value.js";

export interface StructuralFacts<T> {
  readonly valueChanged: boolean;
  readonly provenanceChanged: boolean;
}

export type StructuralComparison<T> = DiffResult<StructuralFacts<T>>;

export interface StructuralComparisonOptions<T> {
  readonly value?: (item: T) => unknown;
  readonly provenance?: (item: T) => unknown;
}

function callbackError(label: string, cause: unknown): DiffKernelError {
  return { kind: "callback-threw", message: `${label} callback threw`, cause };
}

function projected<T>(label: string, projector: (item: T) => unknown, item: T): DiffResult<unknown> {
  try {
    return { ok: true, value: projector(item) };
  } catch (cause) {
    return { ok: false, error: callbackError(label, cause) };
  }
}

function equalCanonical(prior: unknown, current: unknown): DiffResult<boolean> {
  const priorKey = canonicalValueKey(prior);
  if (!priorKey.ok) return priorKey;
  const currentKey = canonicalValueKey(current);
  if (!currentKey.ok) return currentKey;
  return { ok: true, value: priorKey.key === currentKey.key };
}

export function compareStructural<T>(
  prior: T,
  current: T,
  options: StructuralComparisonOptions<T> = {},
): StructuralComparison<T> {
  const valueProjector = options.value ?? ((item: T) => item);
  const priorValue = projected("value", valueProjector, prior);
  if (!priorValue.ok) return priorValue;
  const currentValue = projected("value", valueProjector, current);
  if (!currentValue.ok) return currentValue;
  const valueEqual = equalCanonical(priorValue.value, currentValue.value);
  if (!valueEqual.ok) return valueEqual;

  let provenanceChanged = false;
  if (options.provenance) {
    const priorProvenance = projected("provenance", options.provenance, prior);
    if (!priorProvenance.ok) return priorProvenance;
    const currentProvenance = projected("provenance", options.provenance, current);
    if (!currentProvenance.ok) return currentProvenance;
    const provenanceEqual = equalCanonical(priorProvenance.value, currentProvenance.value);
    if (!provenanceEqual.ok) return provenanceEqual;
    provenanceChanged = !provenanceEqual.value;
  }
  return { ok: true, value: { valueChanged: !valueEqual.value, provenanceChanged } };
}

export interface KeyedMultisetFacts<T, K extends string> {
  readonly unchanged: boolean;
  readonly retained: readonly { readonly prior: T; readonly current: T }[];
  readonly additions: readonly T[];
  readonly removals: readonly T[];
}

export interface KeyedMultisetOptions<T, K extends string> {
  readonly identity: (item: T) => K | IdentityResult<K>;
}

function identityOf<T, K extends string>(
  callback: (item: T) => K | IdentityResult<K>,
  item: T,
): DiffResult<K> {
  try {
    const result = callback(item);
    if (typeof result === "string") return { ok: true, value: result };
    return result.ok ? { ok: true, value: result.key } : result;
  } catch (cause) {
    return { ok: false, error: callbackError("identity", cause) };
  }
}

export function diffKeyedMultiset<T, K extends string>(
  prior: readonly T[],
  current: readonly T[],
  options: KeyedMultisetOptions<T, K>,
): DiffResult<KeyedMultisetFacts<T, K>> {
  const currentKeys: K[] = [];
  for (const item of current) {
    const identity = identityOf(options.identity, item);
    if (!identity.ok) return identity;
    currentKeys.push(identity.value);
  }
  const queues = new Map<K, number[]>();
  for (let index = 0; index < currentKeys.length; index += 1) {
    const key = currentKeys[index]!;
    const queue = queues.get(key) ?? [];
    queue.push(index);
    queues.set(key, queue);
  }

  const retained: { prior: T; current: T }[] = [];
  const removals: T[] = [];
  const matchedCurrent = new Set<number>();
  for (const item of prior) {
    const identity = identityOf(options.identity, item);
    if (!identity.ok) return identity;
    const currentIndex = queues.get(identity.value)?.shift();
    if (currentIndex === undefined) removals.push(item);
    else {
      matchedCurrent.add(currentIndex);
      retained.push({ prior: item, current: current[currentIndex]! });
    }
  }
  const additions = current.filter((_item, index) => !matchedCurrent.has(index));
  return {
    ok: true,
    value: { unchanged: additions.length === 0 && removals.length === 0, retained, additions, removals },
  };
}
