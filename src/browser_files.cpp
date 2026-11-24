#include <KLocalizedString>
#include <KisDocument.h>
#include <KisImportExportManager.h>
#include <KisMainWindow.h>
#include <KisPart.h>
#include <KisRecentFilesManager.h>
#include <KoFileDialog.h>
#include <KoStore.h>
#include <QApplication>
#include <QBuffer>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QDirIterator>
#include <QEventLoop>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QMap>
#include <QMessageBox>
#include <QPointer>
#include <QPushButton>
#include <QRegularExpression>
#include <QSet>
#include <QTemporaryDir>
#include <QTemporaryFile>
#include <QThread>
#include <QTimer>
#include <QUrl>
#include <QUuid>
#include <QVBoxLayout>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <emscripten.h>
#include <kis_file_layer.h>
#include <kis_group_layer.h>
#include <kis_image.h>
#include <kis_layer_utils.h>
#include <memory>
#include <unistd.h>

EM_JS_DEPS(krita_file_dialog, "$UTF8ToString,$stringToNewUTF8,$getWasmTableEntry");

EM_ASYNC_JS(char *, kritaWasmChooseFiles, (const char *directory, const char *title), {
    const paths = await globalThis.kritaChooseFiles(UTF8ToString(directory), UTF8ToString(title));
    return paths ? stringToNewUTF8(JSON.stringify(paths)) : 0;
});

// clang-format off
EM_ASYNC_JS(int, kritaWasmCommitStorage, (void *transaction, intptr_t write, intptr_t rollback, bool discard), {
    try {
        // Retire abandoned session copies before committing a deletion. A
        // retirement failure must leave the recovery snapshot intact.
        if (discard)
            await globalThis.kritaRecovery.sync();
        await globalThis.kritaRecovery.sync(
            async () => await WebAssembly.promising(getWasmTableEntry(write))(transaction) !== 0,
            async () => await WebAssembly.promising(getWasmTableEntry(rollback))(transaction) !== 0);
        return 1;
    } catch (error) {
        return 0;
    }
});
// clang-format on

QString kritaWasmCachePath(const QString &path);
QString kritaWasmStoragePath(const QString &path);
QString kritaWasmUploadedFilePath(const QString &path);

namespace {
void releaseUploadFiles(const QString &folder) {
    if (folder.isEmpty())
        return;
    QDir(folder).removeRecursively();
    // Recreate only already-persistent aliases after releasing temporary bytes.
    // Cached documents can still refer to these inputs after the uploader closes.
    if (QFileInfo(kritaWasmStoragePath(folder)).isDir()) {
        const auto path = folder.toUtf8();
        EM_ASM({ globalThis.kritaRecovery.restoreVirtual(UTF8ToString($0)); }, path.constData());
    }
}

bool copyCacheFile(const QString &source, const QString &destination) {
    QFile input(source);
    QTemporaryFile output(QFileInfo(destination).absolutePath() +
                          QStringLiteral("/.krita-write-XXXXXX"));
    if (!QDir().mkpath(QFileInfo(destination).absolutePath()) || !input.open(QIODevice::ReadOnly) ||
        !output.open()) {
        EM_ASM({ globalThis.kritaRecovery.failed('Could not create the browser cache copy.'); });
        return false;
    }
    while (!input.atEnd()) {
        const auto chunk = input.read(1024 * 1024);
        if (input.error() != QFileDevice::NoError || output.write(chunk) != chunk.size()) {
            EM_ASM({ globalThis.kritaRecovery.failed('Could not write the browser cache copy.'); });
            return false;
        }
    }
    if (!output.flush())
        return false;
    output.close();
    // QSaveFile::commit calls fsync, which syncs an entire IDBFS mount outside
    // the page queue. Rename the completed MEMFS bytes atomically instead;
    // the caller owns the one durable sync and restores targets on failure.
    if (std::rename(QFile::encodeName(output.fileName()).constData(),
                    QFile::encodeName(destination).constData()) != 0) {
        EM_ASM({ globalThis.kritaRecovery.failed('Could not finish the browser cache copy.'); });
        return false;
    }
    output.setAutoRemove(false);
    return true;
}

bool linkCacheFile(const QString &source, const QString &destination) {
    const QDir parent = QFileInfo(destination).dir();
    if (!QDir().mkpath(parent.absolutePath()))
        return false;
    const QString staged = parent.filePath(QStringLiteral(".krita-link-") +
                                           QUuid::createUuid().toString(QUuid::WithoutBraces));
    if (::symlink(QFile::encodeName(source).constData(), QFile::encodeName(staged).constData()) !=
        0)
        return false;
    if (std::rename(QFile::encodeName(staged).constData(),
                    QFile::encodeName(destination).constData()) != 0) {
        QFile::remove(staged);
        return false;
    }
    return true;
}

struct CacheWrite {
    QString source;
    QString destination;
    bool link = false;
    QString backup = {};
    QString originalLink = {};
    bool existed = false;
    bool prepared = false;
};

struct CacheTransaction {
    QTemporaryDir backups;
    QList<CacheWrite> writes;

    bool apply() {
        if (!backups.isValid())
            return false;
        for (qsizetype i = 0; i < writes.size(); ++i) {
            auto &write = writes[i];
            const QFileInfo info(write.destination);
            write.existed = info.exists();
            if (info.isSymLink())
                write.originalLink = info.symLinkTarget();
            write.backup = backups.filePath(QString::number(i));
            if (write.existed && write.originalLink.isEmpty() &&
                !copyCacheFile(write.destination, write.backup))
                return false;
            write.prepared = true;
        }
        for (const auto &write : writes) {
            // An empty source is an acknowledged deletion, with the same
            // backup/rollback protection as an overwritten saved file.
            if (write.source.isEmpty()) {
                if ((QFile::exists(write.destination) ||
                     QFileInfo(write.destination).isSymLink()) &&
                    !QFile::remove(write.destination))
                    return false;
            } else if (write.link) {
                if (!linkCacheFile(write.source, write.destination))
                    return false;
            } else if (!copyCacheFile(write.source, write.destination))
                return false;
        }
        return true;
    }

    bool rollback() {
        bool restored = true;
        for (const auto &write : writes) {
            if (!write.prepared)
                continue;
            if (!write.originalLink.isEmpty())
                restored = linkCacheFile(write.originalLink, write.destination) && restored;
            else if (write.existed)
                restored = copyCacheFile(write.backup, write.destination) && restored;
            else if (QFile::exists(write.destination) || QFileInfo(write.destination).isSymLink())
                restored = QFile::remove(write.destination) && restored;
        }
        if (!restored)
            backups.setAutoRemove(false);
        return restored;
    }
};

QString savedRecoveryPath(const KisDocument *document, const QString &saved, bool forSave = false) {
    const QString current = document->property("kritaWasmRecoveryPath").toString();
    if (document->property("kritaWasmSavedPath").toString() == saved && !current.isEmpty())
        return current;
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    const QDir recovery(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")));
    const QString relative =
        QString::fromLatin1(QUrl::toPercentEncoding(files.relativeFilePath(saved)));
    const QString named =
        recovery.filePath(QStringLiteral(".krita-named-%1-autosave.kra").arg(relative));
    bool claimed = forSave && QFile::exists(named);
    for (auto other : KisPart::instance()->documents()) {
        if (other && other != document &&
            other->property("kritaWasmRecoveryPath").toString() == named)
            claimed = true;
    }
    // An abandoned snapshot belongs to its original document just as a live
    // document's snapshot does. Saving another document never claims it.
    if (claimed)
        return recovery.filePath(QStringLiteral(".krita-copy-%1-%2-autosave.kra")
                                     .arg(QUuid::createUuid().toString(QUuid::Id128), relative));
    return named;
}

void appendUploadedReferences(KisDocument *document, CacheTransaction &transaction) {
    if (!document->image())
        return;
    QStringList references;
    KisLayerUtils::recursiveApplyNodes(KisNodeSP(document->image()->root()), [&](KisNodeSP node) {
        if (auto *layer = dynamic_cast<KisFileLayer *>(node.data())) {
            const QString uploaded = kritaWasmUploadedFilePath(layer->path());
            if (!uploaded.isEmpty())
                references.append(uploaded);
        }
    });
    references.removeDuplicates();
    for (const auto &path : references) {
        if (!QFileInfo(path).isFile() || !kritaWasmCachePath(path).isEmpty())
            continue;
        const QString stored = kritaWasmStoragePath(path);
        transaction.writes.append({path, stored});
        transaction.writes.append({stored, path, true});
    }
}

void rememberSavedFiles(KisDocument *document, const QString &path, const QStringList &outputs) {
    delete document->findChild<QObject *>(QStringLiteral("kritaWasmSavedVersion"));
    auto *version = new QObject(document);
    version->setObjectName(QStringLiteral("kritaWasmSavedVersion"));
    version->setProperty("path", path);
    const QStringList files = outputs.isEmpty() ? QStringList{path} : outputs;
    for (const auto &output : files) {
        // MEMFS open descriptors retain the original inode across rename and
        // atomic replacement, without copying another full KRA into memory.
        auto *reader = new QFile(output, version);
        reader->setObjectName(output);
        if (!reader->open(QIODevice::ReadOnly)) {
            delete version;
            return;
        }
    }
}

} // namespace

static int applySave(void *transaction) {
    return static_cast<CacheTransaction *>(transaction)->apply();
}

static int rollbackSave(void *transaction) {
    return static_cast<CacheTransaction *>(transaction)->rollback();
}

bool kritaWasmPersistUploadedReferences(KisDocument *document) {
    CacheTransaction transaction;
    appendUploadedReferences(document, transaction);
    if (transaction.writes.isEmpty())
        return true;
    bool committed = false;
    QEventLoop pending;
    QTimer::singleShot(0, &pending, [&] {
        committed = kritaWasmCommitStorage(&transaction, reinterpret_cast<intptr_t>(&applySave),
                                           reinterpret_cast<intptr_t>(&rollbackSave), false);
        pending.quit();
    });
    pending.exec(QEventLoop::ExcludeUserInputEvents);
    return committed;
}

bool kritaWasmDiscardRecoveries(const QStringList &paths) {
    if (paths.isEmpty())
        return true;
    CacheTransaction transaction;
    for (const auto &path : paths)
        transaction.writes.append({QString{}, path});
    return kritaWasmCommitStorage(&transaction, reinterpret_cast<intptr_t>(&applySave),
                                  reinterpret_cast<intptr_t>(&rollbackSave), true);
}

bool kritaWasmDiscardRecovery(const QString &path) { return kritaWasmDiscardRecoveries({path}); }

QString kritaWasmCachePath(const QString &path) {
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    const QFileInfo info(path);
    const QString parent = info.dir().canonicalPath();
    const QString physical =
        parent.isEmpty() ? info.absoluteFilePath() : parent + QLatin1Char('/') + info.fileName();
    const QDir virtualFiles(QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")))
                                .absoluteFilePath(QStringLiteral("../virtual")));
    const QString virtualRoot = virtualFiles.canonicalPath();
    if (!virtualRoot.isEmpty() && physical.startsWith(virtualRoot + QLatin1Char('/')))
        return QLatin1Char('/') + QDir(virtualRoot).relativeFilePath(physical);
    const QString root = files.canonicalPath();
    if (!root.isEmpty() && physical.startsWith(root + QLatin1Char('/')))
        return files.filePath(QDir(root).relativeFilePath(physical));
    const QString stored = QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")))
                               .absoluteFilePath(QStringLiteral("../virtual") + physical);
    return QFileInfo(stored).isFile() ? physical : QString{};
}

QString kritaWasmUploadedFilePath(const QString &path) {
    const QString resolved = QFileInfo(path).canonicalFilePath();
    const QString cached = kritaWasmCachePath(resolved.isEmpty() ? path : resolved);
    const QString logical =
        QDir::cleanPath(cached.isEmpty() ? (resolved.isEmpty() ? path : resolved) : cached);
    static const QRegularExpression upload(
        QStringLiteral("^/tmp/krita-upload-[a-f0-9]{32}-[A-Za-z0-9]{6}/.+"));
    return upload.match(logical).hasMatch() ? logical : QString{};
}

QString kritaWasmStoragePath(const QString &path) {
    const QString logical = QDir::cleanPath(QFileInfo(path).absoluteFilePath());
    const QString files = QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR"));
    if (logical.startsWith(files + QLatin1Char('/')))
        return logical;
    const QString root = QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")))
                             .absoluteFilePath(QStringLiteral("../virtual"));
    return QDir::cleanPath(root + logical);
}

static QString recoverySaveDestination(const QString &path) {
    const QString name = QFileInfo(path).fileName();
    const QString prefix = QStringLiteral(".krita-named-");
    const QString suffix = QStringLiteral("-autosave.kra");
    static const QRegularExpression copyPrefix(QStringLiteral("^\\.krita-copy-[a-f0-9]{32}-"));
    const auto copy = copyPrefix.match(name);
    const int offset = name.startsWith(prefix) ? prefix.size()
                       : copy.hasMatch()       ? copy.capturedLength()
                                               : 0;
    if (!offset || !name.endsWith(suffix))
        return {};
    const QString relative = QDir::cleanPath(QUrl::fromPercentEncoding(
        name.mid(offset, name.size() - offset - suffix.size()).toLatin1()));
    if (QDir::isAbsolutePath(relative))
        return {};
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    return QDir::cleanPath(files.filePath(relative));
}

static QJsonArray recoveryFolderRenames(const QDir &storage, const QString &origin) {
    QFile history(storage.filePath(QStringLiteral("folder-renames.json")));
    if (!history.open(QIODevice::ReadOnly))
        return {};
    return QJsonDocument::fromJson(history.readAll()).object().value(origin).toArray();
}

QString kritaWasmEncodeRecoverySource(const QString &archive, const QString &path) {
    const QDir recovery(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")));
    if (QFileInfo(archive).absolutePath() != recovery.absolutePath())
        return {};
    const auto cached = kritaWasmCachePath(path);
    if (cached.isEmpty())
        return {};
    const auto storage = QFileInfo(recovery.absolutePath()).dir();
    const auto origin = storage.dirName();
    const auto revision = recoveryFolderRenames(storage, origin).size();
    const auto saved = recoverySaveDestination(archive);
    return origin + QLatin1Char('/') + QString::number(revision) + QLatin1Char('/') +
           QString::fromLatin1(QUrl::toPercentEncoding(saved)) + cached;
}

QString kritaWasmResolveRecoverySource(const QString &archive, const QString &reference) {
    const QDir recovery(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")));
    if (reference.isEmpty() || QFileInfo(archive).absolutePath() != recovery.absolutePath())
        return {};
    const auto storage = QFileInfo(recovery.absolutePath()).dir();
    const QLatin1Char separator('/');
    const auto origin = reference.section(separator, 0, 0);
    bool revisionValid = false;
    const auto revision = reference.section(separator, 1, 1).toLongLong(&revisionValid);
    auto anchor = QUrl::fromPercentEncoding(reference.section(separator, 2, 2).toLatin1());
    QString path = QStringLiteral("/") + reference.section(separator, 3);
    static const QRegularExpression id(QStringLiteral("^[a-f0-9]{32}$"));
    if (!id.match(origin).hasMatch() || !revisionValid || revision < 0 ||
        path == QStringLiteral("/") || QDir::cleanPath(path) != path)
        return {};
    const auto renames = recoveryFolderRenames(storage, origin);
    // Save As may copy the snapshot to a different name. Only an actual
    // folder rename that moves both the original and its layer changes the link.
    for (qsizetype index = revision; index < renames.size(); ++index) {
        const auto move = renames.at(index).toArray();
        const auto from = move.at(0).toString();
        const auto to = move.at(1).toString();
        const QString prefix = from + separator;
        if (anchor.startsWith(prefix)) {
            anchor = to + anchor.mid(from.size());
            if (path.startsWith(prefix))
                path = to + path.mid(from.size());
        }
    }
    if (storage.dirName() == origin)
        return path;
    QFile imports(storage.filePath(QStringLiteral("imports.json")));
    if (imports.open(QIODevice::ReadOnly)) {
        const auto sessions = QJsonDocument::fromJson(imports.readAll()).object();
        const auto original = QFileInfo(storage.absolutePath()).dir().filePath(origin);
        const auto current = sessions.value(original).toObject().value(path).toString();
        if (!current.isEmpty())
            return current;
    }
    // Never bind a migrated layer to an unrelated file in the primary session.
    return recovery.filePath(origin + path);
}

bool kritaWasmRemoveAnimationFrames(const QDir &dir, const QStringList &frames) {
    CacheTransaction transaction;
    QSet<QString> paths;
    for (const auto &frame : frames) {
        const QString path = dir.absoluteFilePath(frame);
        const QString cached = kritaWasmCachePath(path);
        if (cached.isEmpty()) {
            if (QFileInfo(path).isFile())
                paths.insert(path);
        } else {
            if (QFileInfo(cached).isSymLink())
                paths.insert(cached);
            paths.insert(kritaWasmStoragePath(cached));
        }
    }
    for (const auto &path : paths)
        transaction.writes.append({QString{}, path});
    return transaction.writes.isEmpty() ||
           kritaWasmCommitStorage(&transaction, reinterpret_cast<intptr_t>(&applySave),
                                  reinterpret_cast<intptr_t>(&rollbackSave), false);
}

void kritaWasmSyncRecovery() {
    // IDBFS acknowledges the IndexedDB transaction asynchronously. The page
    // owns serialization and reports failures without losing the previous copy.
    // This JavaScript arrow must not be tokenized as C++ operators.
    // clang-format off
    EM_ASM({ globalThis.kritaRecovery.sync().catch(() => {}); });
    // clang-format on
}

QString kritaWasmRecoveryFileName(const KisDocument *document, const QString &source) {
    auto *mutableDocument = const_cast<KisDocument *>(document);
    auto path = document->property("kritaWasmRecoveryPath").toString();
    if (!path.isEmpty())
        return path;
    auto saved = document->property("kritaWasmSavedPath").toString();
    if (saved.isEmpty() && !kritaWasmCachePath(source).isEmpty()) {
        saved = kritaWasmCachePath(source);
        mutableDocument->setProperty("kritaWasmSavedPath", saved);
    }
    path = saved.isEmpty()
               ? QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")))
                     .filePath(QStringLiteral(".krita-%1-%2-autosave.kra")
                                   .arg(document->objectName(),
                                        QUuid::createUuid().toString(QUuid::WithoutBraces)))
               : savedRecoveryPath(document, saved);
    mutableDocument->setProperty("kritaWasmRecoveryPath", path);
    return path;
}

void kritaWasmRestoreRecoveryIdentity(KisDocument *document, const QString &path) {
    document->setProperty("kritaWasmRecoveryPath", path);
    const auto saved = recoverySaveDestination(path);
    if (!saved.isEmpty())
        document->setProperty("kritaWasmSavedPath", saved);
}

EM_JS(char *, kritaWasmRecoveryMove, (),
      { return stringToNewUTF8(JSON.stringify(globalThis.kritaRecovery.move)); });

extern "C" EMSCRIPTEN_KEEPALIVE int kritaWasmRelocateRecoveries() {
    const std::unique_ptr<char, decltype(&std::free)> json(kritaWasmRecoveryMove(), &std::free);
    const auto move = QJsonDocument::fromJson(QByteArray(json.get())).object();
    const auto source = move.value(QStringLiteral("from")).toString();
    const auto destination = move.value(QStringLiteral("to")).toString();
    const auto snapshots = move.value(QStringLiteral("snapshots")).toObject();
    for (const auto &document : KisPart::instance()->documents()) {
        if (!document)
            continue;
        const auto saved = document->property("kritaWasmSavedPath").toString();
        if (!saved.startsWith(source + QLatin1Char('/')))
            continue;
        if (destination.isEmpty()) {
            if (document->isSaving() || document->property("kritaWasmPreparingAutoSave").toBool())
                return 0;
            continue;
        }
        const auto previous = document->property("kritaWasmRecoveryPath").toString();
        const auto renamed = snapshots.value(previous).toString();
        if (!renamed.isEmpty()) {
            kritaWasmRestoreRecoveryIdentity(document, renamed);
        } else {
            const QString savedPath = destination + saved.mid(source.size());
            document->setProperty("kritaWasmSavedPath", savedPath);
            if (!QFile::exists(previous))
                document->setProperty("kritaWasmRecoveryPath", QString{});
        }
    }
    return 1;
}

bool kritaWasmCommitSavedFile(KisDocument *document, const QString &source, const QString &staged,
                              bool exporting, bool nativeFormat) {
    // Frame exporters also call the synchronous API from image worker threads.
    if (QThread::currentThread() != qApp->thread()) {
        bool committed = false;
        QMetaObject::invokeMethod(
            qApp,
            [&] {
                committed =
                    kritaWasmCommitSavedFile(document, source, staged, exporting, nativeFormat);
            },
            Qt::BlockingQueuedConnection);
        return committed;
    }
    const QString cached = kritaWasmCachePath(source);
    const QString destination =
        cached.isEmpty() ? QDir::cleanPath(QFileInfo(source).absoluteFilePath()) : cached;
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    const QDir virtualFiles(QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")))
                                .absoluteFilePath(QStringLiteral("../virtual")));
    const bool external = !destination.startsWith(files.absolutePath() + QLatin1Char('/'));
    CacheTransaction transaction;
    QStringList outputs;
    const QDir stagedDirectory = QFileInfo(staged).dir();
    const QDir outputDirectory = QFileInfo(destination).dir();
    QDirIterator generated(stagedDirectory.absolutePath(),
                           QDir::Files | QDir::Hidden | QDir::NoDotAndDotDot,
                           QDirIterator::Subdirectories);
    while (generated.hasNext()) {
        const QString path = generated.next();
        if (QFileInfo(path).isSymLink())
            return false;
        const QString target = outputDirectory.filePath(stagedDirectory.relativeFilePath(path));
        if (external) {
            const QString stored = virtualFiles.absolutePath() + target;
            transaction.writes.append({path, stored});
            transaction.writes.append({stored, target, true});
        } else {
            transaction.writes.append({path, target});
        }
        outputs.append(target);
    }

    // Native saves and their layered recovery copies keep uploaded file-layer
    // inputs alive after the temporary upload directory is released.
    bool layered = !exporting || nativeFormat;
    for (const auto &output : outputs)
        layered = layered || output.endsWith(QLatin1String(".kra"), Qt::CaseInsensitive) ||
                  output.endsWith(QLatin1String(".krz"), Qt::CaseInsensitive);
    if (layered)
        appendUploadedReferences(document, transaction);

    const QString currentRecovery = savedRecoveryPath(document, destination, true);
    const auto previousRecovery = document->property("kritaWasmRecoveryPath").toString();
    if (!exporting && !nativeFormat && previousRecovery != currentRecovery &&
        QFile::exists(previousRecovery))
        transaction.writes.append({previousRecovery, currentRecovery});
    // Copy and rollback run inside the page's serialized sync queue. No other
    // sync may publish a rejected overwrite before its original is restored.
    if (!kritaWasmCommitStorage(&transaction, reinterpret_cast<intptr_t>(&applySave),
                                reinterpret_cast<intptr_t>(&rollbackSave), false))
        return false;
    document->setProperty("kritaWasmDownloadFiles", outputs);
    // Manual bytes are durable before any recovery deletion can reach syncfs.
    if (!exporting) {
        document->setProperty("kritaWasmSavedPath", destination);
        document->setProperty("kritaWasmSavedFiles", outputs);
        rememberSavedFiles(document, destination, outputs);
        document->setProperty("kritaWasmRecoveryPath", currentRecovery);
        if (!previousRecovery.isEmpty() && previousRecovery != currentRecovery)
            QFile::remove(previousRecovery);
        if (nativeFormat)
            QFile::remove(currentRecovery);
        kritaWasmSyncRecovery();
    }
    return true;
}

bool kritaWasmOpenCachedDocument(KisMainWindow *window, const QString &path, bool importing) {
    const auto cached = kritaWasmCachePath(path);
    if (cached.isEmpty() || !QFileInfo(kritaWasmStoragePath(cached)).isFile()) {
        const QUrl recentUrl = QUrl::fromLocalFile(path);
        QTimer::singleShot(0, qApp,
                           [recentUrl] { KisRecentFilesManager::instance()->remove(recentUrl); });
        return false;
    }
    const QString files = QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR"));
    if (!cached.startsWith(files + QLatin1Char('/'))) {
        const auto parent = QFileInfo(cached).absolutePath().toUtf8();
        EM_ASM({ globalThis.kritaRecovery.restoreVirtual(UTF8ToString($0)); }, parent.constData());
    }
    return window->openDocument(cached, importing ? KisMainWindow::Import : KisMainWindow::None);
}

namespace {
void showError(QWidget *parent, const QString &message) {
    QMessageBox::warning(parent, i18n("Krita"), message);
}

void offerDownload(const QString &path, const QStringList &outputs = {},
                   QObject *version = nullptr) {
    QByteArray content;
    QString downloadPath = path;
    if (outputs.size() > 1) {
        downloadPath = QFileInfo(path).completeBaseName() + QStringLiteral(".zip");
        QBuffer buffer(&content);
        std::unique_ptr<KoStore> archive(
            KoStore::createStore(&buffer, KoStore::Write, {}, KoStore::Zip, false));
        const QDir directory = QFileInfo(path).dir();
        bool ok = archive && !archive->bad();
        for (const auto &output : outputs) {
            QFile input(output);
            auto *reader = version ? version->findChild<QFile *>(output) : &input;
            if (!ok || !reader || (!version && !reader->open(QIODevice::ReadOnly)) ||
                !reader->seek(0) || !archive->open(directory.relativeFilePath(output))) {
                ok = false;
                break;
            }
            for (;;) {
                const auto chunk = reader->read(1024 * 1024);
                if (reader->error() != QFileDevice::NoError) {
                    ok = false;
                    break;
                }
                if (chunk.isEmpty())
                    break;
                if (archive->write(chunk) != chunk.size()) {
                    ok = false;
                    break;
                }
            }
            ok = archive->close() && ok;
        }
        if (!ok || !archive->finalize()) {
            showError(qApp->activeWindow(), i18n("Could not save %1.", downloadPath));
            return;
        }
    } else {
        QFile file(path);
        auto *reader = version ? version->findChild<QFile *>(path) : &file;
        if (!reader || (!version && !reader->open(QIODevice::ReadOnly)) || !reader->seek(0)) {
            showError(qApp->activeWindow(), i18n("Could not open %1.", path));
            return;
        }
        // QFile's cached/path-based size may describe a replacement file.
        // Read the retained descriptor until EOF rather than trusting that size.
        for (;;) {
            const auto chunk = reader->read(1024 * 1024);
            if (reader->error() != QFileDevice::NoError) {
                showError(qApp->activeWindow(), reader->errorString());
                return;
            }
            if (chunk.isEmpty())
                break;
            content.append(chunk);
        }
    }
    // Capture the completed bytes: another save may replace the VFS path while
    // this prompt is open. Keep the prompt available if a native picker is
    // cancelled; saveFileContent has no completion/cancellation callback.
    // Return from the background-save completion signal before creating GUI
    // objects: Qt's Wasm dispatcher may currently be resuming a JSPI frame.
    QTimer::singleShot(0, qApp, [content, path = downloadPath] {
        auto *dialog = new QDialog(KisPart::instance()->currentMainwindow());
        dialog->setObjectName(QStringLiteral("kritaWasmDownloadDialog"));
        dialog->setWindowTitle(i18n("Save"));
        dialog->setAttribute(Qt::WA_DeleteOnClose);
        auto *layout = new QVBoxLayout(dialog);
        auto *label = new QLabel(
            i18nd(
                "krita-wasm",
                "The file is ready. Click Download to save a copy to your device. The browser cache is separate from this download. You can retry Download if the file picker is canceled."),
            dialog);
        label->setObjectName(QStringLiteral("kritaWasmDownloadMessage"));
        label->setWordWrap(true);
        layout->addWidget(label);
        auto *name = new QLabel(QFileInfo(path).fileName(), dialog);
        name->setTextFormat(Qt::PlainText);
        layout->addWidget(name);
        auto *buttons = new QDialogButtonBox(QDialogButtonBox::Close, dialog);
        auto *download =
            buttons->addButton(i18nd("krita-wasm", "Download"), QDialogButtonBox::ActionRole);
        download->setObjectName(QStringLiteral("kritaWasmDownload"));
        layout->addWidget(buttons);
        QObject::connect(buttons, &QDialogButtonBox::rejected, dialog, &QDialog::close);
        QObject::connect(download, &QPushButton::clicked, dialog, [content, path, dialog] {
            // The fresh click supplies user activation for File System Access.
            // Other browsers use Qt's Blob/download fallback.
            QFileDialog::saveFileContent(content, QFileInfo(path).fileName(), dialog);
        });
        dialog->open();
    });
}

void watchDocument(KisDocument *document) {
    // Documents are added after synchronous loading succeeds. Imports and
    // recovered dirty images must still follow the native save pipeline.
    if (!document->isRecovered() && !kritaWasmCachePath(document->localFilePath()).isEmpty())
        rememberSavedFiles(document, document->localFilePath(), {});
    QObject::connect(document, &KisDocument::sigCompleteBackgroundSaving, qApp,
                     [](const KritaUtils::ExportFileJob &job, KisImportExportErrorCode status,
                        const QString &, const QString &) {
                         if ((job.flags & KritaUtils::SaveInAutosaveMode) && status.isOk())
                             kritaWasmSyncRecovery();
                     });
    QObject::connect(
        document, &KisDocument::sigSavingFinished, qApp, [document](const QString &path) {
            // The document emits this only after its complete output set is durable.
            offerDownload(path, document->property("kritaWasmDownloadFiles").toStringList());
        });
}

void openTemporaryFiles(KisMainWindow *window, bool importing,
                        const std::shared_ptr<QTemporaryDir> &directory, const QStringList &paths) {
    const QPointer<KisMainWindow> guarded(window);
    QTimer::singleShot(0, window, [guarded, directory, paths, importing] {
        QMap<QString, std::shared_ptr<QDir>> uploads;
        const QString sharedPath = directory->filePath(QStringLiteral("shared"));
        std::shared_ptr<QDir> siblings;
        if (QFileInfo(sharedPath).isDir()) {
            siblings = std::shared_ptr<QDir>(new QDir(sharedPath), [directory](QDir *files) {
                releaseUploadFiles(files->path());
                delete files;
            });
        }
        for (const auto &path : paths) {
            if (!guarded)
                return;
            const QString folder = QFileInfo(path).absolutePath();
            auto &owner = uploads[folder];
            if (!owner) {
                if (folder == sharedPath) {
                    owner = siblings;
                } else {
                    owner =
                        std::shared_ptr<QDir>(new QDir(folder), [directory, siblings](QDir *files) {
                            releaseUploadFiles(files->path());
                            delete files;
                        });
                }
            }
            const auto before = KisPart::instance()->documents();
            if (!guarded->openDocument(path,
                                       importing ? KisMainWindow::Import : KisMainWindow::None))
                continue;
            // Sibling inputs live until the last document using their group
            // closes. Independent duplicate-name groups still release early.
            for (auto document : KisPart::instance()->documents()) {
                if (document && !before.contains(document)) {
                    QObject::connect(document, &QObject::destroyed, [owner, path] {
                        KisRecentFilesManager::instance()->remove(QUrl::fromLocalFile(path));
                    });
                }
            }
        }
    });
}

void openCache(KisMainWindow *window, bool importing) {
    const QPointer<KisMainWindow> guarded(window);
    // Return from the source-choice button before entering the same JSPI-aware
    // native file dialog used by Krita Save, including directory navigation.
    QTimer::singleShot(0, window, [guarded, importing] {
        if (!guarded)
            return;
        KoFileDialog dialog(guarded,
                            importing ? KoFileDialog::ImportFiles : KoFileDialog::OpenFiles,
                            QStringLiteral("BrowserCacheOpen"));
        dialog.setCaption(i18nd("krita-wasm", "Browser cache"));
        dialog.setDefaultDir(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")), true);
        dialog.setMimeTypeFilters(
            KisImportExportManager::supportedMimeTypes(KisImportExportManager::Import));
        const auto paths = dialog.filenames();
        for (const auto &path : paths) {
            if (!guarded)
                return;
            // The same validation/restore path is used by Open Recent.
            kritaWasmOpenCachedDocument(guarded, path, importing);
        }
    });
}
} // namespace

bool kritaWasmOfferUnmodifiedDownload(KisDocument *document) {
    if (!document || document->isModified() || document->isSaving() || document->isRecovered())
        return false;
    auto *version = document->findChild<QObject *>(QStringLiteral("kritaWasmSavedVersion"));
    if (!version) {
        const auto path = document->localFilePath();
        if (kritaWasmCachePath(path).isEmpty())
            return false;
        showError(qApp->activeWindow(), i18n("Could not open %1.", path));
        return true;
    }
    const auto path = version->property("path").toString();
    const auto outputs = document->property("kritaWasmSavedFiles").toStringList();
    offerDownload(path, outputs, version);
    return true;
}

void kritaWasmInitializeFiles() {
    static bool initialized = false;
    if (initialized)
        return;
    initialized = true;
    KLocalizedString::addDomainLocaleDir("krita-wasm", QStringLiteral("/krita/share/locale"));
    EM_ASM({ globalThis.kritaRecovery.widgetsReady = true; });
    auto *part = KisPart::instance();
    QObject::connect(part, &KisPart::sigDocumentAdded, qApp, watchDocument);
    for (auto document : part->documents()) {
        if (document)
            watchDocument(document);
    }
}

void kritaWasmOpenDocument(KisMainWindow *window, bool importing) {
    const QPointer<KisMainWindow> guarded(window);
    // Leave the action signal before waiting for the combined browser dialog.
    QTimer::singleShot(0, window, [guarded, importing] {
        if (!guarded)
            return;
        auto directory = std::shared_ptr<QTemporaryDir>(
            new QTemporaryDir(QDir::tempPath() + QStringLiteral("/krita-upload-") +
                              QUuid::createUuid().toString(QUuid::Id128) +
                              QStringLiteral("-XXXXXX")),
            [](QTemporaryDir *temporary) {
                const QString path = temporary->isValid() ? temporary->path() : QString{};
                temporary->setAutoRemove(false);
                delete temporary;
                releaseUploadFiles(path);
            });
        if (!directory->isValid()) {
            showError(guarded, directory->errorString());
            return;
        }
        const QString title = importing ? i18n("Import Images") : i18n("Open Images");
        char *selected = kritaWasmChooseFiles(directory->path().toUtf8().constData(),
                                              title.toUtf8().constData());
        if (!selected)
            return;
        const auto chosen = QJsonDocument::fromJson(QByteArray(selected)).array();
        std::free(selected);
        QStringList paths;
        for (const auto &path : chosen)
            paths.append(path.toString());
        if (!guarded)
            return;
        // Uploaded files have absolute temporary paths; "cache" selects the
        // native browser-cache directory picker instead.
        if (paths == QStringList{QStringLiteral("cache")})
            openCache(guarded, importing);
        else
            openTemporaryFiles(guarded, importing, directory, paths);
    });
}
