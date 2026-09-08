export type UUID = string;

/** `agents` 表行：可空字段来自历史脏数据 / 未填配置，UI 层必须再做白名单与 clamp。 */
export type AgentRow = {
  id: UUID;
  user_id: UUID;
  name: string;
  system_prompt: string | null;
  model_name: string | null;
  temperature: number | null;
  created_at: string;
};

/**
 * `tools` 表行。
 * `tool_type`：explicit 需用户显式授权才进入 agent_tools；implicit 由运行时默认注入，目录/编辑器不展示、不绑定。
 * `connection_config` 结构因工具类型而异，本模块只透传，不解析。
 */
export type ToolRow = {
  id: UUID;
  user_id: UUID;
  name: string;
  display_name: string | null;
  description: string | null;
  tool_type: "explicit" | "implicit" | string;
  connection_config: unknown;
};

/** `agent_tools` 多对多中间表：一个智能体可绑定多个显式工具。 */
export type AgentToolRow = {
  id: UUID;
  agent_id: UUID;
  tool_id: UUID;
};

/** 目录卡 / 编辑器使用的聚合视图：只挂显式工具，避免把 implicit 误显示成可开关项。 */
export type AgentWithTools = AgentRow & {
  explicitTools: ToolRow[];
};

/** 下拉框与入库白名单。库里若出现未列出的 model_name，一律回落到首项，防止 select 出现空值。 */
export const MODEL_VALUES = [
  "deepseek-chat",
  "gemini-2-5-flash",
  "gpt-4o",
  "claude-3-5-sonnet",
] as const;

export type ModelValue = (typeof MODEL_VALUES)[number];

export const MODEL_LABELS: Record<ModelValue, string> = {
  "deepseek-chat": "DeepSeek R1",
  "gemini-2-5-flash": "Gemini 2.5 Flash",
  "gpt-4o": "GPT-4o",
  "claude-3-5-sonnet": "Claude 3.5 Sonnet",
};
