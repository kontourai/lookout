/** Orders strings by UTF-16 code unit. Unlike `localeCompare`, it ignores the host locale. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function encode(input: unknown, key: string): string | undefined {
  // Mirrors JSON.stringify apart from key order: toJSON is honoured (a Date
  // becomes its ISO string); undefined, functions and symbols have no encoding
  // (omitted from objects, null in arrays); array holes and non-finite numbers
  // become null; bigint throws.
  const value = input !== null && typeof input === "object" && typeof (input as { toJSON?: unknown }).toJSON === "function"
    ? (input as { toJSON(key: string): unknown }).toJSON(key)
    : input;
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string | undefined;
  // Array.from visits holes; Array.prototype.map would skip them and write `[,1]`.
  if (Array.isArray(value)) return `[${Array.from(value, (item, index) => encode(item, String(index)) ?? "null").join(",")}]`;
  const members: string[] = [];
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const item = encode((value as Record<string, unknown>)[key], key);
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
  const text = encode(value, "");
  if (text === undefined) throw new TypeError("Value has no JSON encoding");
  return text;
}
