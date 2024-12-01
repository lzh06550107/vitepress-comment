import RawTheme from '@theme/index'
import {
  createApp as createClientApp,
  createSSRApp,
  defineComponent,
  h,
  onMounted,
  watchEffect,
  type App
} from 'vue'
import { ClientOnly } from './components/ClientOnly'
import { Content } from './components/Content'
import { useCodeGroups } from './composables/codeGroups'
import { useCopyCode } from './composables/copyCode'
import { useUpdateHead } from './composables/head'
import { usePrefetch } from './composables/preFetch'
import { dataSymbol, initData, siteDataRef, useData } from './data'
import { RouterSymbol, createRouter, scrollTo, type Router } from './router'
import { inBrowser, pathToFile } from './utils'

function resolveThemeExtends(theme: typeof RawTheme): typeof RawTheme {
  if (theme.extends) {
    const base = resolveThemeExtends(theme.extends)
    return {
      ...base,
      ...theme,
      async enhanceApp(ctx) {
        if (base.enhanceApp) await base.enhanceApp(ctx)
        if (theme.enhanceApp) await theme.enhanceApp(ctx)
      }
    }
  }
  return theme
}

const Theme = resolveThemeExtends(RawTheme)

const VitePressApp = defineComponent({
  name: 'VitePressApp',
  setup() {
    const { site, lang, dir } = useData()

    // change the language on the HTML element based on the current lang
    onMounted(() => {
      watchEffect(() => {
        document.documentElement.lang = lang.value
        document.documentElement.dir = dir.value
      })
    })

    if (import.meta.env.PROD && site.value.router.prefetchLinks) {
      // in prod mode, enable intersectionObserver based pre-fetch
      usePrefetch()
    }

    // setup global copy code handler
    useCopyCode()
    // setup global code groups handler
    useCodeGroups()

    if (Theme.setup) Theme.setup()
    return () => h(Theme.Layout!)
  }
})

/**
 * 它创建了一个 VitePress 应用，并设置了各种配置、路由、全局组件等
 * createApp 函数的主要功能是：
 * 1. 创建和配置 VitePress 应用。
 * 2. 初始化并提供路由和页面数据。
 * 3. 注册全局组件（如 Content 和 ClientOnly）。
 * 4. 设置 $frontmatter 和 $params 作为全局属性，使其在组件中可以方便访问。
 * 5. 在开发模式下配置开发者工具。
 * 6. 如果主题中定义了 enhanceApp，则对应用进行增强。
 */
export async function createApp() {
  // 通过 globalThis（这是一个指向全局对象的引用，适用于不同的 JavaScript 环境，如浏览器、Node.js 等），
  // 将 __VITEPRESS__ 设置为 true。这可能是为了标记当前环境为 VitePress 或者在其他地方检查这个标志来决定是否执行特定的逻辑。
  ;(globalThis as any).__VITEPRESS__ = true

  // 创建一个新的路由实例，可能是通过 VitePress 或其他框架定义的一个函数，用于管理应用中的路由。
  const router = newRouter()

  // 创建一个新的应用实例，可能是一个基于 Vue.js（假设是 Vue 3）构建的应用实例。
  const app = newApp()

  // app.provide 是 Vue 3 的依赖注入机制。这里将 router 和 data 提供给整个应用，使得任何组件都可以通过 inject 机制访问这些值
  app.provide(RouterSymbol, router)

  // 初始化了与当前路由相关的数据，可能包含页面数据、前端数据等。
  const data = initData(router.route)
  app.provide(dataSymbol, data)

  // install global components
  app.component('Content', Content) // 用于显示页面内容的组件
  app.component('ClientOnly', ClientOnly) // 用于仅在客户端渲染的组件

  // expose $frontmatter & $params 暴露 $frontmatter 和 $params 到全局属性
  Object.defineProperties(app.config.globalProperties, {
    // 返回页面的 frontmatter 数据，通常包含页面的元数据（例如标题、描述等）
    $frontmatter: {
      get() {
        return data.frontmatter.value
      }
    },
    // 返回当前页面的路由参数。data.page.value.params 可能是从路由中提取的参数
    $params: {
      get() {
        return data.page.value.params
      }
    }
  })

  // 主题增强
  // 检查 Theme.enhanceApp 是否存在，如果存在则调用它并传递 app、router 和 siteDataRef，可能是为了进行主题相关的增强功能或定制
  if (Theme.enhanceApp) {
    await Theme.enhanceApp({
      app,
      router,
      siteData: siteDataRef
    })
  }

  // setup devtools in dev mode 在开发模式中设置开发者工具
  // 如果当前环境是开发模式（import.meta.env.DEV）或者生产环境启用了开发者工具（__VUE_PROD_DEVTOOLS__），则动态加载并设置开发者工具
  if (import.meta.env.DEV || __VUE_PROD_DEVTOOLS__) {
    import('./devtools.js').then(({ setupDevtools }) =>
      setupDevtools(app, router, data)
    )
  }

  // 这些对象分别是 Vue 应用实例、路由实例和与页面数据相关的对象
  return { app, router, data }
}

/**
 * 用于根据环境创建一个 Vue 应用实例。它根据当前运行的环境（生产环境或开发环境）来决定使用服务器端渲染（SSR）版本的应用，还是客户端渲染版本的应用
 */
function newApp(): App {
  // 表示当前代码是否在生产环境中运行
  return import.meta.env.PROD
    ? createSSRApp(VitePressApp) // 创建一个 服务器端渲染 (SSR) 应用
    : createClientApp(VitePressApp) // 开发环境时，创建一个 客户端渲染 (CSR) 应用
  // VitePressApp 是应用的根组件。在开发和生产环境中，都会用这个组件作为应用的起点。
  // 在客户端渲染模式下，VitePressApp 作为客户端渲染的入口组件；在服务器端渲染模式下，它是服务器渲染的根组件。
}

// 用于创建一个路由实例，并负责动态加载页面模块（如 .js、.md 文件）以实现客户端和服务器端渲染的页面导航。
function newRouter(): Router {
  // 一个标志，表示是否是页面的初次加载。它的初始值取决于当前环境是否为浏览器（inBrowser）
  let isInitialPageLoad = inBrowser
  // 存储初始加载时的页面路径，之后会用于决定是否重新加载页面模块
  let initialPath: string

  // 它接收一个路径处理函数并返回一个路由实例。在这个路由中，当某个路径（path）发生变化时，会调用路径处理函数来动态加载对应的页面模块
  return createRouter((path) => {
    // 将路径转换为文件路径，通常会把 URL 路径转换为对应的文件路径，如将 /about 转换为 about.md 或 about.js
    let pageFilePath = pathToFile(path)
    let pageModule = null

    if (pageFilePath) {
      if (isInitialPageLoad) {
        initialPath = pageFilePath
      }

      // use lean build if this is the initial page load or navigating back
      // to the initial loaded path (the static vnodes already adopted the
      // static content on that load so no need to re-fetch the page)
      // 如果是首次加载页面或用户回到初始页面，则使用 .lean.js 后缀的文件。 .lean.js 文件可能是经过优化的精简版 JavaScript 文件，避免重新加载冗余内容
      if (isInitialPageLoad || initialPath === pageFilePath) {
        pageFilePath = pageFilePath.replace(/\.js$/, '.lean.js')
      }

      // 根据环境选择不同的加载方式
      if (import.meta.env.DEV) { // 开发模式
        // 在开发模式下，pageModule 使用动态 import 语法加载页面模块
        pageModule = import(/*@vite-ignore*/ pageFilePath).catch(() => {
          // try with/without trailing slash
          // in prod this is handled in src/client/app/utils.ts#pathToFile
          const url = new URL(pageFilePath!, 'http://a.com')
          const path =
            (url.pathname.endsWith('/index.md')
              ? url.pathname.slice(0, -9) + '.md'
              : url.pathname.slice(0, -3) + '/index.md') +
            url.search +
            url.hash
          return import(/*@vite-ignore*/ path)
        })
      } else if (import.meta.env.SSR) { // 服务端渲染
        // 在服务器端渲染（SSR）模式下，使用动态导入并附加时间戳（?t=${Date.now()}）来避免缓存问题，确保每次请求加载最新的页面模块
        pageModule = import(/*@vite-ignore*/ `${pageFilePath}?t=${Date.now()}`)
      } else { // 生产模式
        // 在生产环境中，直接加载 pageFilePath 指定的模块
        pageModule = import(/*@vite-ignore*/ pageFilePath)
      }
    }

    // 如果代码在浏览器环境中运行，isInitialPageLoad 会被设置为 false，表示首次加载已经完成，后续导航将不再使用精简版的模块
    if (inBrowser) {
      isInitialPageLoad = false
    }

    return pageModule
    // 第二个参数是一个 "NotFound" 组件或页面，当路由无法匹配到有效路径时，会显示这个页面
  }, Theme.NotFound)
}

if (inBrowser) {
  createApp().then(({ app, router, data }) => {
    // wait until page component is fetched before mounting
    router.go().then(() => {
      // dynamically update head tags
      useUpdateHead(router.route, data.site)
      app.mount('#app')

      // scroll to hash on new tab during dev
      if (import.meta.env.DEV && location.hash) {
        const target = document.getElementById(
          decodeURIComponent(location.hash).slice(1)
        )
        if (target) {
          scrollTo(target, location.hash)
        }
      }
    })
  })
}
