/// <reference types="vite/client" />
// Vite 在构建期替换的 `import.meta.env` 等类型。没有它，前端里 `import.meta.env.DEV`
// 会被 tsc 判成「Property 'env' does not exist」。
