import { z } from "zod";

export type ValidationResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Every component type is registered here with its Zod schema. The schema is
 * triple-duty: validates all mutations (AI output included), auto-generates
 * inspector UI, and exports as JSON Schema for the AI's machine-readable spec.
 */
export class ComponentRegistry {
  private schemas = new Map<string, z.ZodType>();

  register(name: string, schema: z.ZodType): void {
    if (this.schemas.has(name)) {
      throw new Error(`component "${name}" is already registered`);
    }
    this.schemas.set(name, schema);
  }

  has(name: string): boolean {
    return this.schemas.has(name);
  }

  names(): string[] {
    return [...this.schemas.keys()];
  }

  /** Validate and normalize (defaults applied) component data. */
  validate(name: string, data: unknown): ValidationResult {
    const schema = this.schemas.get(name);
    if (!schema) {
      return { ok: false, error: `unknown component type "${name}"` };
    }
    const result = schema.safeParse(data);
    if (!result.success) {
      return { ok: false, error: z.prettifyError(result.error) };
    }
    return { ok: true, data: result.data };
  }

  /** JSON Schema per component — handed to the AI as its spec of what it can build. */
  jsonSchemas(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, schema] of this.schemas) {
      out[name] = z.toJSONSchema(schema, { io: "input" });
    }
    return out;
  }
}
