// 初始化tools数据表
require("dotenv").config({ path: ".env.local" }); // 加载 Next.js 的本地环境变量
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

// 1. 初始化 Supabase 客户端
// 确保你的 .env.local 中有这两个变量：NEXT_PUBLIC_SUPABASE_URL 和 SUPABASE_SERVICE_ROLE_KEY (或 NEXT_PUBLIC_SUPABASE_ANON_KEY)
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ 找不到 Supabase 环境变量，请检查 .env.local 文件。");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// 2. 核心：使用我们之前约定的合法 UUID 作为测试用户的 ID
const TEST_USER_ID = process.env.NEXT_PUBLIC_MOCK_USER_ID;

// 3. 定义要注入的工具数据
// 注意：字段必须严格对齐你数据库表 tools 的字段 (user_id, name, display_name, description, tool_type, connection_config)
const toolsData = [
  {
    id: crypto.randomUUID(), // 手动生成合法 UUID 主键
    user_id: TEST_USER_ID,
    name: "get_weather",
    display_name: "获取天气",
    description:
      "根据指定城市名称查询当前的天气情况。返回包括温度和天气状态的信息。",
    tool_type: "explicit", // 跟你之前前端代码里的 .eq("tool_type", "explicit") 对应
    connection_config: {
      // 模拟工具的连接配置，实际场景下这里可以存 API 格式或所需参数
      schema: {
        city: {
          type: "string",
          description: "需要查询天气的城市名称，如：杭州",
        },
      },
    },
  },
  {
    id: crypto.randomUUID(),
    user_id: TEST_USER_ID,
    name: "web_search",
    display_name: "网络搜索",
    description: "使用搜索引擎在互联网上查找最新的资讯、新闻或实时数据。",
    tool_type: "explicit",
    connection_config: {
      engine: "duckduckgo",
      max_results: 5,
      // 👇 关键补充：告诉大模型这个工具需要什么入参
      schema: {
        query: {
          type: "string",
          description:
            "需要搜索的关键词或完整句子，尽量精确以获得最佳搜索结果。",
        },
      },
    },
  },
];

// 4. 执行插入操作
async function seedTools() {
  const { data, error } = await supabase
    .from("tools")
    .insert(toolsData)
    .select(); // 插入后返回数据以便确认

  if (error) {
    console.error("❌ 插入失败:", error.message, error.details);
    return;
  }
}

seedTools();
