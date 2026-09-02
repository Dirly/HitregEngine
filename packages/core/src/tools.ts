import { z } from "zod";

export const toolIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*$/, "use lowercase dot-separated ids (for example hitreg.armor-atlas)");

const commonInput = {
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  required: z.boolean().default(true),
};

const stringInputSchema = z.object({
  ...commonInput,
  kind: z.literal("string"),
  default: z.string().optional(),
  placeholder: z.string().optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().positive().optional(),
  pattern: z.string().optional(),
});

const numberInputSchema = z.object({
  ...commonInput,
  kind: z.literal("number"),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().positive().optional(),
  integer: z.boolean().default(false),
});

const booleanInputSchema = z.object({
  ...commonInput,
  kind: z.literal("boolean"),
  default: z.boolean().default(false),
});

const selectInputSchema = z.object({
  ...commonInput,
  kind: z.literal("select"),
  options: z.array(z.object({ value: z.string(), label: z.string().min(1) })).min(1),
  default: z.string().optional(),
});

const fileInputSchema = z.object({
  ...commonInput,
  kind: z.literal("file"),
  accept: z.array(z.string().min(1)).min(1).optional(),
  maxBytes: z.number().int().positive().optional(),
});

export const toolInputSchema = z.discriminatedUnion("kind", [
  stringInputSchema,
  numberInputSchema,
  booleanInputSchema,
  selectInputSchema,
  fileInputSchema,
]);

export const toolDefinitionSchema = z
  .object({
    version: z.literal(1).default(1),
    id: toolIdSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    surfaces: z.array(z.enum(["tools", "assets"])).min(1).default(["tools"]),
    permissions: z.array(z.string().regex(/^[a-z][a-z0-9.*:-]*$/)).default([]),
    inputs: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), toolInputSchema),
  })
  .superRefine((definition, ctx) => {
    for (const [name, input] of Object.entries(definition.inputs)) {
      if (input.kind === "string") {
        if (
          input.minLength !== undefined &&
          input.maxLength !== undefined &&
          input.minLength > input.maxLength
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["inputs", name],
            message: "minLength must not exceed maxLength",
          });
        }
        if (input.pattern !== undefined) {
          try {
            new RegExp(input.pattern);
          } catch {
            ctx.addIssue({
              code: "custom",
              path: ["inputs", name, "pattern"],
              message: "invalid regular expression",
            });
          }
        }
      }
      if (
        input.kind === "number" &&
        input.min !== undefined &&
        input.max !== undefined &&
        input.min > input.max
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs", name],
          message: "min must not exceed max",
        });
      }
      if (
        input.kind === "select" &&
        input.default !== undefined &&
        !input.options.some((option) => option.value === input.default)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs", name, "default"],
          message: "default must name one of the options",
        });
      }
    }
  });

/** Host-only extension of the public definition. `entry` is never published. */
export const toolManifestSchema = toolDefinitionSchema.safeExtend({
  entry: z.string().min(1),
});

export const toolFileValueSchema = z.object({
  name: z.string().min(1),
  mediaType: z.string().min(1),
  /** Base64 bytes without a data-URL prefix. */
  data: z
    .string()
    .min(1)
    .regex(
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
      "invalid base64 data",
    ),
});

export const toolResultSchema = z.object({
  assets: z
    .array(
      z.object({
        kind: z.string().min(1),
        id: z.string().min(1),
        file: z.string().min(1),
      }),
    )
    .default([]),
  previews: z
    .array(
      z.object({
        label: z.string().min(1),
        mediaType: z.string().min(1),
        /** Base64 bytes without a data-URL prefix. */
        data: z.string().min(1),
      }),
    )
    .default([]),
  warnings: z.array(z.string()).default([]),
  report: z.unknown().optional(),
  log: z.string().optional(),
});

export type ToolInput = z.infer<typeof toolInputSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolManifest = z.infer<typeof toolManifestSchema>;
export type ToolFileValue = z.infer<typeof toolFileValueSchema>;
export type ToolResult = z.infer<typeof toolResultSchema>;

export interface ToolDescription extends ToolDefinition {
  /** Exact invocation payload schema, generated from the validators below. */
  inputSchema: unknown;
}

export type ToolValidationResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

function valueSchema(input: ToolInput): z.ZodType {
  switch (input.kind) {
    case "string": {
      let schema = z.string();
      if (input.minLength !== undefined) schema = schema.min(input.minLength);
      if (input.maxLength !== undefined) schema = schema.max(input.maxLength);
      if (input.pattern !== undefined) schema = schema.regex(new RegExp(input.pattern));
      return schema;
    }
    case "number": {
      let schema = z.number().finite();
      if (input.integer) schema = schema.int();
      if (input.min !== undefined) schema = schema.min(input.min);
      if (input.max !== undefined) schema = schema.max(input.max);
      return schema;
    }
    case "boolean":
      return z.boolean();
    case "select": {
      const values = input.options.map((option) => option.value) as [string, ...string[]];
      return z.enum(values);
    }
    case "file": {
      const mediaType = input.accept
        ? z.enum(input.accept as [string, ...string[]])
        : z.string().min(1);
      let data = z
        .string()
        .min(1)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          "invalid base64 data",
        );
      if (input.maxBytes !== undefined) {
        data = data.max(Math.ceil(input.maxBytes / 3) * 4);
      }
      return z
        .object({ name: z.string().min(1), mediaType, data })
        .superRefine((file, ctx) => {
        if (input.maxBytes !== undefined) {
          const padding = file.data.endsWith("==") ? 2 : file.data.endsWith("=") ? 1 : 0;
          const bytes = Math.floor((file.data.length * 3) / 4) - padding;
          if (bytes > input.maxBytes) {
            ctx.addIssue({
              code: "custom",
              path: ["data"],
              message: `file exceeds ${input.maxBytes} bytes`,
            });
          }
        }
      });
    }
  }
}

function invocationSchema(definition: ToolDefinition): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, input] of Object.entries(definition.inputs)) {
    let schema = valueSchema(input);
    if ("default" in input) schema = schema.default(input.default as never);
    else if (!input.required) schema = schema.optional();
    shape[name] = schema;
  }
  return z.object(shape).strict();
}

/**
 * Public registry for editor/asset tools contributed by the engine or plugins.
 * Definitions drive validation, the generated editor form, and the AI spec;
 * execution stays in the trusted host that loaded the plugin.
 */
export class ToolRegistry {
  private definitions = new Map<string, ToolDefinition>();
  private schemas = new Map<string, z.ZodType<Record<string, unknown>>>();

  register(raw: unknown): ToolDefinition {
    const parsed = toolDefinitionSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid tool definition: ${z.prettifyError(parsed.error)}`);
    const definition = parsed.data;
    if (this.definitions.has(definition.id)) {
      throw new Error(`tool "${definition.id}" is already registered`);
    }
    const schema = invocationSchema(definition);
    for (const [name, input] of Object.entries(definition.inputs)) {
      if ("default" in input) {
        const result = valueSchema(input).safeParse(input.default);
        if (!result.success) {
          throw new Error(
            `invalid default for tool "${definition.id}" input "${name}": ${z.prettifyError(result.error)}`,
          );
        }
      }
    }
    this.definitions.set(definition.id, definition);
    this.schemas.set(definition.id, schema);
    return definition;
  }

  get(id: string): ToolDefinition | undefined {
    return this.definitions.get(id);
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()];
  }

  validate(id: string, inputs: unknown): ToolValidationResult {
    const schema = this.schemas.get(id);
    if (!schema) return { ok: false, error: `unknown tool "${id}"` };
    const result = schema.safeParse(inputs);
    if (!result.success) return { ok: false, error: z.prettifyError(result.error) };
    return { ok: true, data: result.data };
  }

  describe(): Record<string, ToolDescription> {
    const out: Record<string, ToolDescription> = {};
    for (const [id, definition] of this.definitions) {
      out[id] = {
        ...definition,
        inputSchema: z.toJSONSchema(this.schemas.get(id)!, { io: "input" }),
      };
    }
    return out;
  }
}
