import postcssPrefixSelector from 'postcss-prefix-selector'

/**
 * 使用了 postcssPrefixSelector 来处理样式表，并为特定的选择器添加前缀。
 * 这通常用于样式隔离（例如在组件化的 CSS 环境中），使样式应用于某些元素，而不影响全局的 CSS
 * @param options 该参数是 postcssPrefixSelector 函数的选项
 */
export function postcssIsolateStyles(
  options: Parameters<typeof postcssPrefixSelector>[0] = {}
): ReturnType<typeof postcssPrefixSelector> {
  // postcssPrefixSelector 是一个 PostCSS 插件，用于为 CSS 选择器添加前缀，以防止样式冲突。
  // 它会遍历 CSS 选择器并为每个选择器添加一个前缀。这个插件通常用于样式隔离，以确保组件样式不会泄漏或覆盖其他样式
  return postcssPrefixSelector({
    // 它表示仅在选择器不匹配 .vp-raw 和 .vp-raw * 类的情况下，才会添加该前缀
    prefix: ':not(:where(.vp-raw, .vp-raw *))',
    // 用于匹配需要添加前缀的文件。这里，它仅对包含 base.css 的文件进行样式隔离
    includeFiles: [/base\.css/],
    // 这个 transform 函数会处理选择器，确保前缀被正确应用。它通过正则表达式将选择器与伪类分开，然后把前缀附加到选择器上
    transform(prefix, _selector) {
      const [selector, pseudo = ''] = _selector.split(/(:\S*)$/)
      return selector + prefix + pseudo
    },
    ...options // 允许用户传入自定义的选项来覆盖默认的配置
  })
}
