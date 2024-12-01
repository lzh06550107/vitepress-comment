import {
  componentPlugin,
  type ComponentPluginOptions
} from '@mdit-vue/plugin-component'
import {
  frontmatterPlugin,
  type FrontmatterPluginOptions
} from '@mdit-vue/plugin-frontmatter'
import {
  headersPlugin,
  type HeadersPluginOptions
} from '@mdit-vue/plugin-headers'
import { sfcPlugin, type SfcPluginOptions } from '@mdit-vue/plugin-sfc'
import { titlePlugin } from '@mdit-vue/plugin-title'
import { tocPlugin, type TocPluginOptions } from '@mdit-vue/plugin-toc'
import { slugify } from '@mdit-vue/shared'
import type { Options } from 'markdown-it'
import MarkdownIt from 'markdown-it'
import anchorPlugin from 'markdown-it-anchor'
import attrsPlugin from 'markdown-it-attrs'
import { full as emojiPlugin } from 'markdown-it-emoji'
import type {
  BuiltinTheme,
  Highlighter,
  LanguageInput,
  ShikiTransformer,
  ThemeRegistrationAny
} from 'shiki'
import type { Logger } from 'vite'
import { containerPlugin, type ContainerOptions } from './plugins/containers'
import { gitHubAlertsPlugin } from './plugins/githubAlerts'
import { highlight } from './plugins/highlight'
import { highlightLinePlugin } from './plugins/highlightLines'
import { imagePlugin, type Options as ImageOptions } from './plugins/image'
import { lineNumberPlugin } from './plugins/lineNumbers'
import { linkPlugin } from './plugins/link'
import { preWrapperPlugin } from './plugins/preWrapper'
import { restoreEntities } from './plugins/restoreEntities'
import { snippetPlugin } from './plugins/snippet'

export type { Header } from '../shared'

export type ThemeOptions =
  | ThemeRegistrationAny
  | BuiltinTheme
  | {
      light: ThemeRegistrationAny | BuiltinTheme
      dark: ThemeRegistrationAny | BuiltinTheme
    }

export interface MarkdownOptions extends Options {
  /* ==================== General Options ==================== */

  /**
   * Setup markdown-it instance before applying plugins
   */
  preConfig?: (md: MarkdownIt) => void
  /**
   * Setup markdown-it instance
   */
  config?: (md: MarkdownIt) => void
  /**
   * Disable cache (experimental)
   */
  cache?: boolean
  externalLinks?: Record<string, string>

  /* ==================== Syntax Highlighting ==================== */

  /**
   * Custom theme for syntax highlighting.
   *
   * You can also pass an object with `light` and `dark` themes to support dual themes.
   *
   * @example { theme: 'github-dark' }
   * @example { theme: { light: 'github-light', dark: 'github-dark' } }
   *
   * You can use an existing theme.
   * @see https://shiki.style/themes
   * Or add your own theme.
   * @see https://shiki.style/guide/load-theme
   */
  theme?: ThemeOptions
  /**
   * Languages for syntax highlighting.
   * @see https://shiki.style/languages
   */
  languages?: LanguageInput[]
  /**
   * Custom language aliases.
   *
   * @example { 'my-lang': 'js' }
   * @see https://shiki.style/guide/load-lang#custom-language-aliases
   */
  languageAlias?: Record<string, string>
  /**
   * Show line numbers in code blocks
   * @default false
   */
  lineNumbers?: boolean
  /**
   * Fallback language when the specified language is not available.
   */
  defaultHighlightLang?: string
  /**
   * Transformers applied to code blocks
   * @see https://shiki.style/guide/transformers
   */
  codeTransformers?: ShikiTransformer[]
  /**
   * Setup Shiki instance
   */
  shikiSetup?: (shiki: Highlighter) => void | Promise<void>
  /**
   * The tooltip text for the copy button in code blocks
   * @default 'Copy Code'
   */
  codeCopyButtonTitle?: string

  /* ==================== Markdown It Plugins ==================== */

  /**
   * Options for `markdown-it-anchor`
   * @see https://github.com/valeriangalliat/markdown-it-anchor
   */
  anchor?: anchorPlugin.AnchorOptions
  /**
   * Options for `markdown-it-attrs`
   * @see https://github.com/arve0/markdown-it-attrs
   */
  attrs?: {
    leftDelimiter?: string
    rightDelimiter?: string
    allowedAttributes?: Array<string | RegExp>
    disable?: boolean
  }
  /**
   * Options for `markdown-it-emoji`
   * @see https://github.com/markdown-it/markdown-it-emoji
   */
  emoji?: {
    defs?: Record<string, string>
    enabled?: string[]
    shortcuts?: Record<string, string | string[]>
  }
  /**
   * Options for `@mdit-vue/plugin-frontmatter`
   * @see https://github.com/mdit-vue/mdit-vue/tree/main/packages/plugin-frontmatter
   */
  frontmatter?: FrontmatterPluginOptions
  /**
   * Options for `@mdit-vue/plugin-headers`
   * @see https://github.com/mdit-vue/mdit-vue/tree/main/packages/plugin-headers
   */
  headers?: HeadersPluginOptions | boolean
  /**
   * Options for `@mdit-vue/plugin-sfc`
   * @see https://github.com/mdit-vue/mdit-vue/tree/main/packages/plugin-sfc
   */
  sfc?: SfcPluginOptions
  /**
   * Options for `@mdit-vue/plugin-toc`
   * @see https://github.com/mdit-vue/mdit-vue/tree/main/packages/plugin-toc
   */
  toc?: TocPluginOptions
  /**
   * Options for `@mdit-vue/plugin-component`
   * @see https://github.com/mdit-vue/mdit-vue/tree/main/packages/plugin-component
   */
  component?: ComponentPluginOptions
  /**
   * Options for `markdown-it-container`
   * @see https://github.com/markdown-it/markdown-it-container
   */
  container?: ContainerOptions
  /**
   * Math support (experimental)
   *
   * You need to install `markdown-it-mathjax3` and set `math` to `true` to enable it.
   * You can also pass options to `markdown-it-mathjax3` here.
   * @default false
   * @see https://vitepress.dev/guide/markdown#math-equations
   */
  math?: boolean | any
  image?: ImageOptions
  /**
   * Allows disabling the github alerts plugin
   * @default true
   * @see https://vitepress.dev/guide/markdown#github-flavored-alerts
   */
  gfmAlerts?: boolean
}

export type MarkdownRenderer = MarkdownIt

/**
 * 创建一个自定义的 Markdown 渲染器，带有丰富的插件和配置选项，包括代码高亮、组件、链接、图像处理、数学公式、表情符号等。
 * @param srcDir 源目录，通常是存放 Markdown 文件的文件夹路径
 * @param options 可选的配置对象，允许用户自定义渲染器的行为和插件
 * @param base 基础 URL，通常用于处理相对链接。默认为 '/'
 * @param logger 日志记录器，默认使用 console.warn
 */
export const createMarkdownRenderer = async (
  srcDir: string,
  options: MarkdownOptions = {},
  base = '/',
  logger: Pick<Logger, 'warn'> = console
): Promise<MarkdownRenderer> => {
  const theme = options.theme ?? { light: 'github-light', dark: 'github-dark' }
  const codeCopyButtonTitle = options.codeCopyButtonTitle || 'Copy Code'
  const hasSingleTheme = typeof theme === 'string' || 'name' in theme

  // 初始化 MarkdownIt
  const md = MarkdownIt({
    html: true, // 启用 HTML 支持
    linkify: true, // 自动转换 URL 成为链接
    // 设置代码高亮，支持自定义的高亮函数或使用默认的高亮
    highlight: options.highlight || (await highlight(theme, options, logger)),
    ...options // 通过 ...options 将用户传入的配置合并到 MarkdownIt 实例中
  })

  // 禁用模糊链接（Fuzzy Links）
  // linkify 插件用于将文本中的 URL 自动转换为可点击的链接
  // fuzzyLink: false 禁用模糊链接匹配。默认情况下，linkify 会尽可能宽松地匹配可能的 URL，允许某些不完整的链接（比如缺少协议的链接）被认为是有效的链接。
  // 设置 fuzzyLink: false 后，只有严格符合 URL 规范的文本才会被转换为链接。这意味着类似 www.example.com 这样的文本不会自动变成链接，除非它以 http:// 或 https:// 开头
  md.linkify.set({ fuzzyLink: false })
  // 这个插件通常用于处理某些 HTML 实体或字符在解析过程中可能被错误解读的问题
  md.use(restoreEntities)

  // 自定义的预配置函数
  if (options.preConfig) {
    // 这种方式允许开发者在创建渲染器时，进行一些额外的定制化设置，通常用于一些低层次的配置调整，或者需要在 Markdown 渲染器加载其他插件之前完成的设置
    options.preConfig(md)
  }

  // custom plugins
  md.use(componentPlugin, { ...options.component }) // 用于解析 Markdown 中的组件（比如 Vue 组件）
    .use(highlightLinePlugin) // 高亮显示特定行的代码
    .use(preWrapperPlugin, { codeCopyButtonTitle, hasSingleTheme }) // 为代码块添加复制按钮，并处理代码块的显示
    .use(snippetPlugin, srcDir) // 处理代码片段的插件
    .use(containerPlugin, { hasSingleTheme }, options.container) // 支持容器类型的自定义 Markdown
    .use(imagePlugin, options.image) // 图像处理插件，可能用于调整图像的大小、格式等
    .use(
      linkPlugin, // 处理链接，默认会将外部链接设置为 target="_blank" 和 rel="noreferrer"
      { target: '_blank', rel: 'noreferrer', ...options.externalLinks },
      base
    )
    .use(lineNumberPlugin, options.lineNumbers) // 为代码块添加行号

  if (options.gfmAlerts !== false) {
    md.use(gitHubAlertsPlugin) // 提供 GitHub 风格的警告消息支持
  }

  // third party plugins
  if (!options.attrs?.disable) {
    md.use(attrsPlugin, options.attrs) // 用于处理 HTML 属性
  }
  md.use(emojiPlugin, { ...options.emoji }) // 启用表情符号解析

  // mdit-vue plugins
  md.use(anchorPlugin, { // 处理锚点链接，为标题生成可点击的链接
    slugify,
    permalink: anchorPlugin.permalink.linkInsideHeader({
      symbol: '&ZeroWidthSpace;',
      renderAttrs: (slug, state) => {
        // Find `heading_open` with the id identical to slug
        const idx = state.tokens.findIndex((token) => {
          const attrs = token.attrs
          const id = attrs?.find((attr) => attr[0] === 'id')
          return id && slug === id[1]
        })
        // Get the actual heading content
        const title = state.tokens[idx + 1].content
        return {
          'aria-label': `Permalink to "${title}"`
        }
      }
    }),
    ...options.anchor
  } as anchorPlugin.AnchorOptions).use(frontmatterPlugin, { // 用于解析 frontmatter（通常用于 Markdown 文件的元数据）
    ...options.frontmatter
  } as FrontmatterPluginOptions)

  if (options.headers) {
    md.use(headersPlugin, { // 处理标题，支持配置标题的级别
      level: [2, 3, 4, 5, 6],
      slugify,
      ...(typeof options.headers === 'boolean' ? undefined : options.headers)
    } as HeadersPluginOptions)
  }

  md.use(sfcPlugin, { // 处理 Vue 单文件组件（SFC）
    ...options.sfc
  } as SfcPluginOptions)
    .use(titlePlugin) // 设置页面标题
    .use(tocPlugin, { // 生成目录
      ...options.toc
    } as TocPluginOptions)

  if (options.math) { // 支持 Markdown 中的数学公式渲染。通过动态导入 markdown-it-mathjax3 插件
    try {
      const mathPlugin = await import('markdown-it-mathjax3')
      md.use(mathPlugin.default ?? mathPlugin, {
        ...(typeof options.math === 'boolean' ? {} : options.math)
      })
    } catch (error) {
      throw new Error(
        'You need to install `markdown-it-mathjax3` to use math support.'
      )
    }
  }

  // apply user config 如果 options.config 存在，它会作为配置函数传递给 MarkdownIt 实例。这个函数可以用来进一步定制 Markdown 渲染器的行为
  if (options.config) {
    options.config(md)
  }

  return md
}
