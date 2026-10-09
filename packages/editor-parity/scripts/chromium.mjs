/**
 * Chromium cho oracle/ứng viên: `CHROMIUM` nếu đặt, bản cài sẵn của sandbox nếu
 * có, không thì để Playwright tự chọn (CI cài bằng `npx playwright install`).
 */

import { existsSync } from 'node:fs';

const SANDBOX = '/opt/pw-browsers/chromium';

export const executablePath = process.env.CHROMIUM ?? (existsSync(SANDBOX) ? SANDBOX : undefined);
