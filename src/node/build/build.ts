import { createHash } from 'crypto'
import fs from 'fs-extra'
import { createRequire } from 'module'
import pMap from 'p-map'
import path from 'path'
import { packageDirectorySync } from 'pkg-dir'
import { rimraf } from 'rimraf'
import { pathToFileURL } from 'url'
import type { BuildOptions, Rollup } from 'vite'  // 只导出类型
import { resolveConfig, type SiteConfig } from '../config'
import { clearCache } from '../markdownToVue'
import { slash, type HeadConfig } from '../shared'
import { deserializeFunctions, serializeFunctions } from '../utils/fnSerialize'
import { task } from '../utils/task'
import { bundle } from './bundle'
import { generateSitemap } from './generateSitemap'
import { renderPage } from './render'

/**
 * 它处理了整个构建过程，包括配置处理、打包、渲染页面、生成资源文件等
 * @param root
 * @param buildOptions
 */
export async function build(
  root?: string,
  buildOptions: BuildOptions & { base?: string; mpa?: string } = {}
) {
  const start = Date.now() // 获取当前时间戳，记录构建开始时间。now() 静态方法返回自 epoch 以来经过的毫秒数

  process.env.NODE_ENV = 'production' // 设置为生产环境
  // 解析并获取构建所需的配置。它会加载生产环境的构建配置
  const siteConfig = await resolveConfig(root, 'build', 'production')
  const unlinkVue = linkVue()

  // 处理构建选项
  if (buildOptions.base) { // 设置站点的基础路径
    siteConfig.site.base = buildOptions.base
    delete buildOptions.base
  }

  if (buildOptions.mpa) { // 如果设置为 true，则启用多页面应用（MPA）模式
    siteConfig.mpa = true
    delete buildOptions.mpa
  }

  if (buildOptions.outDir) { // 设置构建输出目录
    siteConfig.outDir = path.resolve(process.cwd(), buildOptions.outDir)
    delete buildOptions.outDir
  }

  try {
    // 执行实际的打包操作
    // clientResult：客户端打包结果
    // serverResult：服务器端打包结果
    // pageToHashMap：页面与哈希值的映射
    const { clientResult, serverResult, pageToHashMap } = await bundle(
      siteConfig,
      buildOptions
    )

    if (process.env.BUNDLE_ONLY) {
      return
    }

    // 通过 import 动态加载 app.js，它是渲染页面所需的入口文件
    const entryPath = path.join(siteConfig.tempDir, 'app.js')
    const { render } = await import(
      pathToFileURL(entryPath).toString() + '?t=' + Date.now()
    )

    // 这段代码主要处理网站页面的渲染，具体来说是通过异步任务来生成网站页面，并为每个页面添加合适的资源（如 CSS 和 JavaScript）。
    // 在这个过程中，默认主题的字体会被特殊处理，且每个页面都会被渲染成最终的 HTML 文件
    await task('rendering pages', async () => {
      // clientResult.output.find() 查找 clientResult 中的输出项，找到类型为 chunk 且是入口文件（isEntry）的 JavaScript 文件。
      // 这是用于渲染页面的核心 JavaScript 代码
      const appChunk =
        clientResult &&
        (clientResult.output.find(
          (chunk) =>
            chunk.type === 'chunk' &&
            chunk.isEntry &&
            chunk.facadeModuleId?.endsWith('.js')
        ) as Rollup.OutputChunk)

      // 查找 CSS 文件。在 MPA（多页面应用）模式下，优先使用 serverResult，否则使用 clientResult 中的 CSS 文件
      const cssChunk = (
        siteConfig.mpa ? serverResult : clientResult!
      ).output.find(
        (chunk) => chunk.type === 'asset' && chunk.fileName.endsWith('.css')
      ) as Rollup.OutputAsset

      // 过滤出所有类型为 asset 且不是 CSS 的静态资源（例如 JavaScript、图片等）。
      // 然后将资源的文件名与基础路径 (siteConfig.site.base) 拼接，得到资源的完整路径
      const assets = (siteConfig.mpa ? serverResult : clientResult!).output
        .filter(
          (chunk) => chunk.type === 'asset' && !chunk.fileName.endsWith('.css')
        )
        .map((asset) => siteConfig.site.base + asset.fileName)

      // default theme special handling: inject font preload
      // custom themes will need to use `transformHead` to inject this
      // additionalHeadTags 是一个数组，用来存储将在 HTML 页头注入的额外标签（例如预加载字体）
      const additionalHeadTags: HeadConfig[] = []
      // 判断当前是否使用默认主题。如果 clientResult 中包含名为 'theme' 的 chunk，并且该 chunk 中包含 client/theme-default 模块，则认为使用的是默认主题
      const isDefaultTheme =
        clientResult &&
        clientResult.output.some(
          (chunk) =>
            chunk.type === 'chunk' &&
            chunk.name === 'theme' &&
            chunk.moduleIds.some((id) => id.includes('client/theme-default'))
        )

      const metadataScript = generateMetadataScript(pageToHashMap, siteConfig)

      // 如果使用的是默认主题且找到了字体文件（匹配 inter-roman-latin 字体文件），则将该字体文件作为 preload 资源注入到 HTML 的 <head> 中
      if (isDefaultTheme) {
        const fontURL = assets.find((file) =>
          /inter-roman-latin\.\w+\.woff2/.test(file)
        )
        if (fontURL) {
          additionalHeadTags.push([
            'link',
            {
              rel: 'preload',
              href: fontURL,
              as: 'font',
              type: 'font/woff2',
              crossorigin: ''
            }
          ])
        }
      }

      // 使用 pMap 执行并发渲染多个页面。pMap 是一个并发执行的映射函数，它会并行处理 siteConfig.pages 中的每个页面和 404.md 页面
      await pMap(
        ['404.md', ...siteConfig.pages],
        async (page) => {
          // 对于每个页面，调用 renderPage 函数来进行页面渲染
          await renderPage(
            render, // 渲染函数
            siteConfig, // 网站配置
            siteConfig.rewrites.map[page] || page, // 页面路径（如果有重写规则则使用重写后的路径）
            clientResult, // 客户端打包结果
            appChunk, // 入口 JS
            cssChunk, // CSS
            assets, // 静态资源
            pageToHashMap, // 页面与哈希值的映射
            metadataScript, // 元数据脚本（可能用于 SEO 或页面级别的配置）
            additionalHeadTags // 需要注入页面的额外头部标签
          )
        },
        { concurrency: siteConfig.buildConcurrency }
      )
    })

    // emit page hash map for the case where a user session is open
    // when the site got redeployed (which invalidates current hash map)
    fs.writeJSONSync( // 将 pageToHashMap（页面与哈希的映射关系）写入 hashmap.json 文件
      path.join(siteConfig.outDir, 'hashmap.json'),
      pageToHashMap
    )
  } finally {
    unlinkVue()
    if (!process.env.DEBUG) await rimraf(siteConfig.tempDir) // 如果不是调试模式，删除临时构建目录
  }

  await generateSitemap(siteConfig) // 生成站点地图
  await siteConfig.buildEnd?.(siteConfig) // 调用 buildEnd 钩子（如果存在），标记构建结束
  clearCache() // 清理缓存

  // 输出构建完成时间
  siteConfig.logger.info(
    `build complete in ${((Date.now() - start) / 1000).toFixed(2)}s.`
  )
}

/**
 * 主要作用是确保 Vue.js 在当前项目中的正确链接，特别是在 VitePress 项目中，Vue.js 可能是作为依赖被安装的
 */
function linkVue() {
  // 通过 packageDirectorySync() 查找当前项目的根目录。这个函数的作用是返回当前项目的根目录路径
  const root = packageDirectorySync()
  if (root) {
    // 将根目录与 node_modules/vue 拼接，得到 Vue.js 在 node_modules 中的目标路径
    const dest = path.resolve(root, 'node_modules/vue')
    // if user did not install vue by themselves, link VitePress' version
    // 检查 node_modules/vue 是否已经存在。如果没有安装 Vue.js，则进入下一步处理
    if (!fs.existsSync(dest)) {
      // 通过 import.meta.url 获取当前模块的路径，并解析出 Vue.js 的模块位置
      const src = path.dirname(createRequire(import.meta.url).resolve('vue'))
      // 创建一个符号链接，将 Vue.js 的路径链接到 node_modules/vue 中。'junction' 表示创建一个目录链接，在 Windows 系统中，这是软链接的一种类型
      fs.ensureSymlinkSync(src, dest, 'junction')
      // 返回一个函数，用于清除之前创建的符号链接。在调用该函数时，它会删除 node_modules/vue 中的符号链接
      return () => {
        fs.unlinkSync(dest)
      }
    }
  }
  // 如果 Vue.js 已经安装在 node_modules 中，直接返回一个空的清理函数，因为不需要进行任何操作
  return () => {}
}

/**
 * 生成和嵌入页面元数据（如页面哈希映射和站点配置），并根据配置决定如何处理这些元数据。
 * 这些元数据可以包括页面的哈希映射（pageToHashMap）和站点的配置信息（config.site），这些数据会在页面加载时由客户端脚本读取和使用
 * @param pageToHashMap
 * @param config
 */
function generateMetadataScript(
  pageToHashMap: Record<string, string>,
  config: SiteConfig
) {
  // 如果是多页面应用（MPA，config.mpa 为 true），则不生成元数据脚本。MPA 通常需要在每个页面上单独处理数据，而不是通过全局的 JavaScript 注入
  if (config.mpa) {
    return { html: '', inHead: false }
  }

  // We embed the hash map and site config strings into each page directly
  // so that it doesn't alter the main chunk's hash on every build.
  // It's also embedded as a string and JSON.parsed from the client because
  // it's faster than embedding as JS object literal.
  const hashMapString = JSON.stringify(JSON.stringify(pageToHashMap))
  const siteDataString = JSON.stringify(
    JSON.stringify(serializeFunctions({ ...config.site, head: [] }))
  )

  const metadataContent = `window.__VP_HASH_MAP__=JSON.parse(${hashMapString});${
    siteDataString.includes('_vp-fn_')
      ? `${deserializeFunctions};window.__VP_SITE_DATA__=deserializeFunctions(JSON.parse(${siteDataString}));`
      : `window.__VP_SITE_DATA__=JSON.parse(${siteDataString});`
  }`

  if (!config.metaChunk) {
    return { html: `<script>${metadataContent}</script>`, inHead: false }
  }

  const metadataFile = path.join(
    config.assetsDir,
    'chunks',
    `metadata.${createHash('sha256')
      .update(metadataContent)
      .digest('hex')
      .slice(0, 8)}.js`
  )

  const resolvedMetadataFile = path.join(config.outDir, metadataFile)
  const metadataFileURL = slash(`${config.site.base}${metadataFile}`)

  fs.ensureDirSync(path.dirname(resolvedMetadataFile))
  fs.writeFileSync(resolvedMetadataFile, metadataContent)

  return {
    html: `<script type="module" src="${metadataFileURL}"></script>`,
    inHead: true
  }
}
