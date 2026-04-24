// Next.js instrumentation hook — runs once at server startup. We use it
// to boot the in-process job worker on self-hosted deployments. On
// Vercel (where RUN_WORKER isn't set) startWorker() early-returns.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startWorker } = await import("./lib/job-runner");
  startWorker();
}
