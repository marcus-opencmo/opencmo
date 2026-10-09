/**
 * Dải ngân hà ở footer: ~14.000 sao trên Canvas 2D (không WebGL), xếp ba nhánh xoắn
 * nghiêng như nhìn chéo; lõi kem → terracotta → hồng → xanh ở rìa. Nhánh trong quay
 * nhanh hơn nhánh ngoài. Lõi đặt ngay sau câu CTA (`ctaHeight`), không sau khung link.
 *
 * Seed cố định: thiên hà giống hệt nhau mỗi lần tải trang.
 */
export function startGalaxy(canvas: HTMLCanvasElement, foot: HTMLElement, cta: HTMLElement | null, reduced: boolean): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = rnd();
    while (!v) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const mix = (a: number[], b: number[], t: number) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const CORE = [255, 236, 214], TERRA = [236, 120, 82], ROSE = [214, 120, 170], BLUE = [118, 140, 255], ICE = [190, 210, 255];

  const stars: { r: number; th: number; c: string; a: number; s: number; w: number }[] = [];
  const N = Math.min(14000, Math.round(window.innerWidth * 9));
  for (let i = 0; i < N; i++) {
    const arm = i % 3 === 0 ? 2 : i % 2, t = Math.pow(rnd(), 1.35);
    const spread = 0.42 * (1 - t) + 0.1, th = arm * Math.PI * (arm === 2 ? 0.5 : 1) + t * 7.4 + gauss() * spread;
    const rr = t + gauss() * 0.03;
    const c = t < 0.12 ? mix(CORE, TERRA, t / 0.12) : t < 0.45 ? mix(TERRA, ROSE, (t - 0.12) / 0.33) : mix(ROSE, rnd() > 0.5 ? BLUE : ICE, Math.min(1, (t - 0.45) / 0.45));
    stars.push({ r: Math.max(0.004, rr), th, c: `rgb(${c[0]},${c[1]},${c[2]})`, a: (0.25 + rnd() * 0.75) * (t < 0.1 ? 1 : 0.85), s: rnd() < 0.04 ? 2 : 1, w: 0.9 / Math.sqrt(Math.max(0.05, rr)) });
  }
  const clouds = Array.from({ length: 70 }, (_, i) => {
    const t = 0.08 + rnd() * 0.85, arm = i % 2;
    return { r: t, th: arm * Math.PI + t * 7.4 + gauss() * 0.18, sz: 0.05 + rnd() * 0.12 * (1 - t * 0.5), c: t < 0.4 ? "236,120,82" : rnd() > 0.5 ? "118,140,255" : "214,120,170", a: 0.05 + rnd() * 0.07, w: 0.9 / Math.sqrt(t) };
  });
  const field = Array.from({ length: 700 }, () => ({ x: rnd(), y: rnd(), a: rnd(), s: rnd() < 0.08 ? 1.6 : 0.8, f: 0.5 + rnd() * 2 }));

  let W = 0, H = 0, CH = 600, dpr = 1, rot = 0, mx = 0, my = 0, tmx = 0, tmy = 0, vis = false, last = 0, raf = 0;
  const size = () => {
    dpr = Math.min(1.5, window.devicePixelRatio || 1);
    W = foot.clientWidth;
    H = foot.clientHeight;
    CH = cta ? cta.offsetHeight : 600;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
  };
  const draw = (now: number) => {
    const dt = Math.min(50, now - (last || now));
    last = now;
    if (!reduced) rot += dt * 0.000035;
    mx += (tmx - mx) * 0.04;
    my += (tmy - my) * 0.04;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#03050f";
    ctx.fillRect(0, 0, W, H);
    for (const f of field) {
      ctx.globalAlpha = 0.25 + 0.55 * Math.abs(Math.sin(now * 0.0006 * f.f + f.a * 9));
      ctx.fillStyle = "#e8e4f5";
      ctx.fillRect(f.x * W + mx * -6, f.y * H + my * -6, f.s, f.s);
    }
    const cx = W * 0.5 + mx * 22, cy = CH * 0.5 + my * 14, R = Math.max(W * 0.62, CH * 1.15), tilt = 0.4, tiltA = -0.32, ca = Math.cos(tiltA), sa = Math.sin(tiltA);
    const P = (r: number, th: number): [number, number] => {
      const x = r * R * Math.cos(th), y = r * R * Math.sin(th) * tilt;
      return [cx + x * ca - y * sa, cy + x * sa + y * ca];
    };
    ctx.globalCompositeOperation = "lighter";
    let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.75);
    g.addColorStop(0, "rgba(120,110,200,.16)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(tiltA); ctx.scale(1, tilt * 1.6); ctx.translate(-cx, -cy);
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    ctx.restore();
    for (const c of clouds) {
      const [x, y] = P(c.r, c.th + rot * c.w), s = c.sz * R;
      const cg = ctx.createRadialGradient(x, y, 0, x, y, s);
      cg.addColorStop(0, `rgba(${c.c},${c.a})`);
      cg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = cg;
      ctx.fillRect(x - s, y - s, s * 2, s * 2);
    }
    for (const st of stars) {
      const [x, y] = P(st.r, st.th + rot * st.w);
      if (x < -2 || y < -2 || x > W + 2 || y > H + 2) continue;
      ctx.globalAlpha = st.a;
      ctx.fillStyle = st.c;
      ctx.fillRect(x, y, st.s, st.s);
    }
    ctx.globalAlpha = 1;
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.16);
    g.addColorStop(0, "rgba(255,244,228,.95)");
    g.addColorStop(0.25, "rgba(255,190,140,.45)");
    g.addColorStop(1, "rgba(226,112,74,0)");
    ctx.fillStyle = g;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(tiltA); ctx.scale(1, 0.62); ctx.translate(-cx, -cy);
    ctx.fillRect(cx - R * 0.2, cy - R * 0.2, R * 0.4, R * 0.4);
    ctx.restore();
    if (vis && !reduced) raf = requestAnimationFrame(draw);
  };

  size();
  draw(performance.now());
  const ro = new ResizeObserver(() => {
    size();
    if (!vis || reduced) draw(performance.now());
  });
  ro.observe(foot);
  // Khuất màn hình thì ngừng vẽ.
  const io = new IntersectionObserver(([e]) => {
    const was = vis;
    vis = e.isIntersecting;
    if (vis && !was) {
      last = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    }
  }, { rootMargin: "200px" });
  io.observe(foot);
  const move = (e: PointerEvent) => {
    const b = foot.getBoundingClientRect();
    tmx = (e.clientX - b.left) / b.width - 0.5;
    tmy = (e.clientY - b.top) / b.height - 0.5;
  };
  foot.addEventListener("pointermove", move);

  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    foot.removeEventListener("pointermove", move);
  };
}
