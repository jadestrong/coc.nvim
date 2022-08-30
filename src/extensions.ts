'use strict'
import { debounce } from 'debounce'
import fs from 'fs-extra'
import isuri from 'isuri'
import { parse, ParseError } from 'jsonc-parser'
import path from 'path'
import semver from 'semver'
import { Disposable, Emitter, Event } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import which from 'which'
import commandManager from './commands'
import Watchman from './core/watchman'
import events from './events'
import DB from './model/db'
import FloatFactory from './model/floatFactory'
import InstallBuffer from './model/installBuffer'
import { createInstallerFactory } from './model/installer'
import Memos from './model/memos'
import { OutputChannel } from './types'
import { concurrent, disposeAll, wait, watchFile } from './util'
import { distinct, splitArray } from './util/array'
import './util/extensions'
import { createExtension, ExtensionExport } from './util/factory'
import { checkFolder, readFile, statAsync } from './util/fs'
import { objectLiteral } from './util/is'
import window from './window'
import workspace from './workspace'

const createLogger = require('./util/logger')
const logger = createLogger('extensions')

export type API = { [index: string]: any } | void | null | undefined

export type ExtensionState = 'disabled' | 'loaded' | 'activated' | 'unknown'

export enum ExtensionType {
  Global,
  Local,
  SingleFile,
  Internal
}

export interface PropertyScheme {
  type: string
  default: any
  description: string
  enum?: string[]
  items?: any
  [key: string]: any
}

export interface Extension<T> {
  readonly id: string
  readonly extensionPath: string
  readonly isActive: boolean
  readonly packageJSON: any
  readonly exports: T
  activate(): Promise<T>
}

export interface ExtensionItem {
  readonly id: string
  readonly type: ExtensionType
  extension: Extension<API>
  deactivate: () => void | Promise<void>
  filepath?: string
  directory?: string
  readonly isLocal: boolean
}

export interface ExtensionJson {
  name: string
  main?: string
  engines: {
    [key: string]: string
  }
  version?: string
  [key: string]: any
}

export interface ExtensionInfo {
  id: string
  version: string
  description: string
  root: string
  exotic: boolean
  uri?: string
  state: ExtensionState
  isLocal: boolean
  packageJSON: Readonly<ExtensionJson>
}

// global local file native
export class Extensions {
  private extensions: Map<string, ExtensionItem> = new Map()
  private disabled: Set<string> = new Set()
  private db: DB
  private memos: Memos
  private root: string
  private _onDidLoadExtension = new Emitter<Extension<API>>()
  private _onDidActiveExtension = new Emitter<Extension<API>>()
  private _onDidUnloadExtension = new Emitter<string>()
  private _additionalSchemes: { [key: string]: PropertyScheme } = {}
  private activated = false
  private installBuffer: InstallBuffer
  private disposables: Disposable[] = []
  private _outputChannel: OutputChannel | undefined
  public ready = true
  public readonly onDidLoadExtension: Event<Extension<API>> = this._onDidLoadExtension.event
  public readonly onDidActiveExtension: Event<Extension<API>> = this._onDidActiveExtension.event
  public readonly onDidUnloadExtension: Event<string> = this._onDidUnloadExtension.event

  constructor() {
    let folder = global.__TEST__ ? path.join(__dirname, '__tests__') : process.env.COC_DATA_HOME
    // COC_DATA_HOME 下的 extensions 目录，即插件的 root 目录
    let root = this.root = path.join(folder, 'extensions')
    let checked = this.checkRoot(root)
    if (checked) {
      let filepath = path.join(root, 'db.json')
      this.db = new DB(filepath)
    }
  }

  public checkRoot(root: string): boolean {
    try {
      if (!fs.existsSync(root)) {
        fs.mkdirpSync(root)
      }
      let stat = fs.statSync(root)
      if (stat.isFile()) {
        logger.info(`Trying to delete ${root}`)
        fs.unlinkSync(root)
        fs.mkdirpSync(root)
      } else if (!stat.isDirectory()) {
        console.error(`Data home ${root} it not a valid directory`)
        return false
      }
      let jsonFile = path.join(root, 'package.json')
      if (!fs.existsSync(jsonFile)) {
        fs.writeFileSync(jsonFile, '{"dependencies":{}}', 'utf8')
      }
    } catch (e) {
      console.error(`Unexpected error when check data home: ${e}`)
      return false
    }
    return true
  }

  private get outputChannel(): OutputChannel {
    if (this._outputChannel) return this._outputChannel
    this._outputChannel = window.createOutputChannel('extensions')
    return this._outputChannel
  }

  public async init(): Promise<void> {
    // 从 db 中拿到这个 obj 是什么？
    let extensionObj = this.db.fetch('extension') || {}
    let keys = Object.keys(extensionObj)
    // 如果注明了要 disable 则 disable 它
    for (let key of keys) {
      if (extensionObj[key].disabled == true) {
        this.disabled.add(key)
      }
    }
    // 如果不加载插件，则直接返回
    if (process.env.COC_NO_PLUGINS) return
    // 插件的统计信息？ global and local
    let stats = await this.globalExtensionStats()
    let localStats = await this.localExtensionStats(stats.map(o => o.id))
    stats = stats.concat(localStats)
    this.memos = new Memos(path.resolve(this.root, '../memos.json'))

    stats.map(stat => {
      let extensionType = stat.isLocal ? ExtensionType.Local : ExtensionType.Global
      try {
        // 自行创建？
        this.createExtension(stat.root, stat.packageJSON, extensionType)
      } catch (e) {
        logger.error(`Error on create ${stat.root}:`, e)
      }
    })
    // 又加载文件插件，和上面的区别是什么？
    await this.loadFileExtensions()
    commandManager.register({
      id: 'extensions.forceUpdateAll',
      execute: async () => {
        let arr = await this.cleanExtensions()
        logger.info(`Force update extensions: ${arr}`)
        await this.installExtensions(arr)
      }
    }, false, 'remove all global extensions and install them')
    workspace.onDidRuntimePathChange(async paths => {
      for (let p of paths) {
        if (p && this.checkDirectory(p) === true) {
          await this.loadExtension(p)
        }
      }
    }, null, this.disposables)
  }

  public getExtensionsInfo(): { name: string, directory: string, filepath?: string }[] {
    let res: { name: string, directory: string, filepath?: string }[] = []
    for (let [key, entry] of this.extensions.entries()) {
      let { directory, filepath } = entry
      if (!directory) directory = filepath
      entry.type
      if (directory) res.push({
        name: key,
        filepath,
        directory: directory.endsWith(path.sep) ? directory : directory + path.sep
      })
    }
    return res
  }

  public activateExtensions(): void {
    this.activated = true
    for (let item of this.extensions.values()) {
      let { id, packageJSON } = item.extension
      this.setupActiveEvents(id, packageJSON).logError()
    }
    // make sure workspace.env exists
    let floatFactory = new FloatFactory(workspace.nvim)
    events.on('CursorMoved', debounce(async bufnr => {
      if (this.installBuffer && bufnr == this.installBuffer.bufnr) {
        let lnum = await workspace.nvim.call('line', ['.'])
        let msgs = this.installBuffer.getMessages(lnum - 1)
        let docs = msgs && msgs.length ? [{ content: msgs.join('\n'), filetype: 'txt' }] : []
        await floatFactory.show(docs, { modes: ['n'] })
      }
    }, 500))
    if (global.__TEST__) return
    // check extensions need watch & install
    this.checkExtensions()
    let config = workspace.getConfiguration('coc.preferences')
    let interval = config.get<string>('extensionUpdateCheck', 'never')
    let silent = config.get<boolean>('silentAutoupdate', true)
    if (interval != 'never') {
      let now = new Date()
      let day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (interval == 'daily' ? 0 : 7))
      let ts = this.db.fetch('lastUpdate')
      if (ts && Number(ts) > day.getTime()) return
      this.outputChannel.appendLine('Start auto update...')
      this.updateExtensions(false, silent).logError()
    }
  }

  public async updateExtensions(sync?: boolean, silent = false): Promise<Disposable | null> {
    if (!this.npm) return
    let lockedList = await this.getLockedList()
    let stats = await this.globalExtensionStats()
    stats = stats.filter(o => ![...lockedList, ...this.disabled].includes(o.id))
    this.db.push('lastUpdate', Date.now())
    if (silent) {
      window.showMessage('Updating extensions, checkout output:///extensions for details.', 'more')
    }
    let installBuffer = this.installBuffer = new InstallBuffer(true, sync, silent ? this.outputChannel : undefined)
    installBuffer.setExtensions(stats.map(o => o.id))
    await installBuffer.show(workspace.nvim)
    let createInstaller = createInstallerFactory(this.npm, this.modulesFolder)
    let fn = (stat: ExtensionInfo): Promise<void> => {
      let { id } = stat
      installBuffer.startProgress([id])
      let url = stat.exotic ? stat.uri : null
      // msg => installBuffer.addMessage(id, msg)
      let installer = createInstaller(id)
      installer.on('message', (msg, isProgress) => {
        installBuffer.addMessage(id, msg, isProgress)
      })
      // 执行 update 后返回的是更新的插件的目录地址
      return installer.update(url).then(directory => {
        installBuffer.finishProgress(id, true)
        if (directory) {
          this.loadExtension(directory).logError()
        }
      }, err => {
        installBuffer.addMessage(id, err.message)
        installBuffer.finishProgress(id, false)
      })
    }
    await concurrent(stats, fn, silent ? 1 : 3)
  }

  private checkExtensions(): void {
    let { globalExtensions } = workspace.env
    if (globalExtensions && globalExtensions.length) {
      let names = this.filterGlobalExtensions(globalExtensions)
      void this.installExtensions(names)
    }
  }

  public get installer() {
    return createInstallerFactory(this.npm, this.modulesFolder)
  }

  /**
   * :CocInstall 的实际执行的方法
   * Install extensions, can be called without initialize.
   */
  public async installExtensions(list: string[] = []): Promise<void> {
    let { npm } = this
    if (!npm || !list.length) return
    list = distinct(list)
    // 这个应该是 vim 里面安装时弹出的那个 buffer ，里面有要安装的插件的列表以及安装进度等信息
    let installBuffer = this.installBuffer = new InstallBuffer()
    installBuffer.setExtensions(list)
    await installBuffer.show(workspace.nvim)

    // 安装器工厂？用什么实现的？ worker 吗，还是 child_process
    // modulesFolder 是 root 目录
    let createInstaller = createInstallerFactory(this.npm, this.modulesFolder)
    let fn = (key: string): Promise<void> => {
      installBuffer.startProgress([key])
      let installer = createInstaller(key)
      // 监听安装器发送出来的 message ，更新 buffer 中的 progress 信息
      installer.on('message', (msg, isProgress) => {
        installBuffer.addMessage(key, msg, isProgress)
      })
      // 启动安装
      return installer.install().then(name => {
        installBuffer.finishProgress(key, true)
        let directory = path.join(this.modulesFolder, name)
        // 安装完成，加载该插件
        this.loadExtension(directory).logError()
        let ms = key.match(/(.+)@([^/]+)$/)
        if (ms != null) void this.lockExtension(name, true)
      }, err => {
        installBuffer.addMessage(key, err.message)
        installBuffer.finishProgress(key, false)
        logger.error(`Error on install ${key}`, err)
      })
    }
    // 同时安装 list ，针对 list 的中的每一个 item 执行 fn
    await concurrent(list, fn)
  }

  /**
   * Get list of extensions in package.json that not installed
   */
  public getMissingExtensions(): string[] {
    let json = this.loadJson() || { dependencies: {} }
    let ids: string[] = []
    for (let key of Object.keys(json.dependencies)) {
      let folder = path.join(this.modulesFolder, key)
      if (!fs.existsSync(folder)) {
        let val = json.dependencies[key]
        if (val.startsWith('http')) {
          ids.push(val)
        } else {
          ids.push(key)
        }
      }
    }
    return ids
  }

  public get npm(): string {
    let npm = workspace.getConfiguration('npm').get<string>('binPath', 'npm')
    npm = workspace.expand(npm)
    for (let exe of [npm, 'yarnpkg', 'yarn', 'npm']) {
      try {
        let res = which.sync(exe)
        return res
      } catch (e) {
        continue
      }
    }
    window.showMessage(`Can't find npm or yarn in your $PATH`, 'error')
    return null
  }

  /**
   * Get all loaded extensions.
   */
  public get all(): Extension<API>[] {
    return Array.from(this.extensions.values()).map(o => o.extension).filter(o => !this.isDisabled(o.id))
  }

  public getExtension(id: string): ExtensionItem {
    return this.extensions.get(id)
  }

  public getExtensionState(id: string): ExtensionState {
    let disabled = this.isDisabled(id)
    if (disabled) return 'disabled'
    let item = this.extensions.get(id)
    if (!item) return 'unknown'
    let { extension } = item
    return extension.isActive ? 'activated' : 'loaded'
  }

  public async getExtensionStates(): Promise<ExtensionInfo[]> {
    let localStats = await this.localExtensionStats([])
    let globalStats = await this.globalExtensionStats()
    return localStats.concat(globalStats.filter(o => localStats.find(s => s.id == o.id) == null))
  }

  public async getLockedList(): Promise<string[]> {
    let obj = await this.db.fetch('extension')
    obj = obj || {}
    return Object.keys(obj).filter(id => obj[id].locked === true)
  }

  public async lockExtension(id: string, lock?: boolean): Promise<void> {
    let key = `extension.${id}.locked`
    let locked = await this.db.fetch(key)
    lock = lock === undefined ? !locked : lock
    if (lock) {
      this.db.push(key, true)
    } else {
      this.db.delete(key)
    }
  }

  public async toggleExtension(id: string): Promise<void> {
    let state = this.getExtensionState(id)
    if (state == null) return
    if (state == 'activated') {
      await this.deactivate(id)
    }
    let key = `extension.${id}.disabled`
    this.db.push(key, state == 'disabled' ? false : true)
    if (state != 'disabled') {
      this.disabled.add(id)
      await this.unloadExtension(id)
    } else {
      this.disabled.delete(id)
      let folder = path.join(this.modulesFolder, id)
      if (fs.existsSync(folder)) {
        await this.loadExtension(folder)
      }
    }
    await wait(200)
  }

  public async reloadExtension(id: string): Promise<void> {
    let item = this.extensions.get(id)
    if (!item) {
      window.showMessage(`Extension ${id} not registered`, 'error')
      return
    }
    if (item.type == ExtensionType.Internal) {
      window.showMessage(`Can't reload internal extension "${item.id}"`, 'warning')
      return
    }
    if (item.type == ExtensionType.SingleFile) {
      await this.loadExtensionFile(item.filepath)
    } else if (item.directory) {
      await this.loadExtension(item.directory)
    } else {
      window.showMessage(`Can't reload extension ${item.id}`, 'warning')
    }
  }

  /**
   * Unload & remove all global extensions, return removed extensions.
   */
  public async cleanExtensions(): Promise<string[]> {
    let dir = this.modulesFolder
    if (!fs.existsSync(dir)) return []
    let ids = this.globalExtensions
    let res: string[] = []
    for (let id of ids) {
      let directory = path.join(dir, id)
      let stat = await fs.lstat(directory)
      if (!stat || (stat && stat.isSymbolicLink())) continue
      await this.unloadExtension(id)
      await fs.remove(directory)
      res.push(id)
    }
    return res
  }

  public async uninstallExtension(ids: string[]): Promise<void> {
    try {
      if (!ids.length) return
      let [globals, filtered] = splitArray(ids, id => this.globalExtensions.includes(id))
      if (filtered.length) {
        window.showMessage(`Extensions ${filtered} not global extensions, can't uninstall!`, 'warning')
      }
      let json = this.loadJson() || { dependencies: {} }
      for (let id of globals) {
        await this.unloadExtension(id)
        delete json.dependencies[id]
        // remove directory
        let folder = path.join(this.modulesFolder, id)
        if (fs.existsSync(folder)) {
          await fs.remove(folder)
        }
      }
      // update package.json
      const sortedObj = { dependencies: {} }
      Object.keys(json.dependencies).sort().forEach(k => {
        sortedObj.dependencies[k] = json.dependencies[k]
      })
      let jsonFile = path.join(this.root, 'package.json')
      fs.writeFileSync(jsonFile, JSON.stringify(sortedObj, null, 2), { encoding: 'utf8' })
      window.showMessage(`Removed: ${globals.join(' ')}`)
    } catch (e) {
      window.showMessage(`Uninstall failed: ${e}`, 'error')
    }
  }

  public isDisabled(id: string): boolean {
    return this.disabled.has(id)
  }

  public has(id: string): boolean {
    return this.extensions.has(id)
  }

  public isActivated(id: string): boolean {
    let item = this.extensions.get(id)
    if (item && item.extension.isActive) {
      return true
    }
    return false
  }

  /**
   * folder -> 安装的插件的 package.json 所在的目录
   * Load extension from folder, folder should contains coc extension.
   */
  public async loadExtension(folder: string | string[]): Promise<boolean> {
    if (Array.isArray(folder)) {
      for (let f of folder) {
        await this.loadExtension(f)
      }
      return true
    }
    try {
      // 得到父级目录
      let parentFolder = path.dirname(folder)
      // 如果当前插件的目录是我们定义的存放插件的 extensions 目录，表明这是一个本地插件
      let isLocal = path.normalize(parentFolder) != path.normalize(this.modulesFolder)
      let jsonFile = path.join(folder, 'package.json')
      // 读取 package.json 的内容
      let packageJSON = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
      let { name } = packageJSON
      if (this.isDisabled(name)) return false
      // unload if loaded
      await this.unloadExtension(name)
      //
      this.createExtension(folder, Object.freeze(packageJSON), isLocal ? ExtensionType.Local : ExtensionType.Global)
      return true
    } catch (e) {
      window.showMessage(`Error on load extension from "${folder}": ${e}`, 'error')
      logger.error(`Error on load extension from ${folder}`, e)
      return false
    }
  }

  // 加载 coc-extensions 目录下的所有 js 文件
  private async loadFileExtensions(): Promise<void> {
    if (!process.env.COC_VIMCONFIG) return
    let folder = path.join(process.env.COC_VIMCONFIG, 'coc-extensions')
    if (!fs.existsSync(folder)) return
    let files = await fs.readdir(folder)
    files = files.filter(f => f.endsWith('.js'))
    for (let file of files) {
      await this.loadExtensionFile(path.join(folder, file))
    }
  }

  public loadedExtensions(): string[] {
    return Array.from(this.extensions.keys())
  }

  public async watchExtension(id: string): Promise<void> {
    let item = this.extensions.get(id)
    if (!item) {
      window.showMessage(`extension ${id} not found`, 'error')
      return
    }
    if (id.startsWith('single-')) {
      window.showMessage(`watching ${item.filepath}`)
      this.disposables.push(watchFile(item.filepath, async () => {
        await this.loadExtensionFile(item.filepath)
        window.showMessage(`reloaded ${id}`)
      }))
    } else {
      let watchmanPath = workspace.getWatchmanPath()
      if (!watchmanPath) {
        window.showMessage('watchman not found', 'error')
        return
      }
      let client = await Watchman.createClient(watchmanPath, item.directory)
      if (!client) {
        window.showMessage(`Can't create watchman client, check output:///watchman`)
        return
      }
      window.showMessage(`watching ${item.directory}`)
      this.disposables.push(client)
      client.subscribe('**/*.js', async () => {
        await this.reloadExtension(id)
        window.showMessage(`reloaded ${id}`)
      }).then(disposable => {
        this.disposables.push(disposable)
      }, _e => {
        // ignore
      })
    }
  }

  /**
   * Load single javascript file as extension.
   */
  public async loadExtensionFile(filepath: string): Promise<void> {
    let filename = path.basename(filepath)
    let basename = path.basename(filepath, '.js')
    let name = 'single-' + basename
    if (this.isDisabled(name)) return
    let root = path.dirname(filepath)
    let packageJSON = {
      name, main: filename, engines: { coc: '^0.0.79' }
    }
    let confpath = path.join(root, basename + '.json')
    let stat = await statAsync(confpath)
    if (stat && stat.isFile()) {
      let content = await readFile(confpath, 'utf8')
      let obj = JSON.parse(content)
      if (obj) {
        let attrs = ['activationEvents', 'contributes']
        for (const attr of attrs) {
          if (obj[attr]) {
            packageJSON[attr] = obj[attr]
          }
        }
      }
    }
    await this.unloadExtension(name)
    this.createExtension(root, packageJSON, ExtensionType.SingleFile)
  }

  /**
   * 激活插件
   * Activate extension, throw error if disabled or doesn't exist.
   * Returns true if extension successfully activated.
   */
  public async activate(id): Promise<boolean> {
    if (this.isDisabled(id)) {
      throw new Error(`Extension ${id} is disabled!`)
    }
    // 从 createExtension 创建并记录到 extensions map 中的插件列表中，根据 id(name) 得到`插件结构体`
    let item = this.extensions.get(id)
    if (!item) {
      throw new Error(`Extension ${id} not registered!`)
    }
    let { extension } = item
    if (extension.isActive) return true
    // 执行插件结构体的 activate 方法
    await Promise.resolve(extension.activate())
    if (extension.isActive) {
      // 插件内会监听该事件
      // 通知插件 active 完成，插件执行注册的回调函数，比如 coc-tsserver 会在插件激活完成之后，加载 plugins
      this._onDidActiveExtension.fire(extension)
      return true
    }
    return false
  }

  public async deactivate(id): Promise<boolean> {
    let item = this.extensions.get(id)
    if (!item) return false
    await Promise.resolve(item.deactivate())
    return true
  }

  public async call(id: string, method: string, args: any[]): Promise<any> {
    let item = this.extensions.get(id)
    if (!item) throw new Error(`extension ${id} not registered`)
    let { extension } = item
    if (!extension.isActive) {
      await this.activate(id)
    }
    let { exports } = extension
    if (!exports || !exports.hasOwnProperty(method)) {
      throw new Error(`method ${method} not found on extension ${id}`)
    }
    return await Promise.resolve(exports[method].apply(null, args))
  }

  public getExtensionApi(id: string): API | null {
    let item = this.extensions.get(id)
    if (!item) return null
    let { extension } = item
    return extension.isActive ? extension.exports : null
  }

  public registerExtension(extension: Extension<API>, deactivate?: () => void): void {
    let { id, packageJSON } = extension
    this.extensions.set(id, { id, type: ExtensionType.Internal, extension, deactivate, isLocal: true })
    let { contributes } = packageJSON
    if (contributes) {
      let { configuration } = contributes
      if (configuration && configuration.properties) {
        let { properties } = configuration
        let props = {}
        for (let key of Object.keys(properties)) {
          let val = properties[key].default
          if (val != null) props[key] = val
        }
        workspace.configurations.extendsDefaults(props)
      }
    }
    this._onDidLoadExtension.fire(extension)
    this.setupActiveEvents(id, packageJSON).logError()
  }

  public get globalExtensions(): string[] {
    let json = this.loadJson()
    if (!json || !json.dependencies) return []
    return Object.keys(json.dependencies)
  }

  private async globalExtensionStats(): Promise<ExtensionInfo[]> {
    let json = this.loadJson()
    // dependencies 中是当前已经安装的插件的列表
    if (!json || !json.dependencies) return []
    let { modulesFolder } = this
    // 全部安装
    let res: ExtensionInfo[] = await Promise.all(Object.keys(json.dependencies).map(key => new Promise<ExtensionInfo>(async resolve => {
      try {
        let val = json.dependencies[key]
        let root = path.join(modulesFolder, key)
        let res = this.checkDirectory(root)
        if (res instanceof Error) {
          window.showMessage(`Unable to load global extension at ${root}: ${res.message}`, 'error')
          logger.error(`Error on load ${root}`, res)
          return resolve(null)
        }
        let content = await readFile(path.join(root, 'package.json'), 'utf8')
        root = await fs.realpath(root)
        let obj = JSON.parse(content)
        let version = obj ? obj.version || '' : ''
        let description = obj ? obj.description || '' : ''
        let uri = isuri.isValid(val) ? val : ''
        resolve({
          id: key,
          isLocal: false,
          version,
          description,
          exotic: /^https?:/.test(val),
          uri: uri.replace(/\.git(#master)?$/, ''),
          root,
          state: this.getExtensionState(key),
          packageJSON: Object.freeze(obj)
        })
      } catch (e) {
        logger.error(e)
        resolve(null)
      }
    })))
    return res.filter(info => info != null)
  }

  private async localExtensionStats(excludes: string[]): Promise<ExtensionInfo[]> {
    // runtimepath 又是什么呢？
    let runtimepath = await workspace.nvim.eval('join(globpath(&runtimepath, "", 0, 1), ",")') as string
    // 得到一个 paths 数组，应该是一堆插件的目录地址
    let paths = runtimepath.split(',')
    let res: ExtensionInfo[] = await Promise.all(paths.map(root => new Promise<ExtensionInfo>(async resolve => {
      try {
        let res = this.checkDirectory(root)
        if (res !== true) return resolve(null)
        // 读取插件的本地 package.json
        let jsonFile = path.join(root, 'package.json')
        let content = await readFile(jsonFile, 'utf8')
        let obj = JSON.parse(content)
        let exist = this.extensions.get(obj.name)
        if (exist && !exist.isLocal) {
          logger.info(`Extension "${obj.name}" in runtimepath already loaded.`)
          return resolve(null)
        }
        if (excludes.includes(obj.name)) {
          logger.info(`Skipped load vim plugin from "${root}", "${obj.name}" already global extension.`)
          return resolve(null)
        }
        let version = obj ? obj.version || '' : ''
        let description = obj ? obj.description || '' : ''
        resolve({
          id: obj.name,
          isLocal: true,
          version,
          description,
          exotic: false,
          root,
          state: this.getExtensionState(obj.name),
          packageJSON: Object.freeze(obj)
        })
      } catch (e) {
        logger.error(e)
        resolve(null)
      }
    })))
    return res.filter(info => info != null)
  }

  // 读取 root 下的 package.json ，这个 root 是 extensions 目录吧
  // 而这个 json 就是所有已经安装的插件的记录文件
  private loadJson(): any {
    let { root } = this
    let jsonFile = path.join(root, 'package.json')
    if (!fs.existsSync(jsonFile)) return null
    let errors: ParseError[] = []
    let content = fs.readFileSync(jsonFile, 'utf8')
    let data = parse(content, errors, { allowTrailingComma: true })
    if (errors && errors.length > 0) {
      window.showMessage(`Error on parse ${jsonFile}`, 'error')
      workspace.nvim.call('coc#util#open_file', ['edit', jsonFile], true)
    }
    return data
  }

  public get schemes(): { [key: string]: PropertyScheme } {
    return this._additionalSchemes
  }

  public addSchemeProperty(key: string, def: PropertyScheme): void {
    this._additionalSchemes[key] = def
    workspace.configurations.extendsDefaults({ [key]: def.default })
  }

  private async setupActiveEvents(id: string, packageJSON: any): Promise<void> {
    let { activationEvents } = packageJSON
    if (!this.canActivate(id)) return
    if (!activationEvents || Array.isArray(activationEvents) && activationEvents.includes('*')) {
      await this.activate(id).catch(e => {
        window.showMessage(`Error on activate extension ${id}: ${e.message}`)
        this.outputChannel.appendLine(`Error on activate extension ${id}.\n${e.message}\n ${e.stack}`)
      })
      return
    }
    let disposables: Disposable[] = []
    let called = false
    let active = (): Promise<void> => {
      if (called) return
      called = true
      disposeAll(disposables)
      return new Promise(resolve => {
        if (!this.canActivate(id)) {
          this.outputChannel.appendLine(`Extension ${id} is disabled or not loaded.`)
          return resolve()
        }
        this.activate(id).then(() => {
          resolve()
        }, e => {
          window.showMessage(`Error on activate extension ${id}: ${e.message}`)
          this.outputChannel.appendLine(`Error on activate extension ${id}:${e.message}\n ${e.stack}`)
          resolve()
        })
      })
    }

    for (let eventName of activationEvents as string[]) {
      let parts = eventName.split(':')
      let ev = parts[0]
      if (ev == 'onLanguage') {
        // 如果当插件加载的时候，当前 workspace 支持该语言，则立即激活
        if (workspace.languageIds.has(parts[1])
          || workspace.filetypes.has(parts[1])) {
          await active()
          return
        }
        // 给 workspace 挂载一个 didOpen 监听？
        // 之后的文件打开的时候，再激活该语言
        workspace.onDidOpenTextDocument(document => {
          let doc = workspace.getDocument(document.bufnr)
          if (document.languageId == parts[1] || doc.filetype == parts[1]) {
            void active()
          }
        }, null, disposables)
      } else if (ev == 'onCommand') {
        commandManager.onCommandList.push(parts[1])
        events.on('Command', async command => {
          if (command == parts[1]) {
            await active()
            await wait(500)
          }
        }, null, disposables)
      } else if (ev == 'workspaceContains') {
        let check = async () => {
          let folders = workspace.workspaceFolders.map(o => URI.parse(o.uri).fsPath)
          for (let folder of folders) {
            for (let pattern of parts[1].split(/\s+/)) {
              let exists = await checkFolder(folder, pattern)
              if (exists) {
                await active()
                return true
              }
            }
          }
          return false
        }
        workspace.onDidChangeWorkspaceFolders(check, null, disposables)
        let checked = await check()
        if (checked) return
      } else if (ev == 'onFileSystem') {
        for (let doc of workspace.documents) {
          let u = URI.parse(doc.uri)
          if (u.scheme == parts[1]) {
            await active()
            return
          }
        }
        workspace.onDidOpenTextDocument(document => {
          let u = URI.parse(document.uri)
          if (u.scheme == parts[1]) {
            void active()
          }
        }, null, disposables)
      } else {
        window.showMessage(`Unsupported event ${eventName} of ${id}`, 'error')
      }
    }
  }

  /**
   * 构造一个 extension 结构体，并记录它
   */
  private createExtension(root: string, packageJSON: any, type: ExtensionType): void {
    let id = packageJSON.name
    let isActive = false
    let result: Promise<API> | undefined
    // 使用 package.json 中定义的 main 字段指定的路径或者 index.js 作为插件的入口文件
    let filename = path.join(root, packageJSON.main || 'index.js')
    let ext: ExtensionExport
    let subscriptions: Disposable[] = []
    let exports: any

    let extension: any = {
      activate: (): Promise<API> => {
        if (result) return result
        let context = {
          subscriptions,
          extensionPath: root,
          globalState: this.memos.createMemento(`${id}|global`),
          workspaceState: this.memos.createMemento(`${id}|${workspace.rootPath}`),
          asAbsolutePath: relativePath => path.join(root, relativePath),
          storagePath: path.join(this.root, `${id}-data`),
          logger: createLogger(id)
        }
        if (!ext) {
          try {
            let isEmpty = !(packageJSON.engines || {}).hasOwnProperty('coc')
            // 得到 activate 和 deactivate 这两个方法
            // 这个 activate 方法来自于插件文件中导出的入口方法，执行它就是执行了插件的方法
            ext = createExtension(id, filename, isEmpty)
          } catch (e) {
            logger.error(`Error on createExtension ${id} from ${filename}`, e)
            return
          }
        }
        result = new Promise((resolve, reject) => {
          try {
            // 激活插件，给插件传入 context 作为参数
            // 这里调用了插件的方法
            Promise.resolve(ext.activate(context)).then(res => {
              isActive = true
              exports = res
              // 这个返回好像并没有地方用到？ TODO
              resolve(res) // 得到的是一个 { configurePlugin(pluginId: string, configuration: {}): void } 的结构体
            }, e => {
              logger.error(`Error on active extension ${id}: ${e.message}`, e)
              reject(e)
            })
          } catch (e) {
            logger.error(`Error on active extension ${id}: ${e}`, e instanceof Error ? e.stack : e)
            reject(e)
          }
        })
        return result
      }
    }

    // 给 extension 对象注册一些访问方法
    Object.defineProperties(extension, {
      id: {
        get: () => id,
        enumerable: true
      },
      packageJSON: {
        get: () => packageJSON,
        enumerable: true
      },
      extensionPath: {
        get: () => root,
        enumerable: true
      },
      isActive: {
        get: () => isActive,
        enumerable: true
      },
      exports: {
        get: () => {
          if (!isActive) throw new Error(`Invalid access to exports, extension "${id}" not activated`)
          return exports
        },
        enumerable: true
      }
    })

    // 存入 extensions map 中
    this.extensions.set(id, {
      id,
      type,
      isLocal: type == ExtensionType.Local,
      extension,
      directory: root,
      filepath: filename,
      deactivate: () => {
        if (!isActive) return
        result = undefined
        exports = undefined
        isActive = false
        disposeAll(subscriptions)
        subscriptions.splice(0, subscriptions.length)
        subscriptions = []
        if (ext && ext.deactivate) {
          try {
            return Promise.resolve(ext.deactivate()).catch(e => {
              logger.error(`Error on ${id} deactivate: `, e)
            })
          } catch (e) {
            logger.error(`Error on ${id} deactivate: `, e)
          }
        }
      }
    })

    // contributes 是做什么的？ TODO
    let { contributes } = packageJSON
    if (contributes) {
      let { configuration, rootPatterns, commands } = contributes
      // properties: 当前插件的配置属性，比如 tsserver lsp 支持的所有的配置属性
      if (configuration && configuration.properties) {
        let { properties } = configuration
        let props = {}
        for (let key of Object.keys(properties)) {
          let val = properties[key].default
          if (val != null) props[key] = val
        }
        workspace.configurations.extendsDefaults(props)
      }
      // rootPatterns: 应该是根据这些 pattern 来查找项目根目录，比如有 package.json 的地方等等
      // NOTE 在 workspace 中注册 rootPattern
      if (rootPatterns && rootPatterns.length) {
        for (let item of rootPatterns) {
          workspace.workspaceFolderControl.addRootPattern(item.filetype, item.patterns)
        }
      }
      // commands: 该插件支持的命令，vscode 也支持这些命令
      // 这些命令又是如何注册到 vim 中去的呢？
      if (commands && commands.length) {
        for (let cmd of commands) {
          commandManager.titles.set(cmd.command, cmd.title)
        }
      }
    }

    // fire extension 做啥？ TODO
    this._onDidLoadExtension.fire(extension)
    // 如果激活了，则？
    if (this.activated) {
      this.setupActiveEvents(id, packageJSON).logError()
    }
  }

  /**
   * Filter out global extensions that needs install
   */
  public filterGlobalExtensions(names: string[]): string[] {
    let map: Map<string, string> = new Map()
    names.forEach(def => {
      let name = this.getExtensionName(def)
      if (name) map.set(name, def)
    })
    let json = this.loadJson()
    let urls: string[] = []
    let exists: string[] = []
    if (json && json.dependencies) {
      for (let key of Object.keys(json.dependencies)) {
        let val = json.dependencies[key]
        if (typeof val !== 'string') continue
        if (fs.existsSync(path.join(this.modulesFolder, key, 'package.json'))) {
          exists.push(key)
          if (/^https?:/.test(val)) {
            urls.push(val)
          }
        }
      }
    }
    for (let name of map.keys()) {
      if (this.disabled.has(name) || this.extensions.has(name)) {
        map.delete(name)
        continue
      }
      if ((/^https?:/.test(name) && urls.some(url => url.startsWith(name)))
        || exists.includes(name)) {
        map.delete(name)
      }
    }
    return Array.from(map.values())
  }

  /**
   * Name of extension
   */
  private getExtensionName(def: string): string {
    if (/^https?:/.test(def)) return def
    if (!def.includes('@')) return def
    return def.replace(/@[\d.]+$/, '')
  }

  private get modulesFolder(): string {
    return path.join(this.root, global.__TEST__ ? '' : 'node_modules')
  }

  private canActivate(id: string): boolean {
    return !this.disabled.has(id) && this.extensions.has(id)
  }

  /**
   * Deactivate & unregist extension
   */
  private async unloadExtension(id: string): Promise<void> {
    let item = this.extensions.get(id)
    if (item) {
      await this.deactivate(id)
      this.extensions.delete(id)
      this._onDidUnloadExtension.fire(id)
    }
  }

  /**
   * Check if folder contains extension, return Error
   */
  private checkDirectory(folder: string): boolean | Error {
    try {
      let jsonFile = path.join(folder, 'package.json')
      if (!fs.existsSync(jsonFile)) throw new Error('package.json not found')
      let packageJSON = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
      let { name, engines, main } = packageJSON
      if (!name || !engines) throw new Error(`can't find name & engines in package.json`)
      if (!engines || !objectLiteral(engines)) {
        throw new Error(`invalid engines in ${jsonFile}`)
      }
      if (main && !fs.existsSync(path.join(folder, main))) {
        throw new Error(`main file ${main} not found, you may need to build the project.`)
      }
      let keys = Object.keys(engines)
      if (!keys.includes('coc') && !keys.includes('vscode')) {
        throw new Error(`Engines in package.json doesn't have coc or vscode`)
      }
      if (keys.includes('coc')) {
        let required = engines['coc'].replace(/^\^/, '>=')
        if (!semver.satisfies(workspace.version, required)) {
          throw new Error(`Please update coc.nvim, ${packageJSON.name} requires coc.nvim ${engines['coc']}`)
        }
      }
      return true
    } catch (e) {
      return e as Error
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}

export default new Extensions()
