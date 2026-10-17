import { describe, expect, it } from "@effect/vitest";

import { parseCopilotSkillsCliOutput } from "./skills.ts";

describe("parseCopilotSkillsCliOutput", () => {
  it("maps Copilot skill metadata into provider skills", () => {
    const result = parseCopilotSkillsCliOutput(
      JSON.stringify([
        {
          name: "review-pr",
          description: "Review a pull request.",
          enabled: true,
          path: "/Users/test/.agents/skills/review-pr",
          source: "personal-agents",
        },
        {
          name: "builtin-skill",
          description: "A built-in skill.",
          enabled: true,
          path: "/opt/copilot/skills/builtin-skill",
          source: "builtin",
        },
      ]),
    );

    expect(result).toEqual([
      {
        name: "review-pr",
        description: "Review a pull request.",
        shortDescription: "Review a pull request.",
        enabled: true,
        path: "/Users/test/.agents/skills/review-pr",
        scope: "personal",
      },
      {
        name: "builtin-skill",
        description: "A built-in skill.",
        shortDescription: "A built-in skill.",
        enabled: true,
        path: "/opt/copilot/skills/builtin-skill",
        scope: "system",
      },
    ]);
  });

  it("returns no skills for malformed CLI output", () => {
    expect(parseCopilotSkillsCliOutput("not json")).toEqual([]);
  });
});
