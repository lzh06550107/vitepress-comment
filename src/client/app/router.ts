import type { Component, InjectionKey } from 'vue'
import { inject, markRaw, nextTick, reactive, readonly } from 'vue'
import type { Awaitable, PageData, PageDataPayload } from '../shared'
import { notFoundPageData, treatAsHtml } from '../shared'
import { siteDataRef } from './data'
import { getScrollOffset, inBrowser, withBase } from './utils'

// Vitepress 并没有使用 Vuejs 的官方路由方案（Vue Router），而是自己实现了一个简单的路由模块

export interface Route {
  path: string
  data: PageData
  component: Component | null
}

export interface Router {
  /**
   * Current route.
   */
  route: Route
  /**
   * Navigate to a new URL.
   */
  go: (to?: string) => Promise<void>
  /**
   * Called before the route changes. Return `false` to cancel the navigation.
   */
  onBeforeRouteChange?: (to: string) => Awaitable<void | boolean>
  /**
   * Called before the page component is loaded (after the history state is
   * updated). Return `false` to cancel the navigation.
   */
  onBeforePageLoad?: (to: string) => Awaitable<void | boolean>
  /**
   * Called after the route changes.
   */
  onAfterRouteChanged?: (to: string) => Awaitable<void>
}

export const RouterSymbol: InjectionKey<Router> = Symbol()

// we are just using URL to parse the pathname and hash - the base doesn't
// matter and is only passed to support same-host hrefs.
const fakeHost = 'http://a.com'

// 返回默认的路由配置
const getDefaultRoute = (): Route => ({
  path: '/',
  component: null,
  data: notFoundPageData
})

interface PageModule {
  __pageData: PageData
  default: Component
}

/**
 * 用于创建一个基本的路由系统，主要针对 VitePress 这样的静态站点生成工具进行页面路由处理。代码涉及路由的管理、页面加载、浏览器历史管理等内容
 * @param loadPageModule 这是一个加载页面模块的函数，传入页面路径并返回一个 PageModule 或 null，该模块包含了页面的组件和相关数据
 * @param fallbackComponent 可选参数，当页面无法找到时，可以显示的回退组件
 */
export function createRouter(
  loadPageModule: (path: string) => Awaitable<PageModule | null>,
  fallbackComponent?: Component
): Router {
  // 是一个响应式对象，用来保存当前路由的状态（路径、组件、页面数据等）
  const route = reactive(getDefaultRoute())

  const router: Router = {
    route,
    go
  }

  /**
   * 用于进行页面跳转。它会先检查路由变化的前置钩子（onBeforeRouteChange），然后使用 history.pushState 修改浏览器地址栏，最后加载新的页面模块
   * go 函数是用于处理 SPA 中的页面导航的核心函数。它的主要功能包括：
   *
   * 1. 标准化目标 URL。
   * 2. 执行导航前的自定义检查（通过 onBeforeRouteChange 钩子）。
   * 3. 更新浏览器的历史记录。
   * 4. 异步加载新的页面内容。
   * 5. 在路由变化后执行一些额外的操作（通过 onAfterRouteChanged 钩子）。
   * @param href 判断当前是否在浏览器环境中
   */
  async function go(href: string = inBrowser ? location.href : '/') {
    href = normalizeHref(href) // URL 标准化
    // onBeforeRouteChange 是一个生命周期钩子，用于在路由变化前执行某些操作。
    // 如果这个钩子返回 false，那么路由的变化会被取消。你可以在这里添加一些自定义逻辑，比如确认是否有未保存的内容，或者检查用户的权限等
    if ((await router.onBeforeRouteChange?.(href)) === false) return
    // 只有在浏览器环境中 (inBrowser 为 true)，并且目标 URL 与当前 URL 不相同的时候，才会执行以下操作
    if (inBrowser && href !== normalizeHref(location.href)) {
      // save scroll position before changing url
      // 在 URL 改变前，保存当前的滚动位置 (window.scrollY) 到浏览器的历史状态中，这样在跳转回来时可以恢复滚动位置
      history.replaceState({ scrollPosition: window.scrollY }, '')
      // 使用 history.pushState 修改浏览器的地址栏 URL，但不会刷新页面，这样用户可以通过浏览器的前进后退按钮正常进行页面导航
      history.pushState({}, '', href)
    }
    // 在更新了历史记录之后，函数会调用 loadPage(href) 来加载目标页面的内容
    await loadPage(href)
    // 页面加载完成后，如果定义了 onAfterRouteChanged 钩子，就会调用它。这个钩子允许开发者在路由变化后执行一些操作，例如发送分析数据、做一些后处理等
    await router.onAfterRouteChanged?.(href)
  }

  let latestPendingPath: string | null = null

  /**
   * 用于加载指定路径的页面
   * @param href
   * @param scrollPosition
   * @param isRetry
   */
  async function loadPage(href: string, scrollPosition = 0, isRetry = false) {
    // 它首先会检查是否有 onBeforePageLoad 钩子，决定是否加载页面
    if ((await router.onBeforePageLoad?.(href)) === false) return
    const targetLoc = new URL(href, fakeHost)
    const pendingPath = (latestPendingPath = targetLoc.pathname)
    try {
      // 通过 loadPageModule 加载页面模块，解析并设置路由的相关数据
      let page = await loadPageModule(pendingPath)
      // 如果页面加载失败且非重试，则会尝试重新加载页面（例如，部署后的页面更新可能导致路径无效）
      if (!page) {
        throw new Error(`Page not found: ${pendingPath}`)
      }
      if (latestPendingPath === pendingPath) {
        latestPendingPath = null

        const { default: comp, __pageData } = page
        if (!comp) {
          throw new Error(`Invalid route component: ${comp}`)
        }

        route.path = inBrowser ? pendingPath : withBase(pendingPath)
        // 如果页面加载成功，route.component 会设置为加载的页面组件 comp，并标记为原始对象（markRaw），避免 Vue 的响应式代理
        route.component = markRaw(comp)
        // route.data 会包含页面的数据，根据是否处于生产环境 (import.meta.env.PROD) 来决定是否使用只读版本的数据。
        route.data = import.meta.env.PROD
          ? markRaw(__pageData)
          : (readonly(__pageData) as PageData)

        // 在页面加载后，Vue 的 nextTick 用于等待 DOM 更新，然后将页面滚动到指定的位置
        if (inBrowser) {
          nextTick(() => {
            let actualPathname =
              siteDataRef.value.base +
              __pageData.relativePath.replace(/(?:(^|\/)index)?\.md$/, '$1')
            if (!siteDataRef.value.cleanUrls && !actualPathname.endsWith('/')) {
              actualPathname += '.html'
            }
            if (actualPathname !== targetLoc.pathname) {
              targetLoc.pathname = actualPathname
              href = actualPathname + targetLoc.search + targetLoc.hash
              history.replaceState({}, '', href)
            }

            if (targetLoc.hash && !scrollPosition) {
              let target: HTMLElement | null = null
              try {
                target = document.getElementById(
                  decodeURIComponent(targetLoc.hash).slice(1)
                )
              } catch (e) {
                console.warn(e)
              }
              if (target) {
                scrollTo(target, targetLoc.hash)
                return
              }
            }
            window.scrollTo(0, scrollPosition)
          })
        }
      }
    } catch (err: any) {
      if (
        !/fetch|Page not found/.test(err.message) &&
        !/^\/404(\.html|\/)?$/.test(href)
      ) {
        console.error(err)
      }

      // retry on fetch fail: the page to hash map may have been invalidated
      // because a new deploy happened while the page is open. Try to fetch
      // the updated pageToHash map and fetch again.
      if (!isRetry) {
        try {
          const res = await fetch(siteDataRef.value.base + 'hashmap.json')
          ;(window as any).__VP_HASH_MAP__ = await res.json()
          await loadPage(href, scrollPosition, true)
          return
        } catch (e) {}
      }

      if (latestPendingPath === pendingPath) {
        latestPendingPath = null
        route.path = inBrowser ? pendingPath : withBase(pendingPath)
        // 如果页面未找到，route.component 会设置为 fallbackComponent，并返回一个 404 页面数据。
        route.component = fallbackComponent ? markRaw(fallbackComponent) : null
        const relativePath = inBrowser
          ? pendingPath
              .replace(/(^|\/)$/, '$1index')
              .replace(/(\.html)?$/, '.md')
              .replace(/^\//, '')
          : '404.md'
        route.data = { ...notFoundPageData, relativePath }
      }
    }
  }

  if (inBrowser) {
    if (history.state === null) {
      history.replaceState({}, '')
    }
    // 监听 click 事件，处理页面链接点击，阻止非 HTML 链接的默认行为，进行客户端路由导航
    window.addEventListener(
      'click',
      (e) => {
        // temporary fix for docsearch action buttons
        const button = (e.target as Element).closest('button')
        if (button) return

        const link = (e.target as Element | SVGElement).closest<
          HTMLAnchorElement | SVGAElement
        >('a')
        if (
          link &&
          !link.closest('.vp-raw') &&
          (link instanceof SVGElement || !link.download)
        ) {
          const { target } = link
          const { href, origin, pathname, hash, search } = new URL(
            link.href instanceof SVGAnimatedString
              ? link.href.animVal
              : link.href,
            link.baseURI
          )
          const currentUrl = new URL(location.href) // copy to keep old data
          // only intercept inbound html links
          if (
            !e.ctrlKey &&
            !e.shiftKey &&
            !e.altKey &&
            !e.metaKey &&
            !target &&
            origin === currentUrl.origin &&
            treatAsHtml(pathname)
          ) {
            e.preventDefault()
            if (
              pathname === currentUrl.pathname &&
              search === currentUrl.search
            ) {
              // scroll between hash anchors in the same page
              // avoid duplicate history entries when the hash is same
              if (hash !== currentUrl.hash) {
                history.pushState({}, '', href)
                // still emit the event so we can listen to it in themes
                window.dispatchEvent(
                  new HashChangeEvent('hashchange', {
                    oldURL: currentUrl.href,
                    newURL: href
                  })
                )
              }
              if (hash) {
                // use smooth scroll when clicking on header anchor links
                scrollTo(link, hash, link.classList.contains('header-anchor'))
              } else {
                window.scrollTo(0, 0)
              }
            } else {
              go(href)
            }
          }
        }
      },
      { capture: true }
    )

    // 监听 popstate 事件，当浏览器历史记录发生变化时，重新加载对应的页面
    window.addEventListener('popstate', async (e) => {
      if (e.state === null) {
        return
      }
      await loadPage(
        normalizeHref(location.href),
        (e.state && e.state.scrollPosition) || 0
      )
      router.onAfterRouteChanged?.(location.href)
    })

    // 监听 hashchange 事件，当哈希值变化时，阻止默认行为
    window.addEventListener('hashchange', (e) => {
      e.preventDefault()
    })
  }

  // 处理开发环境下的热模块替换功能，确保在开发时路由能够实时更新
  handleHMR(route)

  return router
}

export function useRouter(): Router {
  const router = inject(RouterSymbol)
  if (!router) {
    throw new Error('useRouter() is called without provider.')
  }
  return router
}

export function useRoute(): Route {
  return useRouter().route
}

export function scrollTo(el: Element, hash: string, smooth = false) {
  let target: Element | null = null

  try {
    target = el.classList.contains('header-anchor')
      ? el
      : document.getElementById(decodeURIComponent(hash).slice(1))
  } catch (e) {
    console.warn(e)
  }

  if (target) {
    const targetPadding = parseInt(
      window.getComputedStyle(target).paddingTop,
      10
    )
    const targetTop =
      window.scrollY +
      target.getBoundingClientRect().top -
      getScrollOffset() +
      targetPadding
    function scrollToTarget() {
      // only smooth scroll if distance is smaller than screen height.
      if (!smooth || Math.abs(targetTop - window.scrollY) > window.innerHeight)
        window.scrollTo(0, targetTop)
      else window.scrollTo({ left: 0, top: targetTop, behavior: 'smooth' })
    }
    requestAnimationFrame(scrollToTarget)
  }
}

function handleHMR(route: Route): void {
  // update route.data on HMR updates of active page
  if (import.meta.hot) {
    // hot reload pageData
    import.meta.hot.on('vitepress:pageData', (payload: PageDataPayload) => {
      if (shouldHotReload(payload)) {
        route.data = payload.pageData
      }
    })
  }
}

function shouldHotReload(payload: PageDataPayload): boolean {
  const payloadPath = payload.path.replace(/(?:(^|\/)index)?\.md$/, '$1')
  const locationPath = location.pathname
    .replace(/(?:(^|\/)index)?\.html$/, '')
    .slice(siteDataRef.value.base.length - 1)
  return payloadPath === locationPath
}

function normalizeHref(href: string): string {
  const url = new URL(href, fakeHost)
  url.pathname = url.pathname.replace(/(^|\/)index(\.html)?$/, '$1')
  // ensure correct deep link so page refresh lands on correct files.
  if (siteDataRef.value.cleanUrls)
    url.pathname = url.pathname.replace(/\.html$/, '')
  else if (!url.pathname.endsWith('/') && !url.pathname.endsWith('.html'))
    url.pathname += '.html'
  return url.pathname + url.search + url.hash
}
