/** Poll until the agent reports back, or give up. */
export async function waitForJob(jobId: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const res = await fetch(`/api/jobs?id=${jobId}`, { cache: "no-store" });
    if (!res.ok) continue;
    const job = (await res.json()) as { status: string; error: string | null };
    if (job.status !== "PENDING" && job.status !== "PRINTING") return job;
  }
  return { status: "TIMEOUT", error: "No response from the printer yet. Check it has paper and is switched on." };
}
