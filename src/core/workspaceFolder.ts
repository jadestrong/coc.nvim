'use strict'
import path from 'path'
import { Emitter, Event, WorkspaceFolder, WorkspaceFoldersChangeEvent } from 'vscode-languageserver-protocol'
import { URI } from 'vscode-uri'
import Configurations from '../configuration'
import Document from '../model/document'
import { PatternType } from '../types'
import { distinct } from '../util/array'
import { isParentFolder, resolveRoot } from '../util/fs'

function toWorkspaceFolder(fsPath: string): WorkspaceFolder | undefined {
  if (!fsPath || !path.isAbsolute(fsPath)) return undefined
  return {
    name: path.basename(fsPath), // 取出文件路径最后的文件名
    uri: URI.file(fsPath).toString() // 将一个文件路径装换成一个 URI 字符串？什么样子呢？TODO
  }
}

/** 管理 workspace 下的文件夹 */
export default class WorkspaceFolderController {
  private _onDidChangeWorkspaceFolders = new Emitter<WorkspaceFoldersChangeEvent>()
  public readonly onDidChangeWorkspaceFolders: Event<WorkspaceFoldersChangeEvent> = this._onDidChangeWorkspaceFolders.event
  // filetype => patterns
  private rootPatterns: Map<string, string[]> = new Map()
  private _workspaceFolders: WorkspaceFolder[] = []
  constructor(
    private readonly configurations: Configurations
  ) {
  }

  // 给 workspace 添加一系列的 folders
  public setWorkspaceFolders(folders: string[] | undefined): void {
    if (!folders || !Array.isArray(folders)) return
    let arr = folders.map(f => toWorkspaceFolder(f))
    this._workspaceFolders = arr.filter(o => o != null)
  }

  // 应该式一个形如： file:///xxx 的文件路径
  // 得到 workspace 下给定 uri 所属的文件夹
  public getWorkspaceFolder(uri: URI): WorkspaceFolder | undefined {
    if (uri.scheme !== 'file') return undefined
    let folders = Array.from(this._workspaceFolders).map(o => URI.parse(o.uri).fsPath)
    folders.sort((a, b) => b.length - a.length)
    let fsPath = uri.fsPath
    // 找到 uri 的父级目录
    let folder = folders.find(f => isParentFolder(f, fsPath, true))
    return toWorkspaceFolder(folder)
  }

  public getRelativePath(pathOrUri: string | URI, includeWorkspace?: boolean): string {
    let resource: URI | undefined
    let p = ''
    if (typeof pathOrUri === 'string') {
      resource = URI.file(pathOrUri)
      p = pathOrUri
    } else if (typeof pathOrUri !== 'undefined') {
      resource = pathOrUri
      p = pathOrUri.fsPath
    }
    if (!resource) return p
    const folder = this.getWorkspaceFolder(resource)
    if (!folder) return p
    if (typeof includeWorkspace === 'undefined' && this._workspaceFolders) {
      includeWorkspace = this._workspaceFolders.length > 1
    }
    let result = path.relative(URI.parse(folder.uri).fsPath, resource.fsPath)
    result = result == '' ? resource.fsPath : result
    if (includeWorkspace && folder.name) {
      result = `${folder.name}/${result}`
    }
    return result!
  }

  public get workspaceFolders(): ReadonlyArray<WorkspaceFolder> {
    return this._workspaceFolders
  }

  // 将给定的 rootPatterns 记录到给定 filetype 的配置中
  public addRootPattern(filetype: string, rootPatterns: string[]): void {
    let patterns = this.rootPatterns.get(filetype) || []
    for (let p of rootPatterns) {
      if (!patterns.includes(p)) {
        patterns.push(p)
      }
    }
    this.rootPatterns.set(filetype, patterns)
  }

  public resolveRoot(document: Document, cwd: string, fireEvent: boolean, expand: ((input: string) => string)): string | null {
    if (document.buftype !== '' || document.schema !== 'file' || !document.enabled) return null
    let types = [PatternType.Buffer, PatternType.LanguageServer, PatternType.Global]
    let u = URI.parse(document.uri)
    let dir = path.dirname(u.fsPath)
    let config = this.configurations.getConfiguration('workspace', document.uri)
    let ignoredFiletypes = config.get<string[]>('ignoredFiletypes', [])
    let bottomUpFiletypes = config.get<string[]>('bottomUpFiletypes', [])
    let checkCwd = config.get<boolean>('workspaceFolderCheckCwd', true)
    let ignored = config.get<string[]>('ignoredFolders', [])
    let fallbackCwd = config.get<boolean>('workspaceFolderFallbackCwd', true)
    // 如果当前的文件类型是需要忽略的，则直接返回
    if (ignoredFiletypes?.includes(document.filetype)) return null
    // 如果当前的 workspace 记录中有该文件所属的文件夹，则直接返回
    let curr = this.getWorkspaceFolder(URI.parse(document.uri))
    if (curr) return URI.parse(curr.uri).fsPath

    ignored = Array.isArray(ignored) ? ignored.filter(s => s && s.length > 0).map(s => expand(s)) : []
    let res: string | null = null
    for (let patternType of types) {
      // 依次查找符合的 rootPatterns
      let patterns = this.getRootPatterns(document, patternType)
      if (patterns && patterns.length) {
        let isBottomUp = bottomUpFiletypes.includes('*') || bottomUpFiletypes.includes(document.filetype)
        // 找到 root
        let root = resolveRoot(dir, patterns, cwd, isBottomUp, checkCwd, ignored)
        // 找到当前文件所属的项目根目录
        if (root) {
          res = root
          break
        }
      }
    }
    // 如果没找到，则看是否兜底到当前工作目录，也就是当前文件所在的目录吧
    if (fallbackCwd && !res && !ignored.includes(cwd) && isParentFolder(cwd, dir, true)) {
      res = cwd
    }
    // 如果找到了，则将该目录加入到 workspace 中
    if (res) this.addWorkspaceFolder(res, fireEvent)
    return res
  }

  public addWorkspaceFolder(folder: string, fireEvent: boolean): WorkspaceFolder | undefined {
    let workspaceFolder: WorkspaceFolder = toWorkspaceFolder(folder)
    if (!workspaceFolder) return undefined
    // 如果要加入的 folder 不存在则再加入
    if (this._workspaceFolders.findIndex(o => o.uri == workspaceFolder.uri) == -1) {
      this._workspaceFolders.push(workspaceFolder)
      // 是否要 fireEvent
      if (fireEvent) {
        this._onDidChangeWorkspaceFolders.fire({
          added: [workspaceFolder],
          removed: []
        })
      }
    }
    return workspaceFolder
  }

  public renameWorkspaceFolder(oldPath: string, newPath: string): void {
    let added: WorkspaceFolder = toWorkspaceFolder(newPath)
    if (!added) return
    let idx = this._workspaceFolders.findIndex(f => URI.parse(f.uri).fsPath == oldPath)
    if (idx == -1) return
    let removed = this.workspaceFolders[idx]
    this._workspaceFolders.splice(idx, 1, added)
    this._onDidChangeWorkspaceFolders.fire({
      removed: [removed],
      added: [added]
    })
  }

  public removeWorkspaceFolder(fsPath: string): void {
    let removed = toWorkspaceFolder(fsPath)
    if (!removed) return
    let idx = this._workspaceFolders.findIndex(f => f.uri == removed.uri)
    if (idx == -1) return
    this._workspaceFolders.splice(idx, 1)
    this._onDidChangeWorkspaceFolders.fire({
      removed: [removed],
      added: []
    })
  }

  public getRootPatterns(document: Document, patternType: PatternType): string[] {
    let { uri } = document
    if (patternType == PatternType.Buffer) return document.getVar('root_patterns', []) || []
    if (patternType == PatternType.LanguageServer) return this.getServerRootPatterns(document.languageId)
    const preferences = this.configurations.getConfiguration('coc.preferences', uri)
    return preferences.get<string[]>('rootPatterns', ['.git', '.hg', '.projections.json']).slice()
  }

  public reset(): void {
    this.rootPatterns.clear()
    this._workspaceFolders = []
  }

  /**
   * Get rootPatterns of filetype by languageserver configuration and extension configuration.
   */
  private getServerRootPatterns(filetype: string): string[] {
    let lspConfig = this.configurations.getConfiguration().get<{ [key: string]: unknown }>('languageserver', {})
    let patterns: string[] = []
    for (let key of Object.keys(lspConfig)) {
      let config: any = lspConfig[key]
      let { filetypes, rootPatterns } = config
      if (Array.isArray(filetypes) && rootPatterns && filetypes.includes(filetype)) {
        patterns.push(...rootPatterns)
      }
    }
    patterns = patterns.concat(this.rootPatterns.get(filetype) || [])
    return patterns.length ? distinct(patterns) : []
  }
}
