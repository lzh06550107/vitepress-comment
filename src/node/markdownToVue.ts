import { resolveTitleFromToken } from '@mdit-vue/shared'
import _debug from 'debug'
import fs from 'fs-extra'
import { LRUCache } from 'lru-cache'
import path from 'path'
import type { SiteConfig } from './config'
import {
  createMarkdownRenderer,
  type MarkdownOptions,
  type MarkdownRenderer
} from './markdown/markdown'
import {
  EXTERNAL_URL_RE,
  getLocaleForPath,
  slash,
  treatAsHtml,
  type HeadConfig,
  type MarkdownEnv,
  type PageData
} from './shared'
import { getGitTimestamp } from './utils/getGitTimestamp'
import { processIncludes } from './utils/processIncludes'

const debug = _debug('vitepress:md')
const cache = new LRUCache<string, MarkdownCompileResult>({ max: 1024 })

export interface MarkdownCompileResult {
  vueSrc: string
  pageData: PageData
  deadLinks: { url: string; file: string }[]
  includes: string[]
}

/**
 * 一个用于清除缓存的函数，支持按文件清除缓存或清除所有缓存。它通过 cache 对象来管理和清除缓存项。
 * file: 如果提供了文件路径（file），则会清除与该文件相关的缓存；如果没有提供文件路径，则清除所有缓存
 */
export function clearCache(file?: string) {
  if (!file) {
    // 如果没有传递 file 参数（即 !file 为 true），则调用 cache.clear() 来清除所有缓存项
    cache.clear()
    return
  }
  // 如果提供了 file 参数（即清除特定文件的缓存）
  // 将 file 参数转换为 JSON 字符串，并去掉首尾的引号（通过 slice(1) 实现）
  file = JSON.stringify({ file }).slice(1)
  // 调用 cache.find() 查找与给定文件名匹配的缓存项，并删除相关缓存
  cache.find((_, key) => key.endsWith(file!) && cache.delete(key))
}

/**
  * 一个生成 Markdown 渲染函数的工厂函数，用于将 Markdown 文件转换为 Vue 组件格式的源代码，并进行相关处理（例如处理前端页面数据、链接检查、动态路由等）。
  * 这个函数是 VitePress 或类似系统中处理 Markdown 文件的关键步骤。
  *
  * srcDir: 源文件目录路径，用于定位 Markdown 文件和其它资源
  * options: Markdown 渲染选项（可选）
  * pages: 所有页面的路径列表，用于链接检查
  * isBuild: 是否为构建模式。如果为构建模式，则会做缓存和性能优化
  * base: 站点的基本路径（例如 /）
  * includeLastUpdatedData: 是否包含最后更新时间数据（通常用于 git 提交时间）
  * cleanUrls: 是否清理 URL（例如删除 .html 后缀）
  * siteConfig: 站点的配置对象，包含一些自定义配置选项
*/
export async function createMarkdownToVueRenderFn(
  srcDir: string,
  options: MarkdownOptions = {},
  pages: string[],
  isBuild = false,
  base = '/',
  includeLastUpdatedData = false,
  cleanUrls = false,
  siteConfig: SiteConfig | null = null
) {
  // 使用 createMarkdownRenderer 函数生成 Markdown 渲染器
  const md = await createMarkdownRenderer(
    srcDir,
    options,
    base,
    siteConfig?.logger
  )

  // 将页面路径（pages）中的 .md 后缀去掉，进行路径处理。
  // 如果站点配置中有重写规则（siteConfig?.rewrites），会替换文件路径为别名路径。
  pages = pages.map((p) => slash(p.replace(/\.md$/, '')))

  // 处理 Markdown 文件并将其转换为 Vue 组件的异步函数，主要负责渲染和转换单个 Markdown 文件的逻辑
  return async (
    src: string,
    file: string,
    publicDir: string
  ): Promise<MarkdownCompileResult> => {
    const fileOrig = file // 原始文件路径
    // 如果文件路径匹配某个别名（siteConfig?.rewrites.map），则替换成对应的别名路径
    const alias =
      siteConfig?.rewrites.map[file] || // virtual dynamic path file
      siteConfig?.rewrites.map[file.slice(srcDir.length + 1)]
    file = alias ? path.join(srcDir, alias) : file
    // 相对于源目录的文件路径
    const relativePath = slash(path.relative(srcDir, file))
    // 缓存键值，基于文件路径和源代码生成，避免重复计算
    const cacheKey = JSON.stringify({ src, file: fileOrig })

    if (isBuild || options.cache !== false) {
      const cached = cache.get(cacheKey)
      if (cached) {
        debug(`[cache hit] ${relativePath}`)
        return cached // 如果缓存中已有结果，直接返回缓存的内容
      }
    }

    const start = Date.now()

    // resolve params for dynamic routes 动态路由参数解析
    let params
    // 如果 Markdown 源码中包含动态路由参数（通过 __VP_PARAMS_START 和 __VP_PARAMS_END__ 包裹的 JSON 字符串），则提取并解析这些参数
    src = src.replace(
      /^__VP_PARAMS_START([^]+?)__VP_PARAMS_END__/,
      (_, paramsString) => {
        params = JSON.parse(paramsString)
        return ''
      }
    )

    // resolve includes 使用 processIncludes 解析 Markdown 中的 include 文件，并记录所有 include 的路径，以便后续进行文件监听
    let includes: string[] = []
    src = processIncludes(srcDir, src, fileOrig, includes)

    // 根据文件路径和站点配置中的 locale 信息获取文件的本地化索引（例如多语言支持）
    const localeIndex = getLocaleForPath(siteConfig?.site, relativePath)

    // reset env before render
    const env: MarkdownEnv = {
      path: file,
      relativePath,
      cleanUrls,
      includes,
      realPath: fileOrig,
      localeIndex
    }
    // 使用 Markdown 渲染器（md.render）将 Markdown 内容（src）转为 HTML。
    // env 包含了环境信息，如路径、前端配置、文件包含等，作为渲染时的上下文。
    const html = md.render(src, env)
    const {
      frontmatter = {},
      headers = [],
      links = [],
      sfcBlocks,
      title = ''
    } = env

    // validate data.links 检查死链
    const deadLinks: MarkdownCompileResult['deadLinks'] = []
    const recordDeadLink = (url: string) => {
      deadLinks.push({ url, file: path.relative(srcDir, fileOrig) })
    }

    function shouldIgnoreDeadLink(url: string) {
      if (!siteConfig?.ignoreDeadLinks) {
        return false
      }
      if (siteConfig.ignoreDeadLinks === true) {
        return true
      }
      if (siteConfig.ignoreDeadLinks === 'localhostLinks') {
        return url.replace(EXTERNAL_URL_RE, '').startsWith('//localhost')
      }

      return siteConfig.ignoreDeadLinks.some((ignore) => {
        if (typeof ignore === 'string') {
          return url === ignore
        }
        if (ignore instanceof RegExp) {
          return ignore.test(url)
        }
        if (typeof ignore === 'function') {
          return ignore(url)
        }
        return false
      })
    }

    if (links) {
      const dir = path.dirname(file)
      for (let url of links) {
        const { pathname } = new URL(url, 'http://a.com')
        if (!treatAsHtml(pathname)) continue

        url = url.replace(/[?#].*$/, '').replace(/\.(html|md)$/, '')
        if (url.endsWith('/')) url += `index`
        let resolved = decodeURIComponent(
          slash(
            url.startsWith('/')
              ? url.slice(1)
              : path.relative(srcDir, path.resolve(dir, url))
          )
        )
        resolved =
          siteConfig?.rewrites.inv[resolved + '.md']?.slice(0, -3) || resolved
        // 进一步检查死链接
        if (
          !pages.includes(resolved) &&
          !fs.existsSync(path.resolve(dir, publicDir, `${resolved}.html`)) &&
          !shouldIgnoreDeadLink(url)
        ) {
          recordDeadLink(url)
        }
      }
    }

    // 页面数据构建，包含页面的元数据，如标题、描述、前置数据等
    let pageData: PageData = {
      title: inferTitle(md, frontmatter, title),
      titleTemplate: frontmatter.titleTemplate as any,
      description: inferDescription(frontmatter),
      frontmatter,
      headers,
      params,
      relativePath,
      filePath: slash(path.relative(srcDir, fileOrig))
    }

    if (includeLastUpdatedData) { // 如果配置项要求，获取页面的最后更新时间（通过 Git 提交时间）
      pageData.lastUpdated = await getGitTimestamp(fileOrig)
    }

    // 如果 siteConfig.transformPageData 存在，则调用该函数来允许用户自定义页面数据处理
    if (siteConfig?.transformPageData) {
      const dataToMerge = await siteConfig.transformPageData(pageData, {
        siteConfig
      })
      if (dataToMerge) {
        pageData = {
          ...pageData,
          ...dataToMerge
        }
      }
    }

    // 生成 Vue 组件代码
    // * 最终将渲染的 HTML 代码和页面数据注入到 Vue 的模板中，形成 Vue 组件的源代码
    // * 如果 Markdown 文件中包含 script、style 或 customBlock，这些内容也会被加入到最终的 Vue 文件中
    const vueSrc = [
      ...injectPageDataCode(
        sfcBlocks?.scripts.map((item) => item.content) ?? [],
        pageData
      ),
      `<template><div>${html}</div></template>`, // 组件模板内容为 md 文件渲染内容
      ...(sfcBlocks?.styles.map((item) => item.content) ?? []),
      ...(sfcBlocks?.customBlocks.map((item) => item.content) ?? [])
    ].join('\n')

    debug(`[render] ${file} in ${Date.now() - start}ms.`)

    const result = {
      vueSrc,
      pageData,
      deadLinks,
      includes
    }
    // 渲染结果会被缓存，避免重复计算，提升性能。缓存键是 cacheKey，其值由文件路径和源代码生成
    if (isBuild || options.cache !== false) {
      cache.set(cacheKey, result)
    }
    return result
  }
}

// 这些正则表达式用于匹配和提取 Vue 单文件组件（SFC）中的 <script> 标签以及一些常见的 JavaScript 导出模式
const scriptRE = /<\/script>/
// 检查 lang 属性是否等于 ts，即 TypeScript
const scriptLangTsRE = /<\s*script[^>]*\blang=['"]ts['"][^>]*/
// 这个正则表达式用于匹配 <script> 标签中包含 setup 属性的标签，通常用于 Vue 3 的 <script setup> 语法
const scriptSetupRE = /<\s*script[^>]*\bsetup\b[^>]*/
// 这个正则表达式用于匹配 <script> 标签中包含 client 属性的标签。通常这种标签在特定的客户端环境中执行，可能是为了区分服务器端和客户端代码
const scriptClientRE = /<\s*script[^>]*\bclient\b[^>]*/
// 这个正则表达式用于匹配 JavaScript 中的默认导出语句 export default
const defaultExportRE = /((?:^|\n|;)\s*)export(\s*)default/
// 这个正则表达式用于匹配具名的默认导出语句 export { ... } as default，例如 export { myComponent } as default
const namedDefaultExportRE = /((?:^|\n|;)\s*)export(.+)as(\s*)default/

/**
 * 将页面的元数据（如标题、描述等）注入到 Vue 组件中的 <script> 标签里，特别是对于从 Markdown 文件转换成 Vue 组件的情况。
 * 它确保将包含页面信息的代码正确插入到 Vue 组件的 <script> 部分，并保证结构正确
 * @param tags
 * @param data
 */
function injectPageDataCode(tags: string[], data: PageData) {
  // data 对象包含了页面的元数据（如 title、description 等），首先将其序列化成 JSON 字符串，并在外面再包一层 JSON.parse，确保可以在页面中动态获取
  const code = `\nexport const __pageData = JSON.parse(${JSON.stringify(
    JSON.stringify(data)
  )})`

  // 步骤 1：检查是否存在 <script> 标签
  const existingScriptIndex = tags.findIndex((tag) => {
    // 该代码会查找 tags 数组（它代表了 Vue 组件的不同部分）中是否存在普通的 <script> 标签。它检查是否匹配 scriptRE，并且不匹配 scriptSetupRE 和 scriptClientRE（即排除 <script setup> 和 <script client> 标签）
    return (
      scriptRE.test(tag) &&
      !scriptSetupRE.test(tag) &&
      !scriptClientRE.test(tag)
    )
  })

  // 步骤 2：检查 <script> 标签是否使用了 TypeScript
  const isUsingTS = tags.findIndex((tag) => scriptLangTsRE.test(tag)) > -1

  // 步骤 3：修改现有的 <script> 标签或创建一个新的标签
  if (existingScriptIndex > -1) {
    const tagSrc = tags[existingScriptIndex]
    // user has <script> tag inside markdown
    // if it doesn't have export default it will error out on build
    const hasDefaultExport =
      defaultExportRE.test(tagSrc) || namedDefaultExportRE.test(tagSrc)
    // 在现有的 <script> 标签中添加 __pageData 的声明
    // 如果原本的 <script> 标签没有默认导出（没有 export default），则会添加一个 export default { name: "路径" }，表示该页面的名称是该路径
    tags[existingScriptIndex] = tagSrc.replace(
      scriptRE,
      code +
        (hasDefaultExport
          ? `` // 如果已有默认导出，则不再添加
          : `\nexport default {name:${JSON.stringify(data.relativePath)}}`) +
        `</script>`
    )
  } else { // 如果没有找到现有的 <script> 标签，则会在 tags 数组的开头插入一个新的 <script> 标签
    tags.unshift(
      `<script ${
        isUsingTS ? 'lang="ts"' : ''
      }>${code}\nexport default {name:${JSON.stringify(
        data.relativePath
      )}}</script>`
    )
  }

  return tags
}

/**
 * 根据 Markdown 渲染器 md 和页面的 frontmatter 来推断或生成页面的标题。
 * 如果 frontmatter 中定义了 title 字段，则该函数会优先使用该字段的内容作为页面标题。如果没有定义 title，则返回传入的默认 title
 * @param md
 * @param frontmatter
 * @param title
 */
const inferTitle = (
  md: MarkdownRenderer,
  frontmatter: Record<string, any>,
  title: string
) => {
  // 这行代码检查 frontmatter 中是否存在 title 字段，且其值是否是一个字符串。如果是字符串，接下来会进行解析
  if (typeof frontmatter.title === 'string') {
    // 如果 frontmatter.title 是一个字符串，md.parseInline 会被用来将这个字符串解析为 Markdown 内联内容。
    // parseInline 是 Markdown 渲染器的方法，它将字符串解析为一组标记（tokens）。在这里，它被用来解析标题字符串。
    const titleToken = md.parseInline(frontmatter.title, {})[0]
    if (titleToken) {
      // resolveTitleFromToken 会根据这些选项来决定如何处理 titleToken，并返回最终的标题
      return resolveTitleFromToken(titleToken, {
        shouldAllowHtml: false, // 不允许在标题中包含 HTML 标签
        shouldEscapeText: false // 不转义文本字符
      })
    }
  }
  return title
}

/**
 * 从 frontmatter 中获取描述信息（description），如果没有定义描述，则尝试从 head 元素中获取描述信息
 * @param frontmatter
 */
const inferDescription = (frontmatter: Record<string, any>) => {
  const { description, head } = frontmatter

  if (description !== undefined) {
    return description
  }

  // 如果 head 存在，调用 getHeadMetaContent(head, 'description') 来获取 head 中的 <meta name="description" content="..."> 标签的 content 属性值作为描述
  return (head && getHeadMetaContent(head, 'description')) || ''
}

/**
 * 从给定的 head 配置中查找具有特定 name 属性的 <meta> 标签，并返回其 content 属性的值
 * @param head
 * @param name
 */
const getHeadMetaContent = (
  head: HeadConfig[],
  name: string
): string | undefined => {
  // 如果 head 为 null 或 undefined，或者 head 数组为空，则返回 undefined
  if (!head || !head.length) {
    return undefined
  }

  const meta = head.find(([tag, attrs = {}]) => {
    return tag === 'meta' && attrs.name === name && attrs.content
  })

  // 如果 meta 不为 undefined（即找到了符合条件的 <meta> 标签），则返回该标签的 content 属性值（通过 meta[1].content 获取）
  return meta && meta[1].content
}
