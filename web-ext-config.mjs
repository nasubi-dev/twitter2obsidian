// web-ext の設定。`npx web-ext sign` だけで unlisted 署名できるようにする
export default {
  ignoreFiles: [
    "CLAUDE-SECURITY-*",
    "CLAUDE-SECURITY-*/**",
    "docs",
    "docs/**",
    "scripts",
    "scripts/**",
    "*.md",
    "web-ext-config.mjs",
  ],
  sign: {
    channel: "unlisted",
  },
};
