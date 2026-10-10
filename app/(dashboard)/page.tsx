import { redirect } from "next/navigation";

/**
 * 根路径暂时不承载页面。
 * 首页预留给运行统计，当前不开发；直接进入工作流列表，避免打开 localhost:3000 落到空页。
 * 统计页落地后，去掉这次 redirect，在本文件渲染统计内容。
 */
export default function Dashboard() {
  redirect("/workflows");
}
