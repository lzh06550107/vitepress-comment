import { defineConfig } from 'vitepress'
import { shared } from './shared'
import { en } from './en'
import { zh } from './zh'
import { pt } from './pt'
import { ru } from './ru'

export default defineConfig({
  ...shared, // 共享属性和其他顶层内容
  locales: { // locale 特定属性
    root: { label: 'English', ...en },
    zh: { label: '简体中文', ...zh },
    pt: { label: 'Português', ...pt },
    ru: { label: 'Русский', ...ru },
    ko: { label: '한국어', lang: 'ko-KR', link: 'https://vitepress.vuejs.kr/' }
  }
})
