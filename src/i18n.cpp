#include <KLocalizedString>
#include <KStandardGuiItem>
#include <KisCanvasState.h>
#include <KisDocument.h>
#include <KisMainWindow.h>
#include <KisPart.h>
#include <KisView.h>
#include <KoDialog.h>
#include <QAbstractButton>
#include <QAbstractItemView>
#include <QAction>
#include <QApplication>
#include <QBitmap>
#include <QColor>
#include <QComboBox>
#include <QCryptographicHash>
#include <QCursor>
#include <QDialogButtonBox>
#include <QFile>
#include <QFileDialog>
#include <QFileSystemModel>
#include <QGlyphRun>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLocale>
#include <QMenu>
#include <QMenuBar>
#include <QPalette>
#include <QPointer>
#include <QPushButton>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQmlProperty>
#include <QQuickItem>
#include <QQuickWidget>
#include <QScopedPointer>
#include <QStyle>
#include <QTabBar>
#include <QTextEdit>
#include <QTextLayout>
#include <QTimer>
#include <QToolButton>
#include <cstdio>
#include <emscripten.h>
#include <kactioncollection.h>
#include <kis_canvas2.h>
#include <kis_config_notifier.h>
#include <kis_coordinates_converter.h>
#include <kis_group_layer.h>
#include <kis_image.h>
#include <kis_paint_device.h>
#include <kis_painting_assistants_decoration.h>
#include <kundo2stack.h>
#include <thememanager.h>
#include <tiles3/kis_tile_data_store.h>

namespace {
void applyControlRadius(int radius) {
    const auto palette = qApp->palette();
    // Resolve from the application palette, not the widget palette which QSS
    // has already overridden. Otherwise an open editor keeps its old colors.
    qApp->setStyleSheet(
        QStringLiteral(R"(
        .QPushButton {
            border: 1px solid %2; border-radius: %1px;
            background-color: %3; color: %4;
            padding: 3px 8px;
        }
        .QPushButton:hover, .QPushButton:focus, .QPushButton:default { border-color: %5; }
        .QPushButton:pressed, .QPushButton:checked { background-color: %6; }
        .QPushButton:disabled { color: %2; }
        .QLineEdit {
            border: 1px solid %2; border-radius: %1px;
            background-color: %7; color: %8; padding: 2px;
            selection-background-color: %5; selection-color: %9;
        }
        .QLineEdit:focus { border-color: %5; }
        QAbstractSpinBox .QLineEdit { border: none; border-radius: 0; padding: 0; background: transparent; }
    )")
            .arg(radius)
            .arg(palette.color(QPalette::Mid).name(), palette.color(QPalette::Button).name(),
                 palette.color(QPalette::ButtonText).name(),
                 palette.color(QPalette::Highlight).name(),
                 palette.color(QPalette::Midlight).name(), palette.color(QPalette::Base).name(),
                 palette.color(QPalette::Text).name(),
                 palette.color(QPalette::HighlightedText).name()));
    qApp->setProperty("kritaWasmControlRadius", radius);
}

int missingGlyphs(const QString &text) {
    QTextLayout layout(text, QApplication::font());
    layout.beginLayout();
    auto line = layout.createLine();
    line.setLineWidth(16384);
    layout.endLayout();
    int missing = 0;
    for (const auto &run : layout.glyphRuns())
        for (quint32 glyph : run.glyphIndexes())
            missing += glyph == 0;
    return missing;
}

QString pixelFingerprint(KisPaintDeviceSP device, int width, int height) {
    const qsizetype rowBytes = qsizetype(width) * device->pixelSize();
    QByteArray buffer(rowBytes * 32, Qt::Uninitialized);
    QCryptographicHash hash(QCryptographicHash::Sha256);
    for (int y = 0; y < height; y += 32) {
        const int rows = qMin(32, height - y);
        device->readBytes(reinterpret_cast<quint8 *>(buffer.data()), 0, y, width, rows);
        hash.addData(QByteArrayView(buffer.constData(), rowBytes * rows));
    }
    return QString::fromLatin1(hash.result().toHex());
}

QMenu *widgetStyleMenu() {
    auto *window = KisPart::instance()->currentMainwindow();
    auto *action =
        window ? window->actionCollection()->action(QStringLiteral("style_menu")) : nullptr;
    return action ? action->menu() : nullptr;
}

void publishPalette() {
    const QPalette palette = qApp->palette();
    const QJsonObject state{{"dark", palette.color(QPalette::Window).lightness() < 128},
                            {"window", palette.color(QPalette::Window).name()},
                            {"windowText", palette.color(QPalette::WindowText).name()},
                            {"button", palette.color(QPalette::Button).name()},
                            {"buttonText", palette.color(QPalette::ButtonText).name()},
                            {"border", palette.color(QPalette::Mid).name()},
                            {"accent", palette.color(QPalette::Highlight).name()},
                            {"accentText", palette.color(QPalette::HighlightedText).name()},
                            {"link", palette.color(QPalette::Link).name()}};
    const auto data = QJsonDocument(state).toJson(QJsonDocument::Compact);
    EM_ASM({
        globalThis.kritaPalette = JSON.parse(UTF8ToString($0));
        window.dispatchEvent(new Event('krita-palette-change'));
    }, data.constData());
}
} // namespace

extern "C" EMSCRIPTEN_KEEPALIVE int kritaWasmSetControlRadius(int radius) {
    if (radius < 0 || radius > 12)
        return 0;
    QTimer::singleShot(0, qApp, [radius] {
        if (qApp->property("kritaWasmControlRadius").toInt() != radius)
            applyControlRadius(radius);
    });
    return 1;
}

extern "C" EMSCRIPTEN_KEEPALIVE int kritaWasmSetColorScheme(int dark) {
    if (dark != 0 && dark != 1)
        return 0;
    auto *window = KisPart::instance()->currentMainwindow();
    const QPointer<Digikam::ThemeManager> manager =
        window ? window->findChild<Digikam::ThemeManager *>() : nullptr;
    if (!manager)
        return 0;
    QTimer::singleShot(0, qApp, [manager, dark] {
        if (manager)
            manager->setCurrentTheme(dark ? QStringLiteral("Krita dark")
                                          : QStringLiteral("Krita bright"));
    });
    return 1;
}

void kritaWasmPublishWidgetStyles() {
    const auto *menu = widgetStyleMenu();
    if (!menu)
        return;
    QJsonArray available;
    for (const auto *action : menu->actions())
        available.append(action->text());
    // QApplication owns the actual factory style below its stylesheet wrapper.
    // Report that style rather than the wrapper's empty name.
    auto *style = qApp->style();
    if (style->name().isEmpty()) {
        if (auto *base = style->findChild<QStyle *>(QString(), Qt::FindDirectChildrenOnly))
            style = base;
    }
    const QJsonObject state{
        {"available", available},
        {"current", qApp->property("currentUnderlyingStyleName").toString().toLower()},
        {"qtStyle", style->name()}};
    const auto data = QJsonDocument(state).toJson(QJsonDocument::Compact);
    EM_ASM({
        globalThis.kritaWidgetStyleState = JSON.parse(UTF8ToString($0));
        window.dispatchEvent(new Event('krita-widget-style-change'));
    }, data.constData());
}

extern "C" EMSCRIPTEN_KEEPALIVE int kritaWasmSetWidgetStyle(int index) {
    auto *menu = widgetStyleMenu();
    if (!menu || index < 0 || index >= menu->actions().size())
        return 0;
    const QPointer<QAction> action = menu->actions().at(index);
    if (!action->isEnabled())
        return 0;
    // Reuse Krita's native action on a normal Qt event-loop turn, after the
    // browser's select handler has returned. No reload or document mutation.
    QTimer::singleShot(0, qApp, [action] {
        if (action)
            action->trigger();
    });
    return 1;
}

void kritaWasmRequestLanguages(const QStringList &languages) {
    const auto data =
        QJsonDocument(QJsonArray::fromStringList(languages)).toJson(QJsonDocument::Compact);
    EM_ASM({
        window.dispatchEvent(new CustomEvent('krita-language-change', {detail: JSON.parse(UTF8ToString($0))}));
    }, data.constData());
}

void kritaWasmI18nReady() {
    static bool paletteConnected = false;
    if (!paletteConnected) {
        const int radius = EM_ASM_INT({
            const radius = parseInt(document.documentElement.style.getPropertyValue('--app-control-radius'), 10);
            return Number.isInteger(radius) && radius >= 0 && radius <= 12 ? radius : 4;
        });
        applyControlRadius(radius);
        QObject::connect(
            KisConfigNotifier::instance(), &KisConfigNotifier::signalColorThemeChanged, qApp,
            [] {
                applyControlRadius(qApp->property("kritaWasmControlRadius").toInt());
                publishPalette();
            },
            Qt::QueuedConnection);
        paletteConnected = true;
    }
    publishPalette();
    kritaWasmPublishWidgetStyles();
    if (!EM_ASM_INT({ return new URLSearchParams(location.search).has('test');}))
        return;
    const auto *window = KisPart::instance()->currentMainwindow();
    QJsonArray menus;
    QString labels;
    for (const QAction *action : window->menuBar()->actions()) {
        QString text = action->text();
        text.remove(QLatin1Char('&'));
        labels += text + QLatin1Char(' ');
        menus.append(QJsonObject{{"name", action->objectName()}, {"text", text}});
    }
    const QLocale locale;
    QJsonObject result{
        {"locale", locale.name()},
        {"languages", QJsonArray::fromStringList(KLocalizedString::languages())},
        {"rtl", qApp->layoutDirection() == Qt::RightToLeft},
        {"number", locale.toString(12345.67, 'f', 2)},
        {"qtCancel", QCoreApplication::translate("QPlatformTheme", "Cancel")},
        {"kdeCancel", KStandardGuiItem::cancel().text()},
        {"menus", menus},
        {"missingMenuGlyphs", missingGlyphs(labels)},
        {"available", QJsonArray::fromStringList(
                          KLocalizedString::availableApplicationTranslations().values())}};
    if (EM_ASM_INT({ return new URLSearchParams(location.search).has('fontscan');})) {
        const auto originalLanguages = KLocalizedString::languages();
        QJsonObject coverage;
        for (const auto &language : KLocalizedString::availableApplicationTranslations()) {
            KLocalizedString::setLanguages({language, QStringLiteral("en_US")});
            const QString sample =
                i18nd("krita", "&File") + QLatin1Char(' ') + i18nd("krita", "&Edit") +
                QLatin1Char(' ') + i18nd("krita", "&View") + QLatin1Char(' ') +
                i18nd("krita", "&Image") + QLatin1Char(' ') + i18nd("krita", "&Layer") +
                QLatin1Char(' ') + i18nd("krita", "&Help") + QLatin1Char(' ') +
                i18nd("krita", "Cancel") + QLatin1Char(' ') + i18nd("krita", "Create new document");
            coverage[language] =
                QJsonObject{{"sample", sample}, {"missing", missingGlyphs(sample)}};
        }
        KLocalizedString::setLanguages(originalLanguages);
        result["fontCoverage"] = coverage;
    }
    // Exercise the same shared QML button used by the font/alignment controls.
    // This runs only in the existing ?test startup path, without a user document.
    QQmlEngine engine;
    QQmlComponent component(
        &engine, QUrl(QStringLiteral("qrc:/qt/qml/org/krita/components/GroupButton.qml")));
    QScopedPointer<QObject> button(component.create());
    QJsonArray buttonColors;
    if (button) {
        button->setProperty("checkable", true);
        for (bool enabled : {true, false}) {
            button->setProperty("enabled", enabled);
            for (bool checked : {false, true}) {
                button->setProperty("checked", checked);
                const auto icon = QQmlProperty(button.data(), QStringLiteral("icon.color"))
                                      .read()
                                      .value<QColor>();
                const auto text = QQmlProperty(button.data(), QStringLiteral("palette.buttonText"))
                                      .read()
                                      .value<QColor>();
                buttonColors.append(QJsonObject{{"enabled", enabled},
                                                {"checked", checked},
                                                {"valid", icon.isValid() && text.isValid()},
                                                {"icon", icon.name(QColor::HexArgb)},
                                                {"text", text.name(QColor::HexArgb)}});
            }
        }
    }
    result["groupButtonColors"] = buttonColors;
    // These are the real resources/hotspots used by SvgTextTool at document
    // creation. Validate both image decoding and Qt's constructed cursor.
    const struct {
        const char *name;
        int x;
        int y;
    } cursorAssets[] = {
        {"tool_text_basic.xpm", 7, 7},
        {"tool_text_inline_horizontal.xpm", 7, 7},
        {"tool_text_inline_vertical.xpm", 7, 7},
        {"tool_text_on_path.xpm", 7, 7},
        {"tool_text_in_shape.xpm", 7, 7},
        {"tool_text_i_beam_horizontal.xpm", 11, 11},
        {"tool_text_i_beam_vertical.xpm", 11, 11},
        {"tool_text_i_beam_horizontal_done.xpm", 5, 11},
    };
    QJsonArray cursors;
    for (const auto &asset : cursorAssets) {
        const QString path = QStringLiteral(":/") + QLatin1String(asset.name);
        const QPixmap pixmap(path);
        const QCursor cursor(pixmap, asset.x, asset.y);
        cursors.append(
            QJsonObject{{"path", path},
                        {"loaded", !pixmap.isNull()},
                        {"width", pixmap.width()},
                        {"height", pixmap.height()},
                        {"bitmap", !cursor.bitmap().isNull()},
                        {"mask", !cursor.mask().isNull()},
                        {"custom", cursor.shape() == Qt::BitmapCursor},
                        {"hotspot", QJsonArray{cursor.hotSpot().x(), cursor.hotSpot().y()}},
                        {"expectedHotspot", QJsonArray{asset.x, asset.y}}});
    }
    result["textToolCursors"] = cursors;
    result["textToolQmlExists"] = QFile::exists(QStringLiteral(":/SvgTextToolOptions.qml"));
    QJsonArray emptyCanvasStates;
    for (qreal dpr : {1.0, 1.5, 2.0}) {
        KisCoordinatesConverter converter;
        converter.setDevicePixelRatio(dpr);
        converter.setCanvasWidgetSize(QSizeF(1, 1));
        converter.setDocumentOffset(QPointF(0.5, 0.5));
        const auto state = KisCanvasState::fromConverter(converter);
        emptyCanvasStates.append(
            QJsonObject{{"dpr", dpr},
                        {"boundsEmpty", converter.imageRectInImagePixels().isEmpty()},
                        {"mappedEmpty", state.imageRectInWidgetPixels.isEmpty()}});
    }
    result["emptyCanvasStates"] = emptyCanvasStates;
    const auto data = QJsonDocument(result).toJson(QJsonDocument::Compact);
    std::printf("KRITA_WASM_I18N_READY: %s\n", data.constData());
    EM_ASM({ globalThis.kritaI18nState = JSON.parse(UTF8ToString($0));}, data.constData());
}

// Observes the real Qt widget tree. Only the ?test launcher exposes a callable
// wrapper. Automation uses actual widget geometry so translated/RTL layouts
// are tested without assuming English labels or fixed pixel positions.
extern "C" EMSCRIPTEN_KEEPALIVE void kritaWasmTestSnapshot(int includePixels) {
    QJsonArray widgets;
    for (QWidget *widget : QApplication::allWidgets()) {
        if (!widget->isVisible())
            continue;
        const QPoint point = widget->mapToGlobal(QPoint());
        QJsonObject item{{"name", widget->objectName()},
                         {"class", widget->metaObject()->className()},
                         {"x", point.x()},
                         {"y", point.y()},
                         {"width", widget->width()},
                         {"height", widget->height()},
                         {"window", widget->isWindow()},
                         {"enabled", widget->isEnabled()}};
        if (widget->inherits("KisQPainterCanvas")) {
            for (auto view : KisPart::instance()->views()) {
                if (view && view->canvasBase()->canvasWidget() == widget)
                    item["activeCanvas"] = view->isCurrent();
            }
        }
        if (auto *combo = qobject_cast<QComboBox *>(widget)) {
            QJsonArray choices;
            for (int i = 0; i < combo->count(); ++i)
                choices.append(combo->itemData(i).toString());
            item["choices"] = choices;
            item["index"] = combo->currentIndex();
        }
        if (widget->inherits("QAbstractSpinBox") &&
            widget->metaObject()->indexOfProperty("value") >= 0)
            item["value"] = QJsonValue::fromVariant(widget->property("value"));
        if (auto *button = qobject_cast<QAbstractButton *>(widget)) {
            item["text"] = button->text();
            if (button->isCheckable())
                item["checked"] = button->isChecked();
            if (auto *box = qobject_cast<QDialogButtonBox *>(button->parentWidget())) {
                item["buttonBox"] = box->objectName();
                item["standardButton"] = int(box->standardButton(button));
                item["buttonRole"] = int(box->buttonRole(button));
            }
            if (auto *dialog = qobject_cast<KoDialog *>(widget->window()))
                if (button == dialog->button(KoDialog::User2))
                    item["koButton"] = int(KoDialog::User2);
        }
        if (auto *label = qobject_cast<QLabel *>(widget))
            item["text"] = label->text();
        if (auto *edit = qobject_cast<QTextEdit *>(widget))
            item["text"] = edit->toPlainText();
        if (auto *dialog = qobject_cast<QFileDialog *>(widget)) {
            item["directory"] = dialog->directory().absolutePath();
            item["acceptMode"] = int(dialog->acceptMode());
        }
        if (auto *view = qobject_cast<QAbstractItemView *>(widget);
            view &&
            (view->objectName() == QLatin1String("treeView") ||
             view->objectName() == QLatin1String("listView") ||
             view->objectName() == QLatin1String("sidebar")) &&
            qobject_cast<QFileDialog *>(view->window())) {
            for (int row = 0; row < view->model()->rowCount(view->rootIndex()); ++row) {
                const auto index = view->model()->index(row, 0, view->rootIndex());
                const auto rect = view->visualRect(index);
                if (!rect.isValid() || !view->viewport()->rect().intersects(rect))
                    continue;
                const auto origin = view->viewport()->mapToGlobal(rect.topLeft());
                widgets.append(QJsonObject{
                    {"class", "KritaTestFileItem"},
                    {"filePath", view->objectName() == QLatin1String("sidebar")
                                     ? index.data(Qt::UserRole + 1).toUrl().toLocalFile()
                                     : index.data(QFileSystemModel::FilePathRole).toString()},
                    {"viewName", view->objectName()},
                    {"text", index.data().toString()},
                    {"x", origin.x()},
                    {"y", origin.y()},
                    {"width", rect.width()},
                    {"height", rect.height()}});
            }
        }
        if (auto *button = qobject_cast<QToolButton *>(widget))
            if (button->defaultAction())
                item["action"] = button->defaultAction()->objectName();
        if (auto *tabs = qobject_cast<QTabBar *>(widget)) {
            for (int index = 0; index < tabs->count(); ++index) {
                const auto rect = tabs->tabRect(index);
                const auto origin = tabs->mapToGlobal(rect.topLeft());
                widgets.append(QJsonObject{{"class", "KritaTestTab"},
                                           {"text", tabs->tabText(index)},
                                           {"selected", tabs->currentIndex() == index},
                                           {"index", index},
                                           {"x", origin.x()},
                                           {"y", origin.y()},
                                           {"width", rect.width()},
                                           {"height", rect.height()}});
            }
        }
        if (auto *quick = qobject_cast<QQuickWidget *>(widget)) {
            item["qml_source"] = quick->source().toString();
            item["qml_status"] = int(quick->status());
            item["qml_root"] = quick->rootObject() != nullptr;
            QJsonArray errors;
            for (const auto &error : quick->errors())
                errors.append(error.toString());
            item["qml_errors"] = errors;
            if (const auto *root = quick->rootObject()) {
                for (const auto *tab : root->findChildren<QQuickItem *>()) {
                    if (!tab->inherits("QQuickTabButton") || !tab->isVisible())
                        continue;
                    const auto origin = quick->mapToGlobal(tab->mapToScene(QPointF()).toPoint());
                    widgets.append(QJsonObject{{"class", "KritaTestQmlTab"},
                                               {"text", tab->property("text").toString()},
                                               {"checked", tab->property("checked").toBool()},
                                               {"x", origin.x()},
                                               {"y", origin.y()},
                                               {"width", tab->width()},
                                               {"height", tab->height()}});
                }
            }
        }
        widgets.append(item);
        const auto appendActions = [&](auto *menu) {
            if (!menu)
                return;
            for (const QAction *action : menu->actions()) {
                const auto rect = menu->actionGeometry(const_cast<QAction *>(action));
                if (!action->isVisible() || rect.isEmpty())
                    continue;
                const auto origin = menu->mapToGlobal(rect.topLeft());
                widgets.append(QJsonObject{{"class", "QMenuAction"},
                                           {"action", action->objectName()},
                                           {"text", action->text()},
                                           {"enabled", action->isEnabled()},
                                           {"checked", action->isChecked()},
                                           {"checkable", action->isCheckable()},
                                           {"x", origin.x()},
                                           {"y", origin.y()},
                                           {"width", rect.width()},
                                           {"height", rect.height()}});
            }
        };
        appendActions(qobject_cast<QMenu *>(widget));
        appendActions(qobject_cast<QMenuBar *>(widget));
    }
    for (auto document : KisPart::instance()->documents()) {
        if (!document || !document->image())
            continue;
        QJsonObject item{{"class", "KritaTestDocument"},
                         {"path", document->path()},
                         // nlayers includes the implicit image root, which is not a saved layer.
                         {"modified", document->isModified()},
                         {"layers", document->image()->nlayers() - 1},
                         {"saving", document->isSaving()},
                         {"recovered", document->isRecovered()},
                         {"autosaveActive", document->isAutoSaveActive()},
                         {"recoveryPath", document->property("kritaWasmRecoveryPath").toString()},
                         {"savedPath", document->property("kritaWasmSavedPath").toString()},
                         {"width", document->image()->width()},
                         {"height", document->image()->height()},
                         {"undoIndex", document->undoStack()->index()},
                         {"undoCount", document->undoStack()->count()},
                         {"canUndo", document->undoStack()->canUndo()},
                         {"canRedo", document->undoStack()->canRedo()}};
        if (includePixels) {
            QJsonArray layers;
            for (auto node = document->image()->rootLayer()->firstChild(); node;
                 node = node->nextSibling()) {
                auto device = node->paintDevice();
                if (device)
                    layers.append(
                        QJsonObject{{"name", node->name()},
                                    {"sha256", pixelFingerprint(device, document->image()->width(),
                                                                document->image()->height())}});
            }
            item["layerPixels"] = layers;
        }
        widgets.append(item);
    }
    auto *tileStore = KisTileDataStore::instance();
    const auto memory = tileStore->memoryStatistics();
    widgets.append(QJsonObject{{"class", "KritaTestTileMemory"},
                               {"swapBytes", double(memory.swapSize)},
                               {"residentBytes", double(memory.totalMemorySize)},
                               {"tilesInMemory", tileStore->numTilesInMemory()},
                               {"tilesTotal", tileStore->numTiles()}});
    for (auto view : KisPart::instance()->views()) {
        if (!view || !view->image())
            continue;
        const auto *converter = view->viewConverter();
        const auto state = KisCanvasState::fromConverter(*converter);
        const auto rect = state.imageRectInWidgetPixels;
        const auto offset = state.documentOffsetF;
        const auto bounds = converter->imageRectInImagePixels();
        auto assistants = view->canvasBase()->paintingAssistantsDecoration();
        widgets.append(
            QJsonObject{{"class", "KritaTestCanvasGeometry"},
                        {"path", view->document()->path()},
                        {"imageSize", QJsonArray{bounds.width(), bounds.height()}},
                        {"active", view->isCurrent()},
                        {"mirrorX", state.mirrorHorizontally},
                        {"mirrorY", state.mirrorVertically},
                        {"assistantVisible", assistants && assistants->assistantVisibility()},
                        {"assistantPreviewVisible", assistants && assistants->outlineVisibility()},
                        {"openGL", view->canvasBase()->canvasIsOpenGL()},
                        {"lodPreferred", view->canvasBase()->lodPreferredInCanvas()},
                        {"widgetRect", QJsonArray{rect.x(), rect.y(), rect.width(), rect.height()}},
                        {"documentOffsetF", QJsonArray{offset.x(), offset.y()}},
                        {"dpr", converter->devicePixelRatio()},
                        {"zoom", state.zoom}});
    }
    const auto data = QJsonDocument(widgets).toJson(QJsonDocument::Compact);
    EM_ASM({ globalThis.kritaWidgetSnapshot = JSON.parse(UTF8ToString($0));}, data.constData());
}
