"use client";

import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { cn } from "@/lib/utils";

/**
 * 模型输出走 Streamdown：流式时 remend 先补全未闭合的 ** / ` / 链接，再交给内置 remark-gfm。
 * skipHtml 关掉原始 HTML，避免 prompt 注入把气泡变成可执行标记。
 * 默认不限表格/代码块高度，长报告不能被 Streamdown 自带的 300px 裁切。
 */
export function ChatMarkdown({
  content,
  variant = "assistant",
}: {
  content: string;
  variant?: "user" | "assistant";
}) {
  return (
    <div
      className={cn(
        "text-sm wrap-break-word [&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
        "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
        "[&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:opacity-90",
        "[&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold",
        "[&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-medium",
        "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:p-2 [&_pre]:text-xs",
        "[&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
        "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
        "[&_a]:underline [&_a]:underline-offset-2",
        "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1",
        // 用户气泡是实心主色，代码块必须换成浅底，否则和助手侧 muted 底会糊成一块。
        variant === "user"
          ? "[&_pre]:bg-white/15 [&_code]:bg-white/20 [&_a]:text-inherit [&_th]:border-white/30 [&_td]:border-white/30"
          : "[&_pre]:bg-muted [&_code]:bg-muted [&_a]:text-primary [&_th]:border-border [&_td]:border-border",
      )}
    >
      <Streamdown
        mode="streaming"
        skipHtml
        controls={false}
        linkSafety={{ enabled: false }}
        tableMaxHeight={0}
        codeBlockMaxHeight={0}
        components={{
          a: ({ href, children }) => {
            // remend 给半截链接塞的占位协议，不能真的拿去跳转。
            if (!href || href === "streamdown:incomplete-link") {
              return <span>{children}</span>;
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </Streamdown>
    </div>
  );
}
