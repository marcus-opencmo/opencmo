/**
 * Dữ liệu có cấu trúc (schema.org) cho Google và các AI trả lời câu hỏi.
 *
 * `application/ld+json` là khối dữ liệu, trình duyệt không chạy nên CSP không
 * chặn. Thoát `<` để một chuỗi chứa `</script>` trong nội dung bài không đóng
 * thẻ sớm.
 */
export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
