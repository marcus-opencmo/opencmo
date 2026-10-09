/** Dùng tài sản gốc của OpenCMO, không dựng lại logo bằng ký tự. */
export function Brand() {
  return (
    <span className="brand-lockup">
      <img src="/icon.svg" width="32" height="32" alt="" />
      <span>OpenCMO</span>
    </span>
  );
}

export function Mascot({ className = "" }: { className?: string }) {
  return <img className={className} src="/mascot/logo-poster.png" width="480" height="480" alt="" />;
}
