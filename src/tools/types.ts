import type { z } from "zod";
import type { BackloggdApi } from "../api/index.js";
import type { SessionManager } from "../auth/session.js";
import type { HttpClient } from "../http/client.js";
import type { Config } from "../config.js";

export interface ToolContext {
  api: BackloggdApi;
  session: SessionManager;
  http: HttpClient;
  config: Config;
}

/**
 * A registered tool, with its argument type erased.
 *
 * The erasure matters: handlers are contravariant in their argument type, so an array
 * of differently-shaped `ToolDef<Shape>` values has no useful common supertype. Tools
 * are therefore authored through `defineTool`, which keeps full inference inside the
 * handler body, and stored as this erased type.
 */
export interface AnyToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Mutates the account. Refused in read-only mode and throttled harder. */
  write?: boolean;
  /**
   * Destroys data that cannot be recovered. Requires a two-phase confirmation token;
   * see src/confirm.ts for why a boolean flag is not enough.
   */
  destructive?: boolean;
  handler: (args: never, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolDef<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  write?: boolean;
  destructive?: boolean;
  handler: (
    args: z.objectOutputType<Shape, z.ZodTypeAny>,
    ctx: ToolContext,
  ) => Promise<unknown>;
}

/** Authoring helper: infers `args` from `inputSchema`, returns the erased type. */
export function defineTool<Shape extends z.ZodRawShape>(def: ToolDef<Shape>): AnyToolDef {
  return def as unknown as AnyToolDef;
}
