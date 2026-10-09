/**
 * Camera của vùng canvas: scene hiện ở đâu và to bao nhiêu trên màn hình.
 *
 * Là trạng thái XEM của từng tab, không lưu vào document: zoom hay kéo khung
 * không phải một lượt sửa clip, và ghi nó xuống sẽ biến mỗi cú cuộn chuột thành
 * một bước Undo và một lượt lưu. Vừa khung dùng đúng `cameraFor` của
 * editor-core — cùng lề với thứ `set_frame` ghi cho fork.
 */

import { cameraFor } from "@opencmo/editor-core";

export type Camera = { scale: number; x: number; y: number };
export type Size = { width: number; height: number };

const MIN = 0.02;
const MAX = 8;

export function fitCamera(scene: Size, viewport: Size): Camera {
  const matrix = cameraFor(scene.width, scene.height, viewport);
  if (matrix) return { scale: matrix[0], x: matrix[4], y: matrix[5] };
  return { scale: 1, x: 0, y: 0 };
}

/** Phóng quanh điểm (px, py) của màn hình: điểm dưới con trỏ đứng yên. */
export function zoomAt(camera: Camera, factor: number, px: number, py: number): Camera {
  const scale = Math.min(MAX, Math.max(MIN, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { scale, x: px - (px - camera.x) * ratio, y: py - (py - camera.y) * ratio };
}

export const panBy = (camera: Camera, dx: number, dy: number): Camera => ({
  ...camera,
  x: camera.x + dx,
  y: camera.y + dy,
});

/**
 * Tỉ lệ vẽ scene vào canvas phụ: đủ nét cho mức zoom hiện tại, không vẽ quá cỡ
 * thật. Làm tròn theo nấc √2 để zoom liên tục không dựng lại renderer mỗi khung.
 */
export function renderScale(camera: Camera, dpr: number): number {
  const wanted = Math.min(1, camera.scale * dpr);
  return Math.max(1 / 16, Math.min(1, 2 ** (Math.ceil(Math.log2(wanted) * 2) / 2)));
}
