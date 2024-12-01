import {
  intro,
  outro,
  group,
  text,
  select,
  cancel,
  confirm
} from '@clack/prompts'
import fs from 'fs-extra'
import path from 'path'
import { cyan, bold, yellow } from 'picocolors'
import { fileURLToPath } from 'url'
import template from 'lodash.template'

export enum ScaffoldThemeType {
  Default = 'default theme', // 默认主题
  DefaultCustom = 'default theme + customization', // 默认主题 + 自定义主题
  Custom = 'custom theme' // 自定义主题
}

export interface ScaffoldOptions {
  root: string // 表示 VitePress 配置应该初始化到哪个目录
  title?: string // 站点的标题
  description?: string // 站点的描述
  theme: ScaffoldThemeType // 站点的主题
  useTs: boolean // 是否希望在配置和主题文件中使用 TypeScript
  injectNpmScripts: boolean // 是否将 VitePress 的 npm 脚本添加到 package.json 文件中
}

/**
 * 用于检测并返回当前使用的包管理器的名称
 */
const getPackageManger = () => {
  const name = process.env?.npm_config_user_agent || 'npm'
  return name.split('/')[0]
}

/**
 * 用于在命令行中初始化一个 VitePress 项目。它通过交互式提示获取用户输入，使用 ScaffoldOptions 配置初始化参数，并在最后执行与这些配置相关的操作。
 * 主要的功能包括获取用户输入的配置（如根目录、站点标题、主题选择等）以及在项目中设置这些配置
 */
export async function init() {
  // 显示欢迎消息，使用 cyan 颜色和 bold 字体样式
  // intro 函数通常用于在 CLI 应用程序启动时展示一段欢迎文本，可能是通过 chalk 或类似库来设置文本样式
  intro(bold(cyan('Welcome to VitePress!')))

  // 命令行配置步骤
  // 使用 group 函数生成一个交互式的命令行界面，提示用户输入配置选项。ScaffoldOptions 是一个类型定义，代表最终的配置对象
  const options: ScaffoldOptions = await group(
    {
      // root 是配置选项之一，表示 VitePress 配置应该初始化到哪个目录
      root: () =>
        text({
          message: 'Where should VitePress initialize the config?', // 交互式输入提示信息
          initialValue: './', // 设置默认值为当前目录（./）
          validate(value) { // 用于验证输入的目录路径
            // TODO make sure directory is inside
          }
        }),

      // title 配置选项，提示用户输入站点的标题
      title: () =>
        text({
          message: 'Site title:', // 交互式输入提示信息
          placeholder: 'My Awesome Project' // 如果用户没有输入，则使用这个占位符
        }),

      // description 配置选项，提示用户输入站点的描述
      description: () =>
        text({
          message: 'Site description:',
          placeholder: 'A VitePress Site'
        }),

      // theme 配置选项，提示用户选择站点的主题
      theme: () =>
        select({ // 提供了三个主题选项：Default Theme（默认主题）、Default Theme + Customization（默认主题并可自定义）、Custom Theme（完全自定义主题）
          message: 'Theme:',
          options: [
            {
              // @ts-ignore
              value: ScaffoldThemeType.Default,
              label: 'Default Theme',
              hint: 'Out of the box, good-looking docs'
            },
            {
              // @ts-ignore
              value: ScaffoldThemeType.DefaultCustom,
              label: 'Default Theme + Customization',
              hint: 'Add custom CSS and layout slots'
            },
            {
              // @ts-ignore
              value: ScaffoldThemeType.Custom,
              label: 'Custom Theme',
              hint: 'Build your own or use external'
            }
          ]
        }),

      // useTs 配置选项，询问用户是否希望在配置和主题文件中使用 TypeScript
      useTs: () =>
          // confirm 是一个交互式的确认框，返回一个布尔值（true 或 false），表示用户是否同意
        confirm({ message: 'Use TypeScript for config and theme files?' }),

      // injectNpmScripts 配置选项，询问用户是否将 VitePress 的 npm 脚本添加到 package.json 文件中
      injectNpmScripts: () =>
        confirm({
          message: 'Add VitePress npm scripts to package.json?'
        })
    },
    { // onCancel 是取消操作时触发的回调函数
      onCancel: () => {
        cancel('Cancelled.')
        process.exit(0)
      }
    }
  )

  // outro 通常用于展示结束时的消息或操作
  outro(scaffold(options))
}

/**
 * 主要用于根据用户的配置生成一个 VitePress 项目结构和配置文件。
 * 它会根据用户输入的选项（如根目录、站点标题、描述、主题、是否使用 TypeScript 等）生成必要的文件，并提供一些后续步骤和提示
 * @param root 用户指定的根目录，默认为 ./
 * @param title 站点标题，默认为 "My Awesome Project"
 * @param description 站点描述，默认为 "A VitePress Site"
 * @param theme 来自用户输入的选项，表示主题类型
 * @param useTs 是否使用 TypeScript
 * @param injectNpmScripts 是否将 VitePress 的 npm 脚本添加到 package.json
 */
export function scaffold({
  root = './',
  title = 'My Awesome Project',
  description = 'A VitePress Site',
  theme,
  useTs,
  injectNpmScripts
}: ScaffoldOptions): string {
  const resolvedRoot = path.resolve(root) // 解析后的根目录路径
  // 模板目录的路径，指向项目模板的文件夹
  const templateDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../template'
  )

  // data 对象存储了最终需要渲染模板的数据，包括站点标题、描述、是否使用 TypeScript 以及默认主题标志
  const data = {
    title: JSON.stringify(title),
    description: JSON.stringify(description),
    useTs,
    defaultTheme:
      theme === ScaffoldThemeType.Default ||
      theme === ScaffoldThemeType.DefaultCustom
  }

  // 解析当前目录下的 package.json，如果存在则读取内容并解析为 JSON 对象。如果文件不存在，userPkg 为一个空对象
  const pkgPath = path.resolve('package.json')
  const userPkg = fs.existsSync(pkgPath)
    ? JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    : {}

  // 判断项目是否是使用 ES Module（package.json 中的 type 字段）。如果 type 不等于 'module'，则使用 .mjs 文件扩展名
  const useMjs = userPkg.type !== 'module'

  /**
   * 用于渲染模板文件，并将渲染后的内容写入目标文件
   * @param file
   */
  const renderFile = (file: string) => {
    const filePath = path.resolve(templateDir, file) // 模板文件的源路径
    // 目标文件路径，根据 useMjs 和 useTs 来调整文件扩展名
    let targetPath = path.resolve(resolvedRoot, file)
    if (useMjs && file === '.vitepress/config.js') {
      targetPath = targetPath.replace(/\.js$/, '.mjs')
    }
    if (useTs) {
      targetPath = targetPath.replace(/\.(m?)js$/, '.$1ts')
    }
    // 读取模板文件的内容
    const src = fs.readFileSync(filePath, 'utf-8')
    // 渲染模板并将用户提供的数据填充到模板中
    const compiled = template(src)(data)
    fs.outputFileSync(targetPath, compiled)
  }

  const filesToScaffold = [
    'index.md',
    'api-examples.md',
    'markdown-examples.md',
    '.vitepress/config.js'
  ]

  if (theme === ScaffoldThemeType.DefaultCustom) { // 默认+自定义主题
    filesToScaffold.push(
      '.vitepress/theme/index.js',
      '.vitepress/theme/style.css'
    )
  } else if (theme === ScaffoldThemeType.Custom) { // 自定义主题
    filesToScaffold.push(
      '.vitepress/theme/index.js',
      '.vitepress/theme/style.css',
      '.vitepress/theme/Layout.vue'
    )
  }

  for (const file of filesToScaffold) {
    renderFile(file)
  }

  // 获取 .vitepress 目录
  const dir =
    root === './' ? '' : ` ${root.replace(/^\.\//, '').replace(/[/\\]$/, '')}`
  const gitignorePrefix = dir ? `${dir}/.vitepress` : '.vitepress'

  const tips = []
  // 如果 .git 存在，提醒用户将构建产物和缓存添加到 .gitignore
  if (fs.existsSync('.git')) {
    tips.push(
      `Make sure to add ${cyan(`${gitignorePrefix}/dist`)} and ` +
        `${cyan(`${gitignorePrefix}/cache`)} to your ` +
        `${cyan(`.gitignore`)} file.`
    )
  }
  // 如果用户选择了自定义主题并且没有安装 vue，提醒用户安装 vue
  if (
    theme !== ScaffoldThemeType.Default &&
    !userPkg.dependencies?.['vue'] &&
    !userPkg.devDependencies?.['vue']
  ) {
    tips.push(
      `Since you've chosen to customize the theme, ` +
        `you should also explicitly install ${cyan(`vue`)} as a dev dependency.`
    )
  }

  const tip = tips.length ? yellow([`\n\nTips:`, ...tips].join('\n- ')) : ``

  // 根据 injectNpmScripts 的值，决定是否将 VitePress 的 npm 脚本添加到 package.json 中
  if (injectNpmScripts) {
    const scripts = {
      'docs:dev': `vitepress dev${dir}`,
      'docs:build': `vitepress build${dir}`,
      'docs:preview': `vitepress preview${dir}`
    }
    Object.assign(userPkg.scripts || (userPkg.scripts = {}), scripts)
    fs.writeFileSync(pkgPath, JSON.stringify(userPkg, null, 2))
    return `Done! Now run ${cyan(
      `${getPackageManger()} run docs:dev`
    )} and start writing.${tip}`
  } else {
    const pm = getPackageManger()
    return `You're all set! Now run ${cyan(
      `${pm === 'npm' ? 'npx' : pm} vitepress dev${dir}`
    )} and start writing.${tip}`
  }
}
