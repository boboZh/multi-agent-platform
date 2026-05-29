"use client";
import { useTranslations } from "next-intl";

export default function Dashboard() {
  const t = useTranslations("layout");
  return <div>{t("dashboard")}</div>;
}
/*  */
