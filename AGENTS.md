<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

1、关于数据库表结构
- supabase的数据表暂时不开启RSL，所有的user_id使用process.env.NEXT_PUBLIC_MOCK_USER_ID代替
<!-- END:nextjs-agent-rules -->
