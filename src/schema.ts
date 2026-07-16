export function assertSchema(value: unknown, schema: Record<string, any>, path = "$", depth = 0): void {
  if (depth > 30) throw new Error(`Schema validation exceeded maximum depth at ${path}.`);
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    const object = value as Record<string, unknown>;
    for (const key of schema.required || []) if (!(key in object)) throw new Error(`${path}.${key} is required.`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!schema.properties?.[key]) throw new Error(`${path}.${key} is not allowed.`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in object) assertSchema(object[key], child as Record<string, any>, `${path}.${key}`, depth + 1);
    return;
  }
  if (type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems) throw new Error(`${path} has too few items.`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) throw new Error(`${path} has too many items.`);
    value.forEach((item, index) => assertSchema(item, schema.items || {}, `${path}[${index}]`, depth + 1));
    return;
  }
  if (type === "string" && typeof value !== "string") throw new Error(`${path} must be a string.`);
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} must be a finite number.`);
  if (type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) throw new Error(`${path} must be an integer.`);
  if (type === "boolean" && typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${path} is not an allowed value.`);
}
