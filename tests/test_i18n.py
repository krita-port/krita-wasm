"""Project translation coverage and upstream catalog merge regressions."""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import polib

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import i18n_index


class TranslationTest(unittest.TestCase):
    def test_project_messages_cover_each_locale_and_keep_placeholders(self) -> None:
        requested = {"en", "ca@valencia", "uz@cyrillic", "pt_BR"}
        messages = i18n_index.load_messages(requested)
        self.assertGreaterEqual(messages.keys(), requested)
        self.assertGreaterEqual(messages["en"].keys(), i18n_index.MESSAGES.keys())
        for language, entries in messages.items():
            with self.subTest(language=language):
                self.assertIn("{filename}", entries["bundlePrompt"])
                if language not in {"en", "en_GB"}:
                    self.assertNotEqual(
                        entries["downloadReady"], messages["en"]["downloadReady"]
                    )

    def test_missing_upstream_locale_stops_the_build(self) -> None:
        with self.assertRaisesRegex(ValueError, "Missing project translations.*zz"):
            i18n_index.load_messages(["zz"])

    def test_incomplete_empty_and_broken_placeholder_translations_fail(self) -> None:
        original = i18n_index.load_messages(["en", "fr"])
        for problem in ("missing", "empty", "placeholder"):
            with (
                self.subTest(problem=problem),
                tempfile.TemporaryDirectory() as temporary,
            ):
                root = Path(temporary)
                (root / "web/messages").mkdir(parents=True)
                messages = {
                    language: dict(entries) for language, entries in original.items()
                }
                if problem == "missing":
                    del messages["fr"]["openCache"]
                elif problem == "empty":
                    messages["fr"]["openCache"] = " "
                else:
                    messages["fr"]["bundlePrompt"] = "{wrong}"
                for language in ("en", "fr"):
                    (root / "web/messages" / (language + ".json")).write_text(
                        json.dumps(messages[language])
                    )
                with (
                    patch.object(i18n_index, "ROOT", root),
                    self.assertRaises(ValueError),
                ):
                    i18n_index.load_messages(["fr"])

    def test_upstream_labels_survive_custom_english_and_missing_catalog_entries(
        self,
    ) -> None:
        # A real GNU MO fixture exercises contextual lookup, UTF-8 and mnemonics.
        catalog = polib.POFile()
        catalog.metadata = {"Content-Type": "text/plain; charset=UTF-8"}
        catalog.extend(
            [
                polib.POEntry(msgid="Appearance", msgstr="&Aspect du catalogue"),
                polib.POEntry(
                    msgid="Light", msgstr="&Clair du catalogue", msgctxt="button"
                ),
                polib.POEntry(msgid="Close", msgstr="&Fermer"),
            ]
        )
        with tempfile.TemporaryDirectory() as temporary:
            share = Path(temporary)
            destination = share / "locale/fr/LC_MESSAGES/krita.mo"
            destination.parent.mkdir(parents=True)
            catalog.save_as_mofile(str(destination))
            result = i18n_index.build_index(share)
        french = result["messages"]["fr"]
        self.assertEqual(french["appearance"], "Aspect du catalogue")
        self.assertEqual(french["light"], "Clair du catalogue")
        self.assertEqual(french["close"], "Fermer")
        self.assertEqual(french["dark"], "Sombre")
        self.assertEqual(french["automatic"], "Automatique")
        self.assertEqual(french["openDevice"], "Ouvrir depuis l’appareil")
        self.assertEqual(result["messages"]["en"]["appearance"], "Appearance")
