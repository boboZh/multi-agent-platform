import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // LangGraph / pg / ioredis 走 Node 原生 require，禁止 Turbopack 打进开发编译图。
  // 否则打开 /runs/[id] 时顺带分析 retry/state 等路由，会把本机内存打满。
  serverExternalPackages: [
    "pg",
    "ioredis",
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/langgraph-checkpoint",
    "@langchain/langgraph-checkpoint-postgres",
    "@langchain/langgraph-checkpoint-redis",
    "@langchain/openai",
    "@langchain/anthropic",
    "@langchain/google-genai",
  ],
};

export default nextConfig;
