import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

export function createChatModel(
  modelName: string | null,
  temperature: number,
): BaseChatModel {
  const temp = Number.isFinite(temperature) ? temperature : 0.7;

  switch (modelName) {
    case "gpt-4o":
      return new ChatOpenAI({
        model: "gpt-4o",
        temperature: temp,
        streaming: true,
        apiKey: process.env.OPENAI_API_KEY,
      });
    case "deepseek-chat":
      return new ChatOpenAI({
        model: "deepseek-chat",
        temperature: temp,
        streaming: true,
        apiKey: process.env.DEEPSEEK_API_KEY,
        configuration: {
          baseURL: "https://api.deepseek.com/v1",
        },
      });
    case "claude-3-5-sonnet":
      return new ChatAnthropic({
        model: "claude-3-5-sonnet-latest",
        temperature: temp,
        streaming: true,
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    case "gemini-2-5-flash":
      return new ChatGoogleGenerativeAI({
        model: "gemini-2.5-flash",
        temperature: temp,
        streaming: true,
        apiKey: process.env.GOOGLE_API_KEY,
      });
    default:
      return new ChatOpenAI({
        model: modelName || "gpt-4o",
        temperature: temp,
        streaming: true,
        apiKey: process.env.OPENAI_API_KEY,
      });
  }
}
