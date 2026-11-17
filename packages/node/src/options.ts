import { PdqError } from "./errors";

export function invalidArgument(message: string): PdqError {
  return new PdqError("INVALID_ARGUMENT", message);
}

export function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

export function requireObject(label: string, value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArgument(`${label} must be an object. received=${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

export function requireNonEmptyString(label: string, value: unknown): string {
  if (typeof value !== "string") {
    throw invalidArgument(`${label} must be a string. received=${describe(value)}`);
  }
  if (value.length === 0) {
    throw invalidArgument(`${label} must not be empty`);
  }
  return value;
}

export function optionalString(label: string, value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidArgument(`${label} must be a string when provided. received=${describe(value)}`);
  }
  return value;
}

const MAX_UINT32 = 4_294_967_295;

export function optionalPositiveUint32(label: string, value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_UINT32) {
    throw invalidArgument(
      `${label} must be an integer between 1 and ${MAX_UINT32} when provided. received=${String(value)}`,
    );
  }
  return value;
}
