import type { Plugin } from 'vite'

// 这个正则表达式用于匹配在 CSS 文件中，用于标记 Web 字体的内容
// 简言之，这个正则用于在 CSS 文件中查找以 /* webfont-marker-begin */ 开始，以 /* webfont-marker-end */ 结束的 Web 字体标记内容
const webfontMarkerRE =
  /\/(?:\*|\/) *webfont-marker-begin *(?:\*\/|\n|\r|\n\r|\r\n)([^]*?)\/(?:\*|\/) *webfont-marker-end *(?:\*\/|\n|\r|\n\r|\r\n|$)/

/**
 * 用于处理 CSS 文件中的 Web 字体相关的内容。
 * 具体来说，它根据 enabled 参数的值来决定是否保留或删除特定的 Web 字体标记（webfont-marker-begin 和 webfont-marker-end）之间的内容
 * @param enabled 参数控制插件的启用状态。默认值是 false，意味着禁用 Web 字体相关的内容处理
 */
export const webFontsPlugin = (enabled = false): Plugin => ({
  name: 'vitepress:webfonts', // 插件的名称
  enforce: 'pre', // 插件的执行时机，'pre' 表示在其他插件之前执行

  // code：文件的源代码。
  // id：文件的路径。
  transform(code, id) {
    if (/[\\/]fonts\.s?css/.test(id)) { // 只处理 fonts.css 或 fonts.scss 文件
      if (enabled) {
        // 如果启用了插件，返回标记中的内容
        return code.match(webfontMarkerRE)?.[1]
      } else {
        // 如果插件禁用，删除标记的内容
        return code.replace(webfontMarkerRE, '')
      }
    }
  }
})
