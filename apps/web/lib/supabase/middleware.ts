import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Làm mới phiên đăng nhập trên mỗi request.
 *
 * Server Component không ghi được cookie, nên nếu chỉ dựa vào chúng thì token
 * hết hạn sẽ đá người dùng ra ngoài giữa chừng. Middleware là chỗ duy nhất vừa
 * đọc vừa ghi được cookie — đây là lý do file này tồn tại.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Chặn ở đây thay vì trong từng trang: quên một trang là lộ một trang.
  //
  // `/api/v1` KHÔNG chuyển hướng: client của nó là `fetch`, và một redirect 307
  // tới trang HTML `/login` sẽ được `res.json()` đọc thành lỗi parse thay vì
  // "hãy đăng nhập lại". `withApi` trả 401 JSON.
  //
  // `/editor` đi cùng nhánh với `/app`: nó là cùng một workspace, chỉ khác ở
  // chỗ nó là một SPA tĩnh. Chưa đăng nhập mà mở thẳng nó thì bundle nạp xong,
  // lượt gọi `/api/v1/editor/project` trả 401, và người dùng nhìn một editor
  // rỗng kèm một toast — thay vì thấy form đăng nhập.
  if (!user && /^\/(app|editor)(\/|$)/.test(request.nextUrl.pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    // Chỉ giữ đường dẫn NỘI BỘ: `next` là chỗ cổ điển để mở open redirect —
    // `//evil.example` cũng là một pathname hợp lệ với trình duyệt.
    const target = request.nextUrl.pathname;
    if (target.startsWith("/") && !target.startsWith("//")) {
      login.searchParams.set("next", target);
    }
    return NextResponse.redirect(login);
  }

  return response;
}
