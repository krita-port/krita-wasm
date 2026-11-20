import type { KritaModule } from './runtime.js'

export interface RecoveryState {
  directory: string
  filesDirectory: string
  filesStorageDirectory: string
  recoveryDirectory: string
  pending: number
  error: string | null
  widgetsReady?: boolean
  failed: (error: unknown) => void
  sync: () => Promise<void>
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
  let queue = Promise.resolve()
  const state: RecoveryState = {
    directory,
    filesDirectory: '/Documents',
    filesStorageDirectory: `${directory}/files`,
    recoveryDirectory: `${directory}/recovery`,
    pending: 0,
    error: null,
    failed(error) {
      state.error = String(error)
      failed(`Browser cache could not be saved: ${state.error}`)
    },
    sync() {
      state.pending++
      const operation = queue.catch(() => {}).then(() => syncFiles(false)).then(() => {
        state.error = null
        failed(null)
      }).catch((error) => {
        state.failed(error)
        throw error
      }).finally(() => state.pending--)
      queue = operation
      return operation
    },
    install(module) {
      instance = module
      instance.addRunDependency('krita-recovery')
      initialize().then(() => instance.removeRunDependency('krita-recovery')).catch((error) => {
        // Never start with an empty tree after a failed database read: a later
        // write could otherwise replace valid recovery records.
        state.failed(error)
        startupFailed(error)
      })
    },
  }
  function syncFiles(populate: boolean) {
    return new Promise<void>((resolve, reject) => {
      instance.FS.syncfs(populate, error => error
        ? reject(error)
        : resolve())
    })
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
    for (const path of sessions) {
      FS.mkdirTree(path)
      FS.mount(IDBFS, {}, path)
    }
    await syncFiles(true)
    for (const root of sessions) {
      FS.mkdirTree(`${root}/files`)
      FS.mkdirTree(`${root}/recovery`)
    }
    // Fold abandoned sessions into the claimed one before the native startup
    // scan. Commit copies before removing originals; an interrupted migration
    // can leave duplicates, never an intentional gap without a snapshot.
    const migrated: string[] = []
    const encodePath = (path: string) => encodeURIComponent(path).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    const copy = (source: string, destination: string, onFile: (source: string, target: string) => void = () => {}, recovery = false): string | undefined => {
      const stat = FS.lstat(source)
      if (FS.isDir(stat.mode)) {
        FS.mkdirTree(destination)
        for (const name of FS.readdir(source).filter(name => name !== '.' && name !== '..'))
          copy(`${source}/${name}`, `${destination}/${name}`, onFile)
        return
      }
      if (!FS.isFile(stat.mode))
        throw new Error(`Unsupported cached file: ${source}`)
      const data = FS.readFile(source)
      if (exists(destination)) {
        const previous = FS.readFile(destination)
        if (previous.length !== data.length || previous.some((value, index) => value !== data[index])) {
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
      migrated.push(source)
      onFile(source, destination)
      return destination
    }
    for (const path of sessions.slice(1)) {
      const id = path.slice(path.lastIndexOf('/') + 1)
      // Namespace other closed tabs instead of overwriting same-named works.
      const imported = `${state.filesStorageDirectory}/Other sessions/${id}`
      const relocated = new Map()
      copy(`${path}/files`, imported, (source, target) => relocated.set(source.slice(`${path}/files/`.length), target.slice(`${state.filesStorageDirectory}/`.length)))
      for (const name of FS.readdir(`${path}/recovery`).filter(name => name.endsWith('-autosave.kra'))) {
        let targetName = `.krita-session-${id}-${name.replace(/^\.?krita-/, '')}`
        if (name.startsWith('.krita-named-')) {
          const relative = decodeURIComponent(name.slice('.krita-named-'.length, -'-autosave.kra'.length))
          targetName = `.krita-named-${encodePath(relocated.get(relative) || `Other sessions/${id}/${relative}`)}-autosave.kra`
        }
        copy(`${path}/recovery/${name}`, `${state.recoveryDirectory}/${targetName}`, undefined, true)
      }
    }
    if (sessions.length > 1) {
      await syncFiles(false)
      for (const path of migrated) FS.unlink(path)
      await syncFiles(false)
      for (const path of sessions.slice(1)) {
        FS.unmount(path)
        // Empty databases can remain: deleting while another page starts a
        // connection adds no recovery benefit. Remove discovery entries only.
      }
      await navigator.locks.request(registryKey, async () => {
        const obsolete = new Set(sessions.slice(1))
        localStorage.setItem(registryKey, JSON.stringify(readRegistry().filter(path => !obsolete.has(path))))
      })
      for (const release of releases.slice(1)) release()
    }
    // A normal filesystem alias keeps database/session names out of native
    // dialogs without changing IDBFS's storage format or copying file bytes.
    FS.symlink(state.filesStorageDirectory, state.filesDirectory)
  }
  return state
}
