#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, redact } from "./config.js";
import { HttpClient } from "./http/client.js";
import { SessionManager } from "./auth/session.js";
import { BackloggdApi } from "./api/index.js";
import { readTools } from "./tools/read.js";
import { writeTools } from "./tools/write.js";
import type { AnyToolDef, ToolContext } from "./tools/types.js";
import {
  BackloggdError,
  ConfirmationRequiredError,
  ReadOnlyError,
} from "./errors.js";
import { runSelfTest } from "./selftest.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const config = loadConfig();
  const http = new HttpClient(config);
  const session = new SessionManager(config, http);
  const api = new BackloggdApi(http, session);
  const ctx: ToolContext = { api, session, http, config };

  if (process.argv.includes("--selftest")) {
    const ok = await runSelfTest(ctx);
    process.exit(ok ? 0 : 1);
  }

  const server = new McpServer(
    { name: "backloggd", version: VERSION },
    {
      instructions:
        "Backloggd game tracking. Read tools cover search, game metadata, libraries, " +
        "journals, lists and reviews. Write tools change the signed-in user's account, " +
        "so state plainly what you are about to change before calling one. Tools marked " +
        "destructive delete data irreversibly and require a two-step confirmation: the " +
        "first call returns an inventory of what would be lost plus a token, which you " +
        "must show the user and get agreement on before calling again with the token.",
    },
  );

  const tools: AnyToolDef[] = [...readTools, ...(config.readOnly ? [] : writeTools)];

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: !tool.write,
          destructiveHint: Boolean(tool.destructive),
          idempotentHint: !tool.destructive && Boolean(tool.write),
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          if (tool.write && config.readOnly) throw new ReadOnlyError(tool.name);

          // Authenticate here rather than inside each handler. Every tool reaches the
          // user's own data sooner or later, and leaving it to individual handlers is
          // how a tool ends up silently issuing unauthenticated requests: public
          // endpoints still answer, so the failure surfaces much later as a confusing
          // 500 from the first endpoint that actually needs a session. Idempotent and
          // cached, so this costs one request per process.
          await session.ensureAuthenticated();

          const result = await tool.handler(args as never, ctx);
          return { content: [{ type: "text" as const, text: stringify(result) }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: describeError(err) }], isError: true };
        }
      },
    );
  }

  if (config.readOnly) {
    process.stderr.write(
      "[backloggd-mcp] read-only mode: write tools are not registered.\n",
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[backloggd-mcp] v${VERSION} ready — ${tools.length} tools, auth mode '${config.authMode}'.\n`,
  );
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (v instanceof Map ? Object.fromEntries(v) : v), 2);
}

/**
 * Turn an error into something a model can act on. Confirmation prompts in particular
 * must come back as structured, readable content — that response is the safety
 * mechanism, not an incidental error string.
 */
function describeError(err: unknown): string {
  if (err instanceof ConfirmationRequiredError) {
    return JSON.stringify(
      {
        status: "confirmation_required",
        message: err.message,
        ...(err.preview as Record<string, unknown>),
        confirmation_token: err.confirmationToken,
      },
      null,
      2,
    );
  }
  if (err instanceof BackloggdError) {
    return JSON.stringify(
      { status: "error", code: err.code, message: err.message, hint: err.hint },
      null,
      2,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ status: "error", code: "UNEXPECTED", message: redact(message) }, null, 2);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  process.stderr.write(`[backloggd-mcp] fatal: ${redact(message)}\n`);
  process.exit(1);
});
