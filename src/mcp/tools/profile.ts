import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProfile, setProfile } from "../../main/profile";
import { define, err, text, type ToolDeps } from "./_helpers";

export function registerProfile(server: McpServer, deps: ToolDeps): void {
  define(server, deps, "profile_get", "Read the stored applicant profile (name, email, phone, address, links). Empty fields mean nothing is stored yet.", {}, async () => {
    try {
      return text(JSON.stringify(getProfile(), null, 2));
    } catch (e) {
      return err(e);
    }
  });

  define(
    server,
    deps,
    "profile_set",
    "Save or update applicant profile fields (name, email, phone, address, links) so fill_form/profile_suggest_fill can reuse them across applications. Only given fields are changed.",
    {
      fullName: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      addressLine1: z.string().optional(),
      addressLine2: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      country: z.string().optional(),
      linkedin: z.string().optional(),
      portfolio: z.string().optional(),
      github: z.string().optional(),
    },
    async (fields) => {
      try {
        return text(JSON.stringify(setProfile(fields), null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );
}
