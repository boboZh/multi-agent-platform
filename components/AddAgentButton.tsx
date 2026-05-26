"use client";

import React, { useRouter } from "next/navigation";

export default function AddAgentButton({
  flowId,
  currentData,
}: {
  flowId: string;
  currentData: any;
}) {
  const router = useRouter();
  const handleAddAgent = async () => {
    const response = await fetch("/api/add-route", {
      method: "post",
      body: JSON.stringify({ flowId, currentData }),
    });
    if (response.ok) {
      router.refresh();
    }
  };
  return (
    <button
      onClick={handleAddAgent}
      className="mt-4 px-3 py-1.5 bg-zinc-900 text-white rounded text-xs cursor-pointer font-medium"
    >
      + Add Execution Node via Client
    </button>
  );
}
