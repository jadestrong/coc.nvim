'use strict'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import fs from 'fs-extra'
import { parse, ParseError } from 'jsonc-parser'
import os from 'os'
import path from 'path'
import readline from 'readline'
import semver from 'semver'
import { statAsync } from '../util/fs'
import { omit } from '../util/lodash'
import workspace from '../workspace'
import download from './download'
import fetch from './fetch'
const logger = require('../util/logger')('model-installer')
const HOME_DIR = global.__TEST__ ? os.tmpdir() : os.homedir()

export interface Info {
  'dist.tarball'?: string
  'engines.coc'?: string
  version?: string
  name?: string
}

export type Dependencies = Record<string, string>

export function registryUrl(scope = 'coc.nvim'): string {
  let res = 'https://registry.npmjs.org/'
  // 查看系统 home 目录下的 .npmrc 文件
  // 如果 .npmrc 中定义了 scope 为 coc.nvim 的源，或着全局源，则使用用户指定的，否则使用官方 npm
  let filepath = path.join(HOME_DIR, '.npmrc')
  if (fs.existsSync(filepath)) {
    try {
      let content = fs.readFileSync(filepath, 'utf8')
      let obj = {}
      for (let line of content.split(/\r?\n/)) {
        if (line.indexOf('=') > -1) {
          let [_, key, val] = line.match(/^(.*?)=(.*)$/)
          obj[key] = val
        }
      }
      if (obj[`${scope}:registry`]) {
        res = obj[`${scope}:registry`]
      } else if (obj['registry']) {
        res = obj['registry']
      }
    } catch (e) {
      logger.error('Error on read .npmrc:', e)
    }
  }
  return res.endsWith('/') ? res : res + '/'
}

export function isNpmCommand(exePath: string): boolean {
  let name = path.basename(exePath)
  return name === 'npm' || name === 'npm.CMD'
}

export function isYarn(exePath: string) {
  let name = path.basename(exePath)
  return ['yarn', 'yarn.CMD', 'yarnpkg', 'yarnpkg.CMD'].includes(name)
}

// 拼接 npm 的 install 命令，可以不生成 lock-file 哦！！
export function getInstallArguments(exePath: string, url: string): string[] {
  // --production 只会安装 dependencies
  let args = ['install', '--ignore-scripts', '--no-lockfile', '--production']
  if (url.startsWith('https://github.com')) {
    args = ['install']
  }
  // npm 安装
  if (isNpmCommand(exePath)) {
    args.push('--legacy-peer-deps')
    args.push('--no-global')
  }
  // yarn 安装
  if (isYarn(exePath)) {
    args.push('--ignore-engines')
  }
  return args
}

// remove properties that should be devDependencies.
export function getDependencies(content: string): Dependencies {
  let dependencies: Dependencies
  try {
    let obj = JSON.parse(content)
    dependencies = obj.dependencies || {}
  } catch (e) {
    // noop
    dependencies = {}
  }
  return omit(dependencies, ['coc.nvim', 'esbuild', 'webpack', '@types/node'])
}

function isSymbolicLink(folder: string): boolean {
  if (fs.existsSync(folder)) {
    let stat = fs.lstatSync(folder)
    if (stat.isSymbolicLink()) {
      return true
    }
  }
  return false
}

// 下载插件的文件到一个临时目录中，顺序下载，并行安装
// 然后在该插件的目录下通过开启一个 child_process 来执行 npm install
export class Installer extends EventEmitter {
  private name: string
  private url: string
  private version: string
  constructor(
    private root: string, // coc 根目录下的 extensions 文件夹
    private npm: string,
    // could be url or name@version or name
    private def: string
  ) {
    super()
    if (!fs.existsSync(root)) fs.mkdirpSync(root)
    if (/^https?:/.test(def)) {
      this.url = def
    } else {
      let ms = def.match(/(.+)@([^/]+)$/)
      if (ms) {
        this.name = ms[1]
        this.version = ms[2]
      } else {
        this.name = def
      }
    }
  }

  public get info() {
    return { name: this.name, version: this.version }
  }

  // 入口
  public async install(): Promise<string> {
    this.log(`Using npm from: ${this.npm}`)
    let info = await this.getInfo()
    logger.info(`Fetched info of ${this.def}`, info)
    let { name } = info
    let required = info['engines.coc'] ? info['engines.coc'].replace(/^\^/, '>=') : ''
    if (required && !semver.satisfies(workspace.version, required)) {
      throw new Error(`${name} ${info.version} requires coc.nvim >= ${required}, please update coc.nvim.`)
    }
    await this.doInstall(info)
    return name
  }

  public async update(url?: string): Promise<string> {
    this.url = url
    // 根据插件的名字，可以直到其在 extensions 目录的地址
    let folder = path.join(this.root, this.name)
    // 软链直接跳过
    if (isSymbolicLink(folder)) {
      this.log(`Skipped update for symbol link`)
      return
    }
    // 拿到之前安装的插件的版本
    let version: string
    if (fs.existsSync(path.join(folder, 'package.json'))) {
      let content = await fs.readFile(path.join(folder, 'package.json'), 'utf8')
      version = JSON.parse(content).version
    }
    this.log(`Using npm from: ${this.npm}`)
    let info = await this.getInfo()
    // semver 比较版本
    if (version && info.version && semver.gte(version, info.version)) {
      this.log(`Current version ${version} is up to date.`)
      return
    }
    let required = info['engines.coc'] ? info['engines.coc'].replace(/^\^/, '>=') : ''
    // 比较插件依赖的 coc.nvim 的版本和当前使用的 coc.nvim 的版本
    if (required && !semver.satisfies(workspace.version, required)) {
      throw new Error(`${info.version} requires coc.nvim ${required}, please update coc.nvim.`)
    }
    await this.doInstall(info)
    let jsonFile = path.join(this.root, info.name, 'package.json')
    this.log(`Updated to v${info.version}`)
    // 返回目录的地址
    return path.dirname(jsonFile)
  }

  public async doInstall(info: Info): Promise<boolean> {
    let folder = path.join(this.root, info.name)
    if (isSymbolicLink(folder)) return false
    let tmpFolder = await fs.mkdtemp(path.join(os.tmpdir(), `${info.name.replace('/', '-')}-`))
    let url = info['dist.tarball']
    this.log(`Downloading from ${url}`)
    // 下载插件
    await download(url, { dest: tmpFolder, onProgress: p => this.log(`Download progress ${p}%`, true), extract: 'untar' })
    this.log(`Extension download at ${tmpFolder}`)
    let content = await fs.readFile(path.join(tmpFolder, 'package.json'), 'utf8')
    // 拿到插件 package.json 中的 dependencies
    let dependencies = getDependencies(content)
    // 如果有依赖才执行 npm 安装
    if (Object.keys(dependencies).length) {
      let p = new Promise<void>((resolve, reject) => {
        let args = getInstallArguments(this.npm, url)
        this.log(`Installing dependencies by: ${this.npm} ${args.join(' ')}.`)
        // 在 tmpFolder 下通过 child_process 来执行 npm install
        const child = spawn(this.npm, args, {
          cwd: tmpFolder,
        })
        // 读取进程的输出内容
        const rl = readline.createInterface({
          input: child.stdout
        })
        rl.on('line', line => {
          this.log(`[npm] ${line}`, true)
        })
        child.stderr.setEncoding('utf8')
        child.stdout.setEncoding('utf8')
        child.on('error', reject)
        let err = ''
        child.stderr.on('data', data => {
          err += data
        })
        child.on('exit', code => {
          if (code) {
            if (err) this.log(err)
            reject(new Error(`${this.npm} install exited with ${code}`))
            return
          }
          resolve()
        })
      })
      // 等待安装完成
      await p
    }
    // 这是 root 下的 package.json 文件？
    let jsonFile = path.resolve(this.root, global.__TEST__ ? '' : '..', 'package.json')
    let errors: ParseError[] = []
    if (!fs.existsSync(jsonFile)) fs.writeFileSync(jsonFile, '{}')
    let obj = parse(fs.readFileSync(jsonFile, 'utf8'), errors, { allowTrailingComma: true })
    if (errors && errors.length > 0) {
      throw new Error(`Error on load ${jsonFile}`)
    }
    obj.dependencies = obj.dependencies || {}
    // 写入该插件的依赖信息
    if (this.url) {
      obj.dependencies[info.name] = this.url
    } else {
      obj.dependencies[info.name] = '>=' + info.version
    }
    const sortedObj = { dependencies: {} }
    // 对 dependencies 进行排序，得到 sorted 后的结果
    Object.keys(obj.dependencies).sort().forEach(k => {
      sortedObj.dependencies[k] = obj.dependencies[k]
    })
    let stat = await statAsync(folder)
    if (stat) {
      if (stat.isDirectory()) {
        fs.removeSync(folder)
      } else {
        fs.unlinkSync(folder)
      }
    }
    // 将安装完成的临时目录移动到插件目录文件夹，并重新命名为插件的文件
    await fs.move(tmpFolder, folder, { overwrite: true })
    // 将 sortedObj 写入到 root 的 package.json
    // 也就是 extensions 目录下的 package.json 文件中会记录所有安装的插件的信息，记录所有安装的插件的信息
    // 主要是用于执行更新命令时，可以提起检查版本是否已经是最新了
    await fs.writeFile(jsonFile, JSON.stringify(sortedObj, null, 2), { encoding: 'utf8' })
    // 删除临时目录
    if (fs.existsSync(tmpFolder)) fs.rmdirSync(tmpFolder)
    this.log(`Update package.json at ${jsonFile}`)
    this.log(`Installed extension ${this.name}@${info.version} at ${folder}`)
    return true
  }

  public async getInfo(): Promise<Info> {
    if (this.url) return await this.getInfoFromUri()
    // 获取 registry url
    let registry = registryUrl()
    this.log(`Get info from ${registry}`)
    // 读取 npm 的元信息？比如 https://registry.npmjs.org/typescript
    let buffer = await fetch(registry + this.name, { timeout: 10000, buffer: true })
    let res = JSON.parse(buffer.toString())
    // 拿到最新的版本号
    if (!this.version) this.version = res['dist-tags']['latest']
    let obj = res['versions'][this.version]
    if (!obj) throw new Error(`${this.def} doesn't exists in ${registry}.`)
    // 拿到 package.json 中定义的依赖 coc 的版本号
    let requiredVersion = obj['engines'] && obj['engines']['coc']
    // 没有，则表示不是一个合法的 coc extension ，抛出错误信息
    if (!requiredVersion) {
      throw new Error(`${this.def} is not valid coc extension, "engines" field with coc property required.`)
    }
    // tarball 的下载地址，比如 "https://registry.npmjs.org/coc-tsserver/-/coc-tsserver-1.0.0.tgz",
    return {
      'dist.tarball': obj['dist']['tarball'],
      'engines.coc': requiredVersion,
      version: obj['version'],
      name: res.name
    } as Info
  }

  public async getInfoFromUri(): Promise<Info> {
    let { url } = this
    if (!url.startsWith('https://github.com')) {
      throw new Error(`"${url}" is not supported, coc.nvim support github.com only`)
    }
    url = url.replace(/\/$/, '')
    let branch = 'master'
    if (url.includes('@')) {
      // https://github.com/sdras/vue-vscode-snippets@main
      let idx = url.indexOf('@')
      branch = url.substr(idx + 1)
      url = url.substring(0, idx)
    }
    let fileUrl = url.replace('github.com', 'raw.githubusercontent.com') + `/${branch}/package.json`
    this.log(`Get info from ${fileUrl}`)
    let content = await fetch(fileUrl, { timeout: 10000 })
    let obj = typeof content == 'string' ? JSON.parse(content) : content
    this.name = obj.name
    return {
      'dist.tarball': `${url}/archive/${branch}.tar.gz`,
      'engines.coc': obj['engines'] ? obj['engines']['coc'] : null,
      name: obj.name,
      version: obj.version
    }
  }

  private log(msg: string, isProgress = false): void {
    logger.info(msg)
    // 并 emit 中 npm 安装进程抛出的 message
    this.emit('message', msg, isProgress)
  }
}

export function createInstallerFactory(npm: string, root: string): (def: string) => Installer {
  return (def): Installer => new Installer(root, npm, def)
}
