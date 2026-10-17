import type { OrchestrationV2TurnItem, ProviderRequestKind } from "@t3tools/contracts";
import type { PermissionRequest } from "@github/copilot-sdk";

type Fields<
  T extends OrchestrationV2TurnItem["type"],
  K extends keyof Extract<OrchestrationV2TurnItem, { type: T }>,
> = Pick<Extract<OrchestrationV2TurnItem, { type: T }>, K>;

export type CopilotToolPresentation =
  | Fields<"command_execution", "type" | "input" | "output" | "exitCode">
  | Fields<"file_change", "type" | "fileName" | "oldStr" | "newStr" | "diffStr">
  | Fields<"file_search", "type" | "pattern">
  | Fields<"web_search", "type" | "patterns">
  | Fields<"dynamic_tool", "type" | "toolName" | "input" | "output">;

export interface CopilotToolState {
  readonly toolName: string;
  readonly mcpServerName?: string | undefined;
  readonly mcpToolName?: string | undefined;
  readonly arguments?: unknown;
  readonly shellCommand?: string | undefined;
  output: string;
  exitCode?: number | undefined;
  detail?: string | undefined;
}

// Copilot's bookkeeping tools; they carry no work the user needs to see.
export const HIDDEN_COPILOT_TOOLS: ReadonlySet<string> = new Set(["report_intent"]);

function stringArg(args: unknown, ...keys: ReadonlyArray<string>): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export function copilotToolTitle(tool: CopilotToolState): string {
  if (tool.mcpServerName) return `${tool.mcpServerName}/${tool.mcpToolName ?? tool.toolName}`;
  return tool.toolName;
}

export function copilotToolPresentation(tool: CopilotToolState): CopilotToolPresentation {
  const name = tool.toolName.toLowerCase();
  const args = tool.arguments;
  const output = tool.detail ? [tool.detail, tool.output].filter(Boolean).join("\n") : tool.output;

  if (
    !tool.mcpServerName &&
    (tool.shellCommand !== undefined || /bash|shell|powershell/.test(name))
  ) {
    return {
      type: "command_execution",
      input: tool.shellCommand ?? stringArg(args, "command", "cmd") ?? "",
      output,
      ...(tool.exitCode === undefined ? {} : { exitCode: tool.exitCode }),
    };
  }
  if (!tool.mcpServerName && /^(edit|create|write|str_replace|apply_patch)/.test(name)) {
    const fileName = stringArg(args, "path", "file_path", "filePath")?.trim();
    if (fileName) {
      const oldStr = stringArg(args, "old_str", "old_string");
      const newStr = stringArg(args, "new_str", "new_string", "file_text", "content");
      const diffStr = stringArg(args, "patch", "diff");
      return {
        type: "file_change",
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
  }
  if (!tool.mcpServerName && /^(grep|glob|rg|search_code)/.test(name)) {
    const pattern = stringArg(args, "pattern", "query");
    return { type: "file_search", ...(pattern ? { pattern } : {}) };
  }
  if (!tool.mcpServerName && /web_?(search|fetch)|fetch_?url/.test(name)) {
    const query = stringArg(args, "query", "url")?.trim();
    return { type: "web_search", ...(query ? { patterns: [query] } : {}) };
  }
  return {
    type: "dynamic_tool",
    toolName: copilotToolTitle(tool),
    input: args ?? null,
    output,
  };
}

export function copilotRequestKind(request: PermissionRequest): ProviderRequestKind {
  switch (request.kind) {
    case "shell":
      return "command";
    case "write":
      return "file-change";
    case "read":
      return "file-read";
    default:
      return "permission";
  }
}

export function copilotPermissionPrompt(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return request.fullCommandText.trim() || request.intention.trim();
    case "write":
      return request.fileName.trim() || request.intention.trim();
    case "read":
      return request.path.trim() || request.intention.trim();
    case "mcp":
      return `${request.serverName}/${request.toolName}`;
    case "url":
      return request.url;
    default:
      return "GitHub Copilot requests permission";
  }
}

export function copilotPermissionOffersSession(request: PermissionRequest): boolean {
  return request.kind === "shell" || request.kind === "write"
    ? request.canOfferSessionApproval
    : true;
}
