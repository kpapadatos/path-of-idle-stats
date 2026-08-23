"""Read-only extraction of Sprite assets from Path of Idle Addressables."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

PROJECT = Path(r"C:\r\path-of-idle-stats")
GAME_BUNDLE = Path(
    r"C:\Program Files (x86)\Steam\steamapps\common\PathOfIdle\PathOfIdle_Data"
    r"\StreamingAssets\aa\StandaloneWindows64"
    r"\sprite_assets_all_6f7f66e7a3e073a3cf3119b03ad41056.bundle"
)
OUTPUT = PROJECT / "data" / "icons"
INDEX = PROJECT / "data" / "icons.json"

sys.path.insert(0, str(PROJECT / "work" / "python-packages"))
import UnityPy  # noqa: E402


def icon_filename(name: str) -> str:
    return hashlib.sha256(name.encode("utf-8")).hexdigest() + ".png"


def main() -> None:
    if not GAME_BUNDLE.is_file():
        raise FileNotFoundError(GAME_BUNDLE)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    environment = UnityPy.load(str(GAME_BUNDLE))
    index: dict[str, str] = {}
    exported = 0
    failed: list[dict[str, str]] = []

    for obj in environment.objects:
        if obj.type.name != "Sprite":
            continue
        try:
            sprite = obj.read()
            name = sprite.m_Name
            if not name:
                continue
            filename = icon_filename(name)
            sprite.image.save(OUTPUT / filename, "PNG")
            index[name] = filename
            exported += 1
        except Exception as error:  # continue past unsupported individual sprites
            failed.append({"pathId": str(obj.path_id), "error": str(error)})

    INDEX.write_text(
        json.dumps({"bundle": str(GAME_BUNDLE), "exported": exported, "failed": failed, "icons": index}, ensure_ascii=False),
        encoding="utf-8",
    )
    print(json.dumps({"exported": exported, "failed": len(failed), "output": str(OUTPUT)}))


if __name__ == "__main__":
    main()
