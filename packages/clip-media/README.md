# clip-media

Font và bộ Lottie có sẵn của clip — **một bản** cho mọi nơi vẽ chữ/Lottie (R7c).

| Thư mục | Ai đọc |
|---|---|
| `fonts/` (32 họ, OFL/Apache) | clip-render (Node + trình duyệt), clip-export, clip-three (Brand Kit), parity, eval agent, web (`/fonts/`) |
| `lottie/` (bộ tự vẽ CC0 + `emoji/` Noto CC BY 4.0) | clip-export (`builtin:<tên>`), editor-core (`find_lotties`), web (`/lottie/`) |

Web không đọc thẳng ở đây: CSP `font-src 'self'` bắt font cùng origin, nên
`apps/web/scripts/sync-media.mts` chép hai thư mục sang `apps/web/public/` trước
`next dev`/`next build` (hai đích đó nằm trong `.gitignore`). Chép chứ không symlink:
build trên Vercel không giữ symlink trỏ ra ngoài thư mục app.

Worker/Modal đọc qua `OPENCMO_EDITOR_FONTS` và `OPENCMO_EDITOR_LOTTIE`. Lottie
`builtin:` KHÔNG suy từ thư mục font: dời một bên mà quên bên kia là Lottie rỗng mà
không lỗi nào báo.

Không phải workspace npm: không ai import nó như module, chỉ đọc file.
Thêm font: `apps/web/scripts/fetch-fonts.mts`; thêm Lottie: `build-lottie-pack.mts`,
`fetch-noto-emoji.mts` — cả ba ghi thẳng vào đây.
