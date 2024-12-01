import _debug from 'debug'
import fs from 'fs-extra'
import MiniSearch from 'minisearch'
import pMap from 'p-map'
import path from 'path'
import type { Plugin, ViteDevServer } from 'vite'
import type { SiteConfig } from '../config'
import { createMarkdownRenderer } from '../markdown/markdown'
import {
  getLocaleForPath,
  slash,
  type DefaultTheme,
  type MarkdownEnv
} from '../shared'
import { processIncludes } from '../utils/processIncludes'

const debug = _debug('vitepress:local-search')

const LOCAL_SEARCH_INDEX_ID = '@localSearchIndex'
const LOCAL_SEARCH_INDEX_REQUEST_PATH = '/' + LOCAL_SEARCH_INDEX_ID

interface IndexObject {
  id: string
  text: string
  title: string
  titles: string[]
}

/**
 * 用于为网站提供本地搜索功能。该插件通过使用 MiniSearch 库，索引网站的 Markdown 文件，允许用户在不依赖外部搜索引擎的情况下，在站点内进行搜索。
 * 插件的工作流程包括：
 *
 * 1. 创建并渲染 Markdown 文件。
 * 2. 为每个文件建立搜索索引。
 * 3. 在构建时扫描并更新索引。
 * 4. 支持文件热更新，在 Markdown 文件更新时重新索引。
 * @param siteConfig
 */
export async function localSearchPlugin(
  siteConfig: SiteConfig<DefaultTheme.Config>
): Promise<Plugin> {
  // 只有当 siteConfig.site.themeConfig?.search?.provider 为 'local' 时，插件才会启用。
  // 如果不满足这个条件，插件会返回一个简单的处理函数，忽略对搜索功能的处理。
  if (siteConfig.site.themeConfig?.search?.provider !== 'local') {
    return { // 插件会返回一个简单的处理函数，忽略对搜索功能的处理
      name: 'vitepress:local-search', // 插件名称
      resolveId(id) {
        if (id.startsWith(LOCAL_SEARCH_INDEX_ID)) {
          return `/${id}`
        }
      },
      load(id) {
        if (id.startsWith(LOCAL_SEARCH_INDEX_REQUEST_PATH)) {
          return `export default '{}'`
        }
      }
    }
  }

  // 使用 createMarkdownRenderer 创建一个 Markdown 渲染器，用于渲染 Markdown 文件，并生成 HTML 内容。
  // 它会从 siteConfig 中获取源目录 (srcDir)、Markdown 配置、站点基础路径和日志工具。
  const md = await createMarkdownRenderer(
    siteConfig.srcDir,
    siteConfig.markdown,
    siteConfig.site.base,
    siteConfig.logger
  )

  // 获取搜索选项
  const options = siteConfig.site.themeConfig.search.options || {}

  /**
   * 渲染文件内容
   * @param file
   */
  async function render(file: string) {
    if (!fs.existsSync(file)) return ''
    const { srcDir, cleanUrls = false } = siteConfig
    const relativePath = slash(path.relative(srcDir, file))
    const env: MarkdownEnv = { path: file, relativePath, cleanUrls }
    const md_raw = await fs.promises.readFile(file, 'utf-8')
    const md_src = processIncludes(srcDir, md_raw, file, [])
    // 如果配置中有 _render 函数，它会调用该函数进行渲染，否则默认通过 md.render 渲染 Markdown
    if (options._render) return await options._render(md_src, env, md)
    else {
      // render 函数负责将给定的 Markdown 文件 (file) 渲染为 HTML 内容。
      // 首先，检查文件是否存在，并读取文件内容。然后，根据配置渲染 Markdown 内容
      const html = md.render(md_src, env)
      return env.frontmatter?.search === false ? '' : html
    }
  }

  // MiniSearch 索引初始化
  const indexByLocales = new Map<string, MiniSearch<IndexObject>>()

  /**
   * 通过 MiniSearch 创建多个搜索索引，每个语言使用不同的索引（indexByLocales）。
   * 索引字段包括 title, titles, 和 text，用于全文搜索
   * @param locale
   */
  function getIndexByLocale(locale: string) {
    let index = indexByLocales.get(locale)
    if (!index) {
      index = new MiniSearch<IndexObject>({
        fields: ['title', 'titles', 'text'],
        storeFields: ['title', 'titles'],
        ...options.miniSearch?.options
      })
      indexByLocales.set(locale, index)
    }
    return index
  }

  let server: ViteDevServer | undefined

  function onIndexUpdated() {
    if (server) {
      server.moduleGraph.onFileChange(LOCAL_SEARCH_INDEX_REQUEST_PATH)
      // HMR
      const mod = server.moduleGraph.getModuleById(
        LOCAL_SEARCH_INDEX_REQUEST_PATH
      )
      if (!mod) return
      server.ws.send({
        type: 'update',
        updates: [
          {
            acceptedPath: mod.url,
            path: mod.url,
            timestamp: Date.now(),
            type: 'js-update'
          }
        ]
      })
    }
  }

  function getDocId(file: string) {
    let relFile = slash(path.relative(siteConfig.srcDir, file))
    relFile = siteConfig.rewrites.map[relFile] || relFile
    let id = slash(path.join(siteConfig.site.base, relFile))
    id = id.replace(/(^|\/)index\.md$/, '$1')
    id = id.replace(/\.md$/, siteConfig.cleanUrls ? '' : '.html')
    return id
  }

  /**
   * indexFile 函数处理文件的索引。在此函数中：
   * 1. 首先渲染页面文件并将其分割为多个章节（sections）。
   * 2. 每个章节包含文本和标题，MiniSearch 索引会根据这些信息建立搜索条目。
   * 3. 文件的 ID 是根据相对路径生成的，并且对于每个章节，都为其创建一个索引项。
   * @param page
   */
  async function indexFile(page: string) {
    const file = path.join(siteConfig.srcDir, page)
    // get file metadata
    const fileId = getDocId(file)
    const locale = getLocaleForPath(siteConfig.site, page)
    const index = getIndexByLocale(locale)
    // retrieve file and split into "sections"
    const html = await render(file)
    const sections =
      // user provided generator
      (await options.miniSearch?._splitIntoSections?.(file, html)) ??
      // default implementation
      splitPageIntoSections(html)
    // add sections to the locale index
    for await (const section of sections) {
      if (!section || !(section.text || section.titles)) break
      const { anchor, text, titles } = section
      const id = anchor ? [fileId, anchor].join('#') : fileId
      index.add({
        id,
        text,
        title: titles.at(-1)!,
        titles: titles.slice(0, -1)
      })
    }
  }

  // scanForBuild 扫描所有页面文件并为它们建立索引。通过 pMap 以并发的方式处理文件， buildConcurrency 控制并发度。
  async function scanForBuild() {
    debug('🔍️ Indexing files for search...')
    await pMap(siteConfig.pages, indexFile, {
      concurrency: siteConfig.buildConcurrency
    })
    debug('✅ Indexing finished...')
  }

  return {
    name: 'vitepress:local-search',

    // 优化依赖，确保所需的包如 @vueuse/integrations/useFocusTrap、mark.js、minisearch 包含在内
    config: () => ({
      optimizeDeps: {
        include: [
          'vitepress > @vueuse/integrations/useFocusTrap',
          'vitepress > mark.js/src/vanilla.js',
          'vitepress > minisearch'
        ]
      }
    }),

    // 在服务器配置时扫描并构建索引
    async configureServer(_server) {
      server = _server
      await scanForBuild()
      onIndexUpdated()
    },

    // 解析本地搜索索引文件的 ID
    resolveId(id) {
      if (id.startsWith(LOCAL_SEARCH_INDEX_ID)) {
        return `/${id}`
      }
    },

    // 处理加载本地搜索索引，生成搜索索引数据的 JavaScript 模块
    async load(id) {
      if (id === LOCAL_SEARCH_INDEX_REQUEST_PATH) {
        if (process.env.NODE_ENV === 'production') {
          await scanForBuild()
        }
        let records: string[] = []
        for (const [locale] of indexByLocales) {
          records.push(
            `${JSON.stringify(
              locale
            )}: () => import('@localSearchIndex${locale}')`
          )
        }
        return `export default {${records.join(',')}}`
      } else if (id.startsWith(LOCAL_SEARCH_INDEX_REQUEST_PATH)) {
        return `export default ${JSON.stringify(
          JSON.stringify(
            indexByLocales.get(
              id.replace(LOCAL_SEARCH_INDEX_REQUEST_PATH, '')
            ) ?? {}
          )
        )}`
      }
    },

    // 监听 Markdown 文件的更新，并在文件更改时重新索引
    async handleHotUpdate({ file }) {
      if (file.endsWith('.md')) {
        await indexFile(file)
        debug('🔍️ Updated', file)
        onIndexUpdated()
      }
    }
  }
}

const headingRegex = /<h(\d*).*?>(.*?<a.*? href="#.*?".*?>.*?<\/a>)<\/h\1>/gi
const headingContentRegex = /(.*?)<a.*? href="#(.*?)".*?>.*?<\/a>/i

/**
 * Splits HTML into sections based on headings
 */
function* splitPageIntoSections(html: string) {
  const result = html.split(headingRegex)
  result.shift()
  let parentTitles: string[] = []
  for (let i = 0; i < result.length; i += 3) {
    const level = parseInt(result[i]) - 1
    const heading = result[i + 1]
    const headingResult = headingContentRegex.exec(heading)
    const title = clearHtmlTags(headingResult?.[1] ?? '').trim()
    const anchor = headingResult?.[2] ?? ''
    const content = result[i + 2]
    if (!title || !content) continue
    let titles = parentTitles.slice(0, level)
    titles[level] = title
    titles = titles.filter(Boolean)
    yield { anchor, titles, text: getSearchableText(content) }
    if (level === 0) {
      parentTitles = [title]
    } else {
      parentTitles[level] = title
    }
  }
}

function getSearchableText(content: string) {
  content = clearHtmlTags(content)
  return content
}

function clearHtmlTags(str: string) {
  return str.replace(/<[^>]*>/g, '')
}
