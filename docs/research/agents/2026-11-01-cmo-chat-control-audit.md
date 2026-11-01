# AI agent & automation: CMO chat đã điều khiển được toàn bộ OpenCMO chưa? (2026-11-01)

## TL;DR

- **Chưa.** CMO chat (`cmoScope()`, `apps/web/lib/agent/scope.ts:576`) có 20 tool: 10 tool CMO trong
  `lib/agent/cmo-tools.ts` và 10 tool đọc mạng xã hội trong `lib/agent/cmo-research.ts`. Chat **đọc** được tài liệu,
  lịch, thẻ duyệt và dữ liệu công khai, và **giao việc** qua `create_task` (planner, X writer, Sales, research). Mọi
  **quyết định** thì phải bấm nút trên UI: duyệt thẻ, xếp lịch, kết nối tài khoản, cài đặt, credit, video, huỷ hay
  chạy lại job. Trong khoảng 30 nhóm việc của sản phẩm, chat làm trọn khoảng 7, làm được một phần khoảng 4.
- **Chat và panel phải chưa nối với nhau.** Cột 3 chỉ là route (`components/shell-v2/ShellV2.tsx:341`). Chat bỏ qua
  `tool_result.view` (`components/cmo/workspace/ChatPanel.tsx:143`). Ba tool trong `CARD_TOOLS` chỉ làm Dashboard tải
  lại. Không có tool mở màn hình, và "context chip" (gửi `{segment, ids}` của tab đang mở kèm mỗi lượt) trong plan
  shell chưa được làm. Vì vậy founder hỏi "tìm lead Sales" thì chat chạy job, nhưng panel không mở Sales.
- **Automation phía sau đã khá đủ.** Modal chạy `sweep` mỗi phút, `cmo_schedule` lúc 00:05, `cmo_digest` mỗi giờ
  (thêm ở P6) và cleanup lúc 03:00. Các loop trong `lib/cmo/loops.ts` lo lập kế hoạch tuần, nháp X, Sales theo lịch,
  đối thủ, metrics và review. Chỗ hở là phía người dùng: việc gì làm xong cũng kết thúc bằng một thẻ phải bấm trên UI.
- **3rd-party API khá gọn ở tầng gọi** (mỗi vendor một module, có timeout). Còn **kém ở tầng chi phí**:
  ScrapeCreators không ghi lại đã tiêu bao nhiêu, không giới hạn theo người hay theo ngày, và đọc từ chat hay MCP
  không tính credit. Token LLM của job CMO không được đo. Thứ tự sửa đề xuất: **panel protocol → tool quyết định
  trong chat → sổ chi phí ScrapeCreators → rate limit cho route chat → hoàn credit bị treo → công bằng hàng đợi**.
  Mỗi mục là một PR review nhỏ (mục Khuyến nghị).

## Phát hiện

### 1. Bảng độ phủ: chat làm được gì

Nguồn: danh sách tool `cmo-tools.ts:33-171`, `cmo-research.ts:34-100`; route `apps/web/app/api/v1/**`; trang
`apps/web/app/app/**` (đọc trên `cmo-build` `08daa44`, sau khi P6 đã merge).

| Việc founder muốn làm | Chat? | Bằng gì / vì sao không |
|---|---|---|
| Đọc, sửa 4 tài liệu (product, strategy, competitors, content_strategy) | ✅ | `read_doc`, `update_document` |
| Lập kế hoạch tuần, viết nháp X, quét Sales, nghiên cứu đối thủ | ✅ | `create_task` (`cmo-tools.ts:59`) |
| Xem thẻ đang chờ, trạng thái job | ✅ đọc | `list_approvals`, `get_run_result` |
| Ghi nhớ, đặt mục tiêu tuần | ✅ / ⚠️ | `remember`; `set_week_goal` chỉ đề xuất, duyệt phải ở UI |
| Đọc Reddit, HN, X, TikTok, YouTube, Threads, transcript, web | ✅ | `cmo-research.ts`, `read_site` |
| Viết caption, slide, brief video | ⚠️ | Chỉ gián tiếp, qua work order của planner |
| Thêm mục lịch | ⚠️ | `create_task` có `when` là ngày; không dời, không xoá được |
| Duyệt, bỏ, sửa, làm lại, gửi lại một thẻ | ❌ | Chỉ có `POST approvals/[id]` (14 action) |
| Xếp lịch, đổi giờ, đổi tài khoản đăng | ❌ | `approvals/[id]`, `schedule/slots/[id]` |
| Đánh dấu "đã đăng" hoặc "đã trả lời" | ❌ | `cmo/items/[id]`, `cmo/opportunities/[id]` |
| Kết nối, ngắt tài khoản mạng xã hội | ❌ | `accounts/*` (OAuth phải chạy trong trình duyệt) |
| Cài đặt Sales (subreddit loại trừ, cặp từ) | ❌ | `sales/settings` |
| Cài đặt CMO, tạm dừng, đổi brain mode, thông báo | ❌ | `cmo/settings`, `cmo/pause`, `cmo/mode`, `notify` |
| Xem credit, mua credit | ❌ | Không có tool; MCP thì có `get_credits` |
| Upload, sửa video, tạo media, caption, export | ❌ | Chỉ có trong clip Assistant hoặc qua MCP |
| Studio: cắt short, render slideshow, đánh dấu video xong | ❌ | `studio/*` |
| Brand kit, project, API key, giữ dữ liệu | ❌ | UI |
| Huỷ hoặc chạy lại job, generation, task | ❌ | `*/cancel`, `jobs/[id]/retry` |
| Xem analytics và metrics từng bài | ⚠️ | Chỉ thấy gián tiếp qua `<cmo_state>`; màn Analytics (P6) không có tool |
| Mở hoặc chuyển màn hình ở cột 3 | ❌ | Không có protocol (mục 2) |

`CMO_SYSTEM_PROMPT` (`lib/agent/prompt.ts:53`) còn dặn model không hứa đăng thay founder. Điều này đúng với "Assist,
never act", nhưng là lý do chat phải trả lời "anh vào Approvals bấm duyệt". Luật này chặn **OpenCMO tự hành động**. Nó
không chặn **founder ra lệnh duyệt bằng lời**. Nói "duyệt bài X lúc 9h" trong chat cũng là founder tự duyệt, giống
như bấm nút. Đây là chỗ thiết kế cần sửa để đạt mục tiêu "mọi thứ giải quyết trong chat" (Khuyến nghị 2).

### 2. Chat và panel phải

- Shell v2: rail | chat | panel (`docs/plans/cmo/2026-10-30-three-column-shell-plan.md`). Màn hình ở cột 3 do URL
  quyết định, và chỉ rail hoặc tab gọi `router.push`.
- Stream của loop (`lib/agent/loop.ts`) có `text`, `tool_start`, `tool_result` (kèm `view` tuỳ chọn, `loop.ts:655`),
  `project_changed`, `approval_request`, `input_request` và `done`.
- `ChatPanel.tsx:140-147` chỉ nối text vào khung chat và đặt nhãn "working". Khi một tool trong `CARD_TOOLS`
  (`create_task`, `set_week_goal`, `update_document`; dòng 54) chạy xong, nó tăng `workVersion`. Chỉ Dashboard nghe
  biến này (`components/dashboard/Dashboard.tsx:24-38`). Nếu founder đang mở Sales, Sales không tải lại.
- `Action.view` (`lib/agent/view.ts:21`) chỉ có `plan`, `touched` và `exports`, và chỉ clip scope dùng. Tool CMO
  không đặt `view`.
- Turn route chỉ nhận `{prompt, attachments}`, trong đó attachments là playhead, selection, frame và voice của
  editor (`app/api/v1/agent/sessions/[id]/turns/route.ts:11`). Vì không có context chip, founder nói "làm ngắn bài
  này" khi đang xem một thẻ thì model không biết là bài nào.
- Có hai Assistant: CMO chat (cột 2) và clip Assistant (thay cột 2 khi mở editor, `ShellV2.tsx:327`). Chúng không
  chuyển việc cho nhau, nên chat CMO không thể "mở editor và thêm caption".
- MCP server (`packages/mcp-server/src/groups/`) cho Claude của founder dùng studio, look, export, versions, inbox và
  account. App chat lại không dùng các nhóm này, nên **Claude ngoài app mạnh hơn chat trong app**. Đây là điều ngược
  với mục tiêu.

### 3. Automation

| Chạy tự động | Ở đâu |
|---|---|
| `sweep` mỗi phút: thu hồi lease, đóng lượt Assistant bị kẹt, slot đến giờ thành `publish_post`, dispatch `cmo_runs` và Studio order | `packages/engine/modal_app.py:544` |
| `cmo_schedule` 00:05 UTC → `/api/cron/cmo` → `enqueueDueLoops` | `modal_app.py:636`, `lib/cmo/schedule.ts:47` |
| `cmo_digest` phút 2 mỗi giờ: thả thẻ bị giữ, email, push (P6) | `modal_app.py:652` |
| Loop: kế hoạch thứ Hai, nháp X theo mục lịch, Sales theo mục lịch, đối thủ, tóm tắt memory, review tuần (Chủ nhật), metrics hằng ngày | `lib/cmo/loops.ts:31-76` |
| Work order của planner (writer, Studio), look check trước thẻ video (P6) | `lib/cmo/jobs/studio-orders.ts`, `lib/departments/studio/look-check.ts` |

Phía máy đã tự chạy được. Còn thiếu là **hành động của founder đi qua được chat**, và **kết quả quay về chat và
panel**. Hiện job xong thì founder phải tự tìm thẻ ở Dashboard: chat không báo "đã xong, mở ở bên phải". `done` của
một `cmo_run` cũng không đẩy về phiên chat đang mở, nên phải hỏi lại `get_run_result`.

### 4. Độ mượt

- Một việc trọn vẹn hiện mất 3–4 bước tay. Ví dụ "viết bài X cho ngày mai lúc 9h" đi qua: chat → `create_task` →
  đợi → mở Dashboard → duyệt → thẻ xếp lịch → chọn giờ. Đích nên là 1 câu và 1 xác nhận.
- Chat không có thẻ xác nhận cho CMO: `plan()` của `cmoScope` luôn trả "run" (`scope.ts:585`). Clip scope đã có sẵn
  `approval_request` và `ask_user` (`scope.ts:144-152`). Đây là cơ chế cần để bật hành động có giá mà vẫn có người
  duyệt.
- `get_run_result` bắt model hỏi vòng. Nên có một tool chờ có giới hạn thời gian, như `wait-tool.ts` của clip scope.

### 5. 3rd-party API

| Vendor | Module | Key | Timeout / retry | Ghi chi phí |
|---|---|---|---|---|
| LLM cho job (Anthropic, Gemini, Groq, OpenAI-compat) | `lib/cmo/jobs/llm.ts` `structured()`; `lib/cmo/agents/registry.ts`; failover `lib/llm-health.ts` | `ANTHROPIC_*`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENAI_COMPAT_*`, `CMO_AGENT_<ID>_*` | SDK mặc định nếu không truyền `timeoutMs` (Anthropic 10 phút, 2 retry); compat 120 s | Chỉ một số job có `onUsage`; giá job là số credit cố định |
| LLM cho chat | `lib/agent/providers/{anthropic,gemini}.ts`, `lib/agent/model.ts` | như trên | fallback phía server; không đổi provider giữa lượt | `agent_record_usage_for` theo token ✅ |
| ScrapeCreators | `lib/cmo/social/scrapecreators.ts` `scGet` (một cửa duy nhất ✅) | `SCRAPECREATORS_API_KEY` hoặc `SCRAPE_CREATORS_API_KEY` | 20 s, không retry, không cache | **Không** ghi gì; `ScBudget` chỉ đếm trong bộ nhớ của một request |
| Hacker News (Algolia, P6) | `lib/cmo/social/hn.ts` | không cần | có timeout | miễn phí |
| fal (ảnh, video, NSFW) | `packages/engine/opencmo/ai/providers/fal.py` | `FAL_KEY` | 60/300/900 s; không submit lại sau khi đã trả tiền ✅ | `complete_generation(p_credits)` ✅ |
| ElevenLabs, Scribe | `ai/providers/elevenlabs.py`, `steps/transcribe.py` | `ELEVENLABS_API_KEY` | 30/300 s | voice có tính; transcript upload không tính |
| Zernio (đăng bài, metrics) | `lib/departments/publish/zernio.ts`, `analytics.ts` | `ZERNIO_API_KEY` + `OPENCMO_PUBLISH_LIVE=1` | có timeout, 1 retry khi an toàn ✅ | — |
| Resend, Web Push (P6) | `lib/notify/{email,push,send}.ts` | `RESEND_API_KEY`, `VAPID_*` | — | — |
| Modal | `lib/modal.ts` | `MODAL_SUBMIT_URL`, `OPENCMO_WORKER_TOKEN` | 10 s; sweep là đường dự phòng ✅ | — |

Ba lỗi tích hợp ScrapeCreators mà PR #133 tìm ra **đã sửa ở P5**:
- parser TikTok đọc được cả dạng phẳng lẫn `aweme_info` (`scrapecreators.ts:184`);
- `threadsSearch` dùng Google `site:threads.net` (`research.ts:195`);
- key đọc được cả hai tên (`scrapecreators.ts:28`).

### 6. Rate limit, credit, tải

**Rate limit.** Có `rate_limit_hit` và allowlist bucket trong SQL. Ở web, helper là
`withApi({rateLimit})` (`lib/api/handler.ts:162`).
- **Không** gắn ở route: `agent/sessions/*` (turns, continue, tool-results, approvals), `captures` (tải URL người
  khác đưa vào), `cmo/runs`, `cmo/onboarding`, `jobs/[id]/retry`, `notify/*`.
- `agent_begin_turn` đếm 60 lượt mỗi giờ. `continue` thì không đếm, và mỗi request lại được một `ScBudget(15)` mới
  (`scope.ts:577`). Một lượt kéo dài nhiều lần `continue` có thể gọi ScrapeCreators không giới hạn.
- Không có trần ScrapeCreators theo người hoặc theo ngày, trừ bucket MCP `mcp_social` 60/h.

**Credit.** Tiền đi qua `credit_hold` / `credit_settle` / `credit_refund` ✅. Các chỗ cần xem:
- `cmo_run` bị tạm dừng (`not_before='infinity'`) hoặc nằm `queued` mãi vẫn giữ credit, không hết hạn.
- Inbox run (`brain:"claude"`) hết hạn sau 3 ngày: chưa thấy đường hoàn credit, cần kiểm.
- `credit_settle` báo lỗi khi số cuối lớn hơn số đang giữ, nên lỗi rơi vào lúc job đã xong việc.
- `sales_scan` rỗng hoàn đủ 5 credit sau khi đã tiêu tới 8 lần tìm và 5 lần đọc chi tiết của provider.
- Lượt agent tính `least(hold, usage)`: phần model tiêu vượt hold thì OpenCMO chịu.
- Đọc nghiên cứu từ chat, MCP, `pull_metrics` và onboarding đều không tính credit.

**Tải.**
- `claim_next_task` chạy theo FIFO toàn cục, `FOR UPDATE SKIP LOCKED`, không chia công bằng giữa người dùng: một
  người có thể chiếm cả 10 container `run_task`.
- `run_job` không có `max_containers` (`modal_app.py:291`).
- Không có trần số phiên chat chạy song song của một người (chỉ có 30 phiên mới mỗi giờ).
- `llm-health` nhớ provider hỏng trong bộ nhớ từng instance, nên mỗi instance Vercel phải tự học lại.

## Repo đáng học

| Repo | Học được gì | File nên đọc | Licence | Copy hay chỉ học |
|---|---|---|---|---|
| [vercel/ai](https://github.com/vercel/ai) | Tool phía client: `onToolCall` chạy tool ngay trong trình duyệt, rồi `addToolOutput` trả kết quả về. Trạng thái tool `approval-requested` → `approval-responded`, kèm `addToolApproveResponse({id, approved, reason})`. `sendAutomaticallyWhen` tự gửi tiếp khi mọi tool đã có kết quả. UI vẽ theo `part.type` (`tool-<name>`) và `state` | `packages/ai/src/ui/chat.ts` (dòng 67-130, 215-260, 397-405, 600-606) | Apache-2.0 | Chỉ học |
| [CopilotKit/CopilotKit](https://github.com/CopilotKit/CopilotKit) | "Frontend tools" (agent hành động trong app, code của app làm việc thật) và human-in-the-loop (agent dừng chờ xác nhận) qua AG-UI. Mới đọc README; chưa đọc được file nguồn, vì host docs bị chặn trong môi trường này | README | MIT | Chỉ học |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | Vẽ tool call thành React component, duyệt inline, "safe frontend actions". Mới đọc README; chưa đọc file nguồn | README | MIT | Chỉ học |

Bài học chung: tool có thể **chạy ở client**, và điều hướng UI nên là tool client, không phải việc của server. Việc
cần duyệt là một **trạng thái của tool call** (requested → responded), không phải một luồng riêng. OpenCMO đã có đủ
mảnh: `tool_request` và route `tool-results` (tool trình duyệt), `approval_request` và route `approvals` (thẻ
duyệt). Chỉ chưa bật chúng cho CMO scope.

## Gắn vào OpenCMO

### 1. Panel protocol và context chip (S)
- **Nguồn:** vercel/ai `onToolCall` (tool client), `part.type` rendering.
- **Đích:**
  - `lib/agent/view.ts` thêm `open?: {screen, tab?, ids?}`, kiểm bằng zod theo `lib/screens/registry.ts`;
  - `components/cmo/workspace/ChatPanel.tsx` đọc `view.open` → `router.push`, và tăng `workVersion` cho màn đang mở;
  - `lib/agent/cmo-tools.ts` đặt `view.open` cho `create_task`, `list_approvals`, `list_calendar` và
    `get_run_result`, thêm tool `open_screen`;
  - turn route thêm `context: {segment, ids}` (tối đa 20 id); prompt CMO coi nó là dữ liệu.
- **Kiểm:** check zod, e2e với `OPENCMO_AGENT_FAKE=1`: "quét Sales" mở `/app/sales`; xem ảnh chụp ở 1440 và 390.

### 2. Tool quyết định trong chat (M)
- **Nguồn:** trạng thái approval của vercel/ai; `approval_request` sẵn có ở clip scope (`scope.ts:144`).
- **Đích:** `cmoScope().plan()` trả "approve" cho các tool có giá hoặc tool đi ra ngoài. Tool mới, mỗi tool gọi
  **đúng RPC mà nút UI đang gọi** (`approvals/[id]`, `schedule/slots/[id]`, `cmo/goals/[id]`, `cmo/pause`,
  `sales/settings`):
  - `decide_card` (approve/skip/edit/redo);
  - `schedule_card`;
  - `decide_goal`;
  - `set_sales_settings`;
  - `pause_cmo`;
  - `get_credits`;
  - `cancel_run`.
- **Luật:** OpenCMO vẫn không tự đăng hay trả lời. Tool chỉ chạy khi chính câu của founder trong lượt đó yêu cầu,
  sau thẻ xác nhận trong chat. Sau khi đọc nội dung ngoài, tool bị khoá như `remember` (`cmo-tools.ts:182`). Sales
  vẫn không có nút đăng.

### 3. Sales finder chạy bằng chat (M, sau R0)
Mục §4a mới trong spec PR #133: kế hoạch tìm kiếm có báo giá hiện thành thẻ duyệt trong chat. Chạy xong thì
`view.open: {screen: "sales", ids}`. "Find email" là thẻ giá cho từng creator. Bảng `leads` chờ R0.

### 4. Sổ chi phí ScrapeCreators (S)
- **Đích:** `scGet` ghi một dòng vào bảng `provider_usage` (user, vendor, endpoint, credits, at). Có trần theo người
  và theo ngày bằng mẫu `cmo_read_hit`. `ScBudget` của chat tính theo lượt, không theo request.
- **Kiểm:** pgTAP, kèm check rằng `continue` không làm mới budget.

### 5. Rate limit, credit, tải
Mỗi mục là một PR review riêng (bảng dưới).

## Khuyến nghị

Các PR review cắt từ `cmo-build`, mỗi PR một mảng, mỗi PR chạy `/code-review max`. Xếp theo thứ tự owner đã đặt.

| # | Làm gì | Chi phí | Cải thiện | PR |
|---|---|---|---|---|
| 1 | **Chất lượng sản phẩm:** panel protocol + context chip; review và sửa phần P6 vừa merge (notify, analytics, look check, thread, reply outcome) | S–M | activation, retention | `review/1-quality` |
| 2 | **Bảo mật:** unsubscribe token, push endpoint, HTML của digest, `sw.js`, text HN không tin cậy, SSRF ở `captures`, MCP key → JWT, webhook, RLS/grant của bảng P6 | S–M | rủi ro | `review/2-security` |
| 3 | **Rate limit:** gắn `withApi({rateLimit})` cho route chat, `captures`, `cmo/runs`, onboarding, retry, notify; đếm cả `continue`; `ScBudget` theo lượt; trần ScrapeCreators theo ngày | S | chi phí, rủi ro | `review/3-rate-limit` |
| 4 | **Credit:** hoàn hold của run bị dừng hoặc treo quá hạn; kiểm hoàn credit khi inbox hết hạn; settle vượt hold; giá sàn cho `sales_scan` rỗng (chờ owner) | S–M | doanh thu, niềm tin | `review/4-credits` |
| 5 | **Tải:** chia công bằng theo người trong `claim_next_task`, `max_containers` cho `run_job`, trần phiên chat song song | S | độ ổn định | `review/5-load` |
| 6 | **Tool quyết định trong chat** (Gắn vào OpenCMO 2) | M | activation: "1 câu, 1 xác nhận" | plan riêng, sau PR 1 |
| 7 | **Sales finder qua chat** (Gắn vào OpenCMO 3) | M–L | doanh thu | PR #133, sau R0 |

**Cần owner quyết:**
- Đọc nghiên cứu trong chat có nên tính credit không? Hiện miễn phí, chỉ bị chặn bởi trần.
- `sales_scan` rỗng có nên giữ lại 1–2 credit không?
- Có cho chat duyệt hoặc xếp lịch thay nút bấm không, nếu có thẻ xác nhận? Khuyến nghị: **có**, vì đây chính là "như
  dùng Claude".

**Không làm:** không gộp clip Assistant vào CMO chat. Nên giữ hai scope và cho CMO **chuyển việc** sang editor
(`view.open: {screen: "editor", ids: [clipId]}`), vì clip scope đã có khoảng 60 tool và các guard riêng.

## Nguồn

- Code OpenCMO, `cmo-build` tại `08daa44` (đọc 2026-11-01): các file ghi trong bài.
- `docs/plans/cmo/2026-10-30-three-column-shell-plan.md`, `docs/plans/cmo/2026-10-28-p6-quality-reach-plan.md`,
  PR #133 `docs/plans/cmo/2026-10-31-sales-finder-spec.md` và
  `docs/research/growth/2026-10-31-scrapecreators-sales-finder.md` (nhánh `cmo-sales-finder`) (2026-11-01).
- https://raw.githubusercontent.com/vercel/ai/main/packages/ai/src/ui/chat.ts (2026-11-01)
- https://raw.githubusercontent.com/vercel/ai/main/LICENSE (2026-11-01)
- https://github.com/CopilotKit/CopilotKit, https://raw.githubusercontent.com/CopilotKit/CopilotKit/main/LICENSE (2026-11-01)
- https://github.com/assistant-ui/assistant-ui, https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/LICENSE (2026-11-01)
