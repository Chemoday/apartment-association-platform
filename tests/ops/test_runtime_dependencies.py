"""Everything src/ imports comes with the image's dependencies, not only with the dev group.

The image installs `uv sync --no-dev`; a package that only the dev group brings in (e.g. httpx
before 2026-11-15) makes the app crash at start when a plugin needing it is enabled, which tests
never notice because they run with the dev group installed.

Limits: only the top-level name of an import is mapped, so a submodule of a namespace package
shared by several distributions (e.g. `opentelemetry.instrumentation.httpx`) counts as covered
by any of them; imports by string (`importlib.import_module`) are not seen, but src/ uses them
only for its own modules, whose imports are scanned.
"""

import ast
import re
import sys
import tomllib
from importlib.metadata import PackageNotFoundError, packages_distributions, requires
from pathlib import Path

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[2]


def _normalise(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _runtime_closure() -> set[str]:
    """The project dependencies and what they require: unconditional requirements and the extras
    actually asked for (e.g. uvicorn[standard]), with markers evaluated for this platform."""
    project = tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]
    pending = [Requirement(spec) for spec in project["dependencies"]]
    seen: set[tuple[str, frozenset[str]]] = set()
    names: set[str] = set()
    while pending:
        requirement = pending.pop()
        name, extras = _normalise(requirement.name), frozenset(requirement.extras)
        if (name, extras) in seen:
            continue
        seen.add((name, extras))
        names.add(name)
        try:
            specs = requires(name) or []
        except PackageNotFoundError:
            continue  # not installed on this platform
        for spec in specs:
            child = Requirement(spec)
            if child.marker is None or any(
                child.marker.evaluate({"extra": extra}) for extra in (extras or {""})
            ):
                pending.append(child)
    return names


def _imported_top_level_modules() -> set[str]:
    modules: set[str] = set()
    for path in (ROOT / "src").rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(), filename=str(path))):
            if isinstance(node, ast.Import):
                modules.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                modules.add(node.module.split(".")[0])
    return modules - set(sys.stdlib_module_names) - {"src", "__future__"}


def test_every_package_src_imports_is_a_runtime_dependency() -> None:
    runtime = _runtime_closure()
    distributions = packages_distributions()
    missing = {
        module: names
        for module in sorted(_imported_top_level_modules())
        if not (names := distributions.get(module))
        or not any(_normalise(name) in runtime for name in names)
    }
    assert not missing, f"imported by src/ but not a runtime dependency: {missing}"
