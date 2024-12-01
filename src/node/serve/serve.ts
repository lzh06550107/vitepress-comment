import compression from '@polka/compression'
import fs from 'fs-extra'
import path from 'path'
import polka, { type IOptions } from 'polka'
import sirv from 'sirv'
import { resolveConfig } from '../config'

/**
 * 从字符串的两端删除指定的字符（char）。它会不断检查字符串的开头和结尾，如果发现目标字符就去除，直到字符串的两端不再包含该字符
 * @param str 输入的字符串
 * @param char 要去除的字符
 */
function trimChar(str: string, char: string) {
  // 从字符串开头删除指定的字符
  while (str.charAt(0) === char) {
    str = str.substring(1)
  }

  // 从字符串结尾删除指定的字符
  while (str.charAt(str.length - 1) === char) {
    str = str.substring(0, str.length - 1)
  }

  // 返回去掉指定字符后的字符串
  return str
}

export interface ServeOptions {
  base?: string
  root?: string
  port?: number
}

/**
 * 这段代码展示了一个基于 Polka 和 Sirv 的简易 HTTP 服务器的实现，用于在生产环境中为构建后的静态网站提供服务
 * @param options 用于配置服务器选项，如端口、基础路径等。
 */
export async function serve(options: ServeOptions = {}) {
  // 从 options 中获取指定的端口，如果没有指定，则默认为 4173
  const port = options.port ?? 4173
  // 解析配置文件，获取 serve 阶段的配置。resolveConfig 是一个异步函数，返回一个配置对象
  const config = await resolveConfig(options.root, 'serve', 'production')
  // 获取站点的基础路径，默认情况下从配置中获取 base，如果未指定 base，则默认为空字符串。trimChar 函数会移除两端的斜杠 /
  const base = trimChar(options?.base ?? config?.site?.base ?? '', '/')

  // 检查文件路径是否是一个静态资源文件（例如图像、样式表等）。如果路径包含 config.assetsDir（通常是 assets 目录），则认为它是一个资源文件
  const notAnAsset = (pathname: string) =>
    !pathname.includes(`/${config.assetsDir}/`)
  // 读取 404.html 页面内容，在访问不存在的页面时返回
  const notFound = fs.readFileSync(path.resolve(config.outDir, './404.html'))
  // 处理请求路径没有匹配到任何资源的情况，返回 404 错误，并在需要时写入自定义的 404.html 页面
  const onNoMatch: IOptions['onNoMatch'] = (req, res) => {
    res.statusCode = 404
    if (notAnAsset(req.path)) res.write(notFound.toString())
    res.end()
  }

  // 启用 Brotli 压缩。使用 compression 中间件对静态文件进行压缩，以减小文件体积并提高加载速度
  const compress = compression({ brotli: true })
  // 使用 Sirv 中间件来提供静态文件服务。设置了一些缓存相关的选项
  const serve = sirv(config.outDir, {
    etag: true, // 启用 ETag（实体标签）用于缓存验证
    maxAge: 31536000, // 设置资源的最大缓存时间为 1 年（31536000 秒）
    immutable: true, // 设置资源为不可变的，这意味着不会更新缓存，除非文件名变化
    // 对非静态资源设置 no-cache，以防它们被缓存
    setHeaders(res, pathname) {
      if (notAnAsset(pathname)) {
        // force server validation for non-asset files since they
        // are not fingerprinted
        res.setHeader('cache-control', 'no-cache')
      }
    }
  })
  // 启动服务器
  if (base) { // 根据 base 是否存在来决定是否使用基础路径
    return polka({ onNoMatch })
      .use(base, compress, serve)
      .listen(port, () => {
        config.logger.info( // 为路径添加基础路径，启动服务器并监听指定端口
          `Built site served at http://localhost:${port}/${base}/`
        )
      })
  } else {
    return polka({ onNoMatch })
      .use(compress, serve)
      .listen(port, () => {
        config.logger.info(`Built site served at http://localhost:${port}/`)
      })
  }
}
