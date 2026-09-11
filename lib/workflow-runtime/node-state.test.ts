import { describe, expect, it } from "vitest";
import { nodeStateFromHistory } from "@/lib/workflow-runtime/node-state";

describe("nodeStateFromHistory", () => {
  it("从未执行的节点返回 null", () => {
    expect(nodeStateFromHistory([], "n_agent")).toBeNull();
    expect(
      nodeStateFromHistory(
        [{ values: { vars: { a: 1 }, lastAgentText: "x", messages: [] } }],
        "n_agent",
      ),
    ).toBeNull();
  });

  it("非法空 nodeId 返回 null", () => {
    expect(
      nodeStateFromHistory(
        [
          {
            metadata: { writes: { n_agent: { lastAgentText: "hi" } } },
            values: { vars: {}, lastAgentText: "hi", messages: [] },
          },
        ],
        "",
      ),
    ).toBeNull();
  });

  it("取该节点最后一次 writes 对应快照的 vars / lastAgentText", () => {
    const view = nodeStateFromHistory(
      [
        {
          metadata: { writes: { n_agent: {} } },
          values: {
            vars: { k: 2 },
            lastAgentText: "new",
            messages: [{ content: "hello world" }],
          },
          createdAt: "2026-01-02",
        },
        {
          metadata: { writes: { n_agent: {} } },
          values: { vars: { k: 1 }, lastAgentText: "old", messages: [] },
        },
      ],
      "n_agent",
    );
    expect(view?.lastAgentText).toBe("new");
    expect(view?.vars).toEqual({ k: 2 });
    expect(view?.messagesPreview[0]).toContain("hello");
  });
});
