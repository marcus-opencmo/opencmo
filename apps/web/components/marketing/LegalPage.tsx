/**
 * Một trang pháp lý: tiêu đề, ngày cập nhật, các mục. Nội dung là dữ liệu để
 * bốn trang giữ cùng một bố cục và cùng một ngày cập nhật khi sửa.
 */

export const LEGAL_UPDATED = "October 2, 2026";

export type LegalSection = { heading: string; body: React.ReactNode };

export function LegalPage({ title, intro, sections }: { title: string; intro: React.ReactNode; sections: LegalSection[] }) {
  return (
    <main className="legal-page">
      <p className="section-kicker">Legal</p>
      <h1>{title}</h1>
      <p className="legal-updated">Last updated {LEGAL_UPDATED}</p>
      <div className="legal-intro">{intro}</div>
      {sections.map((s) => (
        <section key={s.heading}>
          <h2>{s.heading}</h2>
          {s.body}
        </section>
      ))}
    </main>
  );
}
