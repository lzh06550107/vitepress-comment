import type MarkdownIt from 'markdown-it'

/**
 * 是一个自定义的 MarkdownIt 插件，用于在 Markdown 渲染过程中处理文本中的 HTML 实体
 * @param md
 */
export function restoreEntities(md: MarkdownIt): void {
  // text_join 是 MarkdownIt 的一个核心规则，负责将相邻的文本节点合并成一个文本节点。在默认情况下，MarkdownIt 会尝试将相邻的文本合并成一个字符串，以便更高效地渲染
  // md.core.ruler.disable('text_join') 禁用了这个规则，防止文本节点被合并。
  // 这样做的目的是保留文本的原始格式，尤其是在处理 HTML 实体时，确保它们不会被错误地合并或更改
  md.core.ruler.disable('text_join')
  // 自定义文本渲染规则，用于处理文本节点。
  md.renderer.rules.text_special = (tokens, idx) => {
    // 如果 token 的 info 属性是 'entity'，则直接返回 tokens[idx].markup，即保留原始的文本（这通常是 HTML 实体）。
    // 这样做是为了确保 Vue 可以正确地处理这些 HTML 实体，而不进行转义
    if (tokens[idx].info === 'entity') {
      return tokens[idx].markup // leave as is so Vue can handle it
    }
    // 否则，调用 md.utils.escapeHtml(tokens[idx].content) 对内容进行 HTML 转义，防止潜在的 XSS 攻击或不期望的 HTML 被渲染
    return md.utils.escapeHtml(tokens[idx].content)
  }
}
