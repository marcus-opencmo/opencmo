import { readState } from "./global-setup";

/** Tắt worker fixture. Bỏ qua thì nó sống qua cả lần chạy sau và tranh việc. */
export default async function globalTeardown(): Promise<void> {
  try {
    const { workerPid } = readState();
    if (workerPid) process.kill(-workerPid, "SIGTERM");
  } catch {
    // Không có state (setup hỏng sớm) thì cũng không có gì để tắt.
  }
}
