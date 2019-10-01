const sub = require('subleveldown')
const assert = require('assert')
const debug = require('debug')('garden')
const eos = require('end-of-stream')
const { defer, infer } = require('deferinfer')

const SYNC_TIMEOUT = 100

class CoreGarden {
  constructor (storage, lvl, opts = {}) {
    this._id = Math.floor(Math.random() * 10000)
    this.mappers = Object.assign({}, opts.mappers || {})
    this.db = lvl
    this.glob = sub(lvl, 'G')
    this.key2fs = sub(lvl, 'K2FS')
    this.meta = sub(lvl, 'M', { valueEncoding: 'json' })
    this.rootStore = storage
    this._iBatch = []
    this._processing = false
    this.inodes = sub(lvl, 'I')
    this._feeds = {}
    this._closed = false

    if (opts.secrets) {
      assert(typeof opts.secrets.read === 'function', 'secrets.read must be a function')
      assert(typeof opts.secrets.write === 'function', 'secrets.write must be a function')
      this.externalSecrets = opts.secrets
    }
  }

  registerType (type, initFn) {
    this.mappers[type] = initFn
  }

  async getMeta (key) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    // if (this.meta.isClosed()) debugger
    return this.meta.get(key)
  }

  async get (key, ...hyperopts) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const fid = await this.key2fs.get(key)
    const meta = await this.getMeta(key)
    if (meta.banned) throw new BannedCoreError()
    if (meta.deleted) throw new DeletedCoreError()
    if (!this._feeds[fid]) {
      this._feeds[fid] = await this._load(fid, key, ...hyperopts)
    }
    return this._feeds[fid]
  }

  async _load (fid, key, ...hyperopts) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const { type } = await this.meta.get(key)
    debug('Fetching', type, fid, key.slice(0, 4))
    // const store = this._subStore(fid, key)
    const store = this._subStore(fid, Buffer.from(key, 'hex'))
    const core = this.mappers[type].call(null, store, key, ...hyperopts)
    await new Promise(resolve => core.ready(resolve))

    // Detect failure, key deduction was only tested with hypercore and
    // hyperdrive
    assert(core.key.equals(store().detectedKey), 'black magic fail: key detection failed, secrets were misplaced during load')

    debug(parseInt(fid), 'GET READY!')
    return core
  }

  async sizeOf (key) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const fid = await this.key2fs.get(key)
    await this.sync()
    const s = this.inodes.createReadStream({
      keys: false,
      gt: `${fid - 1}/`,
      lt: `${fid + 1}/`
    })
    return new Promise((resolve, reject) => {
      let sum = 0
      s.on('data', chunk => {
        const n = parseInt(chunk)
        if (typeof n === 'number' && !Number.isNaN(n)) sum = sum + n
      })
      s.once('error', reject)
      s.once('end', () => resolve(sum))
    })
  }

  async sync () {
    if (this.processing) return this._syncDone
    else return Promise.resolve()
  }

  _enqueueBatch (ops) {
    ops.forEach(op => this._iBatch.push(op))
    if (!this.processing) {
      this.processing = true
      this._syncDone = new Promise(resolve => {
        setTimeout(async () => {
          const mb = this._iBatch
          this._iBatch = []
          await this.inodes.batch(mb)
          delete this._syncDone
          this.processing = false
          debug(`sync! ${mb.length}`) //, mb)
          process.nextTick(resolve)
        }, SYNC_TIMEOUT)
      })
    }
  }

  /**
   * Initializes a new feed.
   * Expects core initFn to use arguments (storage, key, ...)
   * when using plant, omit the first storage argument as that will be provided
   * internally.
   *
   * Alternatively you want to bypass the mapper for some insane
   * reason you can use the form:
   * garden.plant(type, (pot, bury, mapper) =>  bury(mapper(pot)) )
   *
   * But be careful, because next time the core is loaded from storage
   * the standard mapper will be used and you might produce an unloadable
   * core.
   */
  async plant (type, ...args) {
    const override = typeof args[0] === 'function' ? args[0] : null

    const [ providedKey ] = args
    if (providedKey) {
      const isBanned = await this.isBanned(providedKey)
      if (isBanned) throw new BannedCoreError()
    }
    assert(typeof this.mappers[type] === 'function', `Unknown core type "${type}`)

    const fid = await this._counter()
    const store = this._subStore(fid)
    let feed = null
    if (override) {
      feed = await new Promise((resolve) => {
        override(store, resolve, this.mappers[type])
      })
      assert(typeof feed.ready === 'function', 'Core should have been provided during manual planting')
    } else {
      args.unshift(store) // prepend our store
      debug('Planting', type, fid)
      feed = this.mappers[type].apply(null, args)
    }
    await new Promise(resolve => feed.ready(resolve))
    this._feeds[fid] = feed
    debug(fid, 'READY!')
    const key = feed.key.hexSlice()

    const isBanned = await this.isBanned(key)
    if (isBanned) throw new BannedCoreError()

    // Detect failure, key deduction was only tested with hypercore and hyperdrive
    const detectedKey = store().detectedKey
    if (detectedKey && feed.key.equals(detectedKey)) console.warn('black magic fail: key detection failed, secrets were misplaced during plant')

    await this.key2fs.put(key, fid)
    // await this.key2fs.put(fid, key) // also store the reverse index
    await this.meta.put(key, { type, createdAt: new Date() })
    return feed
  }

  close (cb) {
    debug('Closing garden')
    const p = defer(async done => {
      const all = []
      for (const fid of Object.keys(this._feeds)) {
        all.push(this._closeCore(fid))
      }
      await Promise.all(all)
      await this.sync()
      await defer(done => this.glob.close(done))
      await defer(done => this.key2fs.close(done))
      await defer(done => this.meta.close(done))
      await defer(done => this.db.close(done))

      this._closed = true
      debug('Garden successfully closed', this._id)
      done(null, this.closed)
    })
    return infer(p, cb)
  }

  get closed () {
    return this._closed
  }

  async closeCore (key) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const fid = await this.key2fs.get(key)
    return this._closeCore(fid)
  }

  async _closeCore (fid) {
    if (typeof this._feeds[fid] === 'undefined') return // no such open core.

    // Tell core to close if it supports close method.
    if (typeof this._feeds[fid].close === 'function') {
      await defer(done => this._feeds[fid].close(done))
    }
    delete this._feeds[fid]
    return true
  }

  async _purge (key) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const fid = await this.key2fs.get(key)
    const files = await this._listFiles(fid)
    const store = this._subStore(fid)

    await this._closeCore(fid)

    for (let path of files) {
      const handle = store(path)
      debug('Destroying: ', path)
      // TODO: Awaiting here somehow got all stuck
      // await new Promise( ...
      let p = new Promise((resolve, reject) => {
        if (handle.opened) handle.close()
        handle.once('destroy', resolve)
        handle.destroy(reject)
      })
      p.then(() => debug('Destroyed path:', path))
    }

    const meta = await this.meta.get(key)
    meta.deleted = true
    meta.deletedAt = new Date()
    await this.meta.put(key, meta)
    debug('Core successfully purged', key)
    return true
  }
  async listMeta () {
    const stream = this.meta.createReadStream()
    const res = []
    stream.on('data', entry => res.push(entry))
    return defer(done => {
      eos(stream, err => done(err, res))
    })
  }
  async listCores () {
    const metas = await this.listMeta()
    return Promise.all(metas
      .filter(meta => !(meta.value.deleted || meta.value.banned))
      .map(async meta => {
        const core = await this.get(meta.key)
        return { key: meta.key, meta: meta.value, core }
      })
    )
  }

  /* Deletes local content
   * and marks key as banned so that it won't be re-downloaded
   */
  async ban (key, purge = true) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const meta = await this.meta.get(key)
    if (meta.banned) return true
    meta.banned = true
    meta.bannedAt = new Date()
    await this.meta.put(key, meta)

    if (purge) await this._purge(key)

    await this.sync()
    return true
  }

  /* Purges core from store
   * optionally bans it to prevent re-download
   */
  async purge (key, ban = false) {
    if (ban) return this.ban(key, true)
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    await this._purge(key)
    await this.sync()
    return true
  }

  async isBanned (key) {
    try {
      const { banned } = await this.getMeta(key)
      return !!banned
    } catch (err) {
      if (err.type === 'NotFoundError') return false
      throw err
    }
  }

  async _counter () {
    let n = 0
    try {
      n = await this.glob.get('feed_inc')
    } catch (err) {
      if (err.type !== 'NotFoundError') throw err
    }
    await this.glob.put('feed_inc', ++n)
    return n
  }

  async listFiles (key) {
    if (Buffer.isBuffer(key)) key = key.hexSlice()
    const fid = await this.key2fs.get(key)
    return this._listFiles(fid)
  }

  async _listFiles (fid) {
    await this.sync()
    const s = this.inodes.createReadStream({
      values: false,
      gt: `${fid - 1}/`,
      lt: `${fid + 1}/`
    })
    return new Promise((resolve, reject) => {
      const list = []
      const n = (fid + '').length + 1
      s.on('data', chunk => list.push(chunk.slice(n)))
      s.once('error', reject)
      s.once('end', () => resolve(list))
    })
  }

  _subStore (namespace, key = null) {
    let detectedKey = key
    return path => {
      const subPath = [namespace, path].join('/').replace(/\/+/, '/')

      // at this point we could just return the handle
      const handle = this.rootStore(subPath)

      // but... instead we'll waste 20+ hours on bulding a
      // blackmagic random-access-key-sniffer...
      // In order to store all secret_keys in our cool distributed-encrypted-kv.
      const self = this
      return new Proxy(handle, {
        get (target, prop, args) {
          // debug(prop, subPath)
          switch (prop) {
            case 'write':
              return (...op) => {
                const [ offset, data ] = op

                if (detectedKey && self._feeds[detectedKey]) {
                  console.warn('Unhandeled state, please inspect!')
                  debugger
                }

                // TODO: not thread safe nor batch safe.
                self.inodes.get(subPath, (err, v) => {
                  let size = offset + data.length
                  if (!err) size = Math.max(size, v)
                  self._enqueueBatch([{ type: 'put', key: subPath, value: size }])
                })

                // Hijack key & secret_key writes
                let m
                if (self.externalSecrets && (m = subPath.match(/(secret_)?key$/))) {
                  const isSecret = !!m[1]
                  assert(offset === 0, 'black magic fail: expected offset to be zero')

                  if (!isSecret && !detectedKey) {
                    // Let key writes fall through but make a copy of them
                    detectedKey = data
                  } else if (!isSecret && detectedKey && !detectedKey.equals(data)) {
                    // Subcore detected
                    debug('Subcore detected', `Owner: ${detectedKey.hexSlice()}\nStorepoint: ${subPath}\nSub:${data.hexSlice()}`)
                  } else if (isSecret) {
                    // Redirect secret_key writes to externalSecrets interface
                    assert(detectedKey, 'black magic fail: detected secret before key')

                    // it's possible to extract the core pubkey during secret writes
                    // but sadly dosen't make sense during reads.
                    // const isRootKey = detectedKey.equal(data.slice(32))

                    return self.externalSecrets.write(`${detectedKey.hexSlice()}:${path}`, op, {
                      key: detectedKey,
                      path,
                      localNamespace: namespace
                    })
                  }
                }

                return target[prop].apply(target, op)
              }
            case 'read':
              return (...op) => {
                const [ offset, size, next ] = op

                // Hijack key & secret_key reads
                let m
                if (self.externalSecrets && (m = subPath.match(/(secret_)?key$/))) {
                  const isSecret = !!m[1]

                  assert(offset === 0, 'black magic fail: expected offset to be zero')

                  if (!isSecret && !detectedKey) {
                    return target[prop](offset, size, (err, data) => {
                      if (err) return next(err)
                      detectedKey = data
                      next(err, data)
                    })
                  }

                  // we can't request a secret for unknown cores.
                  if (isSecret && detectedKey) {
                    const errHandler = (err, data) => {
                      // on error, scapegoat back to original storage to
                      // avoid forwarding errors not related to random-access.
                      if (err || !Buffer.isBuffer(data)) {
                        // at least log the original error to mitigate future headaches
                        if (err) console.warn(data, err)
                        return target[prop].apply(target, op)
                      }
                      return next(null, data)
                    }
                    // Redirect secret_key reads to externalSecrets interface
                    return self.externalSecrets.read(
                      `${detectedKey.hexSlice()}:${path}`,
                      [offset, size, errHandler],
                      { key: detectedKey, path, localNamespace: namespace }
                    )
                  }
                }

                return target[prop].apply(target, op)
              }
            case 'destroy':
              return (...a) => {
                self._enqueueBatch([{ type: 'del', key: subPath }])
                if (self.externalSecrets && path.match(/secret_key$/)) {
                  // TODO: maybe redirect delete/destroy to externalSecrets
                  // since they're diverted there's nothing to destroy and RAF gets stuck
                  target.emit('destroy')
                } else return target[prop].apply(target, ...a)
              }
            case 'detectedKey':
              return detectedKey
            default:
              if (typeof target[prop] === 'function') return target[prop].bind(target)
              else return target[prop]
          }
        }
      })
    }
  }

  /*
   * Decentstack middleware support
   */
  async share (next) {
    const list = await this.listCores().catch(next)
    next(null, list.map(i => i.core))
  }

  async describe ({ key, meta }, next) {
    try {
      const meta = await this.getMeta(key)
      meta.origin = 'garden'
      next(null, meta)
    } catch (err) {
      if (err.type === 'NotFoundError') next()
      else next(err)
    }
  }

  async store ({ key, meta }, next) {
    let core
    try {
      core = await this.get(key)
    } catch (err) {
      if (err.type !== 'NotFoundError') return next(err)
    }

    // accept all existing cores
    if (core) return next(null, core)

    // Ignore non garden cores
    if (meta.origin !== 'garden') return next()

    // Ignore core if there's no type info attached or if we don't know
    // how to handle the type
    if (!meta.type || typeof this.mappers[meta.type] !== 'function') return next()
    try {
      core = await this.plant(meta.type, key)
      next(null, core)
    } catch (err) { next(err) }
  }

  async resolve (key, next) {
    try {
      const core = await this.get(key)
      next(null, core)
    } catch (err) {
      if (err.type === 'NotFoundError') next() // not our core, ignore it.
      else next(err)
    }
  }
}

module.exports = (...a) => new CoreGarden(...a)

class BannedCoreError extends Error {
  constructor (msg = 'the core is blacklisted', ...params) {
    super(msg, ...params)
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) Error.captureStackTrace(this, BannedCoreError)
    this.name = this.type = 'BannedCoreError'
  }
}

class DeletedCoreError extends Error {
  constructor (msg = 'the core is deleted', ...params) {
    super(msg, ...params)
    // Maintains proper stack trace for where our error was thrown (only available on V8)
    if (Error.captureStackTrace) Error.captureStackTrace(this, DeletedCoreError)
    this.name = this.type = 'DeletedCoreError'
  }
}
