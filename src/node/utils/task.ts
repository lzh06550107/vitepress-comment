import ora from 'ora'

export const okMark = '\x1b[32m✓\x1b[0m'
export const failMark = '\x1b[31m✖\x1b[0m'

/**
 * 提供了一个优雅的方式来处理命令行中的异步任务，同时为任务的成功或失败添加了直观的标志，并通过 ora 库创建了流畅的进度指示。
 * 它特别适合用于自动化脚本、构建工具和命令行应用程序中
 * @param taskName 任务名称，用于显示进度指示器的标题
 * @param task 是一个返回 Promise 的异步函数，表示需要执行的任务
 */
export async function task(taskName: string, task: () => Promise<void>) {
  // ora 是一个用于创建旋转指示器的库，常用于命令行工具中，能够显示任务的进度
  const spinner = ora({ discardStdin: false })
  // 启动进度指示器并显示任务名称
  spinner.start(taskName + '...')

  try {
    await task() // 执行传入的异步任务
  } catch (e) {
    // 如果任务执行时抛出错误，进度条会显示失败标志 (✖)，然后重新抛出错误
    spinner.stopAndPersist({ symbol: failMark })
    throw e
  }

  // 如果任务执行成功，进度条会显示成功标志 (✓)
  spinner.stopAndPersist({ symbol: okMark })
}
