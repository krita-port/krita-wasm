#include <KisMainWindow.h>
#include <KisPart.h>
#include <QApplication>
#include <QFontDatabase>
#include <QGlyphRun>
#include <QLocale>
#include <QTextLayout>
#include <QThreadPool>
#include <QTimer>
#include <cstdio>
#include <emscripten.h>

namespace {
struct GlyphCoverage {
    int missing = 0;
    int glyphs = 0;
};

GlyphCoverage templateLabelCoverage() {
    // Use the same default widget font and real Qt fallback/shaping path as
    // the five translated template categories in the new-document sidebar.
    QTextLayout layout(QStringLiteral("动画模板 漫画模板 设计模板 相机模板 纹理模板"),
                       QApplication::font());
    layout.beginLayout();
    auto line = layout.createLine();
    line.setLineWidth(2048);
    layout.endLayout();
    GlyphCoverage result;
    for (const auto &run : layout.glyphRuns()) {
        for (quint32 glyph : run.glyphIndexes()) {
            ++result.glyphs;
            result.missing += glyph == 0;
        }
    }
    return result;
}

void configureBundledFonts() {
    const bool testing = EM_ASM_INT({ return new URLSearchParams(location.search).has('test'); });
    const auto before = testing ? templateLabelCoverage() : GlyphCoverage{};
    // Qt Wasm's font database only loads its resource fonts automatically;
    // preloading a file into /fonts alone does not register it for widgets.
    const QStringList files{QStringLiteral("NotoSansCJK-Regular.ttc"),
                            QStringLiteral("FreeSans.ttf"), QStringLiteral("FreeSerif.ttf"),
                            QStringLiteral("NotoSansKhmer-Regular.ttf")};
    for (const auto &file : files) {
        if (QFontDatabase::addApplicationFont(QStringLiteral("/fonts/") + file) < 0) {
            EM_ASM({ throw new Error('Could not register bundled font: ' + UTF8ToString($0)); }, file.toUtf8().constData());
            return;
        }
    }
    QString hanFamily = QStringLiteral("Noto Sans CJK SC");
    const QLocale locale;
    if (locale.language() == QLocale::Japanese) {
        hanFamily = QStringLiteral("Noto Sans CJK JP");
    } else if (locale.language() == QLocale::Korean) {
        hanFamily = QStringLiteral("Noto Sans CJK KR");
    } else if (locale.territory() == QLocale::Taiwan) {
        hanFamily = QStringLiteral("Noto Sans CJK TC");
    } else if (locale.territory() == QLocale::HongKong || locale.territory() == QLocale::Macao) {
        hanFamily = QStringLiteral("Noto Sans CJK HK");
    }
    QFontDatabase::addApplicationFallbackFontFamily(QChar::Script_Han, hanFamily);
    QFontDatabase::addApplicationFallbackFontFamily(QChar::Script_Hiragana,
                                                    QStringLiteral("Noto Sans CJK JP"));
    QFontDatabase::addApplicationFallbackFontFamily(QChar::Script_Katakana,
                                                    QStringLiteral("Noto Sans CJK JP"));
    QFontDatabase::addApplicationFallbackFontFamily(QChar::Script_Hangul,
                                                    QStringLiteral("Noto Sans CJK KR"));
    for (auto script : {QChar::Script_Devanagari, QChar::Script_Gurmukhi, QChar::Script_Georgian})
        QFontDatabase::addApplicationFallbackFontFamily(script, QStringLiteral("FreeSans"));
    for (auto script : {QChar::Script_Tamil, QChar::Script_Thai})
        QFontDatabase::addApplicationFallbackFontFamily(script, QStringLiteral("FreeSerif"));
    QFontDatabase::addApplicationFallbackFontFamily(QChar::Script_Khmer,
                                                    QStringLiteral("Noto Sans Khmer"));
    if (testing) {
        const auto after = templateLabelCoverage();
        if (after.glyphs < 20 || after.missing != 0) {
            EM_ASM({ throw new Error('Bundled CJK font still has missing template-label glyphs'); });
            return;
        }
        std::printf("KRITA_WASM_CJK_GLYPHS_READY: missing-before=%d missing-after=%d glyphs=%d\n",
                    before.missing, after.missing, after.glyphs);
    }
}
} // namespace

extern void kritaWasmI18nReady();
extern void kritaWasmInitializeFiles();

void kritaWasmConfigureFonts() { configureBundledFonts(); }

void kritaWasmConfigureThreads() {
    // Leave prewarmed workers for Krita's dedicated threads and image scheduler.
    QThreadPool::globalInstance()->setMaxThreadCount(2);
}

// Register preloaded fonts after QApplication exists and before the first
// browser event-loop turn. Window visibility is only a startup check;
// document creation and painting need separate verification.
void kritaWasmScheduleStatus() {
    kritaWasmInitializeFiles();
    QTimer::singleShot(0, qApp, [] {
        const auto *window = KisPart::instance()->currentMainwindow();
        if (!window || !window->isVisible()) {
            std::fputs("Krita Wasm: no visible main window\n", stderr);
            EM_ASM({
                if (new URLSearchParams(location.search).has('test'))
                    fetch('/__probe_result?status=FAIL:%20No%20visible%20Krita%20window');
            });
            return;
        }
        kritaWasmI18nReady();
        std::puts("KRITA_WASM_WINDOW_READY: real main window is visible");
        EM_ASM({
            document.title = 'Krita';
            const status = document.getElementById('status');
            if (status) status.hidden = true;
            if (new URLSearchParams(location.search).has('test'))
                fetch('/__probe_result?status=KRITA_WASM_WINDOW_READY');
        });
    });
}
