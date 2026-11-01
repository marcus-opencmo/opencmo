# AI agent & automation

AI agent cho sản phẩm của mình (tool, vòng lặp, bộ nhớ, evals) và automation (job engine, scheduler, marketing automation, API mạng xã hội).

Báo cáo của mảng này có thêm mục **Gắn vào OpenCMO** (đặt sau "Repo đáng học"): với mỗi thứ học được, ghi nguồn (repo, file), file của mình sẽ sửa, sửa ra sao, licence cho copy hay chỉ học, chi phí S/M/L và cách kiểm (test, hard budgets, xem frame thật).

Mới nhất ở trên. Mỗi lượt thêm một dòng và kiểm danh sách này để không lặp lại chủ đề hay nguồn. Định dạng báo cáo: [`../README.md`](../README.md).

| Ngày | Chủ đề | Báo cáo | Nguồn chính |
|---|---|---|---|
| 2026-11-01 | CMO chat đã điều khiển được toàn bộ OpenCMO chưa: bảng độ phủ tool, chat ↔ panel phải, automation, 3rd-party API, rate limit, credit, tải; thứ tự 5 PR review | [2026-11-01-cmo-chat-control-audit.md](2026-11-01-cmo-chat-control-audit.md) | code `cmo-build` `08daa44`, vercel/ai `chat.ts`, CopilotKit, assistant-ui |
| 2026-10-17 | Evals cho agent: đo "duyệt nguyên văn" từ production, judge theo tầng sau bước kiểm bằng code, eval onboarding/Sales/memory-safety, so hai lần chạy theo cặp | [2026-10-17-agent-evals-draft-signal.md](2026-10-17-agent-evals-draft-signal.md) | inbox-zero, inspect_ai, promptfoo, autoevals, agentevals; release notes Claude (Haiku 5.5) và Gemini (4 Argon) |

## Repo đã đọc

Mỗi lượt thêm các repo đã đọc code vào đây và ưu tiên repo chưa có trong bảng; chỉ đọc lại khi repo có thay đổi lớn (ghi lý do).

| Repo | Licence | Đọc ngày | File đã đọc | Báo cáo |
|---|---|---|---|---|
| [vercel/ai](https://github.com/vercel/ai) | Apache-2.0 | 2026-11-01 | `packages/ai/src/ui/chat.ts` | [2026-11-01](2026-11-01-cmo-chat-control-audit.md) |
| [elie222/inbox-zero](https://github.com/elie222/inbox-zero) | AGPL-3.0 | 2026-10-17 | `apps/web/utils/reply-tracker/draft-tracking.ts`, `utils/similarity-score.ts`, `utils/ai/reply/reply-memory.ts`, `__tests__/eval/{judge,reporter}.ts`, `__tests__/eval/assistant-chat-memory-safety.scenarios.ts`, `__tests__/eval/harness/{taxonomy,stats,split-lock,send-ready-judge}.ts`, `scripts/eval-compare-runs.ts`, `.github/workflows/ai-evals.yml`, `.claude/skills/testing/eval.md`, `prisma/schema.prisma` (`DraftSendLog`) | [2026-10-17](2026-10-17-agent-evals-draft-signal.md) |
| [UKGovernmentBEIS/inspect_ai](https://github.com/UKGovernmentBEIS/inspect_ai) | MIT | 2026-10-17 | `src/inspect_ai/scorer/_cascade.py`, `scorer/_reducer/reducer.py`, `scorer/_model.py` | [2026-10-17](2026-10-17-agent-evals-draft-signal.md) |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | MIT | 2026-10-17 | `src/assertions/trajectory.ts`, `src/assertions/trajectoryUtils.ts`, `src/matchers/{agent,llmGrading,rubric,comparison}.ts` | [2026-10-17](2026-10-17-agent-evals-draft-signal.md) |
| [braintrustdata/autoevals](https://github.com/braintrustdata/autoevals) | MIT | 2026-10-17 | `js/llm.ts`, `templates/factuality.yaml`, `templates/battle.yaml` | [2026-10-17](2026-10-17-agent-evals-draft-signal.md) |
| [langchain-ai/agentevals](https://github.com/langchain-ai/agentevals) | MIT | 2026-10-17 | `js/src/trajectory/utils.ts` | [2026-10-17](2026-10-17-agent-evals-draft-signal.md) |
