"""Build static launcher messages from Krita's own compiled catalogs."""

import gettext
import json
import subprocess
import tempfile
from collections.abc import Iterable
from pathlib import Path
from string import Formatter
from typing import Any

import polib

ROOT = Path(__file__).resolve().parents[1]
MESSAGES = {
    "settings": "Settings",
    "close": "Close",
    "language": "Switch Application Language",
    "appearance": "Appearance",
    "light": "Light",
    "dark": "Dark",
    "automatic": "Automatic",
    "apply": "Apply",
    "preparing": "Initializing Globals...",
    "loading": "Loading resources...",
    "starting": "Loading Main Window...",
    "error": "Error",
    "details": "Details",
}


def load_messages(languages: Iterable[str]) -> dict[str, dict[str, str]]:
    """Reject incomplete project translations before producing either catalog."""
    messages: dict[str, dict[str, str]] = {
        path.stem: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((ROOT / "web/messages").glob("*.json"))
    }
    missing = set(languages) - messages.keys()
    if missing:
        raise ValueError(f"Missing project translations: {sorted(missing)}")

    def placeholders(text: str) -> set[str]:
        return {
            field for _, field, _, _ in Formatter().parse(text) if field is not None
        }

    english = messages["en"]
    for language, entries in messages.items():
        if entries.keys() != english.keys():
            raise ValueError(f"Incomplete project translations: {language}")
        for key, value in entries.items():
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"Empty project translation: {language}/{key}")
            if placeholders(value) != placeholders(english[key]):
                raise ValueError(f"Invalid translation placeholders: {language}/{key}")
    return messages


def compile_native_messages(share: Path, msgfmt: Path) -> None:
    """Package our native Qt messages separately from upstream Krita catalogs."""
    messages = load_messages(
        {
            "en",
            *(
                path.parent.parent.name
                for path in (share / "locale").glob("*/LC_MESSAGES/krita.mo")
            ),
        }
    )
    with tempfile.TemporaryDirectory(
        prefix="native-messages-", dir=share.parent
    ) as temporary:
        for language, entries in messages.items():
            if language == "en":
                continue
            catalog = polib.POFile()
            catalog.metadata = {
                "Language": language,
                "MIME-Version": "1.0",
                "Content-Type": "text/plain; charset=UTF-8",
                "Content-Transfer-Encoding": "8bit",
            }
            catalog.extend(
                polib.POEntry(msgid=messages["en"][key], msgstr=entries[key])
                for key in ("downloadReady", "download", "browserCache")
            )
            source = Path(temporary) / (language + ".po")
            catalog.save(str(source))
            destination = share / "locale" / language / "LC_MESSAGES/krita-wasm.mo"
            destination.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(
                [msgfmt, "--check-format", "-o", destination, source], check=True
            )


def build_index(share: Path) -> dict[str, Any]:
    catalogs: dict[str, gettext.NullTranslations] = {"en": gettext.NullTranslations()}
    for path in sorted((share / "locale").glob("*/LC_MESSAGES/krita.mo")):
        with path.open("rb") as stream:
            catalogs[path.parent.parent.name] = gettext.GNUTranslations(stream)
    custom = load_messages(catalogs)
    messages = {}
    for language, catalog in catalogs.items():
        entries = dict(custom[language])
        for key, text in MESSAGES.items():
            value = catalog.gettext(text)
            if value == text and hasattr(catalog, "_catalog"):
                # Reuse existing context-specific translations for short UI
                # labels instead of maintaining a second catalog of synonyms.
                variants = sorted(
                    (k, v)
                    for k, v in catalog._catalog.items()
                    if isinstance(k, str)
                    and k.endswith("\x04" + text)
                    and isinstance(v, str)
                    and v
                )
                if variants:
                    value = variants[0][1]
            # Reuse translated upstream labels. English is only a fallback;
            # it must never overwrite a project or upstream translation.
            if value != text or key not in entries:
                entries[key] = value.replace("&", "")
        messages[language] = entries
    return {
        "languages": sorted(catalogs),
        "messages": messages,
        "fallback": "en",
    }
