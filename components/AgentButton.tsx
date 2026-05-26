"use client";
import React, { useState } from "react";

export default function AgentButton() {
  const [message, setMessage] = useState("");
  const handleClick = async () => {
    setMessage("Loading...");
    try {
      const response = await fetch("/api/agent-test");
      const data = await response.json();
      setMessage(data.message);
    } catch (error) {
      setMessage("Error: " + error);
    }
  };
  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-500">{message}</div>
      <button
        onClick={handleClick}
        className="bg-blue-500 text-white px-4 py-2 rounded-md"
      >
        run agent test
      </button>
    </div>
  );
}
