import type { ViteDevServer } from 'vite'
import c from 'picocolors'
import { clearCache } from './markdownToVue'

type CreateDevServer = () => Promise<void>

export type CLIShortcut = {
  key: string
  description: string
  action(
    server: ViteDevServer,
    createDevServer: CreateDevServer
  ): void | Promise<void>
}

/**
 * 为 Vite 开发服务器绑定键盘快捷键。它监听用户的输入并根据快捷键执行相应的操作，允许用户在开发过程中方便地控制服务器。
 * 该功能通常在命令行工具中实现，用于提高开发效率。
 * @param server ViteDevServer 类型，表示 Vite 开发服务器实例。
 * @param createDevServer CreateDevServer 类型，表示创建开发服务器的函数，用于处理服务器的重启等操作。
 */
export function bindShortcuts(
  server: ViteDevServer,
  createDevServer: CreateDevServer
): void {
  // 如果 server.httpServer 不存在，或当前不是交互式终端（process.stdin.isTTY），或者当前环境是 CI（process.env.CI），则不执行任何操作
  if (!server.httpServer || !process.stdin.isTTY || process.env.CI) {
    return
  }

  server.config.logger.info(
    c.dim(c.green('  ➜')) +
      c.dim('  press ') +
      c.bold('h') +
      c.dim(' to show help')
  )

  let actionRunning = false

  const onInput = async (input: string) => {
    // ctrl+c or ctrl+d 如果用户输入 ctrl+c（\x03）或 ctrl+d（\x04），则关闭服务器并退出进程
    if (input === '\x03' || input === '\x04') {
      await server.close().finally(() => process.exit(1))
      return
    }

    // actionRunning 用来防止同时执行多个操作，确保每次只有一个操作在执行
    if (actionRunning) return

    // 如果用户按下 h 键，会显示所有可用的快捷键信息
    if (input === 'h') {
      server.config.logger.info(
        [
          '',
          c.bold('  Shortcuts'),
          ...SHORTCUTS.map(
            (shortcut) =>
              c.dim('  press ') +
              c.bold(shortcut.key) +
              c.dim(` to ${shortcut.description}`)
          )
        ].join('\n')
      )
    }

    // 当用户按下快捷键时，onInput 会根据按下的键查找相应的操作并执行
    const shortcut = SHORTCUTS.find((shortcut) => shortcut.key === input)
    if (!shortcut) return

    actionRunning = true
    await shortcut.action(server, createDevServer) // 执行快捷命令
    actionRunning = false
  }

  // 将标准输入设置为原始模式，使得输入字符能够立即被捕获而不需要按下回车键
  process.stdin.setRawMode(true)
  // 监听用户的输入数据，当用户按下键时触发 onInput 回调，设置编码为 utf8，并恢复流的默认行为
  process.stdin.on('data', onInput).setEncoding('utf8').resume()

  // 关闭时清理资源，在服务器关闭时，取消输入监听并恢复标准输入的行为
  server.httpServer.on('close', () => {
    process.stdin.off('data', onInput).pause()
    process.stdin.setRawMode(false)
  })
}

// SHORTCUTS 是一个快捷键列表，每个快捷键包含一个 key 和一个 description，按下相应键时会显示该快捷键的描述
const SHORTCUTS: CLIShortcut[] = [
  {
    key: 'r',
    description: 'restart the server',
    async action(server, createDevServer) {
      server.config.logger.info(c.green(`restarting server...\n`), {
        clear: true,
        timestamp: true
      })
      clearCache()
      await server.close()
      await createDevServer()
    }
  },
  {
    key: 'u',
    description: 'show server url',
    action(server) {
      server.config.logger.info('')
      server.printUrls()
    }
  },
  {
    key: 'o',
    description: 'open in browser',
    action(server) {
      server.openBrowser()
    }
  },
  {
    key: 'c',
    description: 'clear console',
    action(server) {
      server.config.logger.clearScreen('error')
    }
  },
  {
    key: 'q',
    description: 'quit',
    async action(server) {
      await server.close().finally(() => process.exit())
    }
  }
]
