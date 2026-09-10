export async function POST(request: Request) {
  const { doc } = await request.json();
  console.log("compile doc", doc);
  // const workflow = await getWorkflow(workflowId);

  return Response.json({ success: true, message: "Workflow compiled successfully" });
}