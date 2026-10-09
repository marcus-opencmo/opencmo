import { NextResponse, type NextRequest } from "next/server";

import { createServerClient } from "@/lib/supabase/server";

/**
 * Base giả để phân tích `next`. Chỉ dùng cho việc đối chiếu origin bên dưới —
 * không bao giờ đi vào header `Location`.
 */
const PARSE_BASE = "http://redirect.invalid";

/**
 * Chuyển hướng bằng `Location` TƯƠNG ĐỐI.
 *
 * Vì sao không ghép `request.nextUrl.origin`: thuộc tính đó KHÔNG đọc header
 * `Host`. Chạy `next start` sau một proxy — hoặc chỉ cần phục vụ trên
 * `127.0.0.1` — thì nó trả về `http://localhost:<port>`. Cookie phiên vừa được
 * ghi cho host thật, rồi redirect sang `localhost` là sang một origin khác:
 * trình duyệt không gửi cookie theo, `/app` thấy chưa đăng nhập và đá ngược về
 * `/login`. Đăng nhập hỏng mà không in ra một dòng lỗi nào — đúng kiểu lỗi im
 * lặng đắt nhất. Location tương đối để trình duyệt tự giải theo host thật.
 */
function redirectTo(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}

/**
 * Đích của Google OAuth (PKCE). Đổi `code` lấy phiên rồi chuyển tiếp vào app.
 *
 * Route handler chứ không phải Server Component: chỉ ở đây mới ghi được cookie
 * phiên đăng nhập.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const code = searchParams.get("code");
  const next = searchParams.get("next") || "/app";
  const url = searchParams.get("url");
  const site = searchParams.get("site");

  // Người dùng bấm huỷ ở màn Google: Supabase gửi `error`, không có `code`.
  if (searchParams.get("error")) {
    return redirectTo("/login?error=huy");
  }
  if (!code) {
    return redirectTo("/login?error=thieu-ma");
  }

  const supabase = await createServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return redirectTo("/login?error=link-het-han");
  }

  // `next` tới từ query của người dùng (`/login?next=…` đi thẳng vào
  // `redirectTo` của OAuth), nên nó là dữ liệu KHÔNG tin được. `new URL(next, base)`
  // bỏ qua base ngay khi next là URL tuyệt đối: `https://evil.com`, `//evil.com`
  // và `/\evil.com` đều thoát ra ngoài miền. Đó là open redirect ngay sau lúc
  // đăng nhập thành công — chỗ đắt nhất để lừa, vì người dùng vừa tự tay xác
  // thực nên tin trang kế tiếp.
  //
  // Danh sách chặn tiền tố ("//", "/\", …) rất dễ sót một biến thể của bộ phân
  // tích URL. Nên dựng xong rồi ĐỐI CHIẾU origin: một bất biến duy nhất, đúng
  // với mọi cách viết. Đối chiếu với `PARSE_BASE` cố định chứ không với origin
  // của request, vì origin đó có thể sai (xem `redirectTo`). Redirect URLs của
  // Supabase không đỡ được — nó duyệt địa chỉ callback, không duyệt query của
  // callback.
  let target = new URL(next, PARSE_BASE);
  if (target.origin !== PARSE_BASE) {
    console.warn("[auth] chặn next ra ngoài miền:", next);
    target = new URL("/app", PARSE_BASE);
  }
  if (url) target.searchParams.set("url", url);
  // Website nhập ở hero → `/app` (AI CMO), nơi W0 Onboarding đọc nó. KHÔNG trộn vào
  // `url` — `url` là link video và app sẽ tạo job clip từ nó.
  if (site) target.searchParams.set("site", site);
  return redirectTo(`${target.pathname}${target.search}`);
}
