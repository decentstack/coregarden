# Core Garden

Higher level storage provider for hypercore based data structures

### Usage
```js
const RAM = require('random-access-memory')
const memdb = require('memdb')

const hypercore = require('hypercore')
const hypertrie = require('hypertrie')
const hyperdrive = require('hyperdrive')

const Garden = require('coregarden')


const garden = Garden(RAM, memdb(), {
  mappers: {
    hypercore,
    hypertrie,
    hyperdrive
  }
})

try {
  const myTrie = await garden.plant('hypertrie')

  const meta = await garden.getMeta(myTrie.key)
  console.log(meta)

  await garden.closeCore(mTrie)
} catch (err) {
  console.error('Something went wrong', err)
}
```

### API

#### `Garden(storage, lvl, opts = {})`

**`storage`** - `RandomAccess` a base storage

**`lvl`** - `LevelDown` a leveldb instance

**`opts.mappers`** `hash` where keys are type names in form of strings and the
values should be factory functions that generate said type

example:
```js
{
  hypercore: (storage, key, opts) => require('hypercore')(storage, key opts)
}
```

#### `Garden#registerType(type, factoryFn)`

Appends type and factory function to internal mappers.

#### `Garden#getMeta(key)`

Returns Promise of stored metadata for registered key


#### `Garden#get(key, ...coreopts)`

returns Promise of previously stored core, loads a core into memory if
not previously loaded.

Throws `DeletedCoreError` if key was previously purged.

Throws `BannedCoreError` if key was previously banned.

Throws `NotFoundError` if key refences an unknown core.


#### `Garden#sizeOf(key)`

returns Promise of a core's total size on storage in bytes

#### `Garden#sync()`

returns Promise that is either resolved or will be resolved
as soon as metadata is persisted to disc.

#### `Garden#plant(type, [key, ...coreopts] | [manualPlantFn])

Allocates a new storage space `pot` for given `type`.

The mapper factoryFn can be overridden by providing a function as the second
argument to plant. Word of caution, overriding the factory function like this
can produce cores that won't be possible to re-open from storage.

Only use this if you are locally creating a competely new core and want to
initialize it before making it available for replication.

ex.

```
// In most cases you should use:
const emptyfeed = garden.plant('hypercore', key)

// Sometimes you might want to take extra initialization steps during datastructure creation.
const nonEmptyFeed = garden.plant('hypercore', (storage, plant, factoryFn) => {
  const core = factoryFn(storage) // shortcut for the registered mapper function
  core.ready(() => {
    core.append(Buffer.from('My app-specific header/identifier'))
    plant(core)
  })
})

```

returns Promise that resolves to the core when it's ready and stored.

#### `Garden#close(callback)`

Closes all associated resources and also all opened cores.
Callback is invoked once the garden is fully closed.
You should not use the garden instance after it's closed, rather initialize
a new one. This method is part of the replic8 interface.

#### `Garden#closed`

boolean indicator if this instance has been closed

#### `Garden#closeCore(key)`

Closes all resources related to the feed and throws away all refences to let
it be garbage collected.

Also invokes `core.close(cb)` if the datastructure has a `close` function

Calling `Garden#get(key)` reopens the core.

#### `Garden#listMeta()`

returns a promise of a list of all metadata entries.

#### `Garden#listCores()`

Returns a promise of a list of all cores and their metadata

#### `Garden#ban(key, purge = true)`

Marks a key as banned in meta-data which causes garden to throw
`BannedCoreError` if the key is attempted to be added again.

By default the ban operation also purges all the cores files from storage.
Returns a promise that fullfills when core has been successfully banned and
optionally purged.

#### `Garden#isBanned(key)`

Returns a promise of a boolean.

#### `Garden#purge(key, ban = false)`

Purges the storage from all files created by the core.
Returns a promise that resolves once the operation has completed.

#### `Garden#listFiles(key)`

Returns a pomise of a list of all file-entries created by the key


#### Replication
CoreGarden does not attempt to provide replication for all stored cores,
but instead implements the following methods from the `Replic8` interface:

`share()` shares all registered cores.

`describe()` Decorates shared cores with the result of `getMeta(key)`

`accept()` When invoked garden checks if supplied key exists, if not then it
creates the core.

`resolve()` Resolves known keys into core references.

Example how to replicate cores stored in Garden:

```js
const replic8 = require('replic8')

const stack = replic8(exchangeKey)
stack.use(mGardenInstance)

const stream = stack.replicate()
```


### License

GNU LGPL 3.0
