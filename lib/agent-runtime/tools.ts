import type { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import type { ToolRow } from "@/app/(dashboard)/agents/lib/types";
import { fetchWithinTimeout } from "@/lib/agent-runtime/fetch-with-timeout";
import {
  asToolInput,
  formatToolHttpResult,
  parseConnectionConfig,
  prepareHttpCall,
  renderStaticBody,
  zodObjectFromConfig,
  type HttpExecutor,
} from "@/lib/agent-runtime/tool-config";

/**
 * 没有 executor 的旧工具仍按名字执行。
 * 新工具应在 connection_config.executor 里声明 HTTP 或静态 JSON，这里不要再加分支。
 */
async function executeKnownTool(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  if (name === "get_weather" || name.includes("weather")) {
    const city = String(input.city ?? input.location ?? "杭州");
    const res = await fetchWithinTimeout(
      `https://wttr.in/${encodeURIComponent(city)}?format=j1`,
      signal,
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
    const res = await fetchWithinTimeout(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
      signal,
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

  if (name === "get_order_info") {
    return JSON.stringify({
      order_id: input.order_id,
      order_status: "pending",
      order_date: "2026-01-01",
      amount: 2000,
      currency: "CNY",
    });
  }

  return JSON.stringify({
    tool: name,
    input,
    note: "No live executor; echoing input.",
  });
}

async function executeHttpTool(
  executor: HttpExecutor,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const prepared = prepareHttpCall(executor, input);
  if (!prepared.ok) {
    return JSON.stringify({ error: prepared.error });
  }
  const { url, method, headers, body } = prepared.call;
  const res = await fetchWithinTimeout(url, signal, {
    method,
    headers,
    body,
  });
  const text = await res.text();
  return formatToolHttpResult(res.status, text, executor.pick);
}

/**
 * 按工具行执行一次调用。
 *
 * 入参：工具行、模型传入的参数、外层 abort signal。
 * 出参：交给模型的字符串。配置错误返回 JSON，不抛；网络超时仍抛出。
 * 步骤：解析 connection_config → HTTP / 静态模板 → 都没有才按工具名走旧实现。
 * 写了 executor 但解析失败时不回落：名字里带 weather 的坏配置不能偷偷打到天气接口。
 */
export async function executeToolRow(
  row: Pick<ToolRow, "name" | "connection_config">,
  input: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const args = asToolInput(input);
  const parsed = parseConnectionConfig(row.connection_config);
  if (parsed.rejected) {
    return JSON.stringify({
      tool: row.name,
      error: parsed.errors.join("；") || "工具配置无效",
    });
  }
  if (parsed.executor?.kind === "http") {
    return executeHttpTool(parsed.executor, args, signal);
  }
  if (parsed.executor?.kind === "static") {
    return renderStaticBody(parsed.executor.body, args);
  }
  return executeKnownTool(row.name, args, signal);
}

/** 把工具目录包成 LangChain tool。执行逻辑来自 connection_config，不在这里按名字分支。 */
export function buildLangChainTools(tools: ToolRow[]) {
  return tools.map((row) => {
    const schema = zodObjectFromConfig(row.connection_config);
    return tool(
      async (input, config: RunnableConfig) =>
        executeToolRow(row, input, config?.signal),
      {
        name: row.name,
        description:
          row.description?.trim() ||
          row.display_name?.trim() ||
          `Execute tool ${row.name}`,
        schema,
      },
    );
  });
}
