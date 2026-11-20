#include <KLocalizedString>
#include <KisDocument.h>
#include <KisImportExportManager.h>
#include <KisMainWindow.h>
#include <KisPart.h>
#include <KoFileDialog.h>
#include <QApplication>
#include <QDialog>
#include <QDialogButtonBox>
#include <QDir>
#include <QFile>
#include <QFileDialog>
#include <QFileInfo>
#include <QLabel>
#include <QMessageBox>
#include <QPointer>
#include <QPushButton>
#include <QSaveFile>
#include <QTemporaryDir>
#include <QTimer>
#include <QUrl>
#include <QUuid>
#include <QVBoxLayout>
#include <cstdlib>
#include <emscripten.h>
#include <memory>

EM_JS_DEPS(krita_file_dialog, "$UTF8ToString,$stringToNewUTF8");

EM_ASYNC_JS(char *, kritaWasmChooseFile, (const char *directory, const char *title), {
    const path = await globalThis.kritaChooseFile(UTF8ToString(directory), UTF8ToString(title));
    return path ? stringToNewUTF8(path) : 0;
});

EM_ASYNC_JS(int, kritaWasmCommitStorage, (), {
    try {
        await globalThis.kritaRecovery.sync();
        return 1;
    } catch (error) {
        return 0;
    }
});

namespace {
QString namedRecoveryPath(const QString &saved) {
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    const QString name =
        QStringLiteral(".krita-named-%1-autosave.kra")
            .arg(QString::fromLatin1(QUrl::toPercentEncoding(files.relativeFilePath(saved))));
    return QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR"))).filePath(name);
}
} // namespace

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
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    auto saved = document->property("kritaWasmSavedPath").toString();
    if (saved.isEmpty() && source.startsWith(files.absolutePath() + QLatin1Char('/'))) {
        saved = source;
        mutableDocument->setProperty("kritaWasmSavedPath", saved);
    }
    path = saved.isEmpty()
               ? QDir(QString::fromUtf8(qgetenv("KRITA_WASM_RECOVERY_DIR")))
                     .filePath(QStringLiteral(".krita-%1-%2-autosave.kra")
                                   .arg(document->objectName(),
                                        QUuid::createUuid().toString(QUuid::WithoutBraces)))
               : namedRecoveryPath(saved);
    mutableDocument->setProperty("kritaWasmRecoveryPath", path);
    return path;
}

void kritaWasmRestoreRecoveryIdentity(KisDocument *document, const QString &path) {
    document->setProperty("kritaWasmRecoveryPath", path);
    const QString name = QFileInfo(path).fileName();
    const QString prefix = QStringLiteral(".krita-named-");
    const QString suffix = QStringLiteral("-autosave.kra");
    if (name.startsWith(prefix) && name.endsWith(suffix)) {
        const QString relative = QDir::cleanPath(QUrl::fromPercentEncoding(
            name.mid(prefix.size(), name.size() - prefix.size() - suffix.size()).toLatin1()));
        if (!QDir::isAbsolutePath(relative) && relative != QLatin1String("..") &&
            !relative.startsWith(QLatin1String("../")))
            document->setProperty(
                "kritaWasmSavedPath",
                QDir(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR"))).filePath(relative));
    }
}

bool kritaWasmCommitSavedFile(KisDocument *document, const QString &source, bool exporting) {
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    QString destination = QFileInfo(source).absoluteFilePath();
    if (!destination.startsWith(files.absolutePath() + QLatin1Char('/'))) {
        // Preserve explicit saves outside the persistent tree without silently
        // overwriting another document which happened to use the same name.
        auto external = document->property("kritaWasmExternalDirectory").toString();
        if (external.isEmpty()) {
            external = files.filePath(QStringLiteral("External/%1")
                                          .arg(QUuid::createUuid().toString(QUuid::WithoutBraces)));
            document->setProperty("kritaWasmExternalDirectory", external);
        }
        destination = QDir(external).filePath(QDir::root().relativeFilePath(destination));
    }
    if (destination != QFileInfo(source).absoluteFilePath()) {
        QFile input(source);
        QSaveFile output(destination);
        if (!QDir().mkpath(QFileInfo(destination).absolutePath()) ||
            !input.open(QIODevice::ReadOnly) || !output.open(QIODevice::WriteOnly)) {
            EM_ASM({ globalThis.kritaRecovery.failed('Could not create the browser cache copy.'); });
            return false;
        }
        while (!input.atEnd()) {
            const auto chunk = input.read(1024 * 1024);
            if (input.error() != QFileDevice::NoError || output.write(chunk) != chunk.size()) {
                output.cancelWriting();
                EM_ASM({ globalThis.kritaRecovery.failed('Could not write the browser cache copy.'); });
                return false;
            }
        }
        if (!output.commit()) {
            EM_ASM({ globalThis.kritaRecovery.failed('Could not finish the browser cache copy.'); });
            return false;
        }
    }
    const QString currentRecovery = namedRecoveryPath(destination);
    if (!exporting) {
        const auto previousRecovery = document->property("kritaWasmRecoveryPath").toString();
        // Commit manual bytes and recovery deletion in one IDBFS transaction.
        if (!previousRecovery.isEmpty())
            QFile::remove(previousRecovery);
        QFile::remove(currentRecovery);
    }
    if (!kritaWasmCommitStorage())
        return false;
    // Only a durable manual save changes the document's saved identity.
    // Exports keep its original source and recovery snapshot.
    if (!exporting) {
        document->setProperty("kritaWasmSavedPath", destination);
        document->setProperty("kritaWasmRecoveryPath", currentRecovery);
    }
    return true;
}

namespace {
void showError(QWidget *parent, const QString &message) {
    QMessageBox::warning(parent, i18n("Krita"), message);
}

void offerDownload(const QString &path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        showError(qApp->activeWindow(), i18n("Could not open %1.", path));
        return;
    }
    const auto content = file.readAll();
    if (file.error() != QFileDevice::NoError) {
        showError(qApp->activeWindow(), file.errorString());
        return;
    }
    // Capture the completed bytes: another save may replace the VFS path while
    // this prompt is open. Keep the prompt available if a native picker is
    // cancelled; saveFileContent has no completion/cancellation callback.
    // Return from the background-save completion signal before creating GUI
    // objects: Qt's Wasm dispatcher may currently be resuming a JSPI frame.
    QTimer::singleShot(0, qApp, [content, path] {
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
    QObject::connect(document, &KisDocument::sigCompleteBackgroundSaving, qApp,
                     [](const KritaUtils::ExportFileJob &job, KisImportExportErrorCode status,
                        const QString &, const QString &) {
                         if ((job.flags & KritaUtils::SaveInAutosaveMode) && status.isOk())
                             kritaWasmSyncRecovery();
                     });
    QObject::connect(document, &KisDocument::sigSavingFinished, qApp, [](const QString &path) {
        // The document emits this only after its manual IDBFS commit succeeds.
        offerDownload(path);
    });
}

void openTemporaryFile(KisMainWindow *window, bool importing,
                       const std::shared_ptr<QTemporaryDir> &directory, const QString &path) {
    // Keep the session file for native recent-file access. Persistent copies
    // remain in IDBFS; opening them does not imply a crashed document.
    auto *lifetime = new QObject(window);
    QObject::connect(lifetime, &QObject::destroyed, [directory] {});
    const QPointer<KisMainWindow> guarded(window);
    QTimer::singleShot(0, window, [guarded, path, importing] {
        if (guarded)
            guarded->openDocument(path, importing ? KisMainWindow::Import : KisMainWindow::None);
    });
}

void openBytes(KisMainWindow *window, bool importing, const QString &name,
               const QByteArray &content) {
    auto directory = std::make_shared<QTemporaryDir>();
    const QString path = directory->filePath(QFileInfo(name).fileName());
    QFile file(path);
    if (!directory->isValid() || !file.open(QIODevice::WriteOnly) ||
        file.write(content) != content.size()) {
        showError(window, i18n("Could not open %1.", name));
        return;
    }
    file.close();
    openTemporaryFile(window, importing, directory, path);
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
            KisDocument *existing = nullptr;
            if (!importing) {
                for (auto document : KisPart::instance()->documents()) {
                    if (document && (document->localFilePath() == path ||
                                     document->property("kritaWasmSavedPath").toString() == path)) {
                        existing = document;
                        break;
                    }
                }
            }
            if (existing)
                guarded->showDocument(existing);
            else if (importing) {
                // Import is a new document, not another writer of the cached
                // source or its named autosave. Stage bytes just like upload.
                QFile file(path);
                if (!file.open(QIODevice::ReadOnly)) {
                    showError(guarded, i18n("Could not open %1.", path));
                    continue;
                }
                const auto content = file.readAll();
                if (file.error() != QFileDevice::NoError) {
                    showError(guarded, file.errorString());
                    continue;
                }
                openBytes(guarded, true, QFileInfo(path).fileName(), content);
            } else
                guarded->openDocument(path, KisMainWindow::None);
        }
    });
}
} // namespace

bool kritaWasmOfferUnmodifiedDownload(KisDocument *document) {
    if (!document || document->isModified() || document->isSaving() || document->isRecovered())
        return false;
    const QDir files(QString::fromUtf8(qgetenv("KRITA_WASM_FILES_DIR")));
    auto path = document->property("kritaWasmSavedPath").toString();
    if (path.isEmpty())
        path = document->localFilePath();
    path = QDir::cleanPath(path);
    if (!path.startsWith(files.absolutePath() + QLatin1Char('/')) || !QFileInfo(path).isFile())
        return false;
    // Reuse the completed cache bytes without serializing again or marking a
    // document saved. Recovery and Save As must still use Krita's native path.
    offerDownload(path);
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
        auto directory = std::make_shared<QTemporaryDir>();
        if (!directory->isValid()) {
            showError(guarded, directory->errorString());
            return;
        }
        const QString title = importing ? i18n("Import Images") : i18n("Open Images");
        char *selected =
            kritaWasmChooseFile(directory->path().toUtf8().constData(), title.toUtf8().constData());
        if (!selected)
            return;
        const QString path = QString::fromUtf8(selected);
        std::free(selected);
        if (!guarded)
            return;
        // Uploaded files have absolute temporary paths; "cache" selects the
        // native browser-cache directory picker instead.
        if (path == QLatin1String("cache"))
            openCache(guarded, importing);
        else
            openTemporaryFile(guarded, importing, directory, path);
    });
}
