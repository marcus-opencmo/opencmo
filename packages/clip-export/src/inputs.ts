/**
 * Tham số đặt TRƯỚC `-i` của một file media người dùng (cùng danh sách với
 * `USER_MEDIA_FORMATS` của engine). ffmpeg đoán định dạng theo NỘI DUNG: không giới hạn thì
 * một file là playlist HLS / concat khiến exporter đọc file khác trên máy worker hay đi lấy URL
 * tuỳ ý (SSRF, đọc file cục bộ). Không có hls, concat, image2 (chuỗi file theo mẫu).
 */
export const USER_MEDIA_FORMATS =
  'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,aac,ogg,flac,avi,mpegts,gif,png_pipe,jpeg_pipe,webp_pipe';

export const USER_INPUT = ['-protocol_whitelist', 'file', '-format_whitelist', USER_MEDIA_FORMATS];
