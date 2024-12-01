import {
  type Plugin,
  type ViteDevServer,
  loadConfigFromFile,
  normalizePath
} from 'vite'
import path, { dirname, resolve } from 'path'
import { isMatch } from 'micromatch'
import glob from 'fast-glob'

const loaderMatch = /\.data\.m?(j|t)s($|\?)/

let server: ViteDevServer

export interface LoaderModule {
  watch?: string[] | string
  load: (watchedFiles: string[]) => any
}

/**
 * Helper for defining loaders with type inference
 */
export function defineLoader(loader: LoaderModule) {
  return loader
}

const idToLoaderModulesMap: Record<string, LoaderModule | undefined> =
  Object.create(null)

const depToLoaderModuleIdMap: Record<string, string> = Object.create(null)

// During build, the load hook will be called on the same file twice
// once for client and once for server build. Not only is this wasteful, it
// also leads to a race condition in loadConfigFromFile() that results in an
// fs unlink error. So we reuse the same Promise during build to avoid double
// loading.
let idToPendingPromiseMap: Record<string, Promise<string> | undefined> =
  Object.create(null)
let isBuild = false

/**
 * 用于处理静态数据的加载、更新和热更新。它支持通过外部配置文件加载数据，并根据需要进行文件监视（watch）和热更新（HMR）
 *
 * 1. 静态数据加载：通过 load 方法加载指定路径的数据，支持从配置文件动态导入。
 * 2. 文件监视与热更新：通过 watch 配置监视文件变化，支持热更新。
 * 3. 支持构建模式：插件会在构建过程中预先加载数据，避免重复请求。
 * 4. 支持依赖关系：插件会在加载时记录文件的依赖关系，确保在数据源变化时正确更新。
 */
export const staticDataPlugin: Plugin = {
  name: 'vitepress:data',

  // 该函数在配置解析后调用，主要用于设置是否为构建模式（isBuild）
  configResolved(config) {
    isBuild = config.command === 'build'
  },

  // 在开发服务器配置时，将 server 存储为插件的全局变量，以便后续使用
  configureServer(_server) {
    server = _server
  },

  /**
   * 加载静态数据
   * @param id
   */
  async load(id) {
    // 当文件路径匹配 loaderMatch 时，插件会处理该请求
    if (loaderMatch.test(id)) {
      let _resolve: ((res: any) => void) | undefined
      if (isBuild) {
        if (idToPendingPromiseMap[id]) {
          return idToPendingPromiseMap[id]
        }
        idToPendingPromiseMap[id] = new Promise((r) => {
          _resolve = r
        })
      }

      // base 存储了当前文件的目录，用于后续处理相对路径
      const base = dirname(id)
      let watch: LoaderModule['watch']
      let load: LoaderModule['load']

      const existing = idToLoaderModulesMap[id]
      if (existing) {
        ;({ watch, load } = existing)
      } else {
        // use vite's load config util as a away to load Node.js file with
        // TS & native ESM support
        const res = await loadConfigFromFile({} as any, id.replace(/\?.*$/, ''))

        // record deps for hmr
        if (server && res) {
          for (const dep of res.dependencies) {
            depToLoaderModuleIdMap[normalizePath(path.resolve(dep))] = id
          }
        }

        const loaderModule = res?.config as LoaderModule
        watch =
          typeof loaderModule.watch === 'string'
            ? [loaderModule.watch]
            : loaderModule.watch
        if (watch) {
          watch = watch.map((p) => {
            return p.startsWith('.')
              ? normalizePath(resolve(base, p))
              : normalizePath(p)
          })
        }
        load = loaderModule.load
      }

      // load the data
      let watchedFiles
      if (watch) {
        watchedFiles = (
          await glob(watch, {
            ignore: ['**/node_modules/**', '**/dist/**']
          })
        ).sort()
      }
      const data = await load(watchedFiles || [])

      // record loader module for HMR
      if (server) {
        idToLoaderModulesMap[id] = { watch, load }
      }

      const result = `export const data = JSON.parse(${JSON.stringify(
        JSON.stringify(data)
      )})`

      if (_resolve) _resolve(result)
      return result
    }
  },

  transform(_code, id) {
    if (server && loaderMatch.test(id)) {
      // register this module as a glob importer
      const { watch } = idToLoaderModulesMap[id]!
      if (watch) {
        ;(server as any)._importGlobMap.set(
          id,
          [Array.isArray(watch) ? watch : [watch]].map((globs) => {
            const affirmed: string[] = []
            const negated: string[] = []

            for (const glob of globs) {
              ;(glob[0] === '!' ? negated : affirmed).push(glob)
            }
            return { affirmed, negated }
          })
        )
      }
    }
    return null
  },

  handleHotUpdate(ctx) {
    const file = ctx.file

    // dependency of data loader changed
    // (note the dep array includes the loader file itself)
    if (file in depToLoaderModuleIdMap) {
      const id = depToLoaderModuleIdMap[file]!
      delete idToLoaderModulesMap[id]
      ctx.modules.push(server.moduleGraph.getModuleById(id)!)
    }

    for (const id in idToLoaderModulesMap) {
      const { watch } = idToLoaderModulesMap[id]!
      if (watch && isMatch(file, watch)) {
        ctx.modules.push(server.moduleGraph.getModuleById(id)!)
      }
    }
  }
}
