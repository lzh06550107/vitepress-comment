import { build, type Rollup } from 'vite'
import type { SiteConfig } from '..'

const virtualEntry = 'client.js'

/**
 * 构建多页面应用（MPA）客户端的 JavaScript 代码，使用 Vite 和 Rollup 进行构建
 * @param js 包含页面或模块的 JavaScript 代码的对象，键是文件名，值是对应的 JavaScript 代码
 * @param config 站点配置对象，包含站点的源目录、输出目录、缓存目录等
 */
export async function buildMPAClient(
  js: Record<string, string>,
  config: SiteConfig
): Promise<Rollup.RollupOutput> {
  // 将传入的 js 对象中的文件按类型分类
  const files = Object.keys(js)
  // 所有非 .md 文件（通常是主题相关的 JavaScript 文件）
  const themeFiles = files.filter((f) => !f.endsWith('.md'))
  // 所有 .md 文件（通常是文档页面）
  const pages = files.filter((f) => f.endsWith('.md'))

  // 使用 build 函数来启动 Vite 构建过程
  return build({
    root: config.srcDir, // 源目录
    cacheDir: config.cacheDir, // 缓存目录
    base: config.site.base, // 站点基础路径
    logLevel: config.vite?.logLevel ?? 'warn', // 日志级别（默认为 warn，可以从 config.vite 获取）
    build: {
      emptyOutDir: false,
      outDir: config.outDir,
      rollupOptions: {
        input: [virtualEntry, ...pages]
      }
    },
    plugins: [
      {
        name: 'vitepress-mpa-client',
        resolveId(id) {
          if (id === virtualEntry) {
            return id
          }
        },
        load(id) {
          if (id === virtualEntry) {
            return themeFiles
              .map((file) => `import ${JSON.stringify(file)}`)
              .join('\n')
          } else if (id in js) {
            return js[id]
          }
        }
      }
    ]
  }) as Promise<Rollup.RollupOutput>
}
