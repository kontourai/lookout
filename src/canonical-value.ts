declare const canonicalValueKeyBrand: unique symbol;

export type CanonicalValueKey = string & {
  readonly [canonicalValueKeyBrand]: "CanonicalValueKey";
};

export type DiffKernelErrorKind =
  | "unsupported-value"
  | "cyclic-value"
  | "callback-threw";

export interface DiffKernelError {
  readonly kind: DiffKernelErrorKind;
  readonly message: string;
  readonly path?: string;
  readonly cause?: unknown;
}

export type DiffResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DiffKernelError };

export type IdentityResult<K extends string = string> =
  | { readonly ok: true; readonly key: K }
  | { readonly ok: false; readonly error: DiffKernelError };

export type CanonicalValueResult = IdentityResult<CanonicalValueKey>;

function frame(tag: string, value = ""): string {
  return `${tag}${value.length}:${value}`;
}

function unsupported(message: string, path: string): CanonicalValueResult {
  return { ok: false, error: { kind: "unsupported-value", message, path } };
}

function encode(value: unknown, path: string, ancestors: Set<object>): CanonicalValueResult {
  if (value === undefined) return { ok: true, key: frame("u") as CanonicalValueKey };
  if (value === null) return { ok: true, key: frame("n") as CanonicalValueKey };

  switch (typeof value) {
    case "boolean":
      return { ok: true, key: frame("b", value ? "1" : "0") as CanonicalValueKey };
    case "string":
      return { ok: true, key: frame("s", value) as CanonicalValueKey };
    case "bigint":
      return { ok: true, key: frame("i", value.toString(10)) as CanonicalValueKey };
    case "number": {
      const encoded = Number.isNaN(value)
        ? "nan"
        : value === Number.POSITIVE_INFINITY
          ? "+inf"
          : value === Number.NEGATIVE_INFINITY
            ? "-inf"
            : Object.is(value, -0)
              ? "-0"
              : String(value);
      return { ok: true, key: frame("d", encoded) as CanonicalValueKey };
    }
    case "symbol":
    case "function":
      return unsupported(`Cannot canonicalize ${typeof value}`, path);
    case "object":
      break;
  }

  const objectValue = value as object;
  if (ancestors.has(objectValue)) {
    return { ok: false, error: { kind: "cyclic-value", message: "Cannot canonicalize a cyclic value", path } };
  }
  ancestors.add(objectValue);
  try {
    if (Array.isArray(value)) {
      const parts: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          parts.push(frame("h"));
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          return unsupported("Cannot canonicalize an array accessor", `${path}[${index}]`);
        }
        const item = encode(descriptor.value, `${path}[${index}]`, ancestors);
        if (!item.ok) return item;
        parts.push(frame("e", item.key));
      }
      const extraKeys = Reflect.ownKeys(value).filter((key) => {
        if (key === "length") return false;
        return typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length;
      });
      if (extraKeys.length > 0) return unsupported("Cannot canonicalize an array with extra properties", path);
      return { ok: true, key: frame("a", parts.join("")) as CanonicalValueKey };
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return unsupported("Cannot canonicalize an exotic object", path);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      return unsupported("Cannot canonicalize an object with symbol keys", path);
    }
    const keys = (ownKeys as string[]).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        return unsupported("Cannot canonicalize an object accessor", `${path}.${key}`);
      }
      const item = encode(descriptor.value, `${path}.${key}`, ancestors);
      if (!item.ok) return item;
      parts.push(frame("k", key), frame("v", item.key));
    }
    return { ok: true, key: frame("o", parts.join("")) as CanonicalValueKey };
  } finally {
    ancestors.delete(objectValue);
  }
}

export function canonicalValueKey(value: unknown): CanonicalValueResult {
  try {
    return encode(value, "$", new Set<object>());
  } catch (cause) {
    return {
      ok: false,
      error: {
        kind: "unsupported-value",
        message: "Canonical value could not be inspected",
        path: "$",
        cause,
      },
    };
  }
}
