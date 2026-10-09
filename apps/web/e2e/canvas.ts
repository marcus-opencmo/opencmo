import type { Page } from "@playwright/test";

/**
 * Hình chữ nhật (CSS pixel của trang) mà scene đang mở chiếm trên canvas của
 * editor: góc trên-trái đọc từ nhãn tên scene của lớp tương tác (nó neo đúng
 * góc scene), tỉ lệ từ ô zoom, cỡ scene từ document.
 */
export async function sceneBox(
  page: Page,
  size: { width: number; height: number },
): Promise<{ x: number; y: number; width: number; height: number }> {
  const stage = (await page.getByTestId("editor-stage").boundingBox())!;
  const label = page.locator('[data-testid="canvas-overlay"] foreignObject:has([data-testid="scene-label"])');
  const x = Number(await label.getAttribute("x"));
  const y = Number(await label.getAttribute("y")) + 24;
  const scale = Number((await page.getByTestId("zoom-level").textContent())!.replace("%", "")) / 100;
  return { x: stage.x + x, y: stage.y + y, width: size.width * scale, height: size.height * scale };
}

/**
 * Dải CHỈ có video: dưới tiêu đề, trên vùng phụ đề, chừa hai mép. Đo cả canvas
 * thì chữ và phụ đề đủ làm assertion xanh trong khi khung video đen — đúng cái
 * đã xảy ra từ GĐ 1 tới GĐ 5 (`note.md`, 23/09).
 */
const VIDEO_BAND = { left: 0.2, top: 0.2, width: 0.6, height: 0.35 };

export type RegionStats = { mean: number; std: number };

/**
 * Độ sáng trung bình và độ lệch chuẩn của dải video, đo trên ẢNH CHỤP màn hình
 * — thứ người dùng thấy, gồm cả mọi lớp phủ lên canvas.
 *
 * `std` là con số đáng tin: nền đen và ô màu phẳng mà runtime vẽ khi decoder
 * từ chối (Chromium không có H.264) đều cho `std` ≈ 0; một khung hình thật có
 * kết cấu.
 */
export async function videoRegionStats(
  page: Page,
  scene: { x: number; y: number; width: number; height: number },
): Promise<RegionStats> {
  const clip = {
    x: scene.x + scene.width * VIDEO_BAND.left,
    y: scene.y + scene.height * VIDEO_BAND.top,
    width: scene.width * VIDEO_BAND.width,
    height: scene.height * VIDEO_BAND.height,
  };
  const png = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const surface = document.createElement("canvas");
    surface.width = image.naturalWidth;
    surface.height = image.naturalHeight;
    const context = surface.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, surface.width, surface.height);
    let sum = 0;
    let squares = 0;
    const count = data.length / 4;
    for (let at = 0; at < data.length; at += 4) {
      const luma = 0.2126 * data[at]! + 0.7152 * data[at + 1]! + 0.0722 * data[at + 2]!;
      sum += luma;
      squares += luma * luma;
    }
    const mean = sum / count;
    return { mean, std: Math.sqrt(Math.max(0, squares / count - mean * mean)) };
  }, png.toString("base64"));
}
