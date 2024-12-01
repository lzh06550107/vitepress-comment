import {
  loadConfigFromFile,
  normalizePath,
  type Logger,
  type Plugin,
  type ViteDevServer
} from 'vite'
import fs from 'fs-extra'
import c from 'picocolors'
import path from 'path'
import glob from 'fast-glob'
import { type SiteConfig, type UserConfig } from '../siteConfig'
import { resolveRewrites } from './rewritesPlugin'

// 一个正则表达式，用于匹配动态路由的文件名。具体来说，它会匹配类似 [id].md 或 [slug].md 这样的文件名，其中的 [] 表示动态部分
export const dynamicRouteRE = /\[(\w+?)\]/g

/**
 * 用于解析项目中的 Markdown 文件，并根据用户配置生成网站页面、动态路由和路由重写规则。
 * 它处理的主要任务是确定网站的静态页面和动态路由，并准备相关的路由和重写信息。
*/
export async function resolvePages(
  srcDir: string,
  userConfig: UserConfig,
  logger: Logger
) {
  // Important: fast-glob doesn't guarantee order of the returned files.
  // We must sort the pages so the input list to rollup is stable across
  // builds - otherwise different input order could result in different exports
  // order in shared chunks which in turns invalidates the hash of every chunk!
  // JavaScript built-in sort() is mandated to be stable as of ES2019 and
  // supported in Node 12+, which is required by Vite.
  // 重要提示：fast-glob 不保证返回文件的顺序。
  // 我们必须对页面进行排序，以确保传递给 rollup 的输入列表在每次构建时都保持稳定。
  // 否则，不同的输入顺序可能导致共享块中的导出顺序不同，这会使每个块的哈希值失效！
  // JavaScript 内建的 sort() 方法自 ES2019 起被要求稳定，并且 Node 12+ 版本已经支持该特性，
  // 这也是 Vite 的要求。

  const allMarkdownFiles = (
    await glob(['**.md'], {
      cwd: srcDir,
      ignore: [
        '**/node_modules/**',
        '**/dist/**',
        ...(userConfig.srcExclude || []) // 用于匹配应排除作为源内容输出的 markdown 文件
      ]
    })
  ).sort() // 获取所有markdown文件

  const pages: string[] = [] // 收集普通 md 文件
  const dynamicRouteFiles: string[] = [] // 收集动态路由文件

  allMarkdownFiles.forEach((file) => {
    dynamicRouteRE.lastIndex = 0
    ;(dynamicRouteRE.test(file) ? dynamicRouteFiles : pages).push(file)
  }) // 文件分类

  // 解析动态路由，并生成相关的路由配置
  const dynamicRoutes = await resolveDynamicRoutes(
    srcDir,
    dynamicRouteFiles,
    logger
  )
  pages.push(...dynamicRoutes.routes.map((r) => r.path))

  const rewrites = resolveRewrites(pages, userConfig.rewrites) // 路由重写

  return {
    pages,
    dynamicRoutes,
    rewrites
  }
}

interface UserRouteConfig {
  params: Record<string, string>
  content?: string
}

interface RouteModule {
  path: string
  config: {
    paths:
      | UserRouteConfig[]
      | (() => UserRouteConfig[] | Promise<UserRouteConfig[]>)
  }
  dependencies: string[]
}

const routeModuleCache = new Map<string, RouteModule>()

export type ResolvedRouteConfig = UserRouteConfig & {
  /**
   * the raw route (relative to src root), e.g. foo/[bar].md
   */
  route: string
  /**
   * the actual path with params resolved (relative to src root), e.g. foo/1.md
   */
  path: string
  /**
   * absolute fs path
   */
  fullPath: string
}

export const dynamicRoutesPlugin = async (
  config: SiteConfig
): Promise<Plugin> => {
  let server: ViteDevServer

  return {
    name: 'vitepress:dynamic-routes',

    configureServer(_server) {
      server = _server
    },

    resolveId(id) {
      if (!id.endsWith('.md')) return
      const normalizedId = id.startsWith(config.srcDir)
        ? id
        : normalizePath(path.resolve(config.srcDir, id.replace(/^\//, '')))
      const matched = config.dynamicRoutes.routes.find(
        (r) => r.fullPath === normalizedId
      )
      if (matched) {
        return normalizedId
      }
    },

    load(id) {
      const matched = config.dynamicRoutes.routes.find((r) => r.fullPath === id)
      if (matched) {
        const { route, params, content } = matched
        const routeFile = normalizePath(path.resolve(config.srcDir, route))
        config.dynamicRoutes.fileToModulesMap[routeFile].add(id)

        let baseContent = fs.readFileSync(routeFile, 'utf-8')

        // inject raw content
        // this is intended for integration with CMS
        // we use a special injection syntax so the content is rendered as
        // static local content instead of included as runtime data.
        if (content) {
          baseContent = baseContent.replace(/<!--\s*@content\s*-->/, content)
        }

        // params are injected with special markers and extracted as part of
        // __pageData in ../markdownTovue.ts
        return `__VP_PARAMS_START${JSON.stringify(
          params
        )}__VP_PARAMS_END__${baseContent}`
      }
    },

    async handleHotUpdate(ctx) {
      routeModuleCache.delete(ctx.file)
      const mods = config.dynamicRoutes.fileToModulesMap[ctx.file]
      if (mods) {
        // path loader module or deps updated, reset loaded routes
        if (!/\.md$/.test(ctx.file)) {
          Object.assign(
            config,
            await resolvePages(config.srcDir, config.userConfig, config.logger)
          )
        }
        for (const id of mods) {
          ctx.modules.push(server.moduleGraph.getModuleById(id)!)
        }
      }
    }
  }
}

/**
 * 用于解析动态路由，并生成相关的路由配置。它通过加载与动态路由文件相关联的 .paths.js、.paths.ts、.paths.mjs 或 .paths.mts 文件，来动态生成路由
 * 函数的主要目标是：
 *
 * 1. 为每个动态路由文件（例如 route.md）查找对应的 .paths.js、.paths.ts 或 .paths.mjs 文件。
 * 2. 加载 .paths 文件，并解析其中的路径配置。
 * 3. 通过动态参数（例如 [id]）替换路径配置中的动态部分，生成最终的路由。
 * @param srcDir 源代码目录（即包含所有 Markdown 文件和配置的根目录）
 * @param routes 一个字符串数组，包含所有需要解析的动态路由文件的路径
 * @param logger 日志记录器，用于输出警告或错误信息
 */
export async function resolveDynamicRoutes(
  srcDir: string,
  routes: string[],
  logger: Logger
): Promise<SiteConfig['dynamicRoutes']> {
  const pendingResolveRoutes: Promise<ResolvedRouteConfig[]>[] = []
  const routeFileToModulesMap: Record<string, Set<string>> = {}


  for (const route of routes) {
    // locate corresponding route paths file
    const fullPath = normalizePath(path.resolve(srcDir, route))

    // 对于每个路由文件（例如 route.md），函数会尝试查找名为 route.paths.js、route.paths.ts 等文件，并验证这些文件是否存在
    const paths = ['js', 'ts', 'mjs', 'mts'].map((ext) =>
      fullPath.replace(/\.md$/, `.paths.${ext}`)
    )

    const pathsFile = paths.find((p) => fs.existsSync(p))

    // 如果没有找到 .paths 文件，则会发出警告，并跳过当前路由的解析
    if (pathsFile == null) {
      logger.warn(
        c.yellow(
          `Missing paths file for dynamic route ${route}: ` +
            `a corresponding ${paths[0]} (or .ts/.mjs/.mts) file is needed.`
        )
      )
      continue
    }

    // load the paths loader module 如果 .paths 文件存在，函数会加载该文件并缓存，以避免重复加载
    let mod = routeModuleCache.get(pathsFile)
    if (!mod) {
      try {
        mod = (await loadConfigFromFile(
          {} as any,
          pathsFile,
          undefined,
          'silent'
        )) as RouteModule
        routeModuleCache.set(pathsFile, mod)
      } catch (err: any) {
        logger.warn(
          `${c.yellow(`Failed to load ${pathsFile}:`)}\n${err.message}\n${err.stack}`
        )
        continue
      }
    }

    // this array represents the virtual modules affected by this route
    const matchedModuleIds = (routeFileToModulesMap[
      normalizePath(path.resolve(srcDir, route))
    ] = new Set())

    // each dependency (including the loader module itself) also point to the
    // same array
    for (const dep of mod.dependencies) {
      // deps are resolved relative to cwd
      routeFileToModulesMap[normalizePath(path.resolve(dep))] = matchedModuleIds
    }

    // 从 .paths 文件中获取 paths 属性，这个属性定义了动态路由的具体路径。
    // 然后，函数将根据 .md 文件中动态部分（例如 [id]）将路径中的动态部分替换为配置文件中的实际值
    const loader = mod!.config.paths
    if (!loader) {
      logger.warn(
        c.yellow(
          `Invalid paths file export in ${pathsFile}. ` +
            `Missing "paths" property from default export.`
        )
      )
      continue
    }

    const resolveRoute = async (): Promise<ResolvedRouteConfig[]> => {
      const paths = await (typeof loader === 'function' ? loader() : loader)
      return paths.map((userConfig) => {
        const resolvedPath = route.replace(
          dynamicRouteRE, // 用于匹配路径中的动态部分（例如 [id]）
          (_, key) => userConfig.params[key] // 提供了实际的参数值，将动态部分替换为具体的值
        )
        return {
          path: resolvedPath,
          fullPath: normalizePath(path.resolve(srcDir, resolvedPath)),
          route,
          ...userConfig
        }
      })
    }
    pendingResolveRoutes.push(resolveRoute())
  }

  return {
    routes: (await Promise.all(pendingResolveRoutes)).flat(), // 包含所有解析后的路由路径
    fileToModulesMap: routeFileToModulesMap // 将路由文件映射到其相关的模块，用于支持动态路由的模块加载
  }
}
