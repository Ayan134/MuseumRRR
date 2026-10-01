# -*- coding: utf-8 -*-
"""
Подготовка Telegram Web K (https://github.com/morethanwords/tweb) для раздела
«Telegram» в Meridian (backend/app/routers/telegram.py, docs/telegram.md).

    python scripts/tg_patch.py build <папка сборки> — скопировать сборку в
                                            frontend/public/tg/ и перенаправить
                                            адреса DC на /tgws/
    python scripts/tg_patch.py src <корень tweb>    — то же в исходнике
                                            src/lib/mtproto/dcConfigurator.ts
                                            (перед `pnpm build`)

Папка сборки — dist/ после `pnpm build` либо public/ репозитория (там лежит
официальная готовая сборка). Хост берётся из location во время работы:
    wss://kws2.web.telegram.org/apiws  -> wss://<location.host>/tgws/kws2/apiws
    https://venus.web.telegram.org/apiw1 -> https://<location.host>/tgws/venus/apiw1
Если шаблон не найден ни разу — ошибка: значит, tweb поменял код и патч надо
обновить, иначе клиент молча пойдёт напрямую в Telegram.
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

DEST = Path(__file__).resolve().parent.parent / "frontend" / "public" / "tg"

# `wss://${App.suffix.toLowerCase()}ws${dcId}${suffix}.web.telegram.org/${path}`
# (в минифицированной сборке — те же шаблонные строки с короткими именами)
WS_RE = re.compile(r"`wss://\$\{([\w$.]+\.suffix\.toLowerCase\(\))\}ws\$\{([\w$]+)\}\$\{([\w$]+)\}"
                   r"\.web\.telegram\.org/\$\{([\w$]+)\}`")
WS_SUB = r"`wss://${globalThis.location.host}/tgws/${\1}ws${\2}${\3}/${\4}`"
# 'https://' + subdomain + '.web.telegram.org/' + path   (кавычки ' или `)
HTTP_RE = re.compile(r"([`'])https://\1\s*\+\s*([\w$]+)\s*\+\s*([`'])\.web\.telegram\.org/\3")
HTTP_SUB = r"\1https://\1+globalThis.location.host+\1/tgws/\1+\2+\1/\1"


def patch_text(text: str) -> tuple[str, int, int]:
    text, n_ws = WS_RE.subn(WS_SUB, text)
    text, n_http = HTTP_RE.subn(HTTP_SUB, text)
    return text, n_ws, n_http


def patch_files(files) -> None:
    total_ws = total_http = 0
    for f in files:
        text = f.read_text(encoding="utf-8", errors="surrogateescape")
        if ".web.telegram.org/" not in text:
            continue
        new, n_ws, n_http = patch_text(text)
        if n_ws or n_http:
            f.write_text(new, encoding="utf-8", errors="surrogateescape", newline="")
            print(f"  {f.name}: websocket {n_ws}, https {n_http}")
        total_ws += n_ws
        total_http += n_http
    if not total_ws or not total_http:
        sys.exit(f"ОШИБКА: заменено websocket={total_ws}, https={total_http} — "
                 "шаблон адресов DC в tweb изменился, обновите регулярки в tg_patch.py")


def cmd_build(src: Path) -> None:
    if not (src / "index.html").is_file():
        sys.exit(f"нет {src / 'index.html'} — это не папка сборки tweb")
    if DEST.exists():
        shutil.rmtree(DEST)
    # .map не нужны для работы и занимают ~30 МБ; snapshot.html — служебная страница
    shutil.copytree(src, DEST, ignore=shutil.ignore_patterns("*.map", "snapshot.html"))
    print(f"скопировано в {DEST}")
    patch_files(DEST.rglob("*.js"))


def cmd_src(root: Path) -> None:
    f = root / "src" / "lib" / "mtproto" / "dcConfigurator.ts"
    if not f.is_file():
        sys.exit(f"нет {f}")
    patch_files([f])


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] not in ("build", "src"):
        sys.exit(__doc__)
    (cmd_build if sys.argv[1] == "build" else cmd_src)(Path(sys.argv[2]))
