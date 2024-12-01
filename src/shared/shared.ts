import type { HeadConfig, PageData, SiteData } from '../../types/shared'

export type {
  Awaitable,
  DefaultTheme,
  HeadConfig,
  Header,
  LocaleConfig,
  LocaleSpecificConfig,
  MarkdownEnv,
  PageData,
  PageDataPayload,
  SSGContext,
  SiteData
} from '../../types/shared'

// 这个正则表达式用于检查 URL 是否是外部链接（即以协议如 http://、https://、ftp:// 开头，或者以 // 开头的相对链接）
export const EXTERNAL_URL_RE = /^(?:[a-z]+:|\/\/)/i
// 这是一个常量，存储了键名 'vitepress-theme-appearance'。它可能用于 VitePress 项目中管理主题外观（例如：切换浅色/深色模式）
export const APPEARANCE_KEY = 'vitepress-theme-appearance'

// 这个正则表达式匹配 URL 中的 hash 部分，即 # 后面的内容（例如：#section1）
const HASH_RE = /#.*$/
// 这个正则表达式匹配 URL 中的 hash 或查询字符串部分，即 # 或 ? 后面的所有内容
const HASH_OR_QUERY_RE = /[?#].*$/
// 这个正则表达式用于匹配 URL 中的文件扩展名，可能是 index.md 或 index.html，也可能是以 .md 或 .html 结尾的文件
// 它还考虑到 index 可能位于 URL 的根路径或子路径下（例如：/index）
const INDEX_OR_EXT_RE = /(?:(^|\/)index)?\.(?:md|html)$/

// 这个常量用于判断当前代码是否在浏览器环境中运行。它通过检查 document 对象是否存在来进行判断（document 是浏览器中的内置对象，但在 Node.js 环境中是 undefined）
export const inBrowser = typeof document !== 'undefined'

// 这个对象表示一个 “404 Not Found” 页面的数据
export const notFoundPageData: PageData = {
  relativePath: '404.md', // 404 页面文件的相对路径，这里是 '404.md'，意味着页面内容可能存放在这个 Markdown 文件中
  filePath: '', // 404 页面文件的完整路径，这里为空字符串，可能在运行时动态设置
  title: '404', // 页面的标题，设置为 '404'
  description: 'Not Found', // 页面的描述，设置为 'Not Found'
  headers: [], // 一个空数组，可能用于存储该页面的标题或其他头部信息
  frontmatter: { sidebar: false, layout: 'page' }, // 页面的前置元数据对象，指定该页面不显示侧边栏（sidebar: false）且使用 'page' 布局
  lastUpdated: 0, // 页面的最后更新时间戳，设置为 0，可能表示未设置更新时间
  isNotFound: true // 一个布尔值，表示这是一个 “404 Not Found” 页面，设置为 true
}

/**
 * 用于判断当前路径是否与给定的路径匹配，支持正则表达式匹配、路径标准化、以及 hash 比较
 * @param currentPath 当前路径，作为输入用于比较的路径
 * @param matchPath 可选的匹配路径。如果未提供 matchPath，函数将返回 false
 * @param asRegex 如果为 true，则 matchPath 将被视为正则表达式，而非普通的路径字符串。默认为 false，表示 matchPath 是普通路径字符串
 */
export function isActive(
  currentPath: string,
  matchPath?: string,
  asRegex: boolean = false
): boolean {
  // 检查 matchPath 是否为 undefined
  if (matchPath === undefined) {
    return false
  }

  // 使用 normalize 函数对 currentPath 进行标准化（例如，确保路径以 / 开头）
  currentPath = normalize(`/${currentPath}`)

  // 如果 asRegex 为 true，将 matchPath 当作正则表达式来匹配 currentPath
  if (asRegex) {
    return new RegExp(matchPath).test(currentPath)
  }

  // 如果 asRegex 为 false，直接比较标准化后的 currentPath 和 matchPath。如果不相等，返回 false
  if (normalize(matchPath) !== currentPath) {
    return false
  }

  // 如果 matchPath 包含 hash 部分（通过 HASH_RE 匹配），则进一步判断当前 URL 的 hash 部分是否与 matchPath 的 hash 部分相等。这里使用 location.hash 来获取浏览器中的当前 hash（仅在浏览器中有效）
  const hashMatch = matchPath.match(HASH_RE)

  if (hashMatch) {
    return (inBrowser ? location.hash : '') === hashMatch[0]
  }

  return true
}

/**
 * 用于标准化路径。它的目的是将路径进行解码，并去除 URL 中的查询参数、哈希部分（hash），以及一些特定的扩展名处理
 * @param path
 */
function normalize(path: string): string {
  // 使用 decodeURI 解码 URL 中的编码字符。比如 %20 会被解码为空格。这个操作是为了确保路径中的任何 URL 编码部分（例如：空格、特殊字符）都被正确解码
  return decodeURI(path)
      // 使用正则表达式 HASH_OR_QUERY_RE 匹配并去除 URL 中的查询字符串（? 后的部分）和哈希部分（# 后的部分）
    .replace(HASH_OR_QUERY_RE, '')
      // 使用正则表达式 INDEX_OR_EXT_RE 来匹配路径中的 index.md 或 index.html 等文件
      // ($1) 是捕获组的第一个部分，代表路径中 index 前面的部分（如果有）。这一步操作的目的是去掉路径中的 index 部分，确保只留下文件的目录部分或文件名的其他部分
      // 例如，/docs/index.html 会被转换为 /docs/，/about/index.md 会被转换为 /about/
    .replace(INDEX_OR_EXT_RE, '$1')
}

/**
 * 用于判断给定的路径是否是外部链接
 * @param path 这是函数的输入参数，表示要检查的路径（URL）
 */
export function isExternal(path: string): boolean {
  // EXTERNAL_URL_RE 是一个正则表达式，用于匹配以协议（如 http://、https://、ftp:// 等）开头的 URL 或者以 // 开头的相对 URL
  // 如果 path 是外部链接（即符合正则表达式的格式），test() 返回 true
  // 如果 path 不是外部链接，返回 false
  return EXTERNAL_URL_RE.test(path)
}

/**
 * 用于根据给定的路径（relativePath）从 siteData 中确定相应的语言/地区（locale）
 * 函数通过检查网站的 locales 配置，匹配当前路径并返回匹配的语言/地区键
 * @param siteData 这是包含网站数据的对象，可能包含网站的语言配置（locales）和其他信息
 * @param relativePath 这是要检查的相对路径，函数会基于该路径来查找匹配的语言/地区
 */
export function getLocaleForPath(
  siteData: SiteData | undefined,
  relativePath: string
): string {
  return (
      // siteData?.locales 是对 siteData 中 locales 属性的安全访问（如果 siteData 为 undefined，则使用空对象 {} 作为默认值）
      // find() 方法用于遍历 locales 中的所有键，找到第一个满足条件的语言/地区代码
    Object.keys(siteData?.locales || {}).find(
      (key) =>
        key !== 'root' && // 排除 root 键，root 通常是默认语言/地区
        !isExternal(key) && // 确保语言/地区代码不是外部链接
        isActive(relativePath, `/${key}/`, true) // isActive()函数检查relativePath是否与/${key}/ 匹配，true表示将key` 当作正则表达式来匹配路径
    ) || 'root' // 如果没有找到符合条件的语言/地区代码，则返回 'root' 作为默认值
  )
}

/**
 * this merges the locales data to the main data by the route
 */
/**
 * 根据给定的路径（relativePath）从 siteData 中解析出与该路径相关的本地化数据，并返回更新后的 siteData 对象。
 * 它根据不同的语言或地区（locale）调整网站的配置，例如语言、方向、标题等
 * @param siteData 这是包含网站数据的对象，可能包含网站的语言配置（locales）和其他信息
 * @param relativePath 这是要检查的相对路径，函数会基于该路径来查找匹配的语言/地区
 */
export function resolveSiteDataByRoute(
  siteData: SiteData,
  relativePath: string
): SiteData {
  // 使用 getLocaleForPath 函数，传入 siteData 和 relativePath，获取与该路径匹配的语言/地区代码（例如 'en'、'zh' 等）
  // localeIndex 代表当前路径对应的语言或地区的键
  const localeIndex = getLocaleForPath(siteData, relativePath)

  // 使用 Object.assign() 创建一个新的 siteData 对象，并将以下属性合并到新对象中
  return Object.assign({}, siteData, {
    localeIndex, // 将解析出的语言/地区代码作为 localeIndex 属性添加到 siteData 中
    // 设置为 siteData.locales[localeIndex]?.lang，即根据语言/地区设置的语言（lang）。如果没有设置，则使用默认的 siteData.lang
    lang: siteData.locales[localeIndex]?.lang ?? siteData.lang,
    // 设置为 siteData.locales[localeIndex]?.dir，即根据语言/地区设置的文本方向（如 ltr 或 rtl）。如果没有设置，则使用默认的 siteData.dir
    dir: siteData.locales[localeIndex]?.dir ?? siteData.dir,
    // 设置为 siteData.locales[localeIndex]?.title，即根据语言/地区设置的标题。如果没有设置，则使用默认的 siteData.title
    title: siteData.locales[localeIndex]?.title ?? siteData.title,
    // 设置为 siteData.locales[localeIndex]?.titleTemplate，即根据语言/地区设置的标题模板。如果没有设置，则使用默认的 siteData.titleTemplate
    titleTemplate:
      siteData.locales[localeIndex]?.titleTemplate ?? siteData.titleTemplate,
    // 设置为 siteData.locales[localeIndex]?.description，即根据语言/地区设置的描述。如果没有设置，则使用默认的 siteData.description
    description:
      siteData.locales[localeIndex]?.description ?? siteData.description,
    // 调用 mergeHead() 函数，将当前 siteData.head 和语言/地区特定的 head 信息合并。如果语言/地区没有指定 head，则使用空数组
    head: mergeHead(siteData.head, siteData.locales[localeIndex]?.head ?? []),
    // 合并当前 siteData.themeConfig 和语言/地区特定的 themeConfig，以覆盖相应的配置
    themeConfig: {
      ...siteData.themeConfig,
      ...siteData.locales[localeIndex]?.themeConfig
    }
  })
}

/**
 * Create the page title string based on config.
 */
/**
 * 根据网站的配置和页面数据动态创建页面的标题。函数通过检查页面数据和配置中的标题模板，生成适当的标题字符串。
 * @param siteData 包含全站配置的数据对象，其中可能包括网站的默认标题和标题模板
 * @param pageData 包含当前页面的数据对象，其中可能包括该页面的标题和标题模板
 */
export function createTitle(siteData: SiteData, pageData: PageData): string {
  // 如果 pageData.title 存在，则使用该页面的标题；否则，使用 siteData.title 作为默认标题
  const title = pageData.title || siteData.title
  // 如果 pageData.titleTemplate 存在，则使用该页面的标题模板；否则，使用 siteData.titleTemplate 作为默认标题模板
  const template = pageData.titleTemplate ?? siteData.titleTemplate

  // 如果模板是字符串且包含 :title 占位符，则将 :title 替换为当前的页面标题 (title)，并返回替换后的字符串
  if (typeof template === 'string' && template.includes(':title')) {
    return template.replace(/:title/g, title)
  }

  // 如果没有 :title 占位符，使用 createTitleTemplate() 函数来生成一个完整的标题字符串。
  // createTitleTemplate(siteData.title, template) 会基于 siteData.title 和 template 创建最终的标题模板
  const templateString = createTitleTemplate(siteData.title, template)

  // 这里通过 slice(3) 去掉模板字符串的前缀部分（假设模板字符串可能有一个固定的前缀，比如 -）。如果最终的标题和页面标题相同，直接返回页面标题 title
  if (title === templateString.slice(3)) {
    return title
  }

  // 如果标题与模板字符串不相同，则将页面标题 title 和生成的标题模板拼接在一起，并返回最终的标题字符串
  return `${title}${templateString}`
}

/**
 * 用于根据网站的标题和给定的模板生成一个完整的标题字符串。该函数根据模板的不同值来决定返回的标题格式。
 * @param siteTitle 这是网站的默认标题（siteData.title），通常是一个网站的名称或标识
 * @param template 这是可选的标题模板，可以是 string 类型或者 boolean 类型。如果为 true 或 undefined，则使用默认格式；如果为 false，则返回空字符串；如果为 string，则按照该字符串来生成标题
 */
function createTitleTemplate(
  siteTitle: string,
  template?: string | boolean
): string {
  // 如果 template 为 false，则返回空字符串 ''。这是为了处理禁用模板的情况
  if (template === false) {
    return ''
  }

  // 如果 template 为 true 或 undefined（即没有提供模板或明确设置为 true），则返回默认的标题格式 | ${siteTitle}，表示在网站标题前面加上 |
  if (template === true || template === undefined) {
    return ` | ${siteTitle}`
  }

  // 如果提供的 template 与 siteTitle 相同，则返回空字符串 ''。这样可以避免生成冗余的标题（即避免标题重复）
  if (siteTitle === template) {
    return ''
  }

  // 如果 template 是一个字符串且与 siteTitle 不同，则返回 | ${template}，即将 template 添加到网站标题前面
  return ` | ${template}`
}

/**
 * 用于检查一个 HTML <head> 配置中是否已经存在某个特定的标签。它接受一个头部配置数组（head）和一个标签（tag），检查该标签是否已经出现在 head 中。
 * @param head 这是一个数组，包含了多个头部元素配置，每个元素都是一个数组，其中第一个元素是标签类型（如 'meta'、'link' 等），第二个元素是标签的属性（attrs）
 * @param tag 这是一个待检查的标签配置，格式与 head 中的元素相同，包含标签类型和标签属性
 */
function hasTag(head: HeadConfig[], tag: HeadConfig) {
  // 使用数组解构，将 tag 拆解为 tagType（标签类型，如 'meta'）和 tagAttrs（标签的属性对象）
  const [tagType, tagAttrs] = tag
  // 如果标签类型不是 'meta'，则直接返回 false。这是因为当前函数只检查 'meta' 标签。如果需要检查其他类型的标签，可以扩展此逻辑
  if (tagType !== 'meta') return false
  // 使用 Object.entries() 将 tagAttrs 对象转为一个包含 [key, value] 对的数组，并取第一个键值对（即 keyAttr）。这是为了找出 meta 标签的第一个属性并进行匹配
  const keyAttr = Object.entries(tagAttrs)[0] // First key
  // 如果没有找到任何属性（即 keyAttr 为 null 或 undefined），则返回 false。这是为了防止没有有效属性的标签通过检查
  if (keyAttr == null) return false
  // head.some() 遍历 head 数组，检查其中是否存在一个标签，满足以下条件
  // 标签类型（type）与 tagType 相同。
  // 标签的属性（attrs）中，keyAttr[0] 对应的属性值等于 keyAttr[1]（即 meta 标签的第一个属性值与待检查标签的属性值相同）。
  // 如果找到了匹配的标签，则返回 true，否则返回 false
  return head.some(
    ([type, attrs]) => type === tagType && attrs[keyAttr[0]] === keyAttr[1]
  )
}

/**
 * 用于合并两个 head 配置数组（prev 和 curr），并确保在合并时，curr 中的标签不会重复出现在 prev 中。
 * 它主要用于合并 HTML <head> 配置，例如 meta 标签、link 标签等
 * @param prev 这是一个数组，包含了之前的 <head> 配置项，通常是页面的现有头部元素
 * @param curr 这是一个数组，包含了当前的 <head> 配置项，通常是想要添加到页面中的新头部元素
 */
export function mergeHead(prev: HeadConfig[], curr: HeadConfig[]) {
  // 过滤出 prev 中没有出现在 curr 中的标签
  return [...prev.filter((tagAttrs) => !hasTag(curr, tagAttrs)), ...curr]
}

// https://github.com/rollup/rollup/blob/fec513270c6ac350072425cc045db367656c623b/src/utils/sanitizeFileName.ts

// 这个正则表达式用于匹配“无效字符”。这些字符是指在某些情况下（比如 URL 或文件路径中）不能出现的字符。它包含了以下几类字符：
//
// 控制字符（\u0000-\u001F）：这些是 Unicode 范围内的控制字符，从 0x00 到 0x1F，通常是不可见的控制符，如回车、换行、制表符等。
// 删除符号（\u007F）：0x7F 是 Unicode 的“删除”字符，也就是 ASCII 的 DEL（删除符号），通常也不能出现在路径或 URL 中。
// 特定的符号：字符集 "#", "$", "&", "*", "+", ":", ";", "<", "=", ">", "?", "[", "]", "^", "", "{", "|", "}"。这些字符在 URL、文件路径和其他字符串中通常需要进行编码，或者在某些情况下会被认为是无效字符。
const INVALID_CHAR_REGEX = /[\u0000-\u001F"#$&*+,:;<=>?[\]^`{|}\u007F]/g
// 这个正则表达式用于匹配 Windows 系统中的驱动器字母。驱动器字母是表示磁盘驱动器的字符（如 C:、D: 等）。
// 此正则表达式会匹配以一个字母（a-z 或 A-Z）开头，并跟随一个冒号（:）的字符串
const DRIVE_LETTER_REGEX = /^[a-z]:/i

/**
 * 用于清理文件名，确保它符合特定的格式要求：
 * 1. 处理文件路径中的无效字符，通常用于将文件名格式化成可用的形式。
 * 2. 它还处理 Windows 驱动器字母（例如 C:）的特殊情况，确保它被正确保留，并清除文件名中的无效字符。
 * @param name
 */
export function sanitizeFileName(name: string): string {
  // 使用 DRIVE_LETTER_REGEX 正则表达式从 name 中提取驱动器字母（如 C:）
  const match = DRIVE_LETTER_REGEX.exec(name)
  const driveLetter = match ? match[0] : ''

  return (
    driveLetter + // 如果存在驱动器字母（例如 C:），将其保留并放在清理后的文件名开头
    name
      .slice(driveLetter.length) // 从文件名中去除驱动器字母部分，仅保留剩余的文件路径（或文件名）
      .replace(INVALID_CHAR_REGEX, '_') // 替换无效字符
      .replace(/(^|\/)_+(?=[^/]*$)/, '$1') // 修复路径中尾部的下划线问题
  )
}

/**
 * 用于将文件路径中的反斜杠（\）替换为正斜杠（/），确保路径格式一致。
 * 它非常适用于跨平台的路径处理，尤其是在 Windows 和类 Unix 系统之间进行路径转换时
 * @param p
 */
export function slash(p: string): string {
  return p.replace(/\\/g, '/')
}

// 用于存储已知的文件扩展名。扩展名将以小写字母形式存储，集合中的元素代表不应当作为 HTML 文件处理的文件类型
const KNOWN_EXTENSIONS = new Set()

/**
 * 用于判断给定的文件名是否应该被当作 HTML 文件处理。具体而言，它通过判断文件扩展名是否属于已知的非 HTML 类型来做出决策。
 * 对于那些扩展名不在已知扩展名集合中的文件，它将其当作 HTML 文件处理
 * @param filename
 */
export function treatAsHtml(filename: string): boolean {
  // 这里判断 KNOWN_EXTENSIONS 是否为空，如果是空的，说明还没有初始化过已知扩展名集合
  if (KNOWN_EXTENSIONS.size === 0) {
    // 这里首先检查环境变量 VITE_EXTRA_EXTENSIONS（可以是通过 process.env 或 import.meta.env 传入的环境变量）是否存在，并获取其值。
    // 这个变量可以用于额外扩展扩展名的支持，允许自定义哪些扩展名应当被视为非 HTML 类型。
    const extraExts =
      (typeof process === 'object' && process.env?.VITE_EXTRA_EXTENSIONS) ||
      (import.meta as any).env?.VITE_EXTRA_EXTENSIONS ||
      '' // 如果 VITE_EXTRA_EXTENSIONS 没有设置，则默认为空字符串

    // md, html? are intentionally omitted
    ;(
      '3g2,3gp,aac,ai,apng,au,avif,bin,bmp,cer,class,conf,crl,css,csv,dll,' +
      'doc,eps,epub,exe,gif,gz,ics,ief,jar,jpe,jpeg,jpg,js,json,jsonld,m4a,' +
      'man,mid,midi,mjs,mov,mp2,mp3,mp4,mpe,mpeg,mpg,mpp,oga,ogg,ogv,ogx,' +
      'opus,otf,p10,p7c,p7m,p7s,pdf,png,ps,qt,roff,rtf,rtx,ser,svg,t,tif,' +
      'tiff,tr,ts,tsv,ttf,txt,vtt,wav,weba,webm,webp,woff,woff2,xhtml,xml,' +
      'yaml,yml,zip' +
      (extraExts && typeof extraExts === 'string' ? ',' + extraExts : '')
    )
      .split(',')
      .forEach((ext) => KNOWN_EXTENSIONS.add(ext)) // 如果环境变量 VITE_EXTRA_EXTENSIONS 有值（即自定义扩展名），它会将这些扩展名追加到列表中
  }

  const ext = filename.split('.').pop()

  return ext == null || !KNOWN_EXTENSIONS.has(ext.toLowerCase())
}

// https://github.com/sindresorhus/escape-string-regexp/blob/ba9a4473850cb367936417e97f1f2191b7cc67dd/index.js
/**
 * 用于转义字符串中的特殊字符，使得该字符串可以安全地作为正则表达式的一部分使用
 * 1. 它会将常见的正则表达式元字符（如 |, \, {}, (), [], ^, $, +, *, ?, ., 等）前面加上反斜杠 \，确保它们不会被解释为正则表达式的控制符。
 * 2. 它还专门处理了连字符 -，将其转义为 \x2d，以避免它被误解释为字符范围。
 * @param str
 */
export function escapeRegExp(str: string) {
  return str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&').replace(/-/g, '\\x2d')
}
