import { z, type ZodType } from "zod";
import { ValidationError } from "@/lib/errors";

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("Send a valid JSON request body.");
  }
}

export function validateBody<S extends ZodType>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues[0]?.message ?? "Check the details you entered.",
      parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data as z.infer<S>;
}
