import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// 手机远程插件的「高级」页：把参考项目（comfyui-mobile-frontend, MIT）的
// 工作流面板真实组件编译成单文件 bundle，挂进我们自己的手机页面。
// 输出固定叫 panel.js / panel.css，由 server.py 的 _MOBILE_ASSET_FILES 白名单放行。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/mobile/assets/',
  build: {
    // 直接产出到 mobile/：server.py 的静态白名单按文件名放行（panel.js / panel.css），
    // 和 advanced.js 那些资源同一个目录，省掉一步复制。
    outDir: '..',
    emptyOutDir: false,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'src/mtr-entry.tsx'),
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'panel.js',
        assetFileNames: 'panel.[ext]',
        chunkFileNames: 'panel-[name].js',
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
