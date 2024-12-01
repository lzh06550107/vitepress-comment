import type { Plugin } from 'vite'
import { compile, match } from 'path-to-regexp'
import type { SiteConfig, UserConfig } from '../siteConfig'

/**
 * 用于处理路由重写规则，它根据用户提供的重写规则（userRewrites）将页面路径（pages）映射到新的目标路径。
 * 该函数的核心任务是根据一组重写规则，生成两个映射：一个是原始页面到重写目标的映射，另一个是从重写目标到原始页面的映射。
 * @param pages 一个包含页面路径的字符串数组（例如 ['/about', '/contact']），这些是需要进行重写匹配的页面
 * @param userRewrites 用户自定义的重写规则，格式为一个对象，键是原始路由，值是目标路由。规则支持正则表达式和普通路径的重写
 */
export function resolveRewrites(
  pages: string[],
  userRewrites: UserConfig['rewrites']
) {
  // 用户可以在 userRewrites 中定义路由重写规则。每个规则由一个匹配路径和一个目标路径组成。函数通过 compile 和 match 将路径规则编译为可执行的模式
  // from 是原始路径规则，支持字符串和正则表达式。使用 match 将其转换为匹配函数。
  // to 是目标路径，使用 compile 函数将其转换为路径函数。
  const rewriteRules = Object.entries(userRewrites || {}).map(([from, to]) => ({
    toPath: compile(`/${to}`, { validate: false }), // 编译目标路径
    matchUrl: match(from.startsWith('^') ? new RegExp(from) : from) // 编译源路径（支持正则）
  }))

  // 初始化映射对象: 创建两个映射对象
  const pageToRewrite: Record<string, string> = {} // 用于存储从页面路径到重写目标路径的映射
  const rewriteToPage: Record<string, string> = {} // 用于存储从重写目标路径到原页面路径的映射
  // 遍历页面并应用重写规则: 对每个页面路径，逐一检查是否匹配任何重写规则。如果匹配，则生成新的目标路径，并更新两个映射
  if (rewriteRules.length) {
    for (const page of pages) {
      for (const { matchUrl, toPath } of rewriteRules) {
        const res = matchUrl(page) // 判断页面路径是否匹配规则
        if (res) {
          const dest = toPath(res.params).slice(1) // 生成目标路径
          pageToRewrite[page] = dest // 保存页面到重写目标的映射
          rewriteToPage[dest] = page // 保存重写目标到页面的反向映射
          break
        }
      }
    }
  }

  return {
    map: pageToRewrite, // 原页面路径到重写目标路径的映射
    inv: rewriteToPage // 重写目标路径到原页面路径的反向映射
  }
}

/**
 * 主要功能是在开发服务器中对请求的 URL 进行重写。它通过 configureServer 配置项，在开发环境中对特定的请求路径进行自定义的重定向或替换
 * @param config
 */
export const rewritesPlugin = (config: SiteConfig): Plugin => {
  return {
    name: 'vitepress:rewrites', // 插件名称
    configureServer(server) { // 配置开发服务器
      // dev rewrite
      server.middlewares.use((req, _res, next) => { // 使用中间件处理请求
        if (req.url) { // 确保请求的 URL 存在
          // 解码 URL 并去掉查询字符串（?）和哈希（#）部分
          const page = decodeURI(req.url)
            .replace(/[?#].*$/, '') // 去掉 URL 中的查询参数和哈希部分
            .slice(config.site.base.length) // 删除 base URL 前缀

          // 如果该页面有设置重写规则，则进行替换
          if (config.rewrites.inv[page]) {
            req.url = req.url.replace(
              encodeURI(page), // 原始路径
              encodeURI(config.rewrites.inv[page]!) // 替换后的路径
            )
          }
        }
        next() // 调用 next() 继续处理请求
      })
    }
  }
}
