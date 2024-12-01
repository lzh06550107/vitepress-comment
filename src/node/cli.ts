import minimist from 'minimist'
import c from 'picocolors'
import { createLogger } from 'vite'
import { build, createServer, serve } from '.'
import { init } from './init/init'
import { version } from '../../package.json'
import { bindShortcuts } from './shortcuts'

// minimist 轻量级的命令行参数解析引擎
const argv: any = minimist(process.argv.slice(2))

/**
 * 定义了一个 logVersion 函数，主要用于输出 vitepress 版本信息到日志。
 * 它使用了一个默认的日志记录器（logger），如果没有传入日志记录器，则会创建一个新的记录器。
 * 日志信息将包括 vitepress 的版本号，并通过颜色和格式进行高亮显示
 * @param logger
 */
const logVersion = (logger = createLogger()) => {
  logger.info(`\n  ${c.green(`${c.bold('vitepress')} v${version}`)}\n`, {
    clear: !logger.hasWarned // 指示是否清除或重置日志。具体的清除操作取决于日志系统的实现，通常可以用于在每次记录新日志之前清除控制台或日志区域的内容。
  })
}

const command = argv._[0] // 获取命令名称
// 这行代码根据 command 是否存在来决定 root 的值。
// 1. 如果 command 存在（即 argv._[0] 不为空），那么 root 就是 argv._[1]（即第二个参数）。
// 2. 如果 command 不存在，root 就是 argv._[0]（即第一个参数）。
const root = argv._[command ? 1 : 0]
if (root) { // 文档根目录
  argv.root = root
}

let restartPromise: Promise<void> | undefined

// 使用指定目录作为根目录来启动 VitePress 开发服务器。默认为当前目录。在当前目录下运行时也可以省略 dev 命令。
if (!command || command === 'dev') { // 默认是dev命令
  if (argv.force) { // 强制优化程序忽略缓存并重新绑定
    delete argv.force
    argv.optimizeDeps = { force: true }
  }

  const createDevServer = async () => {
    const server = await createServer(root, argv, async () => {
      if (!restartPromise) {
        restartPromise = (async () => {
          await server.close()
          await createDevServer()
        })().finally(() => {
          restartPromise = undefined
        })
      }

      return restartPromise
    })
    await server.listen() // 启动服务器，开始监听
    logVersion(server.config.logger) // 打印 vitepress 版本
    server.printUrls() // 打印启动信息
    bindShortcuts(server, createDevServer) // 绑定快捷键
  }
  // 启动dev服务器
  createDevServer().catch((err) => {
    createLogger().error(
      `${c.red(`failed to start server. error:`)}\n${err.message}\n${err.stack}`
    )
    process.exit(1)
  })
} else if (command === 'init') { // 在当前目录中启动安装向导
  // 会在记录日志之前清空当前日志输出
  createLogger().info('', { clear: true })
  init()
} else {
  logVersion()
  if (command === 'build') { // 构建用于生产环境的 VitePress 站点
    build(root, argv).catch((err) => {
      createLogger().error(
        `${c.red(`build error:`)}\n${err.message}\n${err.stack}`
      )
      process.exit(1)
    })
  } else if (command === 'serve' || command === 'preview') { // 在本地预览生产版本
    serve(argv).catch((err) => {
      createLogger().error(
        `${c.red(`failed to start server. error:`)}\n${err.message}\n${err.stack}`
      )
      process.exit(1)
    })
  } else {
    createLogger().error(c.red(`unknown command "${command}".`))
    process.exit(1)
  }
}
