import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";

export type UUID = string;

export const FLOW_STATUSES = ["draft", "published", "archived"] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export const FLOW_RUN_STATUSES = [
  "pending",
  "running",
  "interrupted",
  "completed",
  "failed",
  "cancelled",
] as const;
export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export type FlowRow = {
  id: UUID;
  user_id: UUID | null;
  name: string;
  description: string | null;
  status: FlowStatus;
  version: number;
  dsl: WorkflowDocument | Record<string, never>;
  /** Legacy column; new code reads/writes `dsl`. */
  flow_data: unknown;
  created_at: string | null;
  updated_at: string;
};

export type FlowVersionRow = {
  id: UUID;
  flow_id: UUID;
  version: number;
  dsl: WorkflowDocument;
  published_at: string;
};

export type FlowRunInterruptPayload = {
  nodeId: string;
  kind: "human_review" | "debug";
  form?: unknown;
  resumeSchema?: string;
};

export type FlowRunRow = {
  id: UUID;
  flow_id: UUID;
  flow_version: number;
  user_id: UUID;
  thread_id: string;
  status: FlowRunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  interrupt_payload: FlowRunInterruptPayload | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
