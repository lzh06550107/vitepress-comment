import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  build,
  normalizePath,
  type BuildOptions,
  type Rollup,
  type InlineConfig as ViteInlineConfig
} from 'vite'
import { APP_PATH } from '../alias'
import type { SiteConfig } from '../config'
import { createVitePressPlugin } from '../plugin'
import { escapeRegExp, sanitizeFileName, slash } from '../shared'
import { task } from '../utils/task'
import { buildMPAClient } from './buildMPAClient'

// https://github.com/vitejs/vite/blob/d2aa0969ee316000d3b957d7e879f001e85e369e/packages/vite/src/node/plugins/splitVendorChunk.ts#L14
const CSS_LANGS_RE =
  /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/

// 用于确定 client 目录的绝对路径
const clientDir = normalizePath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client')
)

// these deps are also being used in the client code (outside of the theme)
// exclude them from the theme chunk so there is no circular dependency
const excludedModules = [
  '/@siteData',
  'node_modules/@vueuse/core/',
  'node_modules/@vueuse/shared/',
  'node_modules/vue/',
  'node_modules/vue-demi/',
  clientDir
]

// bundles the VitePress app for both client AND server.
/**
 * VitePress 项目构建过程中的一个核心函数，它负责为客户端和服务器分别构建相应的捆绑文件，并生成页面哈希映射。
 * 它的作用是处理多入口的构建，其中每个页面都是一个入口模块，并且根据是否启用了多页面应用（MPA）模式来分别处理客户端和服务器端的构建。
 * @param config VitePress 项目的配置，包含页面路径、主题目录、构建目录等信息
 * @param options 构建选项，包括 Vite 配置、Rollup 配置等
 */
export async function bundle(
  config: SiteConfig,
  options: BuildOptions
): Promise<{
  clientResult: Rollup.RollupOutput | null
  serverResult: Rollup.RollupOutput
  pageToHashMap: Record<string, string>
}> {
  const pageToHashMap = Object.create(null)
  const clientJSMap = Object.create(null)

  // define custom rollup input
  // this is a multi-entry build - every page is considered an entry chunk
  // the loading is done via filename conversion rules so that the
  // metadata doesn't need to be included in the main chunk.
  // 定义自定义的 Rollup 输入
  // 这是一个多入口构建——每个页面都被视为一个入口块
  // 加载是通过文件名转换规则完成的，因此元数据不需要包含在主块中。
  const input: Record<string, string> = {}
  // 首先会为每个页面创建一个输入文件，将页面路径转换为符合规范的文件名。输入文件会包含所有页面，作为 Rollup 构建的多入口文件
  config.pages.forEach((file) => {
    // page filename conversion
    // foo/bar.md -> foo_bar.md
    const alias = config.rewrites.map[file] || file
    input[slash(alias).replace(/\//g, '_')] = path.resolve(config.srcDir, file)
  })

  // 创建一个正则表达式 (themeEntryRE)，用于匹配主题相关的入口文件（index.js 或 index.ts）的路径
  // 正则表达式 themeEntryRE 会匹配 config.themeDir 目录下的 index.js 或 index.ts 文件，以及它们可能的模块化变体（例如 .mjs 或 .mts）
  const themeEntryRE = new RegExp(
    `^${escapeRegExp(
        // 该部分将 config.themeDir 目录与 'index.js' 文件名拼接，得到主题目录下的 index.js 文件的绝对路径
      path.resolve(config.themeDir, 'index.js').replace(/\\/g, '/')
    ).slice(0, -2)}m?(j|t)s`
  )

  // resolve options to pass to vite
  const { rollupOptions } = options

  // 使用 resolveViteConfig 函数来解析并生成 Vite 配置，分别用于 SSR（服务器端渲染）和客户端构建
  const resolveViteConfig = async (
    ssr: boolean
  ): Promise<ViteInlineConfig> => ({
    root: config.srcDir,
    cacheDir: config.cacheDir,
    base: config.site.base,
    logLevel: config.vite?.logLevel ?? 'warn',
    plugins: await createVitePressPlugin(
      config,
      ssr,
      pageToHashMap,
      clientJSMap
    ),
    ssr: {
      noExternal: ['vitepress', '@docsearch/css']
    },
    build: {
      ...options,
      emptyOutDir: true,
      ssr,
      ssrEmitAssets: config.mpa,
      // minify with esbuild in MPA mode (for CSS)
      minify: ssr
        ? config.mpa
          ? 'esbuild'
          : false
        : typeof options.minify === 'boolean'
          ? options.minify
          : !process.env.DEBUG,
      // 决定是否构建服务器端渲染（SSR）版本，ssr: true 表示构建 SSR，ssr: false 则为客户端构建
      outDir: ssr ? config.tempDir : config.outDir,
      cssCodeSplit: false,
      rollupOptions: {
        ...rollupOptions,
        input: {
          ...input, // 指定入口文件
          // use different entry based on ssr or not
          app: path.resolve(APP_PATH, ssr ? 'ssr.js' : 'index.js')
        },
        // important so that each page chunk and the index export things for each
        // other
        preserveEntrySignatures: 'allow-extension',
        output: {
          sanitizeFileName,
          ...rollupOptions?.output,
          assetFileNames: `${config.assetsDir}/[name].[hash].[ext]`,
          ...(ssr
            ? {
                entryFileNames: '[name].js',
                chunkFileNames: '[name].[hash].js'
              }
            : {
                entryFileNames: `${config.assetsDir}/[name].[hash].js`,
                chunkFileNames(chunk) {
                  // avoid ads chunk being intercepted by adblock
                  return /(?:Carbon|BuySell)Ads/.test(chunk.name)
                    ? `${config.assetsDir}/chunks/ui-custom.[hash].js`
                    : `${config.assetsDir}/chunks/[name].[hash].js`
                },
                // 用于将一些模块（例如框架代码）分离到单独的文件中，从而避免由于自定义主题的修改导致所有页面的哈希值变化
                manualChunks(id, ctx) {
                  // move known framework code into a stable chunk so that
                  // custom theme changes do not invalidate hash for all pages
                  if (id.startsWith('\0vite')) {
                    return 'framework'
                  }
                  if (id.includes('plugin-vue:export-helper')) {
                    return 'framework'
                  }
                  if (
                    id.includes(`${clientDir}/app`) &&
                    id !== `${clientDir}/app/index.js`
                  ) {
                    return 'framework'
                  }
                  if (
                    isEagerChunk(id, ctx.getModuleInfo) &&
                    /@vue\/(runtime|shared|reactivity)/.test(id)
                  ) {
                    return 'framework'
                  }

                  if (
                    (id.startsWith(`${clientDir}/theme-default`) ||
                      !excludedModules.some((i) => id.includes(i))) &&
                    staticImportedByEntry(
                      id,
                      ctx.getModuleInfo,
                      cacheTheme,
                      themeEntryRE
                    )
                  ) {
                    return 'theme'
                  }
                }
              })
        }
      }
    },
    configFile: config.vite?.configFile
  })

  let clientResult!: Rollup.RollupOutput | null
  let serverResult!: Rollup.RollupOutput

  // 为客户端和服务器端执行构建
  // 客户端构建：非 MPA 模式下，构建客户端的捆绑文件（clientResult）。
  // 服务器端构建：无论是否为 MPA，都会构建服务器端的捆绑文件（serverResult）
  await task('building client + server bundles', async () => {
    clientResult = config.mpa
      ? null
      : ((await build(await resolveViteConfig(false))) as Rollup.RollupOutput)
    serverResult = (await build(
      await resolveViteConfig(true)
    )) as Rollup.RollupOutput
  })

  // 处理 MPA 模式
  // 是否启用多页面应用模式。如果启用了 MPA，每个页面都会有一个独立的捆绑文件，并且服务器端捆绑会处理非 JS 的静态资源
  if (config.mpa) {
    // in MPA mode, we need to copy over the non-js asset files from the
    // server build since there is no client-side build.
    // 在 MPA 模式下，客户端构建被跳过，因为客户端的捆绑是通过静态文件生成的
    await Promise.all(
      serverResult.output.map(async (chunk) => {
        // 服务器端的非 .js 资源（例如 .css 或其他静态资源）会从临时构建目录复制到最终的输出目录
        if (!chunk.fileName.endsWith('.js')) {
          const tempPath = path.resolve(config.tempDir, chunk.fileName)
          const outPath = path.resolve(config.outDir, chunk.fileName)
          await fs.copy(tempPath, outPath)
        }
      })
    )
    // also copy over public dir 如果存在公共目录（public），则会将其中的文件复制到输出目录
    const publicDir = path.resolve(config.srcDir, 'public')
    if (fs.existsSync(publicDir)) {
      await fs.copy(publicDir, config.outDir)
    }
    // build <script client> bundle
    // 对于客户端 JS 文件，如果有对应的客户端捆绑文件（clientJSMap），会调用 buildMPAClient 构建客户端部分
    if (Object.keys(clientJSMap).length) {
      clientResult = await buildMPAClient(clientJSMap, config)
    }
  }

  // clientResult：客户端构建结果，包含客户端捆绑输出。MPA 模式下可能为 null。
  // serverResult：服务器端构建结果，包含服务器捆绑输出。
  // pageToHashMap：一个记录页面路径和页面哈希值的映射表。
  return { clientResult, serverResult, pageToHashMap }
}

const cache = new Map<string, boolean>()
const cacheTheme = new Map<string, boolean>()

/**
 * Check if a module is statically imported by at least one entry.
 * 在构建过程中（可能是 Rollup 或类似的构建工具中）用于识别“eager chunk”（急切加载的代码块）的辅助函数。
 * 急切加载的代码块指的是那些在启动时就被加载的模块，而不是按需懒加载的模块。这个函数检查一个模块或代码块是否应该被视为急切加载的块
 */
function isEagerChunk(id: string, getModuleInfo: Rollup.GetModuleInfo) {
  if (
      // 该条件检查模块是否位于 node_modules 目录下。通常，安装的依赖库都会位于这个目录下。所以这里主要过滤外部依赖
    id.includes('node_modules') &&
      // 该条件检查模块的 ID 是否不匹配 CSS_LANGS_RE 正则表达式。这个正则表达式可能用于排除 CSS 或相关资源（如 .scss、.sass、.less 等）文件。
      // 目的是忽略 CSS 相关文件，专注于 JavaScript 模块
    !CSS_LANGS_RE.test(id) &&
      // 该条件检查模块是否被静态导入到入口文件（即应用程序的主文件）中。staticImportedByEntry 函数会检查该模块是否被主入口文件直接引入，且是静态导入
    staticImportedByEntry(id, getModuleInfo, cache)
  ) {
    return true
  }
}

/**
 * 用于检查某个模块（id）是否通过静态导入的方式直接或间接地被入口文件引入。它通过递归地检查每个导入该模块的文件，并确保没有循环依赖
 * @param id 当前模块的标识符（通常是文件路径或模块名）
 * @param getModuleInfo 一个函数，用于获取模块的元信息（例如该模块是否是入口文件、它的导入者等）
 * @param cache 一个缓存，用于避免重复计算。存储每个模块是否被入口文件静态导入
 * @param entryRE 一个可选的正则表达式，用来匹配模块是否属于入口文件。若为 null，则默认使用 mod.isEntry 来判断该模块是否是入口
 * @param importStack 一个递归栈，用来跟踪当前模块的导入路径，避免循环依赖
 */
function staticImportedByEntry(
  id: string,
  getModuleInfo: Rollup.GetModuleInfo,
  cache: Map<string, boolean>,
  entryRE: RegExp | null = null,
  importStack: string[] = []
): boolean {
  // 如果 cache 中已经存在 id 的值，直接返回缓存的结果，避免重复计算
  if (cache.has(id)) {
    return !!cache.get(id)
  }
  // 如果 importStack 中已经包含当前模块 id，说明出现了循环依赖。此时将该模块标记为 false（即它不是通过入口文件静态导入的），并返回 false
  if (importStack.includes(id)) {
    // circular deps!
    cache.set(id, false)
    return false
  }
  // 通过 getModuleInfo(id) 获取模块的元数据。如果模块信息为空，说明该模块不存在，返回 false，并将其缓存为 false
  const mod = getModuleInfo(id)
  if (!mod) {
    cache.set(id, false)
    return false
  }

  // 如果 entryRE 存在且与模块 id 匹配，或者模块的 mod.isEntry 为 true（即该模块是入口文件），则返回 true，并将其缓存为 true
  if (entryRE ? entryRE.test(id) : mod.isEntry) {
    cache.set(id, true)
    return true
  }
  // 递归检查导入者
  const someImporterIs = mod.importers.some((importer: string) =>
    staticImportedByEntry( // 如果当前模块不是入口模块，则递归地检查它的导入者（mod.importers）。对于每一个导入者（importer），调用 staticImportedByEntry 进行检查，直到找到某个导入者是入口文件为止
      importer,
      getModuleInfo,
      cache,
      entryRE,
      importStack.concat(id)
    )
  )
  // 将模块的结果（是否是静态导入的）缓存到 cache 中，以便后续使用
  cache.set(id, someImporterIs)
  return someImporterIs
}
