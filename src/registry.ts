import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TargetFieldSchema } from "@kontourai/traverse";

export type LookoutSourceKind = "web-page" | "api-record" | "structured-file";
export type StructuredFileFormat = "yaml" | "json" | "csv";
export type RenderPolicy = "never" | "on-shell-warning" | "always";

interface LookoutSourceBase {
  id: string;
  url: string;
  cadenceHint: string;
}

export interface ExtractableLookoutSource extends LookoutSourceBase {
  kind: "web-page" | "api-record";
  targetSchema: TargetFieldSchema[];
  renderPolicy: RenderPolicy;
  format?: never;
}

export interface StructuredFileLookoutSource extends LookoutSourceBase {
  kind: "structured-file";
  format: StructuredFileFormat;
  targetSchema?: never;
  renderPolicy?: never;
}

export type LookoutSource = ExtractableLookoutSource | StructuredFileLookoutSource;

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
    const source = parseSource(candidate, index, ids, issues);
    if (source !== undefined) sources.push(source);
  });

  if (issues.length > 0) throw new RegistryValidationError(issues);
  return new LookoutRegistry(sources);
}

function parseSource(
  candidate: unknown,
  index: number,
  ids: Map<string, number>,
  issues: string[],
): LookoutSource | undefined {
  const context = `sources[${index}]`;
  if (!isRecord(candidate)) {
    issues.push(`${context} must be an object`);
    return undefined;
  }
  const firstIssue = issues.length;
  const common = validateCommonSource(candidate, index, ids, issues);
  const source = candidate.kind === "structured-file"
    ? parseStructuredFileSource(candidate, common, issues)
    : candidate.kind === "web-page" || candidate.kind === "api-record"
      ? parseExtractableSource(candidate, candidate.kind, common, issues)
      : invalidSourceKind(candidate, common.label, issues);
  return issues.length === firstIssue ? source : undefined;
}

interface CommonSourceFields {
  id: string | undefined;
  url: string | undefined;
  cadenceHint: string | undefined;
  label: string;
}

function validateCommonSource(
  candidate: Record<string, unknown>,
  index: number,
  ids: Map<string, number>,
  issues: string[],
): CommonSourceFields {
  const context = `sources[${index}]`;
  const id = typeof candidate.id === "string" && candidate.id.trim() !== "" ? candidate.id : undefined;
  const label = id === undefined ? context : `${context} (id "${id}")`;
  if (id === undefined) {
    issues.push(`${context}.id must be a non-empty string`);
  } else {
    const first = ids.get(id);
    if (first !== undefined) issues.push(`${label}.id duplicates sources[${first}].id`);
    else ids.set(id, index);
  }
  const url = isHttpUrl(candidate.url) ? candidate.url : undefined;
  if (url === undefined) {
    issues.push(`${label}.url must be an absolute HTTP(S) URL`);
  }
  const cadenceHint = typeof candidate.cadenceHint === "string" && candidate.cadenceHint.trim() !== ""
    ? candidate.cadenceHint
    : undefined;
  if (cadenceHint === undefined) {
    issues.push(`${label}.cadenceHint must be a non-empty string`);
  }
  return { id, url, cadenceHint, label };
}

function parseStructuredFileSource(
  candidate: Record<string, unknown>,
  common: CommonSourceFields,
  issues: string[],
): StructuredFileLookoutSource | undefined {
  if (!isStructuredFileFormat(candidate.format)) {
    issues.push(`${common.label}.format must be "yaml", "json", or "csv"`);
  }
  if (candidate.targetSchema !== undefined) {
    issues.push(`${common.label}.targetSchema is not allowed for structured-file sources`);
  }
  if (candidate.renderPolicy !== undefined) {
    issues.push(`${common.label}.renderPolicy is not allowed for structured-file sources`);
  }
  if (
    common.id === undefined || common.url === undefined || common.cadenceHint === undefined ||
    !isStructuredFileFormat(candidate.format)
  ) return undefined;
  return {
    id: common.id,
    kind: "structured-file",
    format: candidate.format,
    url: common.url,
    cadenceHint: common.cadenceHint,
  };
}

function parseExtractableSource(
  candidate: Record<string, unknown>,
  kind: "web-page" | "api-record",
  common: CommonSourceFields,
  issues: string[],
): ExtractableLookoutSource | undefined {
  if (!isRenderPolicy(candidate.renderPolicy)) {
    issues.push(`${common.label}.renderPolicy must be "never", "on-shell-warning", or "always"`);
  }
  const targetSchema = validateTargetSchema(candidate.targetSchema, common.label, issues)
    ? candidate.targetSchema
    : undefined;
  if (candidate.format !== undefined) {
    issues.push(`${common.label}.format is only allowed for structured-file sources`);
  }
  if (
    common.id === undefined || common.url === undefined || common.cadenceHint === undefined ||
    !isRenderPolicy(candidate.renderPolicy) || targetSchema === undefined
  ) return undefined;
  return {
    id: common.id,
    kind,
    url: common.url,
    targetSchema,
    cadenceHint: common.cadenceHint,
    renderPolicy: candidate.renderPolicy,
  };
}

function invalidSourceKind(
  candidate: Record<string, unknown>,
  label: string,
  issues: string[],
): undefined {
  issues.push(`${label}.kind must be "web-page", "api-record", or "structured-file"`);
  if (!isRenderPolicy(candidate.renderPolicy)) {
    issues.push(`${label}.renderPolicy must be "never", "on-shell-warning", or "always"`);
  }
  validateTargetSchema(candidate.targetSchema, label, issues);
  if (candidate.format !== undefined) {
    issues.push(`${label}.format is only allowed for structured-file sources`);
  }
  return undefined;
}

function isStructuredFileFormat(value: unknown): value is StructuredFileFormat {
  return value === "yaml" || value === "json" || value === "csv";
}

function isRenderPolicy(value: unknown): value is RenderPolicy {
  return value === "never" || value === "on-shell-warning" || value === "always";
}

function validateTargetSchema(
  value: unknown,
  context: string,
  issues: string[],
): value is TargetFieldSchema[] {
  const firstIssue = issues.length;
  if (!Array.isArray(value)) {
    issues.push(`${context}.targetSchema must be an array`);
    return false;
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
  return issues.length === firstIssue;
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
