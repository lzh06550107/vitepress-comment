import { defineConfig } from 'vitepress'
import { search as zhSearch } from './zh'
import { search as ptSearch } from './pt'
import { search as ruSearch } from './ru'

export const shared = defineConfig({
  title: 'VitePress', // 站点的标题

  lastUpdated: true, // 是否使用 Git 获取每个页面的最后更新时间戳
  cleanUrls: true, // 当设置为 true 时，VitePress 将从 URL 中删除 .html 后缀
  metaChunk: true, // 当设置为 true 时，将页面元数据提取到单独的 JavaScript 块中，而不是内联在初始 HTML 中。这使每个页面的 HTML 负载更小，并使页面元数据可缓存，从而当站点中有很多页面时可以减少服务器带宽。

  markdown: { // 配置 Markdown 解析器选项
    math: true,
    codeTransformers: [
      // We use `[!!code` in demo to prevent transformation, here we revert it back.
      {
        postprocess(code) {
          return code.replace(/\[\!\!code/g, '[!code')
        }
      }
    ]
  },

  sitemap: { // 这些选项将直接传递给 SitemapStream 构造函数
    hostname: 'https://vitepress.dev',
    transformItems(items) {
      return items.filter((item) => !item.url.includes('migration'))
    }
  },

  /* prettier-ignore 要在页面 HTML 的 <head> 标签中呈现的其他元素 */
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/vitepress-logo-mini.svg' }],
    ['link', { rel: 'icon', type: 'image/png', href: '/vitepress-logo-mini.png' }],
    ['meta', { name: 'theme-color', content: '#5f67ee' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'en' }],
    ['meta', { property: 'og:title', content: 'VitePress | Vite & Vue Powered Static Site Generator' }],
    ['meta', { property: 'og:site_name', content: 'VitePress' }],
    ['meta', { property: 'og:image', content: 'https://vitepress.dev/vitepress-og.jpg' }],
    ['meta', { property: 'og:url', content: 'https://vitepress.dev/' }],
    ['script', { src: 'https://cdn.usefathom.com/script.js', 'data-site': 'AZBRSFGG', 'data-spa': 'auto', defer: '' }]
  ],

  // 主题级配置选项
  themeConfig: {
    logo: { src: '/vitepress-logo-mini.svg', width: 24, height: 24 },

    // 社交帐户链接
    socialLinks: [
      { icon: 'github', link: 'https://github.com/vuejs/vitepress' }
    ],

    // Algolia Search
    search: {
      provider: 'algolia',
      options: {
        appId: '8J64VVRP8K',
        apiKey: 'a18e2f4cc5665f6602c5631fd868adfd',
        indexName: 'vitepress',
        locales: { ...zhSearch, ...ptSearch, ...ruSearch }
      }
    },

    // 对 Carbon Ads 的原生支持
    carbonAds: { code: 'CEBDT27Y', placement: 'vuejsorg' }
  }
})
