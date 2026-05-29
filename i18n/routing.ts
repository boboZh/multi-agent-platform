import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";

// define routing setup configurations
export const routing = defineRouting({
  locales: ["en", "zh"],
  defaultLocale: "en",
  localePrefix: "always", //force /en or /zh to always appear in the URL bar
});

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
