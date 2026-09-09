import type { FlowRow } from "@/lib/workflow-dsl/tables";

/**
 * 目录页与编辑器读到的 flows 行。
 *
 * 刻意剔掉 `flow_data`：那是迁移期遗留列，里面可能压着整份旧版图 JSON，
 * 而新代码只读写 `dsl`。列表一次要渲染几十张卡，把它一起拉下来纯属白花带宽。
 * 新建时仍需给该列写值（NOT NULL 且无默认），但那只发生在 insert 语句里。
 */
export type FlowRecord = Omit<FlowRow, "flow_data">;

/** 查询列清单，集中一处，避免列表页与编辑器各写一串字符串导致字段漂移。 */
export const FLOW_SELECT_COLUMNS =
  "id,user_id,name,description,status,version,dsl,created_at,updated_at";
