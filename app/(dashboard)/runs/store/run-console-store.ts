"use client";

import { create } from "zustand";
import type { WorkflowDocument } from "@/lib/workflow-dsl/schema";
import type {
  FlowRunInterruptPayload,
  FlowRunRow,
} from "@/lib/workflow-dsl/tables";
import type { WorkflowSseEvent } from "@/lib/workflow-runtime/sse";
import type { NodeStateView } from "@/lib/workflow-runtime/node-state";
import { mergeRunSnapshot } from "@/app/(dashboard)/runs/lib/merge-run-snapshot";
import {
  appendTimelineEvent,
  shouldSkipSseEvent,
} from "@/app/(dashboard)/runs/lib/event-reducer";

export type RunConnection = "idle" | "streaming" | "reconnecting";

type RunConsoleState = {
  run: FlowRunRow | null;
  dsl: WorkflowDocument | null;
  flowName: string;
  events: WorkflowSseEvent[];
  interrupt: FlowRunInterruptPayload | null;
  connection: RunConnection;
  selectedNodeId: string | null;
  nodeStateCache: Record<string, NodeStateView | null>;
  lastEventId: number;
  hydrate: (payload: {
    run: FlowRunRow;
    dsl: WorkflowDocument;
    flowName: string;
    events: WorkflowSseEvent[];
    lastEventId?: number;
  }) => void;
  applyEvent: (event: WorkflowSseEvent, eventId?: number) => void;
  hydrateMetadata: (payload: {
    run: FlowRunRow;
    dsl: WorkflowDocument;
    flowName: string;
  }) => void;
  setConnection: (connection: RunConnection) => void;
  selectNode: (nodeId: string | null) => void;
  putNodeState: (nodeId: string, state: NodeStateView | null) => void;
  reset: () => void;
};

const empty = {
  run: null,
  dsl: null,
  flowName: "",
  events: [] as WorkflowSseEvent[],
  interrupt: null as FlowRunInterruptPayload | null,
  connection: "idle" as RunConnection,
  selectedNodeId: null as string | null,
  nodeStateCache: {} as Record<string, NodeStateView | null>,
  lastEventId: 0,
};

export const useRunConsoleStore = create<RunConsoleState>((set) => ({
  ...empty,
  hydrate: ({ run, dsl, flowName, events, lastEventId = 0 }) =>
    set({
      run,
      dsl,
      flowName,
      events,
      interrupt: run.interrupt_payload,
      selectedNodeId: null,
      nodeStateCache: {},
      lastEventId: lastEventId ?? 0, //
    }),
  // 详情和 SSE 并行加载：详情只补元数据，时间线与断点由 SSE 独占，避免慢响应擦掉正文。
  hydrateMetadata: ({ run, dsl, flowName }) =>
    set((state) => {
      const merged = mergeRunSnapshot(run, state.events);
      return { run: merged, dsl, flowName, interrupt: merged.interrupt_payload };
    }),
  applyEvent: (event, eventId) =>
    set((state) => {
      if (shouldSkipSseEvent(state.lastEventId, eventId)) {
        return state;
      }
      const next: Partial<RunConsoleState> = {
        events: appendTimelineEvent(state.events, event),
        lastEventId:
          typeof eventId === "number" && eventId > state.lastEventId
            ? eventId
            : state.lastEventId,
      };
      if (event.type === "interrupt") {
        next.interrupt = event.payload;
      }
      if (event.type === "run_status" && state.run) {
        next.run = mergeRunSnapshot(state.run, [event]);
        if (event.status !== "interrupted") {
          next.interrupt = event.status === "running" ? null : state.interrupt;
        }
      }
      if (event.type === "error" && state.run) {
        next.run = { ...state.run, status: "failed", error: event.message };
      }
      return next;
    }),
  setConnection: (connection) => set({ connection }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  putNodeState: (nodeId, nodeState) =>
    set((state) => ({
      nodeStateCache: { ...state.nodeStateCache, [nodeId]: nodeState },
    })),
  reset: () => set(empty),
}));
