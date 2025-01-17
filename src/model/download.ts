'use strict'
import contentDisposition from 'content-disposition'
import { http, https } from 'follow-redirects'
import fs, { Stats } from 'fs-extra'
import { IncomingMessage } from 'http'
import path from 'path'
import tar from 'tar'
import unzip from 'unzip-stream'
import { v1 as uuidv1 } from 'uuid'
import { CancellationToken } from 'vscode-languageserver-protocol'
import { resolveRequestOptions, FetchOptions } from './fetch'
const logger = require('../util/logger')('model-download')

export interface DownloadOptions extends Omit<FetchOptions, 'buffer'> {
  /**
   * Folder that contains downloaded file or extracted files by untar or unzip
   */
  dest: string
  /**
   * Remove the specified number of leading path elements for *untar* only, default to `1`.
   */
  strip?: number
  /**
   * If true, use untar for `.tar.gz` filename
   */
  extract?: boolean | 'untar' | 'unzip'
  onProgress?: (percent: string) => void
}

/**
 * Download file from url, with optional untar/unzip support.
 * 使用 http/https 发起下载请求，并通过 stream 来边下载边解压
 *
 * @param {string} url
 * @param {DownloadOptions} options contains dest folder and optional onProgress callback
 */
export default function download(url: string, options: DownloadOptions, token?: CancellationToken): Promise<string> {
  let { dest, onProgress, extract } = options
  if (!dest || !path.isAbsolute(dest)) {
    throw new Error(`Expect absolute file path for dest option.`)
  }
  let stat: Stats
  try {
    stat = fs.statSync(dest)
  } catch (_e) {
    fs.mkdirpSync(dest)
  }
  if (stat && !stat.isDirectory()) {
    throw new Error(`${dest} exists, but not directory!`)
  }
  let mod = url.startsWith('https') ? https : http
  let opts = resolveRequestOptions(url, options)
  let extname = path.extname(url)
  return new Promise<string>((resolve, reject) => {
    if (token) {
      let disposable = token.onCancellationRequested(() => {
        disposable.dispose()
        req.destroy(new Error('request aborted'))
      })
    }
    let timer: NodeJS.Timer
    // 使用 http 或者 https 模块来下载 tarball 文件
    const req = mod.request(opts, (res: IncomingMessage) => {
      if ((res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 1223) {
        // 拿到响应头信息
        let headers = res.headers || {}
        let dispositionHeader = headers['content-disposition']
        if (!extname && dispositionHeader) {
          let disposition = contentDisposition.parse(dispositionHeader)
          if (disposition.parameters?.filename) {
            extname = path.extname(disposition.parameters.filename)
          }
        }
        // 是否要解压？
        if (extract === true) {
          if (extname === '.zip' || headers['content-type'] == 'application/zip') {
            extract = 'unzip'
          } else if (extname == '.tgz') {
            extract = 'untar'
          } else {
            reject(new Error(`Unable to extract for ${url}`))
            return
          }
        }
        // 得到下载的 content-length
        let total = Number(headers['content-length'])
        let cur = 0
        if (!isNaN(total)) {
          res.on('data', chunk => {
            // 计算下载的进度
            cur += chunk.length
            let percent = (cur / total * 100).toFixed(1)
            if (onProgress) {
              onProgress(percent)
            } else {
              logger.info(`Download ${url} progress ${percent}%`)
            }
          })
        }
        res.on('error', err => {
          reject(new Error(`Unable to connect ${url}: ${err.message}`))
        })
        res.on('data', () => {
          if (timer) {
            clearTimeout(timer)
            timer = undefined
          }
        })
        res.on('end', () => {
          logger.info('Download completed:', url)
        })
        // 通过流来实现边下载边解压，并写入到 dest 目录
        let stream: any
        if (extract === 'untar') {
          stream = res.pipe(tar.x({ strip: options.strip ?? 1, C: dest }))
        } else if (extract === 'unzip') {
          stream = res.pipe(unzip.Extract({ path: dest }))
        } else {
          dest = path.join(dest, `${uuidv1()}${extname}`)
          stream = res.pipe(fs.createWriteStream(dest))
        }
        stream.on('finish', () => {
          logger.info(`Downloaded ${url} => ${dest}`)
          setTimeout(() => {
            resolve(dest)
          }, 100)
        })
        stream.on('error', reject)
      } else {
        reject(new Error(`Invalid response from ${url}: ${res.statusCode}`))
      }
    })
    req.on('error', e => {
      // Possible succeed proxy request with ECONNRESET error on node > 14
      if (opts.agent && e.code == 'ECONNRESET') {
        // 如果中间有这个错误抛出，则等待 500 毫秒，如果又接收到了数据，则取消这个倒计时
        timer = setTimeout(() => {
          reject(e)
        }, 500)
      } else {
        reject(e)
      }
    })
    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${options.timeout}ms`))
    })
    // 设置 req 的请求超时
    if (options.timeout) {
      req.setTimeout(options.timeout)
    }
    req.end()
  })
}
