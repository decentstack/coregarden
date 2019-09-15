const RAM = require('random-access-memory')
const RAF = require('random-access-file')
const { mkdirSync } = require('fs')
const memdb = require('memdb')
const level = require('level')
const test = require('tape')
const hypercore = require('hypercore')
const { join } = require('path')
// const Dat = require('dat-node')
// const Passport = require('decentpass') // TODO: release it.
const Garden = require('.')
const { defer } = require('deferinfer')
const hyperdrive = require('hyperdrive')
const del = require('del')

test('garden experimental core store', async t => {
  t.plan(6)
  const verySecretStore = {}
  // initialize a new core garden.
  // give it storage, a level instance.
  // and a core-type mapper that let's
  // us mix stored cores
  // also 'secrets' interface that let's us store
  // all secrets externally.
  const g = Garden(RAM, memdb(), {
    mappers: {
      hypercore
    },
    secrets: {
      write (key, [offset, data, next]) {
        verySecretStore[key] = data
        next(null)
      },
      read (key, [offset, size, next]) {
        next(null, verySecretStore[key])
      }
    }
  })

  const feed = await g.plant('hypercore')

  t.equal(
    verySecretStore[`${feed.key.hexSlice()}:secret_key`].hexSlice(),
    feed.secretKey.hexSlice(),
    'Secret successfully redirected'
  )

  await new Promise(resolve => feed.ready(resolve))

  let meta = await g.getMeta(feed.key)
  t.notOk(meta.banned, 'Should not be marked as banned')

  // borrow the feed.. will become problematic in a multi-threaded env.
  // two feed instances using the same storage is unholy.
  const f2 = await g.get(feed.key)
  t.equal(feed.key.hexSlice(), f2.key.hexSlice(), 'should be possible to get core by key')

  let list = await g.listFiles(feed.key)
  t.notEqual(list.indexOf('secret_key'), -1, 'there should be a secret key')

  await g.ban(feed.key)

  meta = await g.getMeta(feed.key)
  t.ok(meta.banned, 'Should be marked as banned')

  list = await g.listFiles(feed.key)
  t.equal(list.length, 0, 'Files should be removed')

  t.end()
})

const prefix = './mock_root'
const makeFileStore = async (purge = false) => {
  if (purge) await destroyFileStore()
  console.info('Creating', prefix)
  mkdirSync(prefix, { recursive: true })
  return {
    storage: path => RAF(join(prefix, path)),
    lvl: level(join(prefix, 'index'))
  }
}
const destroyFileStore = () => {
  console.info('Deleting', prefix)
  return del(join(prefix, '**'))
}

// TODO: Skipped until decentpass is released
// which is sad since this is a pretty extensive and useful
// test.
test.skip('Open and close with real FS', async t => {
  t.plan(22)
  try {
    let { storage, lvl } = await makeFileStore(true)
    const gopts = {
      mappers: {
        hypercore,
        hyperdrive,
        passport: (...a) => new Passport(...a)
      }
    }

    let garden = Garden(storage, lvl, gopts)
    t.equal(garden.closed, false, 'Should not be closed')
    // Generate some content for garden.
    let pass = await garden.plant('passport', (pot, bury) => {
      bury(Passport.create('test', pot))
    })
    const pk = pass.key
    const msk = pass.session.auth
    t.ok(msk, 'Session key extracted')
    let drive = await garden.plant('hyperdrive')
    await defer(done => drive.ready(done))
    const dk = drive.key
    await defer(done => drive.writeFile('msk', Buffer.from(msk), done))
    let contents = await defer(done => drive.readFile('msk', done))
    t.equal(contents.toString('utf8'), msk)

    let core = await garden.plant('hypercore')
    const hk = core.key
    t.ok(hk, 'Garden invokes feed.ready()')
    await defer(done => core.append(Buffer.from(msk), done))
    let hcontent = await defer(done => core.get(0, done))
    t.equal(hcontent.toString('utf8'), msk)

    let list = await garden.listCores()
    t.equal(list.length, 3)
    await garden.close()
    t.equal(garden.closed, true, 'Should be closed')
    // Free pointers
    list = null
    garden = null
    drive = null
    pass = null
    core = null
    await defer(done => lvl.close(done))
    await defer(done => process.nextTick(done))
    // Reopen store
    const rs = await makeFileStore(false)
    storage = rs.storage
    lvl = rs.lvl

    // Reopen garden
    garden = Garden(storage, lvl, gopts)
    list = await garden.listCores()
    t.equal(list.length, 3, 'Reopened 3 cores')

    pass = list.find(v => v.meta.type === 'passport').core
    t.ok(pass, 'Found passport')
    t.equal(pass.key.hexSlice(), pk.hexSlice())
    t.equal(pass.session.auth, msk, 'Readback stored index')
    // TODO: test direct core.get too.

    drive = list.find(v => v.meta.type === 'hyperdrive').core
    t.ok(drive, 'Found drive')
    t.equal(drive.key.hexSlice(), dk.hexSlice())
    // TODO: fails on v10, submit issue and test to hyperdive
    contents = await defer(done => drive.readFile('msk', done))
    t.equal(contents.toString('utf8'), msk, 'Readback stored hyperdrive value')

    core = list.find(v => v.meta.type === 'hypercore').core
    t.ok(core, 'Found hypercore')
    t.equal(core.key.hexSlice(), hk.hexSlice())
    hcontent = await defer(done => core.get(0, done))
    t.equal(hcontent.toString('utf8'), msk)

    // Purge and ban test
    await garden.purge(pass.key)
    t.equal(pass.closed, true, 'Pass should have been closed')
    await garden.ban(drive.key)
    // Drive does not export closed state, probably should open issue.
    //t.equal(drive.closed, true, 'Drive should have been closed')
    await garden.purge(core.key)
    t.equal(core.closed, true, 'Hypercore should have been closed')

    try {
      await garden.get(pk)
    } catch (err) {
      t.equal(err.type, 'DeletedCoreError', 'garden#get() Throws DeletedCoreError')
    }

    try {
      await garden.get(dk)
    } catch (err) {
      t.equal(err.type, 'BannedCoreError', 'garden#get() Throws BannedCoreError')
    }

    try {
      await garden.get(Buffer.from('NOT A KEY'))
    } catch (err) {
      t.equal(err.type, 'NotFoundError', 'garden#get() Throws NotFoundError')
    }
  } catch (err) {
    t.error(err)
  } finally {
    await destroyFileStore()
  }
  t.end()
})
