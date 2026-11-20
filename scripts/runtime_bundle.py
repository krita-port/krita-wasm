"""Deterministic runtime archives and catalog access for packaging/verification."""

import gzip
import tarfile
from contextlib import nullcontext
from pathlib import Path, PurePosixPath


def write_archive(
    destination: Path, files: list[tuple[str, Path]], compressed: bool = False
) -> None:
    """Write regular files in a stable USTAR order without host metadata."""
    with (
        Path(destination).open("wb") as output,
        (
            gzip.GzipFile(
                filename="", fileobj=output, mode="wb", mtime=0, compresslevel=9
            )
            if compressed
            else nullcontext(output)
        ) as stream,
        tarfile.open(fileobj=stream, mode="w|", format=tarfile.USTAR_FORMAT) as archive,
    ):
        seen = set()
        for name, path in sorted(files):
            parts = PurePosixPath(name).parts
            if not parts or name.startswith("/") or ".." in parts or name in seen:
                raise ValueError(f"Invalid or duplicate archive name: {name}")
            seen.add(name)
            info = tarfile.TarInfo(name)
            info.size = path.stat().st_size
            # Runtime files are data; preserve the mode of the former staging copies.
            info.mode = 0o644
            with path.open("rb") as source:
                archive.addfile(info, source)


def read_catalogs(bundle: Path, languages: list[str] | None = None) -> dict[str, bytes]:
    """Read own Krita MO files from the actual distributed resource archive."""
    catalogs = {}
    with tarfile.open(bundle, "r:gz") as outer:
        resources = outer.extractfile("resources.tar")
        if resources is None:
            raise ValueError("Missing runtime resource archive")
        with resources, tarfile.open(fileobj=resources, mode="r|") as inner:
            for entry in inner:
                parts = PurePosixPath(entry.name).parts
                if (
                    entry.isfile()
                    and len(parts) == 6
                    and parts[:3] == ("krita", "share", "locale")
                    and parts[4:] == ("LC_MESSAGES", "krita.mo")
                    and (languages is None or parts[3] in languages)
                ):
                    stream = inner.extractfile(entry)
                    if stream is None:
                        raise ValueError("Missing catalog data")
                    catalogs[parts[3]] = stream.read()
    return catalogs
