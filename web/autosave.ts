import type { KritaModule } from './runtime.js'

type FolderRename = [from: string, to: string]

interface RecoveryMove {
  from: string
  to?: string
  snapshots?: Record<string, string>
}

export interface RecoveryState {
  move?: RecoveryMove
  directory: string
  filesDirectory: string
  filesStorageDirectory: string
  recoveryDirectory: string
  restoreVirtual: (directory?: string) => void
  pending: number
  error: string | null
  widgetsReady?: boolean
  failed: (error: unknown) => void
  sync: (write?: () => boolean | Promise<boolean>, rollback?: () => boolean | Promise<boolean>) => Promise<void>
  cancelStartup: () => void
  install: (module: KritaModule) => void
}

// IDBFS reconciles a whole mount. Give each live tab its own database so a
// stale in-memory tree cannot delete another tab's files during syncfs().
export async function prepareRecovery({ failed, startupFailed }: { failed: (message: string | null) => void, startupFailed: (error: unknown) => void }): Promise<RecoveryState> {
  if (!navigator.locks)
    throw new Error('Document recovery requires the Web Locks API.')
  const registryKey = 'krita.documents.v1'
  const prefix = '/krita/storage'
  const lockName = (directory: string) => `${registryKey}:${directory}`
  const readRegistry = (): string[] => {
    const ids = JSON.parse(localStorage.getItem(registryKey) || '[]')
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^\/krita\/storage\/[a-f0-9]{32}$/.test(id)))
      throw new Error('Invalid document recovery registry.')
    return [
      ...new Set(ids),
    ]
  }
  const hold = (name: string) => new Promise<(() => void) | null>((resolve, reject) => {
    navigator.locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null)
        return
      }
      return new Promise<void>(release => resolve(release))
    }).catch(reject)
  })
  const sessions: string[] = []
  const releases: (() => void)[] = []
  try {
    await navigator.locks.request(registryKey, async () => {
      // Ports already isolate dev/preview. One application registry per origin.
      const directories = readRegistry()
      for (const directory of directories) {
        const release = await hold(lockName(directory))
        if (release) {
          sessions.push(directory)
          releases.push(release)
        }
      }
      if (!sessions.length) {
        const directory = `${prefix}/${crypto.randomUUID().replaceAll('-', '')}`
        const release = await hold(lockName(directory))
        if (!release)
          throw new Error('Could not reserve document recovery storage.')
        sessions.push(directory)
        releases.push(release)
        directories.push(directory)
      }
      // Register before any files are written, so interrupted initialization
      // remains discoverable. Live-session locks last until navigation/close.
      localStorage.setItem(registryKey, JSON.stringify(directories))
    })
  }
  catch (error) {
    for (const release of releases) release()
    throw error
  }
  const directory = sessions[0]
  let instance: KritaModule
  let canceled = false
  let queue = Promise.resolve()
  let directSync: { primaryOnly: boolean, operations: Promise<void>[] } | undefined
  let finishMigration: (() => Promise<void>) | undefined
  const state: RecoveryState = {
    directory,
    filesDirectory: '/Documents',
    filesStorageDirectory: `${directory}/files`,
    recoveryDirectory: `${directory}/recovery`,
    restoreVirtual(parent = '') {
      restoreVirtual(`${directory}/virtual${parent}`, parent)
    },
    pending: 0,
    error: null,
    failed(error) {
      state.error = String(error)
      failed(`Browser cache could not be saved: ${state.error}`)
    },
    sync(write, rollback) {
      state.pending++
      const operation = queue.catch(() => {}).then(async () => {
        try {
          if (write && !await write())
            throw new Error('Could not write the browser cache copy.')
          await syncFiles(false, Boolean(write))
        }
        catch (error) {
          if (write && !await rollback?.())
            throw new Error('Could not restore the previous browser cache file.', { cause: error })
          throw error
        }
        // Retiring old session copies is independent of the acknowledged save.
        // Native completion requests an ordinary sync after recovery cleanup.
        if (!write)
          await finishMigration?.()
        state.error = null
        failed(null)
      }).catch((error) => {
        state.failed(error)
        throw error
      }).finally(() => state.pending--)
      queue = operation
      return operation
    },
    cancelStartup() {
      // Before preRun there are no native writers or filesystem operations.
      // Mounted initialization handles its own settled-failure cleanup.
      if (!instance) {
        canceled = true
        for (const release of releases) release()
      }
    },
    install(module) {
      module.addRunDependency('krita-recovery')
      if (canceled)
        throw new Error('Document startup was canceled.')
      instance = module
      initialize().catch((error) => {
        // Initialization has awaited every filesystem operation, and the run
        // dependency still prevents native writers from starting.
        for (const release of releases) release()
        throw error
      }).then(() => instance.removeRunDependency('krita-recovery')).catch((error) => {
        // Never start with an empty tree after a failed database read: a later
        // write could otherwise replace valid recovery records.
        state.failed(error)
        startupFailed(error)
      })
    },
  }
  async function syncFiles(populate: boolean, primaryOnly = false) {
    const batch = { primaryOnly, operations: [] as Promise<void>[] }
    const filesystem = new Promise<void>((resolve, reject) => {
      directSync = batch
      try {
        instance.FS.syncfs(populate, error => error
          ? reject(error)
          : resolve())
      }
      finally {
        directSync = undefined
      }
    })
    // FS.syncfs reports its first error before the other mounts finish. Keep
    // serialization (and any rollback) waiting for every operation it started.
    const results = await Promise.allSettled([filesystem, ...batch.operations])
    for (const result of results) {
      if (result.status === 'rejected')
        throw result.reason
    }
  }
  async function initialize() {
    const { FS, IDBFS } = instance
    const exists = (path: string) => {
      try {
        FS.lookupPath(path, { follow: true })
        return true
      }
      catch (error) {
        if (error instanceof FS.ErrnoError && error.errno === 44 /* ENOENT */)
          return false
        throw error
      }
    }
    // libc fsync invokes mount.type.syncfs directly, bypassing FS.syncfs.
    // Route those requests through the same queue as acknowledged saves.
    const persistentFS: Emscripten.FileSystemType = {
      ...IDBFS,
      syncfs(mount, populate, done) {
        if (directSync) {
          // A manual save acknowledges its own database; failures while retiring
          // another session cannot turn an already committed save into failure.
          if (directSync.primaryOnly && mount.mountpoint !== directory) {
            done()
          }
          else {
            directSync.operations.push(new Promise<void>((resolve, reject) => {
              try {
                IDBFS.syncfs(mount, populate, (error) => {
                  done(error)
                  if (error)
                    reject(error)
                  else
                    resolve()
                })
              }
              catch (error) {
                done(29 /* EIO */)
                reject(error)
              }
            }))
          }
        }
        else {
          void state.sync().then(() => done(), () => done(29 /* EIO */))
        }
      },
    }
    for (const path of sessions) {
      FS.mkdirTree(path)
      FS.mount(persistentFS, {}, path)
      // IDBFS restores files/ aliases before the lexically later virtual/ tree,
      // and chmod/utime follow the link. Make its known target available first.
      FS.mkdirTree(`${path}/virtual`)
    }
    await syncFiles(true)
    for (const root of sessions) {
      FS.mkdirTree(`${root}/virtual`)
      FS.mkdirTree(`${root}/files`)
      FS.mkdirTree(`${root}/recovery`)
    }
    // Record the copied source identities in the same database transaction as
    // their files. Retrying retirement after navigation must not import them
    // again or resurrect snapshots the user has since discarded.
    const logicalPath = (path: string) => path.startsWith('../')
      ? path.slice(2)
      : `${state.filesDirectory}/${path}`
    const relativePath = (path: string) => path.startsWith(`${state.filesDirectory}/`)
      ? path.slice(state.filesDirectory.length + 1)
      : `..${path}`
    const isLogicalPath = (value: unknown): value is string => typeof value === 'string'
      && value.startsWith('/') && !value.slice(1).split('/').some(part => !part || part === '.' || part === '..')
    const readImports = (root: string) => {
      const path = `${root}/imports.json`
      const entries = new Map<string, Map<string, string>>()
      if (!exists(path))
        return entries
      const record: unknown = JSON.parse(FS.readFile(path, { encoding: 'utf8' }))
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw new TypeError('Invalid document session import record.')
      for (const [source, files] of Object.entries(record)) {
        if (!/^\/krita\/storage\/[a-f0-9]{32}$/.test(source) || !files || typeof files !== 'object' || Array.isArray(files))
          throw new Error('Invalid imported document session.')
        const paths = new Map<string, string>()
        for (const [original, current] of Object.entries(files)) {
          if (!isLogicalPath(original) || !isLogicalPath(current))
            throw new Error('Invalid imported document path.')
          paths.set(original, current)
        }
        entries.set(source, paths)
      }
      return entries
    }
    const readRenameHistory = (root: string) => {
      const path = `${root}/folder-renames.json`
      const histories = new Map<string, FolderRename[]>()
      if (!exists(path))
        return histories
      const data: unknown = JSON.parse(FS.readFile(path, { encoding: 'utf8' }))
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new TypeError('Invalid document folder rename history.')
      for (const [id, renames] of Object.entries(data)) {
        if (!/^[a-f0-9]{32}$/.test(id) || !Array.isArray(renames) || !renames.every(
          (rename): rename is FolderRename => Array.isArray(rename) && rename.length === 2
            && isLogicalPath(rename[0]) && isLogicalPath(rename[1]),
        )) {
          throw new Error('Invalid document folder rename.')
        }
        histories.set(id, renames)
      }
      return histories
    }
    const importedSessions = readImports(directory)
    const renameHistory = readRenameHistory(directory)
    const sessionId = directory.slice(directory.lastIndexOf('/') + 1)
    const writeRenameHistory = () => FS.writeFile(`${directory}/folder-renames.json`, JSON.stringify(Object.fromEntries(renameHistory)))
    const managedAlias = (path: string) => FS.isLink(FS.lstat(path).mode)
      && sessions.some(root => FS.readlink(path) === `${root}/virtual`)
    const encodePath = (path: string) => encodeURIComponent(path).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    const recoverySuffix = '-autosave.kra'
    const namedRecovery = (name: string) => {
      const prefix = name.match(/^(?:\.krita-named-|\.krita-copy-[a-f0-9]{32}-)/)?.[0]
      if (prefix && name.endsWith(recoverySuffix)) {
        return {
          prefix,
          relative: decodeURIComponent(name.slice(prefix.length, -recoverySuffix.length)),
        }
      }
    }
    const importDirectory = (preferred: string) => {
      let path = preferred
      for (let suffix = 1; exists(path) && !FS.isDir(FS.lstat(path).mode); suffix++)
        path = `${preferred} (${suffix})`
      FS.mkdirTree(path)
      return path
    }
    const retainedUploads = new Set<string>()
    const copy = (source: string, destination: string, onFile: (source: string, target: string) => void = () => {}, recovery = false): string | undefined => {
      if (retainedUploads.has(source))
        return
      const stat = FS.lstat(source)
      if (FS.isDir(stat.mode)) {
        destination = importDirectory(destination)
        for (const name of FS.readdir(source).filter(name => name !== '.' && name !== '..'))
          copy(`${source}/${name}`, `${destination}/${name}`, onFile)
        return
      }
      if (managedAlias(source))
        return
      if (FS.isLink(stat.mode)) {
        if (FS.readlink(source) !== '..')
          throw new Error(`Unsupported cached link: ${source}`)
        FS.mkdirTree(destination.slice(0, destination.lastIndexOf('/')))
        FS.symlink('..', destination)
        return
      }
      if (!FS.isFile(stat.mode))
        throw new Error(`Unsupported cached file: ${source}`)
      const data = FS.readFile(source)
      if (exists(destination)) {
        const previous = FS.isFile(FS.lstat(destination).mode)
          ? FS.readFile(destination)
          : null
        if (!previous || previous.length !== data.length || previous.some((value, index) => value !== data[index])) {
          const suffix = destination.lastIndexOf('.') > destination.lastIndexOf('/')
            ? destination.lastIndexOf('.')
            : destination.length
          destination = recovery
            ? `${state.recoveryDirectory}/.krita-import-${crypto.randomUUID()}-autosave.kra`
            : `${destination.slice(0, suffix)}.import-${crypto.randomUUID()}${destination.slice(suffix)}`
        }
      }
      FS.mkdirTree(destination.slice(0, destination.lastIndexOf('/')))
      FS.writeFile(destination, data)
      FS.utime(destination, stat.mtime.getTime(), stat.mtime.getTime())
      onFile(source, destination)
      return destination
    }
    for (const path of sessions.slice(1)) {
      if (importedSessions.has(path))
        continue
      const id = path.slice(path.lastIndexOf('/') + 1)
      // Saved files can use any name, including the import-folder label.
      const parent = importDirectory(`${state.filesStorageDirectory}/Other sessions`)
      let imported = `${parent}/${id}`
      for (let suffix = 1; exists(imported); suffix++)
        imported = `${parent}/${id} (${suffix})`
      FS.mkdirTree(imported)
      const relocated = new Map<string, string>()
      const importedFiles = `${imported}/Documents`
      copy(`${path}/files`, importedFiles, (source, target) => relocated.set(source.slice(`${path}/files/`.length), target.slice(`${state.filesStorageDirectory}/`.length)))
      // Uploaded file layers retain their identity when a saved KRA moves
      // into Other sessions. Their UUID namespace is shared with native KRA metadata.
      const uploaded = `${path}/virtual/tmp`
      if (exists(uploaded)) {
        for (const name of FS.readdir(uploaded).filter(name => /^krita-upload-[a-f0-9]{32}-[A-Za-z0-9]{6}$/.test(name))) {
          const source = `${uploaded}/${name}`
          copy(source, `${directory}/virtual/tmp/${name}`, (source, target) => relocated.set(`../${source.slice(`${path}/virtual/`.length)}`, `../${target.slice(`${directory}/virtual/`.length)}`))
          retainedUploads.add(source)
        }
      }
      // Apply one prefix to the whole logical filesystem, preserving relative
      // links in either direction between Documents and other virtual paths.
      copy(`${path}/virtual`, imported, (source, target) => relocated.set(`../${source.slice(`${path}/virtual/`.length)}`, target.slice(`${state.filesStorageDirectory}/`.length)))
      for (const name of FS.readdir(`${path}/files`).filter(name => managedAlias(`${path}/files/${name}`)))
        FS.symlink('..', `${importedFiles}/${name}`)
      for (const name of FS.readdir(`${path}/recovery`).filter(name => name.endsWith(recoverySuffix))) {
        let targetName = `.krita-session-${id}-${name.replace(/^\.?krita-/, '')}`
        const recovery = namedRecovery(name)
        if (recovery) {
          const { prefix, relative } = recovery
          const savedPath = relocated.get(relative) || `${importedFiles.slice(state.filesStorageDirectory.length + 1)}/${relative}`
          targetName = `${prefix}${encodePath(savedPath)}${recoverySuffix}`
        }
        copy(`${path}/recovery/${name}`, `${state.recoveryDirectory}/${targetName}`, undefined, true)
      }
      importedSessions.set(path, new Map([...relocated].map(([original, current]) => [
        logicalPath(original),
        logicalPath(current),
      ])))
      for (const [origin, renames] of readRenameHistory(path)) {
        if (!renameHistory.has(origin))
          renameHistory.set(origin, renames)
      }
      for (const [source, files] of readImports(path)) {
        if (importedSessions.has(source))
          continue
        const carried = new Map<string, string>()
        for (const [original, current] of files) {
          const moved = relocated.get(relativePath(current))
          if (moved)
            carried.set(original, logicalPath(moved))
        }
        importedSessions.set(source, carried)
      }
    }
    const writeImports = () => FS.writeFile(`${directory}/imports.json`, JSON.stringify(
      Object.fromEntries([...importedSessions].map(([id, files]) => [
        id,
        Object.fromEntries(files),
      ])),
    ))
    writeImports()
    if (renameHistory.size)
      writeRenameHistory()
    const rename = FS.rename
    const filesPrefix = `${state.filesStorageDirectory}/`
    const virtualPrefix = `${directory}/virtual/`
    const logicalDirectory = (path: string) => {
      if (path.startsWith(filesPrefix))
        return logicalPath(path.slice(filesPrefix.length))
      if (path.startsWith(virtualPrefix))
        return path.slice(virtualPrefix.length - 1)
    }
    const updateNative = (move: RecoveryMove) => {
      state.move = move
      try {
        return instance._kritaWasmRelocateRecoveries() !== 0
      }
      finally {
        delete state.move
      }
    }
    FS.rename = (from, to) => {
      const original = FS.lookupPath(from, { follow: false })
      const fromDirectory = logicalDirectory(original.path)
      if (!fromDirectory || !FS.isDir(original.node.mode))
        return rename(from, to)
      const fromRoot = relativePath(fromDirectory)
      if (!updateNative({ from: fromDirectory }))
        throw new FS.ErrnoError(10 /* EBUSY */)
      const snapshots = FS.readdir(state.recoveryDirectory).flatMap((name) => {
        const recovery = namedRecovery(name)
        return recovery?.relative.startsWith(`${fromRoot}/`)
          ? [
              { name, ...recovery },
            ]
          : []
      })
      rename(from, to)
      const toDirectory = logicalDirectory(FS.getPath(original.node))
      if (!toDirectory || toDirectory === fromDirectory)
        return
      const toRoot = relativePath(toDirectory)
      let importsChanged = false
      for (const files of importedSessions.values()) {
        for (const [original, current] of files) {
          if (current.startsWith(`${fromDirectory}/`)) {
            files.set(original, toDirectory + current.slice(fromDirectory.length))
            importsChanged = true
          }
        }
      }
      const moved: Record<string, string> = {}
      for (const { name, prefix, relative } of snapshots) {
        const suffix = encodePath(toRoot + relative.slice(fromRoot.length)) + recoverySuffix
        let target = `${state.recoveryDirectory}/${prefix}${suffix}`
        while (exists(target))
          target = `${state.recoveryDirectory}/.krita-copy-${crypto.randomUUID().replaceAll('-', '')}-${suffix}`
        const previous = `${state.recoveryDirectory}/${name}`
        rename(previous, target)
        moved[previous] = target
      }
      if (importsChanged)
        writeImports()
      const renames = renameHistory.get(sessionId) ?? []
      renames.push([fromDirectory, toDirectory])
      renameHistory.set(sessionId, renames)
      writeRenameHistory()
      updateNative({ from: fromDirectory, to: toDirectory, snapshots: moved })
    }
    if (sessions.length > 1) {
      finishMigration = async () => {
        // The caller has committed the current primary tree, including any
        // recovery copies the user has since discarded. Retire source copies
        // only now; retrying after a quota failure must not resurrect them.
        const retire = (path: string) => {
          if (FS.isDir(FS.lstat(path).mode)) {
            for (const name of FS.readdir(path).filter(name => name !== '.' && name !== '..'))
              retire(`${path}/${name}`)
          }
          else {
            FS.unlink(path)
          }
        }
        for (const source of sessions.slice(1)) {
          for (const tree of ['files', 'virtual', 'recovery']) retire(`${source}/${tree}`)
        }
        await syncFiles(false)
        await navigator.locks.request(registryKey, async () => {
          const obsolete = new Set(sessions.slice(1))
          localStorage.setItem(registryKey, JSON.stringify(readRegistry().filter(path => !obsolete.has(path))))
        })
        for (const path of sessions.slice(1)) FS.unmount(path)
        for (const release of releases.slice(1)) release()
        finishMigration = undefined
      }
      // A quota error leaves copies browsable and originals locked. The next
      // successful ordinary sync also finishes this same migration cleanup.
      await state.sync().catch(() => {})
    }
    // A normal filesystem alias keeps database/session names out of native
    // dialogs without changing IDBFS's storage format or copying file bytes.
    FS.symlink(state.filesStorageDirectory, state.filesDirectory)
    const aliases = FS.readdir(state.filesStorageDirectory).filter(name => name !== '.' && name !== '..'
      && managedAlias(`${state.filesStorageDirectory}/${name}`))
    if (!aliases.length) {
      const preferred = 'Virtual filesystem'
      let name = preferred
      for (let suffix = 1; exists(`${state.filesStorageDirectory}/${name}`); suffix++)
        name = `${preferred} (${suffix})`
      FS.symlink(`${directory}/virtual`, `${state.filesStorageDirectory}/${name}`)
    }
    state.restoreVirtual()
  }
  function restoreVirtual(source: string, target: string) {
    const { FS } = instance
    const stat = FS.lstat(source)
    if (FS.isDir(stat.mode)) {
      FS.mkdirTree(target || '/')
      for (const name of FS.readdir(source).filter(name => name !== '.' && name !== '..'))
        restoreVirtual(`${source}/${name}`, `${target}/${name}`)
    }
    else if (FS.isFile(stat.mode)) {
      // Keep readers owned by another open document on their original inode.
      const staged = `${target}.krita-restore-${crypto.randomUUID()}`
      // Resolve through the persistent entry so cache deletion/rename is also
      // visible to file layers, without keeping a second copy of the bytes.
      FS.symlink(source, staged)
      FS.rename(staged, target)
    }
    else {
      throw new Error(`Unsupported cached virtual file: ${source}`)
    }
  }
  return state
}
