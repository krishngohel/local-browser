import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getProfile, setProfile } from "../../main/profile";
import { matchProfileToFields } from "../../shared/profile-match";
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

  define(
    server,
    deps,
    "profile_suggest_fill",
    "Match the current tab's form fields (from the last forms() call) to the stored profile by label. Returns { ref, label, suggestedValue, confidence } for fields it's confident about; it never fills anything itself and never guesses for a field with no clear match — review each suggestion (or ask the user) before calling fill_form with the ones you accept. Optionally target a specific tabId.",
    { tabId: z.string().optional() },
    async ({ tabId }) => {
      try {
        const fields = (await deps.hub.forms(tabId)).flatMap((f) => f.fields);
        const suggestions = matchProfileToFields(fields, getProfile());
        if (!suggestions.length) return text("No confident matches. Call forms to see the fields, or ask the user for the values.");
        return text(JSON.stringify(suggestions, null, 2));
      } catch (e) {
        return err(e);
      }
    },
  );
}
