import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TargetFieldSchema } from "@kontourai/traverse";

export type LookoutSourceKind = "web-page" | "api-record";
export type RenderPolicy = "never" | "on-shell-warning" | "always";

export interface LookoutSource {
  id: string;
  kind: LookoutSourceKind;
  url: string;
  targetSchema: TargetFieldSchema[];
  cadenceHint: string;
  renderPolicy: RenderPolicy;
}

export interface LookoutRegistryDocument {
  version: 1;
  sources: LookoutSource[];
}

export class RegistryValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid Lookout registry:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "RegistryValidationError";
    this.issues = issues;
  }
}

export class LookoutRegistry {
  readonly version = 1 as const;
  readonly sources: readonly LookoutSource[];
  readonly #byId: Map<string, LookoutSource>;

  constructor(sources: LookoutSource[]) {
    this.sources = sources;
    this.#byId = new Map(sources.map((source) => [source.id, source]));
  }

  list(): readonly LookoutSource[] {
    return this.sources;
  }

  get(id: string): LookoutSource | undefined {
    return this.#byId.get(id);
  }
}

export async function loadRegistry(
  registryPath = path.join(process.cwd(), "lookout.sources.json"),
): Promise<LookoutRegistry> {
  const raw = await readFile(registryPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RegistryValidationError([`document is not valid JSON: ${message}`]);
  }
  return parseRegistry(parsed);
}

export function parseRegistry(value: unknown): LookoutRegistry {
  const issues: string[] = [];
  if (!isRecord(value)) {
    throw new RegistryValidationError(["document must be an object"]);
  }
  if (value.version !== 1) issues.push("version must be exactly 1");
  if (!Array.isArray(value.sources)) {
    issues.push("sources must be an array");
    throw new RegistryValidationError(issues);
  }

  const ids = new Map<string, number>();
  const sources: LookoutSource[] = [];
  value.sources.forEach((candidate, index) => {
    const context = `sources[${index}]`;
    if (!isRecord(candidate)) {
      issues.push(`${context} must be an object`);
      return;
    }
    const id = candidate.id;
    const label = typeof id === "string" && id.trim() ? `${context} (id "${id}")` : context;
    if (typeof id !== "string" || id.trim() === "") {
      issues.push(`${context}.id must be a non-empty string`);
    } else {
      const first = ids.get(id);
      if (first !== undefined) issues.push(`${label}.id duplicates sources[${first}].id`);
      else ids.set(id, index);
    }
    if (candidate.kind !== "web-page" && candidate.kind !== "api-record") {
      issues.push(`${label}.kind must be "web-page" or "api-record"`);
    }
    if (!isHttpUrl(candidate.url)) {
      issues.push(`${label}.url must be an absolute HTTP(S) URL`);
    }
    if (typeof candidate.cadenceHint !== "string" || candidate.cadenceHint.trim() === "") {
      issues.push(`${label}.cadenceHint must be a non-empty string`);
    }
    if (
      candidate.renderPolicy !== "never" &&
      candidate.renderPolicy !== "on-shell-warning" &&
      candidate.renderPolicy !== "always"
    ) {
      issues.push(`${label}.renderPolicy must be "never", "on-shell-warning", or "always"`);
    }
    validateTargetSchema(candidate.targetSchema, label, issues);

    if (
      typeof id === "string" && id.trim() !== "" &&
      (candidate.kind === "web-page" || candidate.kind === "api-record") &&
      isHttpUrl(candidate.url) &&
      typeof candidate.cadenceHint === "string" && candidate.cadenceHint.trim() !== "" &&
      (candidate.renderPolicy === "never" || candidate.renderPolicy === "on-shell-warning" || candidate.renderPolicy === "always") &&
      Array.isArray(candidate.targetSchema)
    ) {
      sources.push(candidate as unknown as LookoutSource);
    }
  });

  if (issues.length > 0) throw new RegistryValidationError(issues);
  return new LookoutRegistry(sources);
}

function validateTargetSchema(value: unknown, context: string, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push(`${context}.targetSchema must be an array`);
    return;
  }
  const allowedTypes = new Set(["string", "number", "boolean", "date", "enum", "array", "object"]);
  value.forEach((field, index) => {
    const label = `${context}.targetSchema[${index}]`;
    if (!isRecord(field)) {
      issues.push(`${label} must be an object`);
      return;
    }
    if (typeof field.path !== "string" || field.path.trim() === "") issues.push(`${label}.path must be a non-empty string`);
    if (typeof field.type !== "string" || !allowedTypes.has(field.type)) issues.push(`${label}.type is invalid`);
    if (field.enumValues !== undefined && (!Array.isArray(field.enumValues) || field.enumValues.some((item) => typeof item !== "string"))) {
      issues.push(`${label}.enumValues must be an array of strings`);
    }
    if (field.type === "enum" && (!Array.isArray(field.enumValues) || field.enumValues.length === 0)) {
      issues.push(`${label}.enumValues must be non-empty for enum fields`);
    }
    if (field.description !== undefined && typeof field.description !== "string") issues.push(`${label}.description must be a string`);
    if (field.required !== undefined && typeof field.required !== "boolean") issues.push(`${label}.required must be a boolean`);
    if (field.inferenceType !== undefined && field.inferenceType !== "explicit" && field.inferenceType !== "inferred") {
      issues.push(`${label}.inferenceType must be "explicit" or "inferred"`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}
