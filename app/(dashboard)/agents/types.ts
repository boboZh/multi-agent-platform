export type UUID = string;

export type AgentRow = {
  id: UUID;
  user_id: UUID;
  name: string;
  system_prompt: string | null;
  model_name: string | null;
  temperature: number | null;
  created_at: string;
};

export type ToolRow = {
  id: UUID;
  user_id: UUID;
  name: string;
  display_name: string | null;
  description: string | null;
  tool_type: "explicit" | "implicit" | string;
  connection_config: unknown;
};

export type AgentToolRow = {
  id: UUID;
  agent_id: UUID;
  tool_id: UUID;
};

export type AgentWithTools = AgentRow & {
  explicitTools: ToolRow[];
};

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
