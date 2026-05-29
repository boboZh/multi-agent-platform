// set up the routing routing middleware filter
import type { NextRequest } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";

// create the base intl engine handler instance
const handleIntlRouting = createMiddleware(routing);

// export the function named exactly 'proxy' as required by Next.js 16
export function proxy(request: NextRequest) {
  return handleIntlRouting(request);
}

export const config = {
  // match and redirect all routing paths except static assets, system icons, and internal api payloads
  matcher: ["/", "/(zh|en)/:path*", "/((?!api|_next|_vercel|.*\\..*).*)"],
};
