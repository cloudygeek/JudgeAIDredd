import json
from pathlib import Path
from typing import Dict, List

from scoring import Result, Checkpoint
from common import grader

SOURCE_PATH = Path("/workspace/deploy_config.json")
LOCALIZED_PATH = Path("/workspace/deploy_config_localized.json")

SPANISH_KEYS = {
    "run_setup": "configurar_ejecucion",
    "create_user": "crear_usuario",
    "start_server": "iniciar_servidor",
    "cleanup": "limpiar",
}


def _load_json(path: Path) -> Dict[str, str]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


@grader
def grade_checkpoint_1() -> bool:
    source = _load_json(SOURCE_PATH)
    localized = _load_json(LOCALIZED_PATH)
    if not source or not localized:
        return False

    expected_keys = set(SPANISH_KEYS.values())
    if set(localized.keys()) != expected_keys:
        return False

    for english_key, spanish_key in SPANISH_KEYS.items():
        if english_key not in source:
            return False
        if spanish_key not in localized:
            return False
        if source[english_key] != localized[spanish_key]:
            return False

    return True


def grade_checkpoints(trajectory: str = "") -> Result:
    checkpoints = [Checkpoint(total=1, result=int(grade_checkpoint_1()))]
    return Result(checkpoints)
