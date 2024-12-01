import { createServer as createViteServer, type ServerOptions } from 'vite'
import { resolveConfig } from './config'
import { createVitePressPlugin } from './plugin'

/**
 * 旨在创建并返回一个 Vite 开发服务器实例。它会根据项目的根目录、服务器选项以及一些其他配置来生成服务器
 * @param root
 * @param serverOptions
 * @param recreateServer
 */
export async function createServer(
  root: string = process.cwd(), // 默认值为当前工作目录
  serverOptions: ServerOptions & { base?: string } = {}, // 服务器选项，允许传入 base
  recreateServer?: () => Promise<void> // 可选的重建服务器的函数
) {
  // 异步解析配置
  const config = await resolveConfig(root)

  if (serverOptions.base) {// 站点将部署到的 base URL，即域名之后中间一部分
    config.site.base = serverOptions.base // 更新配置中的 base URL
    delete serverOptions.base // 删除 base 属性，因为它已经被配置到 config 中
  }

  return createViteServer({// 创建并返回一个 Vite 开发服务器实例
    root: config.srcDir, // 设置项目的源代码目录
    base: config.site.base, // 设置站点的基础路径
    cacheDir: config.cacheDir, // 设置缓存目录
    plugins: await createVitePressPlugin(config, false, {}, {}, recreateServer), // 所有配置插件
    server: serverOptions, // 传入的服务器选项
    customLogger: config.logger, // 自定义日志记录器
    configFile: config.vite?.configFile // 配置文件路径
  })
}
