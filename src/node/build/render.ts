import { isBooleanAttr } from '@vue/shared'
import escape from 'escape-html'
import fs from 'fs-extra'
import path from 'path'
import { pathToFileURL } from 'url'
import { normalizePath, transformWithEsbuild, type Rollup } from 'vite'
import type { SiteConfig } from '../config'
import {
  EXTERNAL_URL_RE,
  createTitle,
  mergeHead,
  notFoundPageData,
  resolveSiteDataByRoute,
  sanitizeFileName,
  slash,
  type HeadConfig,
  type PageData,
  type SSGContext
} from '../shared'
import { version } from '../../../package.json'

/**
 * 用于渲染页面的函数，主要用于构建一个 HTML 页面，包含所有必要的资源（如样式表、脚本、元数据等），并将最终的 HTML 输出到文件系统中
 * @param render 一个异步函数，用于渲染页面，返回一个包含页面内容的上下文（SSGContext）
 * @param config 站点配置对象，包含关于站点、资源、构建等的配置
 * @param page 页面的路径（例如：foo.md）
 * @param result Rollup 构建的结果，用于包含页面的 JavaScript 资源
 * @param appChunk 应用的 JavaScript chunk，用于包含所有页面共享的 JavaScript 代码
 * @param cssChunk CSS chunk，用于包含页面的样式表
 * @param assets 页面所需的其他静态资源文件
 * @param pageToHashMap 页面名称到哈希值的映射，用于动态加载客户端资源
 * @param metadataScript 包含页面元数据的脚本，用于动态注入 HTML
 * @param additionalHeadTags 附加的 <head> 标签配置
 */
export async function renderPage(
  render: (path: string) => Promise<SSGContext>,
  config: SiteConfig,
  page: string, // foo.md
  result: Rollup.RollupOutput | null,
  appChunk: Rollup.OutputChunk | null,
  cssChunk: Rollup.OutputAsset | null,
  assets: string[],
  pageToHashMap: Record<string, string>,
  metadataScript: { html: string; inHead: boolean },
  additionalHeadTags: HeadConfig[]
) {
  // 1 构建页面路径和站点数据
  // 通过将页面文件路径（例如 foo.md）转换为路由路径，确定页面应该展示的内容
  const routePath = `/${page.replace(/\.md$/, '')}`
  // 使用 resolveSiteDataByRoute 函数根据路由获取站点数据
  const siteData = resolveSiteDataByRoute(config.site, routePath)

  // 2 渲染页面内容
  // 调用 render 函数获取页面内容并根据配置调用 postRender 处理页面内容（例如：通过插件处理页面内容或对其进行修改）
  const context = await render(routePath)
  // 通过构建 pageData 获取页面的相关数据，处理可能的错误，例如页面是 404.md，则使用默认的 404 页面数据
  const { content, teleports } = (await config.postRender?.(context)) ?? context

  const pageName = sanitizeFileName(page.replace(/\//g, '_'))
  // server build doesn't need hash
  const pageServerJsFileName = pageName + '.js'
  // for any initial page load, we only need the lean version of the page js
  // since the static content is already on the page!
  const pageHash = pageToHashMap[pageName.toLowerCase()]
  const pageClientJsFileName = `${config.assetsDir}/${pageName}.${pageHash}.lean.js`

  let pageData: PageData
  let hasCustom404 = true

  try {
    // resolve page data so we can render head tags
    const { __pageData } = await import(
      pathToFileURL(
        path.join(config.tempDir, pageServerJsFileName)
      ).toString() +
        '?t=' +
        Date.now()
    )
    pageData = __pageData
  } catch (e) {
    if (page === '404.md') {
      hasCustom404 = false
      pageData = notFoundPageData
    } else {
      throw e
    }
  }

  // 根据站点和页面数据，构建页面的 <title>
  const title: string = createTitle(siteData, pageData)
  // 构建页面的 <meta name="description"> 标签
  const description: string = pageData.description || siteData.description
  const stylesheetLink = cssChunk
    ? `<link rel="preload stylesheet" href="${siteData.base}${cssChunk.fileName}" as="style">`
    : ''

  let preloadLinks =
    config.mpa || (!hasCustom404 && page === '404.md')
      ? []
      : result && appChunk
        ? [
            ...new Set([
              // resolve imports for index.js + page.md.js and inject script tags
              // for them as well so we fetch everything as early as possible
              // without having to wait for entry chunks to parse
              ...resolvePageImports(config, page, result, appChunk),
              pageClientJsFileName
            ])
          ]
        : []

  let prefetchLinks: string[] = []

  // 根据是否需要预加载资源，调整哪些资源应当预加载
  const { shouldPreload } = config
  if (shouldPreload) {
    prefetchLinks = preloadLinks.filter((link) => !shouldPreload(link, page))
    preloadLinks = preloadLinks.filter((link) => shouldPreload(link, page))
  }

  // 通过 toHeadTags 转换为 <link> 标签
  const toHeadTags = (files: string[], rel: string): HeadConfig[] =>
    files.map((file) => [
      'link',
      {
        rel,
        // don't add base to external urls
        href: (EXTERNAL_URL_RE.test(file) ? '' : siteData.base) + file
      }
    ])

  const preloadHeadTags = toHeadTags(preloadLinks, 'modulepreload')
  const prefetchHeadTags = toHeadTags(prefetchLinks, 'prefetch')

  const headBeforeTransform = [
    ...additionalHeadTags,
    ...preloadHeadTags,
    ...prefetchHeadTags,
    ...mergeHead(
      siteData.head,
      filterOutHeadDescription(pageData.frontmatter.head)
    )
  ]

  // 将页面的 <head> 标签与附加的标签（additionalHeadTags）合并，使用 mergeHead 进行处理，同时根据配置和插件的 transformHead 函数进行定制
  const head = mergeHead(
    headBeforeTransform,
    (await config.transformHead?.({
      page,
      siteConfig: config,
      siteData,
      pageData,
      title,
      description,
      head: headBeforeTransform,
      content,
      assets
    })) || []
  )

  // 在构建中，如果 MPA 模式并且有 appChunk，则尝试查找并内联 JavaScript 代码，减少客户端的加载时间
  let inlinedScript = ''
  if (config.mpa && result) {
    const matchingChunk = result.output.find(
      (chunk) =>
        chunk.type === 'chunk' &&
        chunk.facadeModuleId === slash(path.join(config.srcDir, page))
    ) as Rollup.OutputChunk
    if (matchingChunk) {
      if (!matchingChunk.code.includes('import')) {
        inlinedScript = `<script type="module">${matchingChunk.code}</script>`
        fs.removeSync(path.resolve(config.outDir, matchingChunk.fileName))
      } else {
        inlinedScript = `<script type="module" src="${siteData.base}${matchingChunk.fileName}"></script>`
      }
    }
  }

  const dir = pageData.frontmatter.dir || siteData.dir || 'ltr'

  const html = `<!DOCTYPE html>
<html lang="${siteData.lang}" dir="${dir}">
  <head>
    <meta charset="utf-8">
    ${
      isMetaViewportOverridden(head)
        ? ''
        : '<meta name="viewport" content="width=device-width,initial-scale=1">'
    }
    <title>${title}</title>
    ${
      isDescriptionOverridden(head)
        ? ''
        : `<meta name="description" content="${description}">`
    }
    <meta name="generator" content="VitePress v${version}">
    ${stylesheetLink}
    ${metadataScript.inHead ? metadataScript.html : ''}
    ${
      appChunk
        ? `<script type="module" src="${siteData.base}${appChunk.fileName}"></script>`
        : ''
    }
    ${await renderHead(head)}
  </head>
  <body>${teleports?.body || ''}
    <div id="app">${page === '404.md' ? '' : content}</div>
    ${metadataScript.inHead ? '' : metadataScript.html}
    ${inlinedScript}
  </body>
</html>`

  const htmlFileName = path.join(config.outDir, page.replace(/\.md$/, '.html'))
  await fs.ensureDir(path.dirname(htmlFileName))
  // 使用 transformHtml 插件函数允许进一步修改生成的 HTML
  const transformedHtml = await config.transformHtml?.(html, htmlFileName, {
    page,
    siteConfig: config,
    siteData,
    pageData,
    title,
    description,
    head,
    content,
    assets
  })
  await fs.writeFile(htmlFileName, transformedHtml || html)
}

/**
 * 解析一个页面的 JavaScript 导入（imports），并将与该页面相关的所有依赖项（包括静态和动态导入）返回。
 * 它主要是在构建过程中，通过查找页面对应的 JS chunk，确定需要加载的资源。
 *
 * 这段代码的主要目的是为页面解析和收集相关的所有导入（包括静态和动态导入），确保在页面渲染时能够尽早开始加载这些资源，优化页面的加载速度
 * @param config 配置对象，包含有关项目结构、页面路径、主题等的信息
 * @param page 当前页面的路径，可能是经过重写（rewrite）规则处理过的路径
 * @param result Rollup 构建后的输出结果，包含所有 chunk 的信息
 * @param appChunk 应用程序的入口 chunk，包含应用的基础代码
 */
function resolvePageImports(
  config: SiteConfig,
  page: string,
  result: Rollup.RollupOutput,
  appChunk: Rollup.OutputChunk
) {
  // 根据 config.rewrites.inv 对象（反向重写规则），查找是否有对应的重写规则，将页面路径 page 重写为新的路径。若没有重写规则，保持原路径不变
  page = config.rewrites.inv[page] || page
  // find the page's js chunk and inject script tags for its imports so that
  // they start fetching as early as possible
  // 使用 path.resolve 将页面路径与项目的源代码目录 config.srcDir 拼接，得到页面的绝对路径
  let srcPath = path.resolve(config.srcDir, page)
  // 如果 config.vite.resolve.preserveSymlinks 没有设置，尝试解析页面路径的符号链接（symlink），返回实际的文件路径。
  // 否则，如果路径是虚拟生成的（例如动态路由），则会抛出异常，但这个异常是可以接受的
  try {
    if (!config.vite?.resolve?.preserveSymlinks) {
      srcPath = fs.realpathSync(srcPath)
    }
  } catch (e) {
    // if the page is a virtual page generated by a dynamic route this would
    // fail, which is expected
  }
  // 将页面路径标准化（通常用于保证不同操作系统之间的路径一致性，确保路径分隔符统一）
  srcPath = normalizePath(srcPath)
  // 查找页面对应的 Chunk
  const pageChunk = result.output.find(
    (chunk) => chunk.type === 'chunk' && chunk.facadeModuleId === srcPath
  ) as Rollup.OutputChunk
  // 返回页面相关的所有导入
  return [
    ...appChunk.imports,
    ...appChunk.dynamicImports,
    ...pageChunk.imports,
    ...pageChunk.dynamicImports
  ]
}

/**
 * 渲染页面的 <head> 部分，将 head 配置（一个包含标签和属性的数组）转换为 HTML 字符串。
 * 代码会根据不同的标签类型（如 <script>, <link>, <meta> 等）渲染相应的标签，并根据需要进行内联脚本的压缩处理。
 * @param head 这是一个数组，包含了要渲染的所有标签和标签的属性及内容。每个元素是一个元组，格式为 [tag, attrs, innerHTML]
 */
async function renderHead(head: HeadConfig[]): Promise<string> {
  // 渲染标签和属性
  const tags = await Promise.all(
      // head.map 遍历每个标签配置，将每个标签的属性和内容渲染成对应的 HTML 标签。renderAttrs(attrs) 用于将属性对象转换为 HTML 属性字符串。openTag 是打开标签部分。
    head.map(async ([tag, attrs = {}, innerHTML = '']) => {
      const openTag = `<${tag}${renderAttrs(attrs)}>`
      // 对不同类型的标签处理
      if (tag !== 'link' && tag !== 'meta') { // 对于 <script> 标签，会压缩其内容
        if (
          tag === 'script' &&
          (attrs.type === undefined || attrs.type.includes('javascript'))
        ) {
          innerHTML = (
            await transformWithEsbuild(innerHTML, 'inline-script.js', {
              minify: true
            })
          ).code.trim()
        }
        return `${openTag}${innerHTML}</${tag}>`
      } else {
        return openTag // 对于 <link> 和 <meta> 标签，只渲染其开始标签
      }
    })
  )
  // 最后，tags.join('\n ') 将所有渲染的标签合并为一个字符串，使用换行符和空格缩进，以便格式化输出
  return tags.join('\n    ')
}

/**
 * 将一个包含 HTML 属性的对象转换为符合 HTML 标准的属性字符串
 * @param attrs 这是一个对象，表示 HTML 标签的属性，属性名是键，属性值是值。例如，{ src: "image.jpg", alt: "description" }
 */
function renderAttrs(attrs: Record<string, string>): string {
  // 使用 Object.keys(attrs) 获取 attrs 对象的所有属性名（即标签的各个属性，如 src, alt）,然后根据属性的类型生成不同的 HTML 字符串
  return Object.keys(attrs)
    .map((key) => {
      // 如果是布尔属性（例如 disabled，checked 等）：会直接返回 key，即只使用属性名而不需要 = 和属性值。
      // 例如，disabled 属性的输出将是 disabled（这是符合 HTML 规范的写法）。
      if (isBooleanAttr(key)) return ` ${key}`
      // 如果是其他属性：会生成 key="value" 的格式，其中 value 是 attrs[key] 的值，且会经过 escape 函数处理，
      // 确保值中的特殊字符（如 "、<、> 等）能够正确转义，以避免 HTML 注入攻击。
      return ` ${key}="${escape(attrs[key] as string)}"`
    })
    .join('') // 将处理后的每个属性字符串用空字符串连接起来，最终返回一个包含所有属性的 HTML 属性字符串。
}

/**
 * 过滤掉 HTML <head> 中的描述性元标签（<meta name="description">）。
 * 具体来说，它会检查每个 <meta> 标签，如果 name="description"，则将其从 head 配置中移除
 * @param head
 */
function filterOutHeadDescription(head: HeadConfig[] = []) {
  return head.filter(([type, attrs]) => {
    return !(type === 'meta' && attrs?.name === 'description')
  })
}

/**
 * 检查在 head 配置中是否已经存在一个 <meta name="description"> 标签。如果存在，它会返回 true，表示描述已经被覆盖；如果不存在，返回 false
 * @param head
 */
function isDescriptionOverridden(head: HeadConfig[] = []) {
  return head.some(([type, attrs]) => {
    return type === 'meta' && attrs?.name === 'description'
  })
}

/**
 * 功能与之前的 isDescriptionOverridden 类似，不同的是它检查的是 <meta name="viewport"> 标签是否存在于 head 配置中。
 * 具体来说，检查 head 中是否有一个 <meta> 标签，其 name 属性为 'viewport'
 * @param head
 */
function isMetaViewportOverridden(head: HeadConfig[] = []) {
  return head.some(([type, attrs]) => {
    return type === 'meta' && attrs?.name === 'viewport'
  })
}
