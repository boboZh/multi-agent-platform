import { tool } from "@langchain/core/tools";
import { z, type ZodTypeAny } from "zod";
import type { ToolRow } from "@/app/(dashboard)/agents/lib/types";

type JsonSchemaField = {
  type?: string;
  description?: string;
};

function zodFromConnectionConfig(config: unknown) {
  const schema = (config as { schema?: Record<string, JsonSchemaField> } | null)
    ?.schema;
  if (!schema || Object.keys(schema).length === 0) {
    return z.object({
      input: z.string().optional().describe("Tool input"),
    });
  }

  const shape: Record<string, ZodTypeAny> = {};
  for (const [key, def] of Object.entries(schema)) {
    let field: ZodTypeAny =
      def?.type === "number"
        ? z.number()
        : def?.type === "boolean"
          ? z.boolean()
          : z.string();
    if (def?.description) field = field.describe(def.description);
    shape[key] = field;
  }
  return z.object(shape);
}

async function executeKnownTool(
  name: string,
  input: Record<string, unknown>
): Promise<string> {
  if (name === "get_weather" || name.includes("weather")) {
    const city = String(input.city ?? input.location ?? "杭州");
    const res = await fetch(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`
    );
    if (!res.ok) {
      return JSON.stringify({
        city,
        error: `Weather lookup failed (${res.status})`,
      });
    }
    const data = (await res.json()) as {
      current_condition?: Array<{
        temp_C?: string;
        weatherDesc?: Array<{ value?: string }>;
      }>;
    };
    const current = data.current_condition?.[0];
    return JSON.stringify({
      city,
      temperature_c: current?.temp_C ?? null,
      condition: current?.weatherDesc?.[0]?.value ?? "unknown",
    });
  }

  if (name === "web_search" || name.includes("search")) {
    const query = String(input.query ?? input.q ?? "");
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`
    );
    if (!res.ok) {
      return JSON.stringify({ query, error: `Search failed (${res.status})` });
    }
    const data = (await res.json()) as {
      AbstractText?: string;
      AbstractSource?: string;
      RelatedTopics?: Array<{ Text?: string }>;
    };
    return JSON.stringify({
      query,
      abstract: data.AbstractText || null,
      source: data.AbstractSource || null,
      related: (data.RelatedTopics || [])
        .map((t) => t.Text)
        .filter(Boolean)
        .slice(0, 5),
    });
  }

  return JSON.stringify({
    tool: name,
    input,
    note: "No live executor; echoing input.",
  });
}

// 遍历tools，通过tool（）函数动态包裹这些工具，方便喂给reactAgent
export function buildLangChainTools(tools: ToolRow[]) {
  return tools.map((row) => {
    const schema = zodFromConnectionConfig(row.connection_config);
    return tool(
      async (input) =>
        executeKnownTool(row.name, (input ?? {}) as Record<string, unknown>),
      {
        name: row.name,
        description:
          row.description?.trim() ||
          row.display_name?.trim() ||
          `Execute tool ${row.name}`,
        schema,
      }
    );
  });
}
