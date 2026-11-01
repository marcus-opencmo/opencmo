import { NextResponse, type NextRequest } from "next/server";
import { planByProductId } from "@/lib/pricing";
import { productIdOf, verifySignature } from "@/lib/polar";
import { createAdminClient } from "@/lib/supabase/admin";

/** 64 KB. Event nặng nhất của Polar (order kèm snapshot subscription) ~4 KB. */
const MAX_WEBHOOK_BYTES = 64 * 1024;

const EVENTS = new Set([
  "order.paid", "order.refunded", "subscription.active", "subscription.canceled",
  "subscription.revoked", "subscription.past_due",
]);

/** Đối soát tay cần biết ai, nhưng log không được là chỗ rò email người mua. */
function maskEmail(data: Record<string, unknown>): string {
  const raw = (data.customer as { email?: unknown } | null)?.email
    ?? (data.user as { email?: unknown } | null)?.email ?? data.customer_email;
  if (typeof raw !== "string") return "no-email";
  const at = raw.lastIndexOf("@");
  return at < 0 ? "no-email" : `***${raw.slice(at)}`;
}

/** Xác thực body thô trước; mọi ghi billing đi qua một RPC nguyên tử. */
export async function POST(request: NextRequest) {
  const secret = process.env.POLAR_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[polar] thiếu cấu hình webhook");
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 500 });
  }
  // Route này KHÔNG đi qua `withApi`, nên không thừa hưởng trần body 256KB của
  // nó — mà đây lại là endpoint duy nhất mở cho người chưa đăng nhập. Không có
  // trần thì một POST 10MB vẫn bị HMAC trọn vẹn trước khi bị từ chối. Event của
  // Polar nặng nhất cũng chỉ vài KB.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Webhook payload is too large." }, { status: 413 });
  }
  const body = await request.text();
  // `content-length` vắng mặt khi gửi dạng chunked — đo lại trên chuỗi thật.
  // `byteLength` chứ không `.length`: `.length` đếm mã UTF-16, nên 64K ký tự
  // ngoài BMP là tới 256KB byte — trần tính bằng byte thì phải đo bằng byte.
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "Webhook payload is too large." }, { status: 413 });
  }
  const check = verifySignature(body, {
    id: request.headers.get("webhook-id"), timestamp: request.headers.get("webhook-timestamp"),
    signature: request.headers.get("webhook-signature"),
  }, secret);
  if (!check.ok) {
    console.warn("[polar] từ chối webhook:", check.reason);
    return NextResponse.json({ error: check.reason }, { status: 401 });
  }
  let event: { type?: unknown; timestamp?: unknown; data?: unknown };
  try {
    event = JSON.parse(body);
    if (!event || typeof event !== "object" || typeof event.type !== "string") throw new Error();
  } catch {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }
  const type = event.type as string;
  if (!EVENTS.has(type)) return NextResponse.json({ ok: true, ignored: type });
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }
  // Envelope Standard Webhooks không bắt buộc có `timestamp` trong body; header
  // `webhook-timestamp` thì luôn có VÀ đã nằm trong chữ ký vừa kiểm. Thiếu mốc
  // thì mọi lần gửi lại đều 400 — tiền vào mà credit không bao giờ được cộng.
  const eventAt = typeof event.timestamp === "string" && Number.isFinite(Date.parse(event.timestamp))
    ? event.timestamp
    : new Date(Number(request.headers.get("webhook-timestamp")) * 1000).toISOString();
  const data = event.data as Record<string, unknown>;
  if (typeof data.id !== "string" || !data.id) {
    return NextResponse.json({ error: "Invalid webhook payload." }, { status: 400 });
  }
  const productId = productIdOf(data);
  const purchasePlan = type === "order.paid" && productId ? planByProductId(productId) : undefined;
  // Order lịch sử có thể chứa snapshot subscription sau nâng gói. Credit theo
  // product của order; entitlement chỉ theo product CỦA subscription đó.
  const subscription = type.startsWith("subscription.") ? data
    : data.subscription && typeof data.subscription === "object" && !Array.isArray(data.subscription)
      ? data.subscription as Record<string, unknown> : null;
  const subscriptionProductId = subscription ? productIdOf(subscription) : null;
  const entitlementPlan = subscriptionProductId ? planByProductId(subscriptionProductId) : undefined;
  // `order.paid` xác nhận tiền đã nhận, nên một product chưa map không được
  // acknowledge trước khi có receipt/grant bền vững. 5xx để Polar gửi lại sau
  // khi catalog được cấu hình; lifecycle của product retired vẫn có thể skip.
  if (type === "order.paid" && !purchasePlan) {
    console.error("[polar] product lạ:", productId, "— chưa map trong pricing.ts", maskEmail(data));
    return NextResponse.json({ error: "Unable to process billing event." }, { status: 500 });
  }
  // Subscription active chưa map không có entitlement nào để đổi. Các event
  // lifecycle khác đi qua RPC: event của subscription cũ giữ plan đã lưu.
  if (type === "subscription.active" && !entitlementPlan) {
    console.error("[polar] product lạ:", productId, "— chưa map trong pricing.ts", maskEmail(data));
    return NextResponse.json({ ok: true, skipped: "unmapped product" });
  }
  try {
    const { data: result, error } = await createAdminClient().rpc("process_polar_event", {
      p_event_id: request.headers.get("webhook-id"), p_event_type: type,
      p_event_at: eventAt, p_data: data,
      p_purchase_plan: purchasePlan?.id ?? null, p_credits: purchasePlan?.credits ?? null,
      p_entitlement_plan: entitlementPlan?.id ?? null,
    });
    if (error) {
      // DB detail có thể chứa email/payload: chỉ log mã lỗi, không email thô.
      console.error("[polar] giao dịch billing thất bại", error.code);
      return NextResponse.json({ error: "Unable to process billing event." }, { status: 500 });
    }
    if (result && typeof result === "object" && typeof result.skipped === "string") {
      // Không tự tạo hồ sơ ở đây: nó sẽ thuộc về một auth.users không tồn tại.
      console.warn("[polar] bỏ qua", type, "-", result.skipped, maskEmail(data));
    }
    return NextResponse.json(result);
  } catch {
    console.error("[polar] không kết nối được dịch vụ billing");
    return NextResponse.json({ error: "Unable to process billing event." }, { status: 500 });
  }
}
