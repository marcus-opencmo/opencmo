"use client";

/**
 * Job đang chạy, hiện ở MỌI màn hình.
 *
 * Việc xử lý vốn đã chạy nền thật: worker sống trên Modal, trạng thái nằm trong
 * Postgres, đóng tab mở lại vẫn đúng. Cái thiếu là người dùng KHÔNG THẤY điều
 * đó — rời trang project là mất luôn mọi dấu hiệu, và "xong rồi" thì chưa bao
 * giờ được báo.
 *
 * Không xin quyền notification của trình duyệt: một hộp thoại xin quyền ngay
 * lần đầu dùng sản phẩm đổi một chút tiện lợi lấy rất nhiều nghi ngờ.
 *
 * MỘT hook cho cả rail lẫn top bar. Hai chỗ tự đọc riêng là hai lần gọi API và
 * hai channel Realtime trùng tên cho cùng một dữ liệu.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { Project, ProjectPage } from "@/lib/clipping-types";

import { api } from "./api";
import { stageLabel } from "./ProcessingView";
import { useLive } from "./useLive";

const ACTIVE = new Set(["queued", "running"]);
/** Trạng thái + bước: đổi cái nào cũng có thể là lúc số dư vừa đổi. */
const progressKey = (item: Project) => `${item.status}:${item.stage}`;

export type ActiveJobs = {
  active: Project[];
  /** Câu báo "xong rồi", null khi chưa có gì mới. */
  toast: { text: string; projectId: string; tone: "info" | "warning" } | null;
  clearToast: () => void;
};

function finishedMessage(project: Project): string {
  if (project.settings.mode === "full") {
    return `${project.title || "Your video"} is ready to download`;
  }
  const count = project.clip_count ?? project.clips.length;
  return `${count} ${count === 1 ? "clip" : "clips"} ready — ${project.title || "your video"}`;
}

export function useActiveJobs(
  userId: string | null,
  /**
   * Gọi khi một job vừa xuất hiện hoặc vừa kết toán — đó là hai thời điểm duy
   * nhất số credit đổi. Giữ trong ref: nó là hàm mới sau mỗi lần cha render, và
   * `load` phụ thuộc nó thì mỗi lần render lại là một request thừa.
   */
  onSettled?: () => void,
): ActiveJobs {
  const [active, setActive] = useState<Project[]>([]);
  const [toast, setToast] = useState<ActiveJobs["toast"]>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;
  // Trạng thái lần đọc trước, để biết job nào VỪA chuyển sang xong. Ref chứ
  // không phải state: so sánh này không được kéo theo một lần render nữa.
  const seen = useRef<Map<string, string> | null>(null);
  const reading = useRef(false);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const page = await api<ProjectPage>("/projects?limit=24");
      const previous = seen.current;

      // Lần đọc đầu KHÔNG bắn toast: job xong từ hôm qua không phải tin mới.
      if (previous) {
        const wasActive = (id: string) => {
          const before = previous.get(id);
          return before?.startsWith("running:") || before?.startsWith("queued:");
        };
        const finished = page.items.find((item) => item.status === "done" && wasActive(item.id));
        // Hỏng cũng phải báo: trước đây chỉ có tin vui, và job lỗi nằm im tới khi
        // người dùng tự mở lại thư viện.
        const failed = page.items.find((item) => item.status === "failed" && wasActive(item.id));
        if (finished) {
          setToast({ projectId: finished.id, text: finishedMessage(finished), tone: "info" });
        } else if (failed) {
          setToast({
            projectId: failed.id,
            text: `Needs attention — ${failed.title || "your video"}`,
            tone: "warning",
          });
        }

        // Rộng hơn toast một bậc: credit cũng đổi khi job hỏng hoặc bị huỷ
        // (hoàn lại), và khi một job MỚI xuất hiện (vừa bị trừ). Toast thì chỉ
        // nói chuyện vui, còn số dư phải đúng trong cả ba trường hợp.
        // Đổi BƯỚC cũng tính: credit được điều chỉnh theo độ dài thật ngay khi
        // job đọc xong nguồn, lúc nó vẫn `running` (UAT production 29/09: header
        // ghi 396 trong khi số dư thật 375).
        const changed = page.items.some((item) => {
          const before = previous.get(item.id);
          return before === undefined || before !== progressKey(item);
        });
        if (changed) settled.current?.();
      }
      seen.current = new Map(page.items.map((item) => [item.id, progressKey(item)]));
      setActive(page.items.filter((item) => ACTIVE.has(item.status)));
    } catch {
      // Chỉ báo phụ: hỏng thì im lặng. Một banner lỗi ở khung ngoài sẽ che mất
      // lỗi thật của màn hình người dùng đang làm việc.
    } finally {
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    if (userId) void load();
  }, [userId, load]);

  // Polling chỉ chạy khi CÓ job đang chạy: nếu không thì Realtime là đủ, và một
  // timer 5 giây trên mọi màn hình là 720 request mỗi giờ cho việc không có gì.
  useLive("jobs", userId && `user_id=eq.${userId}`, () => void load(), Boolean(userId), active.length > 0);

  return { active, toast, clearToast: () => setToast(null) };
}

/** Chip ở top bar: việc đang làm, bấm vào đi thẳng tới project đó. */
export function ActiveJobChip({
  jobs,
  onOpen,
}: {
  jobs: Project[];
  onOpen: (projectId: string) => void;
}) {
  const first = jobs[0];
  if (!first) return null;

  return (
    <button
      type="button"
      className="active-job"
      onClick={() => onOpen(first.id)}
      title={first.title || first.source_name}
    >
      <span className="active-job-spinner" aria-hidden="true" />
      <span className="active-job-text">
        <b>{stageLabel(first)}</b>
        <small>
          {jobs.length > 1 ? `${jobs.length} videos processing` : first.title || first.source_name}
        </small>
      </span>
    </button>
  );
}
