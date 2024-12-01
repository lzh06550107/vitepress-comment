import path from 'path'
import c from 'picocolors'
import {
  mergeConfig,
  searchForWorkspaceRoot,
  type ModuleNode,
  type Plugin,
  type ResolvedConfig,
  type Rollup,
  type UserConfig
} from 'vite'
import {
  APP_PATH,
  DIST_CLIENT_PATH,
  SITE_DATA_REQUEST_PATH,
  resolveAliases
} from './alias'
import { resolvePages, resolveUserConfig, type SiteConfig } from './config'
import {
  clearCache,
  createMarkdownToVueRenderFn,
  type MarkdownCompileResult
} from './markdownToVue'
import { dynamicRoutesPlugin } from './plugins/dynamicRoutesPlugin'
import { localSearchPlugin } from './plugins/localSearchPlugin'
import { rewritesPlugin } from './plugins/rewritesPlugin'
import { staticDataPlugin } from './plugins/staticDataPlugin'
import { webFontsPlugin } from './plugins/webFontsPlugin'
import { slash, type PageDataPayload } from './shared'
import { deserializeFunctions, serializeFunctions } from './utils/fnSerialize'

declare module 'vite' {
  interface UserConfig {
    vitepress?: SiteConfig
  }
}

const themeRE = /\/\.vitepress\/theme\/index\.(m|c)?(j|t)s$/
const hashRE = /\.([-\w]+)\.js$/
const staticInjectMarkerRE =
  /\b(const _hoisted_\d+ = \/\*(?:#|@)__PURE__\*\/\s*createStaticVNode)\("(.*)", (\d+)\)/g
const staticStripRE = /['"`]__VP_STATIC_START__[^]*?__VP_STATIC_END__['"`]/g
const staticRestoreRE = /__VP_STATIC_(START|END)__/g

// matches client-side js blocks in MPA mode.
// in the future we may add different execution strategies like visible or
// media queries.
// 这个正则表达式 scriptClientRE 是用来匹配具有 client 属性的 <script> 标签内容的。
const scriptClientRE = /<script\b[^>]*client\b[^>]*>([^]*?)<\/script>/

const isPageChunk = (
  chunk: Rollup.OutputAsset | Rollup.OutputChunk
): chunk is Rollup.OutputChunk & { facadeModuleId: string } =>
  !!(
    chunk.type === 'chunk' &&
    chunk.isEntry &&
    chunk.facadeModuleId &&
    chunk.facadeModuleId.endsWith('.md')
  )

const cleanUrl = (url: string): string =>
  url.replace(/#.*$/s, '').replace(/\?.*$/s, '')

/**
 * 用于创建一个包含多个插件的 VitePress 插件集合。这些插件支持 VitePress 的构建、开发和热更新等功能
 * @param siteConfig 站点的配置对象，包含关于站点的信息（如 srcDir、site、vite 配置等）
 * @param ssr 是否启用服务器端渲染，默认为 false
 * @param pageToHashMap 用于映射页面路径到生成的哈希值
 * @param clientJSMap 用于存储客户端 JavaScript 代码
 * @param recreateServer 可选的回调函数，用于在文件变化时重建开发服务器
 */
export async function createVitePressPlugin(
  siteConfig: SiteConfig,
  ssr = false,
  pageToHashMap?: Record<string, string>,
  clientJSMap?: Record<string, string>,
  recreateServer?: () => Promise<void>
) {
  // 从 siteConfig 中提取必要的配置（如 srcDir、site、vite 配置、pages 等）
  const {
    srcDir,
    configPath,
    configDeps,
    markdown,
    site,
    vue: userVuePluginOptions,
    vite: userViteConfig,
    pages,
    lastUpdated,
    cleanUrls
  } = siteConfig

  let markdownToVue: Awaited<ReturnType<typeof createMarkdownToVueRenderFn>>
  const userCustomElementChecker =
    userVuePluginOptions?.template?.compilerOptions?.isCustomElement
  let isCustomElement = userCustomElementChecker

  // 根据 markdown 配置，处理是否启用 math 功能以及自定义元素的检查
  if (markdown?.math) { // markdown 支持 math
    isCustomElement = (tag) => {
      if (['mjx-container', 'mjx-assistive-mml'].includes(tag)) {
        return true
      }
      return userCustomElementChecker?.(tag) ?? false
    }
  }

  // lazy require plugin-vue to respect NODE_ENV in @vue/compiler-x
  // 使用 import 动态导入 @vitejs/plugin-vue 插件，并根据用户的 Vue 配置设置自定义元素检测
  const vuePlugin = await import('@vitejs/plugin-vue').then((r) =>
    r.default({
      include: [/\.vue$/, /\.md$/], // md ??
      ...userVuePluginOptions, // 插件的配置
      template: {
        ...userVuePluginOptions?.template, // 允许我们传递 Vue 模板编译器的配置
        compilerOptions: {
          ...userVuePluginOptions?.template?.compilerOptions, // 配置项用来传递 Vue 模板编译器的参数
          isCustomElement // 用来匹配那些需要被 Vue 编译器视为自定义元素的标签名
        }
      }
    })
  )

  // processClientJS 用于处理代码中的特定部分（如 scriptClientRE），并根据 ssr 设置将相关内容映射到 clientJSMap 中
  /**
   * processClientJS 的主要作用是在 SSR 模式下提取客户端 JavaScript 代码块，并将其存储到 clientJSMap 中。对于不匹配的代码，它则保持原样返回。
   *
   * * SSR 模式下：提取客户端 JavaScript 代码并存入 clientJSMap，同时保留代码格式。
   * * 非 SSR 模式下：返回原始代码，没有任何更改。
   * 该函数是为了在构建过程中区分客户端和服务器端的 JavaScript 代码，特别是在服务器端渲染的场景中，确保客户端相关的代码能够被正确提取和使用。
   *
   * <script client> 不会被视为 Vue 组件代码，它只是普通的 JavaScript 模块。因此，只有在站点需要极少的客户端交互时，才应该使用 MPA 模式
   * @param code
   * @param id
   */
  const processClientJS = (code: string, id: string) => {
    return scriptClientRE.test(code)
      ? code.replace(scriptClientRE, (_, content) => {
        // 这行代码表示：如果启用了 SSR（服务端渲染，ssr 为真）且 clientJSMap 存在，那么将这个页面的 JavaScript 代码存储到 clientJSMap 中，使用 id 作为键，content 作为值。
          // 这通常是用于将客户端 JavaScript 代码从服务端渲染的输出中提取出来，并保存以备后续使用
          if (ssr && clientJSMap) clientJSMap[id] = content
          // 这行代码将原来匹配到的 <script> 标签替换成了等量的换行符（\n）。也就是说，它去掉了 <script> 标签和其中的 JavaScript 内容，但保留了其原本的行数（即每个换行符的数量）。
          // 这是为了保持文件的结构，尤其是在构建过程中，保留原有的行数有助于避免文件被不必要地修改或被认为是不同的。
          return `\n`.repeat(_.split('\n').length - 1)
        })
      : code
  }

  let siteData = site
  let allDeadLinks: MarkdownCompileResult['deadLinks'] = []
  let config: ResolvedConfig
  let importerMap: Record<string, Set<string> | undefined> = {}

  // 定义 vitePress 插件
  const vitePressPlugin: Plugin = {
    name: 'vitepress',

    // 在 Vite 完成配置解析后，调用 createMarkdownToVueRenderFn 来创建一个用于将 Markdown 转换为 Vue 组件的渲染函数
    // 当插件需要根据运行的命令做一些不同的事情时，它也很有用
    async configResolved(resolvedConfig) {
      config = resolvedConfig

      // 初始化 markdown 渲染为 Vue 的函数
      markdownToVue = await createMarkdownToVueRenderFn(
        srcDir,
        markdown,
        pages,
        config.command === 'build',
        config.base,
        lastUpdated,
        cleanUrls,
        siteConfig
      )
    },

    // 返回最终的 Vite 配置，合并用户自定义配置与 VitePress 的默认配置
    // 在解析 Vite 配置前调用。钩子接收原始用户配置（命令行选项指定的会与配置文件合并）和一个描述配置环境的变量，包含正在使用的 mode 和 command。它可以返回一个将被深度合并到现有配置中的部分配置对象，或者直接改变配置（如果默认的合并不能达到预期的结果）
    config() {
      const baseConfig: UserConfig = {
        resolve: {
          alias: resolveAliases(siteConfig, ssr) // 配置别名
        },
        define: {
          __VP_LOCAL_SEARCH__: site.themeConfig?.search?.provider === 'local',
          __ALGOLIA__:
            site.themeConfig?.search?.provider === 'algolia' ||
            !!site.themeConfig?.algolia, // legacy
          __CARBON__: !!site.themeConfig?.carbonAds,
          __ASSETS_DIR__: JSON.stringify(siteConfig.assetsDir),
          __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: !!process.env.DEBUG
        },
        optimizeDeps: {
          // force include vue to avoid duplicated copies when linked + optimized
          include: [
            'vue',
            'vitepress > @vue/devtools-api',
            'vitepress > @vueuse/core'
          ],
          exclude: ['@docsearch/js', 'vitepress']
        },
        server: {
          fs: {
            allow: [ // 它的作用是在 Vite 开发服务器中设置文件系统（fs）的访问权限，指定允许访问的文件夹路径
              DIST_CLIENT_PATH,
              srcDir,
              searchForWorkspaceRoot(process.cwd())
            ]
          }
        },
        vitepress: siteConfig
      }
      return userViteConfig
        ? mergeConfig(baseConfig, userViteConfig)
        : baseConfig
    },

    // rollup 钩子：用于自定义模块解析的行为
    resolveId(id) {
      if (id === SITE_DATA_REQUEST_PATH) {
        return SITE_DATA_REQUEST_PATH
      }
    },

    // rollup load 钩子：处理 SITE_DATA_REQUEST_PATH 的加载，返回站点数据并支持在生产环境下内联数据
    // 它的作用是根据模块的 id 来返回对应的内容。在此代码中，它主要用于处理一个特定路径的请求，即 SITE_DATA_REQUEST_PATH，并根据不同的构建环境返回不同的数据格式。
    load(id) {
      if (id === SITE_DATA_REQUEST_PATH) {
        let data = siteData
        // head info is not needed by the client in production build
        if (config.command === 'build') {
          data = { ...siteData, head: [] } // 在生产环境中不需要发送 head 信息，因此将 head 置为空数组。这样可以减少页面加载时不必要的数据传输
          // in production client build, the data is inlined on each page
          // to avoid config changes invalidating every chunk.
          // 在非 SSR 模式下（!ssr），它会返回 window.__VP_SITE_DATA__，这是在客户端构建时将站点数据绑定到全局 window 对象上的一种方式
          if (!ssr) {
            return `export default window.__VP_SITE_DATA__`
          }
        }
        // 使用 serializeFunctions(data) 将站点数据中的任何函数序列化。序列化后的数据可以在客户端正确地执行，尤其是当数据中包含了不能直接传输的函数时
        data = serializeFunctions(data)
        // 将站点数据进行 JSON.stringify 转换为字符串格式，并返回一段代码，该代码会在客户端进行 deserializeFunctions 反序列化。
        // 这是为了确保在客户端可以正确还原这些函数，并避免在客户端无法直接传输函数
        return `${deserializeFunctions};export default deserializeFunctions(JSON.parse(${JSON.stringify(
          JSON.stringify(data)
        )}))`
      }
    },

    // transform: 处理 .vue 和 .md 文件的转换，将 Markdown 文件转换为 Vue 组件代码，支持 HMR
    async transform(code, id) {
      if (id.endsWith('.vue')) { // 处理 .vue 文件
        return processClientJS(code, id)
      } else if (id.endsWith('.md')) { // 处理 .md 文件
        // transform .md files into vueSrc so plugin-vue can handle it
        const { vueSrc, deadLinks, includes } = await markdownToVue(
          code,
          id,
          config.publicDir
        )
        allDeadLinks.push(...deadLinks) // 收集死链
        // 处理引用的文件
        // * 如果 Markdown 文件中引用了其他文件（通过 includes），则将这些引用添加到 importerMap 中。importerMap 是一个记录文件之间依赖关系的映射，确保 Vite 能够正确地处理热更新（HMR）。
        // * this.addWatchFile(i) 确保 Vite 能够监视这些引用的文件，当这些文件发生变化时会触发更新。
        if (includes.length) {
          includes.forEach((i) => {
            ;(importerMap[slash(i)] ??= new Set()).add(id)
            this.addWatchFile(i)
          })
        }
        // 调用 processClientJS 来处理转换后的 Vue 代码
        return processClientJS(vueSrc, id)
      }
    },

    // rollup 钩子：一个用于检查并报告死链接的函数。它在渲染过程开始时运行，检查收集到的所有死链接（allDeadLinks），并根据配置决定是否抛出错误
    renderStart() {
      // 检查是否存在死链接。如果 allDeadLinks 数组的长度大于零，说明存在死链接
      if (allDeadLinks.length > 0) {
        // 遍历所有的死链接，每个死链接对象包含 url（链接的 URL）和 file（死链接所在的文件）
        allDeadLinks.forEach(({ url, file }, i) => {
          siteConfig.logger.warn(
            c.yellow(
              `${i === 0 ? '\n\n' : ''}(!) Found dead link ${c.cyan(
                url
              )} in file ${c.white(c.dim(file))}`
            )
          )
        })
        siteConfig.logger.info(
          c.cyan(
            '\nIf this is expected, you can disable this check via config. Refer: https://vitepress.dev/reference/site-config#ignoredeadlinks\n'
          )
        )
        // 在警告输出后，抛出一个错误，提示用户总共发现了多少个死链接。这个错误的目的是中止当前的渲染过程，确保用户关注到这些死链接
        throw new Error(`${allDeadLinks.length} dead link(s) found.`)
      }
    },

    // 用于配置服务器的函数，通常用于在构建工具（如 Vite）中进行开发模式的服务器配置。它处理文件的添加、删除，以及相关文件变动时的重载和更新逻辑
    configureServer(server) {
      // 1. 文件监视和响应
      // 首先，如果 configPath 存在，代码会将 configPath 和 configDeps 中的文件添加到服务器的 watcher 中进行监听
      if (configPath) {
        server.watcher.add(configPath)
        // server.watcher 是一个用于监视文件变化的工具，它会监听这些文件的变化，一旦发生变化就触发相应的处理逻辑
        configDeps.forEach((file) => server.watcher.add(file))
      }

      // 2. 文件添加/删除的处理
      const onFileAddDelete = async (added: boolean, _file: string) => {
        const file = slash(_file)
        // restart server on theme file creation / deletion
        if (themeRE.test(file)) { // 如果添加或删除的是主题文件（由 themeRE.test(file) 判断），则会输出日志并重新启动服务器
          siteConfig.logger.info(
            c.green(
              `${path.relative(process.cwd(), _file)} ${
                added ? 'created' : 'deleted'
              }, restarting server...\n`
            ),
            { clear: true, timestamp: true }
          )

          await recreateServer?.()
        }

        // update pages, dynamicRoutes and rewrites on md file creation / deletion
        // 如果是 .md 文件的变化，调用 resolvePages 函数重新解析和更新页面、动态路由和重写规则
        if (file.endsWith('.md')) {
          Object.assign(
            siteConfig,
            await resolvePages(
              siteConfig.srcDir,
              siteConfig.userConfig,
              siteConfig.logger
            )
          )
        }

        // 如果文件删除，且该文件在 importerMap 中有记录，则将其从 importerMap 中删除
        if (!added && importerMap[file]) {
          delete importerMap[file]
        }
      }
      // 通过 server.watcher 监听文件的 add（添加）和 unlink（删除）事件，并将 onFileAddDelete 函数绑定到这些事件。
      // 当文件被添加或删除时，onFileAddDelete 函数将被触发，处理相应的逻辑
      server.watcher
        .on('add', onFileAddDelete.bind(null, true))
        .on('unlink', onFileAddDelete.bind(null, false))

      // serve our index.html after vite history fallback
      // 自定义中间件处理 HTML 请求
      return () => { // 在 Vite 内置中间件之后执行
        server.middlewares.use(async (req, res, next) => {
          const url = req.url && cleanUrl(req.url)
          if (url?.endsWith('.html')) { // 当请求的 URL 以 .html 结尾时
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html')
            // 生成一个基本的 HTML 文件，并将应用的入口 index.js 文件注入到 <script> 标签中
            let html = `<!DOCTYPE html>
<html>
  <head>
    <title></title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="description" content="">
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/@fs/${APP_PATH}/index.js"></script>
  </body>
</html>`
            // 其中 APP_PATH 为 src/client/app/index.ts
            // 在 Vite 中，@fs 是一个特殊的虚拟路径别名，用于访问本地文件系统的文件。当你使用 Vite 的开发服务器时，它允许你通过 @fs 直接从项目的文件系统加载文件
            // 使用 server.transformIndexHtml 处理 HTML 内容，以便对 index.html 进行适当的转换
            html = await server.transformIndexHtml(url, html, req.originalUrl)
            res.end(html) // 最后将 HTML 响应发送给客户端
            return
          }
          next() // 如果请求的 URL 不是 .html 文件，则通过 next() 调用传递给下一个中间件
        })
      }
    },

    /**
     * rollup 钩子：一个用于在 Rollup 构建过程中处理每个代码块的钩子函数。它主要用于修改输出的代码（即 chunk），并且根据一些条件对其进行注入和替换。
     * 这个函数通常用于在构建过程中对生成的代码进行特定的修改
     * @param code
     * @param chunk
     */
    renderChunk(code, chunk) {
      // ssr 变量用于判断是否为服务器端渲染（SSR）模式。如果是 SSR 模式，renderChunk 会跳过处理
      // isPageChunk(chunk) 是一个用于判断 chunk 是否为页面的代码块的函数。如果是页面相关的 Chunk，则会执行下面的代码
      if (!ssr && isPageChunk(chunk as Rollup.OutputChunk)) {
        // For each page chunk, inject marker for start/end of static strings.
        // we do this here because in generateBundle the chunks would have been
        // minified and we won't be able to safely locate the strings.
        // Using a regexp relies on specific output from Vue compiler core,
        // which is a reasonable trade-off considering the massive perf win over
        // a full AST parse.
        // 这个替换操作的目的是在代码中注入 __VP_STATIC_START__ 和 __VP_STATIC_END__ 标记，这样可以标记出静态字符串的范围。这对后续的处理非常重要，比如用来提取或替换静态内容。
        // 注入静态字符串标记的目的是在后续的处理阶段能够安全地定位和修改这些静态字符串。由于 Rollup 构建过程中的代码已经可能被压缩或修改，依赖 AST（抽象语法树）进行处理可能会比较复杂和低效，而正则表达式则提供了更高效的替代方式
        code = code.replace(
          staticInjectMarkerRE,
          '$1("__VP_STATIC_START__$2__VP_STATIC_END__", $3)'
        )
        return code
      }
      return null
    },

    /**
     * rollup 钩子：在构建时调整页面的文件名，将每个页面的 JS 文件进行哈希处理，并处理静态标记
     * Rollup 中的一个钩子函数，它用于在生成最终的 bundle（打包文件）时进行处理。
     * 这个函数在整个构建过程的最后阶段执行，允许开发者对输出的 bundle 进行进一步的修改或处理。
     * @param _options
     * @param bundle
     */
    generateBundle(_options, bundle) {
      // 如果 ssr 为 true，则表示当前是服务器端渲染模式。在这种情况下，generateBundle 会生成一个 package.json 文件并作为一个资产文件（asset）添加到构建产物中。
      // 这个 package.json 文件的内容为 {"private": true, "type": "module"}，表明该项目是一个 ES 模块项目，并且它是私有的，不需要发布到 npm 等包管理平台。
      if (ssr) {
        this.emitFile({
          type: 'asset',
          fileName: 'package.json',
          source: '{ "private": true, "type": "module" }'
        })
      } else {
        // client build:
        // for each .md entry chunk, adjust its name to its correct path.
        // 在客户端构建中，处理每个页面相关的 chunk：
        // 1. 记录页面与哈希值之间的关系。
        // 2. 为每个页面生成一个瘦版的 chunk，去除其中的静态内容。
        // 3. 移除原始代码中的静态标记。
        for (const name in bundle) {
          const chunk = bundle[name]
          if (isPageChunk(chunk)) { // 判断当前的 chunk 是否属于页面相关的代码块
            // record page -> hash relations 记录页面和哈希的关系
            const hash = chunk.fileName.match(hashRE)![1]
            pageToHashMap![chunk.name.toLowerCase()] = hash

            // inject another chunk with the content stripped
            bundle[name + '-lean'] = {
              ...chunk,
              fileName: chunk.fileName.replace(/\.js$/, '.lean.js'),
              preliminaryFileName: chunk.preliminaryFileName.replace(
                /\.js$/,
                '.lean.js'
              ),
              code: chunk.code.replace(staticStripRE, `""`)
            }

            // remove static markers from original code
            chunk.code = chunk.code.replace(staticRestoreRE, '')
          }
        }
      }
    },

    /**
     * 处理热更新事件，重新加载修改过的 Markdown 文件，更新页面数据，并触发 HMR
     * 一个处理热更新的函数，通常用于开发模式下，特别是在使用 Vite 等工具时。
     * 这个函数主要用于监控文件变化，并根据文件变化执行相关的处理逻辑，例如重新加载配置、处理 Markdown 文件热更新为 Vue 文件等
     * @param ctx
     */
    async handleHotUpdate(ctx) {
      const { file, read, server } = ctx
      // 如果检测到配置文件或依赖文件（configPath 或 configDeps 中的文件）发生了变化
      // 这种情况通常发生在开发过程中，当配置文件（如 vite.config.js、siteConfig 等）发生变化时，需要重新加载配置并重启开发服务器
      if (file === configPath || configDeps.includes(file)) {
        // 通过日志记录器输出文件变化的信息
        siteConfig.logger.info(
          c.green(
            `${path.relative(
              process.cwd(),
              file
            )} changed, restarting server...\n`
          ),
          { clear: true, timestamp: true }
        )

        try {
          // 调用 resolveUserConfig 重新加载用户配置
          await resolveUserConfig(siteConfig.root, 'serve', 'development')
        } catch (err: any) {
          siteConfig.logger.error(err)
          return
        }

        // 清理缓存
        clearCache()
        // 重新创建服务器（recreateServer），使配置变化能够生效
        await recreateServer?.()
        return
      }

      // hot reload .md files as .vue files
      // 处理 Markdown 文件热更新
      if (file.endsWith('.md')) { // 如果检测到 .md 文件发生变化
        const content = await read() // 使用 read() 方法获取文件的最新内容
        // 调用 markdownToVue 将 Markdown 文件转换为 Vue 文件，同时返回 vueSrc 和 pageData
        const { pageData, vueSrc } = await markdownToVue( // vueSrc 是 Vue 文件的源码，pageData 是该页面的元数据
          content,
          file,
          config.publicDir
        )

        // 创建 PageDataPayload 对象，用于向客户端传输页面的更新数据
        const payload: PageDataPayload = {
          path: `/${slash(path.relative(srcDir, file))}`,
          pageData
        }

        // notify the client to update page data
        // 使用 Vite 的 server.ws.send 推送一个自定义事件 vitepress:pageData，将更新的页面数据传递给客户端，以便客户端能够根据新的内容重新渲染页面
        server.ws.send({
          type: 'custom',
          event: 'vitepress:pageData',
          data: payload
        })

        // overwrite src so vue plugin can handle the HMR
        // 重写 ctx.read，使其返回转换后的 vueSrc，这样 Vue 插件就能够处理热模块替换（HMR）操作
        ctx.read = () => vueSrc
      }
    }
  }

  // hmrFix 插件用于修复 VitePress 中的热更新（HMR）问题，尤其是在处理模块间依赖关系时。通过此插件，可以确保模块的缓存被清除，并且确保模块图在发生变化时得到更新
  const hmrFix: Plugin = {
    name: 'vitepress:hmr-fix',
    /**
     * Vite 的 HMR 插件提供了 handleHotUpdate 方法，用于在文件热更新时执行特定的操作
     * @param file 变更的文件路径
     * @param server Vite 开发服务器实例
     * @param modules 变更模块的列表
     */
    async handleHotUpdate({ file, server, modules }) {
      // importerMap 是一个对象，保存了各个模块的导入关系。通过 slash(file) 获取当前文件的路径，并查找该文件作为依赖的其他模块（importers）
      const importers = [...(importerMap[slash(file)] || [])]
      if (importers.length > 0) { // 如果当前文件有被其他模块依赖
        return [
          ...modules,
          ...importers.map((id) => {
            clearCache(id) // 清除该模块的缓存，确保其在下次加载时能够获取到最新的内容
            return server.moduleGraph.getModuleById(id) // 获取模块图中的模块
          })
        ].filter(Boolean) as ModuleNode[]
      }
    }
  }

  return [
    vitePressPlugin,
    rewritesPlugin(siteConfig), // 重定向插件
    vuePlugin, // 延迟加载 plugin-vue 插件
    hmrFix, // 热更新插件
    webFontsPlugin(siteConfig.useWebFonts),
    ...(userViteConfig?.plugins || []), // 用户配置的vite插件
    await localSearchPlugin(siteConfig),
    staticDataPlugin,
    await dynamicRoutesPlugin(siteConfig) // 动态路由插件
  ]
}
