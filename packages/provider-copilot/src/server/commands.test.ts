import { describe, expect, it } from "@effect/vitest";

import { mapCopilotSlashCommands, parseCopilotSlashCommand } from "./commands.ts";

describe("mapCopilotSlashCommands", () => {
  it("maps Copilot command metadata and omits T3-owned commands", () => {
    const result = mapCopilotSlashCommands([
      { name: "model", description: "Select a Copilot model." },
      { name: "mcp", description: "Manage MCP servers.", input: { hint: "command" } },
      { name: "mcp", description: "Duplicate." },
      { name: "plan", description: "Plan a change." },
      { name: " " },
    ]);

    expect(result).toEqual([
      { name: "mcp", description: "Manage MCP servers.", input: { hint: "command" } },
    ]);
  });

  it("parses only known Copilot slash commands", () => {
    const commandNames = new Set(["skills", "mcp"]);

    expect(parseCopilotSlashCommand("/skills", commandNames)).toEqual({ name: "skills" });
    expect(parseCopilotSlashCommand("/mcp list", commandNames)).toEqual({
      name: "mcp",
      input: "list",
    });
    expect(parseCopilotSlashCommand("/unknown", commandNames)).toBeUndefined();
  });
});
