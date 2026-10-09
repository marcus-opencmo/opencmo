/**
 * Kiểm lúc typecheck, không chạy trong app: JSON mẫu dùng chung với engine phải
 * có đủ trường mà kiểu ở `clipping-types.ts` yêu cầu. Chiều ngược lại — API
 * trả đúng các khoá trong mẫu — kiểm ở `packages/engine/tests/test_local_editing.py`.
 *
 * `Widen` nới literal ("9:16") thành `string` vì TypeScript suy kiểu JSON import
 * như vậy; giá trị hợp lệ do `parse_settings` phía engine kiểm.
 */
import project from "../../../tests/contracts/clipping/project.json";
import projectPage from "../../../tests/contracts/clipping/project_page.json";
import transcript from "../../../tests/contracts/clipping/transcript.json";

import type {
  Project,
  ProjectPage,
  TranscriptArtifact,
} from "./clipping-types";

type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends null
        ? null
        : T extends (infer U)[]
          ? Widen<U>[]
          : T extends object
            ? { [K in keyof T]: Widen<T[K]> }
            : T;

export const clippingContractFixtures = {
  project: project satisfies Widen<Project>,
  projectPage: projectPage satisfies Widen<ProjectPage>,
  transcript: transcript satisfies Widen<TranscriptArtifact>,
};
