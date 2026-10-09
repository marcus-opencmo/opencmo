/** Tác giả của blog. Khoá là giá trị `author` trong meta của bài. */
export const AUTHORS = {
  marcus: {
    name: "Marcus",
    role: "Founder, OpenCMO",
    url: "https://opencmo.io",
  },
} as const;

export type AuthorId = keyof typeof AUTHORS;
