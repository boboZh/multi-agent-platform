import { describe, expect, it } from "vitest";
import { parseResumePayload } from "@/app/(dashboard)/runs/lib/resume-payload";
import type { ReviewFormField } from "@/lib/workflow-dsl/schema";

const fields: ReviewFormField[] = [
  {
    name: "decision",
    type: "enum",
    required: true,
    options: ["approve", "reject"],
    label: "决定",
  },
  { name: "comment", type: "text", required: false, label: "备注" },
];

describe("parseResumePayload", () => {
  it("resume 不是对象时直接拒绝，防止把字符串写进 vars", () => {
    const result = parseResumePayload(fields, "approve");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.path).toEqual(["resume"]);
  });

  it("缺必填 enum 时失败", () => {
    const result = parseResumePayload(fields, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.includes("decision"))).toBe(true);
    }
  });

  it("enum 不在 options 内时失败；合法对象则只留下表单字段", () => {
    expect(parseResumePayload(fields, { decision: "maybe" }).ok).toBe(false);
    const ok = parseResumePayload(fields, {
      decision: "approve",
      comment: "lgtm",
      extra: 1,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.resume).toEqual({ decision: "approve", comment: "lgtm" });
    }
  });
});
