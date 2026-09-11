import { describe, expect, it } from "vitest";
import { GraphInterrupt } from "@langchain/langgraph";
import {
  interruptPayloadFromError,
  interruptPayloadFromValue,
} from "@/lib/workflow-runtime/interrupt";
import { parseLastEventId } from "@/lib/workflow-runtime/sse";

describe("interruptPayloadFromValue", () => {
  it("缺少 nodeId 的脏 payload 不能写成 interrupt_payload", () => {
    expect(interruptPayloadFromValue({ kind: "human_review" })).toBeNull();
    expect(interruptPayloadFromValue(null)).toBeNull();
    expect(interruptPayloadFromValue("approve")).toBeNull();
  });

  it("从 GraphInterrupt 抽出 nodeId 和 form", () => {
    const err = new GraphInterrupt([
      {
        value: {
          nodeId: "n_review",
          kind: "human_review",
          form: [{ name: "decision", type: "enum" }],
        },
        when: "during",
      },
    ]);
    const payload = interruptPayloadFromError(err);
    expect(payload?.nodeId).toBe("n_review");
    expect(Array.isArray(payload?.form)).toBe(true);
  });
});

describe("parseLastEventId", () => {
  it("缺省、非数字、非正数都从 0 开始回放", () => {
    expect(parseLastEventId(null)).toBe(0);
    expect(parseLastEventId("abc")).toBe(0);
    expect(parseLastEventId("-3")).toBe(0);
    expect(parseLastEventId("12")).toBe(12);
  });
});
