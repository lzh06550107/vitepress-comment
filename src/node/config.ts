import _debug from 'debug'
import fs from 'fs-extra'
import path from 'path'
import c from 'picocolors'
import {
  createLogger,
  loadConfigFromFile,
  mergeConfig as mergeViteConfig,
  normalizePath,
  type ConfigEnv
} from 'vite'
import { DEFAULT_THEME_PATH } from './alias'
import { resolvePages } from './plugins/dynamicRoutesPlugin'
import {
  APPEARANCE_KEY,
  slash,
  type DefaultTheme,
  type HeadConfig,
  type SiteData
} from './shared'
import type { RawConfigExports, SiteConfig, UserConfig } from './siteConfig'

export { resolvePages } from './plugins/dynamicRoutesPlugin'
export * from './siteConfig'

// 调试方法
const debug = _debug('vitepress:config')

// 组合绝对路径并规范化
const resolve = (root: string, file: string) =>
  normalizePath(path.resolve(root, `.vitepress`, file))

export type UserConfigFn<ThemeConfig> = (
  env: ConfigEnv
) => UserConfig<ThemeConfig> | Promise<UserConfig<ThemeConfig>>
export type UserConfigExport<ThemeConfig> =
  | UserConfig<ThemeConfig>
  | Promise<UserConfig<ThemeConfig>>
  | UserConfigFn<ThemeConfig>

/**
 * Type config helper
 */
export function defineConfig(config: UserConfig<DefaultTheme.Config>) {
  return config
}

/**
 * Type config helper for custom theme config
 */
export function defineConfigWithTheme<ThemeConfig>(
  config: UserConfig<ThemeConfig>
) {
  return config
}

/**
 * 它用于解析和生成站点的配置对象 SiteConfig，并返回该配置对象。这个配置对象包含了项目的各种配置信息，例如源代码目录、构建输出目录、缓存目录、主题目录等
 * @param root 项目的根目录，默认为当前工作目录
 * @param command
 * @param mode
 */
export async function resolveConfig(
  root: string = process.cwd(), // 项目的根目录，默认为当前工作目录
  command: 'serve' | 'build' = 'serve', // 当前命令（'serve' 或 'build'），默认为 'serve'
  mode = 'development' // 构建模式，默认为 'development'
): Promise<SiteConfig> { // 返回一个 Promise，最终解析为 SiteConfig 类型
  // normalize root into absolute path
  root = normalizePath(path.resolve(root)) // 获取绝对路径
  // 读取并解析配置文件
  const [userConfig, configPath, configDeps] = await resolveUserConfig(
    root,
    command,
    mode
  )
  // 查看是否配置自定义日志器
  const logger =
    userConfig.vite?.customLogger ??
    createLogger(userConfig.vite?.logLevel, {
      prefix: '[vitepress]',
      allowClearScreen: userConfig.vite?.clearScreen
    })
  const site = await resolveSiteData(root, userConfig)
  const srcDir = normalizePath(path.resolve(root, userConfig.srcDir || '.')) // 相对于项目根目录的 markdown 文件所在的文件夹。
  const assetsDir = userConfig.assetsDir // 指定放置生成的静态资源的目录。该路径应位于 outDir 内，并相对于它进行解析。
    ? slash(userConfig.assetsDir).replace(/^\.?\/|\/$/g, '')
    : 'assets'
  const outDir = userConfig.outDir // 项目的构建输出位置，相对于项目根目录。
    ? normalizePath(path.resolve(root, userConfig.outDir))
    : resolve(root, 'dist')
  const cacheDir = userConfig.cacheDir // 缓存文件的目录，相对于项目根目录。
    ? normalizePath(path.resolve(root, userConfig.cacheDir))
    : resolve(root, 'cache')

  const resolvedAssetsDir = normalizePath(path.resolve(outDir, assetsDir))
  if (!resolvedAssetsDir.startsWith(outDir)) { // 静态资源目录必须在 outDir 目录内
    throw new Error(
      [
        `assetsDir cannot be set to a location outside of the outDir.`,
        `outDir: ${outDir}`,
        `assetsDir: ${assetsDir}`,
        `resolved: ${resolvedAssetsDir}`
      ].join('\n  ')
    )
  }

  // resolve theme path
  const userThemeDir = resolve(root, 'theme') // 解析主题目录
  const themeDir = (await fs.pathExists(userThemeDir))
    ? userThemeDir // 如果不存在用户自定义主题目录，则使用主题默认目录
    : DEFAULT_THEME_PATH

  const { pages, dynamicRoutes, rewrites } = await resolvePages(
    srcDir,
    userConfig,
    logger
  )

  const config: SiteConfig = {
    root,
    srcDir,
    assetsDir,
    site,
    themeDir,
    pages,
    dynamicRoutes,
    configPath,
    configDeps,
    outDir,
    cacheDir,
    logger,
    tempDir: resolve(root, '.temp'),
    markdown: userConfig.markdown,
    lastUpdated:
      userConfig.lastUpdated ?? !!userConfig.themeConfig?.lastUpdated,
    vue: userConfig.vue,
    vite: userConfig.vite,
    shouldPreload: userConfig.shouldPreload,
    mpa: !!userConfig.mpa,
    metaChunk: !!userConfig.metaChunk,
    ignoreDeadLinks: userConfig.ignoreDeadLinks,
    cleanUrls: !!userConfig.cleanUrls,
    useWebFonts:
      userConfig.useWebFonts ??
      typeof process.versions.webcontainer === 'string',
    postRender: userConfig.postRender,
    buildEnd: userConfig.buildEnd,
    transformHead: userConfig.transformHead,
    transformHtml: userConfig.transformHtml,
    transformPageData: userConfig.transformPageData,
    rewrites,
    userConfig,
    sitemap: userConfig.sitemap,
    buildConcurrency: userConfig.buildConcurrency ?? 64
  }

  // to be shared with content loaders
  // @ts-ignore
  global.VITEPRESS_CONFIG = config

  return config
}

const supportedConfigExtensions = ['js', 'ts', 'mjs', 'mts']

/**
 * 负责加载和解析用户的配置文件。它的功能是检查项目中是否存在配置文件，并根据配置文件内容加载和解析配置。该函数返回一个包含用户配置、配置文件路径和依赖文件路径的元组。
 * @param root
 * @param command
 * @param mode
 */
export async function resolveUserConfig(
  root: string, // 项目的根目录
  command: 'serve' | 'build', // 当前的命令（`serve` 或 `build`）
  mode: string  // 当前的模式（如 `development` 或 `production`）
): Promise<[UserConfig, string | undefined, string[]]> { // 返回一个包含配置对象、配置路径和依赖路径的元组
  // load user config，加载用户配置文件
  const configPath = supportedConfigExtensions // 是一个支持的配置文件扩展名列表
    .flatMap((ext) => [
      resolve(root, `config/index.${ext}`), // 配置目录入口文件
      resolve(root, `config.${ext}`) // 或者配置文件
    ])
    .find(fs.pathExistsSync) // 查找文件路径是否存在

  let userConfig: RawConfigExports = {} // 定义空的配置对象
  let configDeps: string[] = [] // 配置文件的依赖路径数组
  if (!configPath) {
    debug(`no config file found.`) // 如果没有找到配置文件，输出调试信息
  } else {
    const configExports = await loadConfigFromFile( // 加载所有配置
      { command, mode }, // 当前命令和模式
      configPath, // 配置文件路径
      root // 项目根目录
    )
    if (configExports) {
      userConfig = configExports.config // 获取配置
      configDeps = configExports.dependencies.map((file) =>
        normalizePath(path.resolve(file)) // 将依赖文件路径转换为绝对路径
      )
    }
    debug(`loaded config at ${c.yellow(configPath)}`) // 输出加载的配置文件路径
  }

  // resolveConfigExtends(userConfig)：处理配置继承（如果配置文件支持继承）。返回一个解析后的配置。
  // configPath：返回找到的配置文件路径。
  // configDeps：返回配置文件的依赖路径数组。
  return [await resolveConfigExtends(userConfig), configPath, configDeps]
}

/**
 * 主要用于处理配置文件的继承机制。当配置文件中定义了 extends 属性时，表示该配置文件继承自另一个父配置文件。
 * 这个函数会递归地解析并合并父配置文件，最终返回一个完整的配置对象
 * @param config
 */
async function resolveConfigExtends(
  config: RawConfigExports
): Promise<UserConfig> { // 如果是配置函数，则调用函数
  const resolved = await (typeof config === 'function' ? config() : config)
  if (resolved.extends) { // extends是父配置文件，下面是递归合并父配置文件，子配置优先级更高
    const base = await resolveConfigExtends(resolved.extends)
    return mergeConfig(base, resolved)
  }
  return resolved
}

/**
 * 是一个用于合并两个配置对象的函数，尤其适用于用户配置的合并。它遵循递归和优先级规则，允许子配置覆盖父配置中的值，并且在需要时可以合并数组和嵌套对象
 * @param a
 * @param b
 * @param isRoot
 */
export function mergeConfig(a: UserConfig, b: UserConfig, isRoot = true) {
  const merged: Record<string, any> = { ...a }
  for (const key in b) {
    const value = b[key as keyof UserConfig]
    if (value == null) {
      continue
    }
    const existing = merged[key]
    if (Array.isArray(existing) && Array.isArray(value)) {
      merged[key] = [...existing, ...value]
      continue
    }
    if (isObject(existing) && isObject(value)) {
      if (isRoot && key === 'vite') { // 如果是根级配置 (isRoot 为 true) 且 key 为 'vite'，则调用 mergeViteConfig 函数处理合并。vite 配置通常包含一些特定的处理，可能是为了优化或有特殊的合并逻辑
        merged[key] = mergeViteConfig(existing, value)
      } else { // 递归调用 mergeConfig 合并嵌套的对象，并将 isRoot 设置为 false，以指示我们正在合并嵌套对象
        merged[key] = mergeConfig(existing, value, false)
      }
      continue
    }
    merged[key] = value
  }
  return merged
}

function isObject(value: unknown): value is Record<string, any> {
  return Object.prototype.toString.call(value) === '[object Object]'
}

/**
 * 用于解析和构建站点的数据配置。它会根据 userConfig 或默认配置返回一个 SiteData 对象，包含一些站点的基本配置、主题、路由等内容
 * @param root 根目录路径（项目的根路径）
 * @param userConfig 可选的用户配置对象（如果未提供，将通过其他方式加载配置）
 * @param command 当前运行的命令，默认为 'serve'（即开发模式）。也可以是 'build'
 * @param mode 当前的构建模式，默认为 'development'
 */
export async function resolveSiteData(
  root: string,
  userConfig?: UserConfig,
  command: 'serve' | 'build' = 'serve',
  mode = 'development'
): Promise<SiteData> {
  // 如果 userConfig 已传入，则直接使用传入的配置。
  // 否则，调用 resolveUserConfig 加载并解析用户配置。resolveUserConfig 会返回一个数组，第一个元素是用户配置对象，我们将其赋值给 userConfig
  userConfig = userConfig || (await resolveUserConfig(root, command, mode))[0]

  return {
    lang: userConfig.lang || 'en-US', // 站点的语言，默认为 'en-US'
    dir: userConfig.dir || 'ltr', // 文本的方向（ltr 或 rtl），默认为 'ltr'
    title: userConfig.title || 'VitePress', // 站点标题，默认为 'VitePress'
    titleTemplate: userConfig.titleTemplate, // 站点标题模板，可以自定义
    description: userConfig.description || 'A VitePress site', // 站点描述，默认为 'A VitePress site'。
    base: userConfig.base ? userConfig.base.replace(/([^/])$/, '$1/') : '/', // 站点的基本 URL 路径。通过正则替换确保 URL 以 / 结尾。如果没有配置，默认是 '/'
    head: resolveSiteDataHead(userConfig), // 站点的头部配置，调用 resolveSiteDataHead(userConfig) 函数来解析
    router: { // 路由配置，包含 prefetchLinks 设置，默认为 true
      prefetchLinks: userConfig.router?.prefetchLinks ?? true
    },
    appearance: userConfig.appearance ?? true, // 是否启用主题外观设置，默认为 true
    themeConfig: userConfig.themeConfig || {}, // 主题的配置，默认为空对象
    locales: userConfig.locales || {}, // 支持的语言区域配置，默认为空对象
    scrollOffset: userConfig.scrollOffset ?? 134, // 滚动偏移量，默认为 134
    cleanUrls: !!userConfig.cleanUrls, // 是否启用干净 URL（去除 .html 后缀），默认为 true
    contentProps: userConfig.contentProps // 内容的其他属性，默认为 undefined
  }
}

/**
 * 函数的目的是生成和返回一个包含必要 HTML <head> 元素的数组。它根据用户配置动态添加头部元素，尤其是涉及到主题（暗黑模式）和操作系统识别的 JavaScript 脚本
 * @param userConfig
 */
function resolveSiteDataHead(userConfig?: UserConfig): HeadConfig[] {
  // head 变量被赋值为用户配置中的 head 字段。如果用户没有提供 head 配置，默认为空数组 []
  const head = userConfig?.head ?? []

  // add inline script to apply dark mode, if user enables the feature.
  // this is required to prevent "flash" on initial page load.
  if (userConfig?.appearance ?? true) { // 检查是否启用外观设置
    // if appearance mode set to light or dark, default to the defined mode
    // in case the user didn't specify a preference - otherwise, default to auto
    const fallbackPreference =
      typeof userConfig?.appearance === 'string'
        ? userConfig?.appearance
        : typeof userConfig?.appearance === 'object'
          ? userConfig.appearance.initialValue ?? 'auto'
          : 'auto' // 站点主题，是暗还是亮

    head.push([ // 除了用户自定义的头，默认需要添加暗黑模式切换脚本
      'script',
      { id: 'check-dark-mode' },
      fallbackPreference === 'force-dark'
        ? `document.documentElement.classList.add('dark')`
        : `;(() => {
            const preference = localStorage.getItem('${APPEARANCE_KEY}') || '${fallbackPreference}'
            const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
            if (!preference || preference === 'auto' ? prefersDark : preference === 'dark')
              document.documentElement.classList.add('dark')
          })()`
    ])
  }

  head.push([ // 添加 Mac 操作系统识别脚本
    'script',
    { id: 'check-mac-os' },
    `document.documentElement.classList.toggle('mac', /Mac|iPhone|iPod|iPad/i.test(navigator.platform))`
  ])

  return head
}
