/** Orders strings by UTF-16 code unit. Unlike `localeCompare`, it ignores the host locale. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encode(value: unknown): string | undefined {
  // Primitives follow JSON.stringify: undefined, functions and symbols have no
  // encoding, non-finite numbers become null, and bigint throws.
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string | undefined;
  if (Array.isArray(value)) return `[${value.map((item) => encode(item) ?? "null").join(",")}]`;
  const members: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const item = encode((value as Record<string, unknown>)[key]);
    if (item !== undefined) members.push(`${JSON.stringify(key)}:${item}`);
  }
  return `{${members.join(",")}}`;
}

/**
 * JSON text with every object's keys in code-unit order, written directly.
 * Rebuilding an object and calling JSON.stringify cannot give this order,
 * because JavaScript always lists integer-like keys ("9", "10") first.
 */
export function canonicalJson(value: unknown): string {
  const text = encode(value);
  if (text === undefined) throw new TypeError("Value has no JSON encoding");
  return text;
}
