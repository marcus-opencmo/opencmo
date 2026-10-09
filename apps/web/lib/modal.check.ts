import assert from "node:assert/strict";

import { wakeWorker } from "./modal";

const originalFetch = globalThis.fetch;
const originalUrl = process.env.MODAL_SUBMIT_URL;
const originalToken = process.env.OPENCMO_WORKER_TOKEN;

async function capturePayload(run: () => Promise<boolean>): Promise<unknown> {
  let payload: unknown;
  globalThis.fetch = async (_input, init) => {
    payload = JSON.parse(String(init?.body));
    return new Response(null, { status: 202 });
  };

  assert.equal(await run(), true);
  return payload;
}

async function main(): Promise<void> {
  process.env.MODAL_SUBMIT_URL = "https://worker.example/submit";
  process.env.OPENCMO_WORKER_TOKEN = "test-token";

  const taskPayload = await capturePayload(() => wakeWorker({ task_id: "task-1" }));
  assert.deepEqual(taskPayload, { token: "test-token", task_id: "task-1" });

  const jobPayload = await capturePayload(() =>
    wakeWorker({
      id: "job-1",
      user_id: "user-1",
      source_url: "https://youtu.be/example",
      clips_requested: 3,
      watermark: false,
    }),
  );
  assert.deepEqual(jobPayload, { token: "test-token", job_id: "job-1" });

  console.log("Modal submit contract: job_id và task_id payload hợp lệ.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.MODAL_SUBMIT_URL;
    else process.env.MODAL_SUBMIT_URL = originalUrl;
    if (originalToken === undefined) delete process.env.OPENCMO_WORKER_TOKEN;
    else process.env.OPENCMO_WORKER_TOKEN = originalToken;
  });
