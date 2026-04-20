import { tool } from "ai";
import { z } from "zod";
import { listSkills, getSkill } from "../../db/skills.js";
import type { SubagentContext } from "./types.js";

export function createSkillTools(ctx: SubagentContext): Record<string, any> {
  if (!ctx.teamId) return {};

  const skills = listSkills(ctx.teamId);
  if (skills.length === 0) return {};

  const skillNames = skills.map((s) => s.name);

  return {
    use_skill: tool({
      description: `Load a skill's full instructions. Available skills:\n${skills.map((s) => `• ${s.name}: ${s.description}`).join("\n")}`,
      inputSchema: z.object({
        name: z.enum(skillNames as [string, ...string[]]).describe("Skill name to load"),
      }),
      execute: async ({ name }) => {
        const skill = getSkill(ctx.teamId!, name);
        if (!skill) return { error: `Skill "${name}" not found.` };
        return { name: skill.name, description: skill.description, content: skill.content };
      },
    }),
  };
}
