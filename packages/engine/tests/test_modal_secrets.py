"""What each Modal container may hold (security fixes plan, items 1 and 2).

The MCP server faces the internet, so it lives in its own app (and its own Modal workspace) with
one secret, `opencmo-mcp`. The worker's secrets (service role, worker token, cron secret, provider
keys) must never be mounted next to it. Read from the source with `ast`: importing the files would
need Modal credentials.
"""

from __future__ import annotations

import ast
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
WORKER_APP = ENGINE / "modal_app.py"
MCP_APP = ENGINE / "mcp_app.py"


def _tree(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _functions(tree: ast.Module) -> dict[str, ast.FunctionDef]:
    return {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}


def _secret_names(tree: ast.AST) -> set[str]:
    """Every `modal.Secret.from_name("…")` in the tree."""
    names = set()
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "from_name"
            and isinstance(node.func.value, ast.Attribute)
            and node.func.value.attr == "Secret"
        ):
            arg = node.args[0]
            assert isinstance(arg, ast.Constant), "secret names are literals"
            names.add(arg.value)
    return names


def _decorator_kwargs(fn: ast.FunctionDef, name: str) -> dict[str, object]:
    for deco in fn.decorator_list:
        if (
            isinstance(deco, ast.Call)
            and isinstance(deco.func, ast.Attribute)
            and deco.func.attr == name
        ):
            return {
                kw.arg: ast.literal_eval(kw.value)
                for kw in deco.keywords
                if isinstance(kw.value, ast.Constant)
            }
    raise AssertionError(f"{fn.name} has no @{name}(…)")


def test_worker_app_has_no_mcp_server():
    assert "mcp_server" not in _functions(_tree(WORKER_APP)), (
        "the MCP server must not run in the worker app"
    )


def test_mcp_app_mounts_only_its_own_secret():
    tree = _tree(MCP_APP)
    assert _secret_names(tree) == {"opencmo-mcp"}
    constants = {
        target.id: node.value.value
        for node in tree.body
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    apps = [
        constants.get(arg.id) if isinstance(arg, ast.Name) else getattr(arg, "value", None)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "App"
        for arg in node.args[:1]
    ]
    assert apps == ["opencmo-mcp"]
    # Not even an import: `modal_app` builds the worker's secret objects at import time.
    imports = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert "modal_app" not in imports


def test_mcp_server_has_a_container_cap():
    fn = _functions(_tree(MCP_APP))["mcp_server"]
    kwargs = _decorator_kwargs(fn, "function")
    assert kwargs.get("max_containers") == 3
    assert kwargs.get("min_containers") == 1


def _code(fn: ast.FunctionDef) -> str:
    """The function without its docstring, which may name what the code must not use."""
    body = fn.body[1:] if ast.get_docstring(fn) else fn.body
    return "\n".join(ast.unparse(node) for node in body)


def test_worker_wake_endpoint_checks_its_own_token():
    source = _code(_functions(_tree(WORKER_APP))["wake"])
    assert "OPENCMO_WAKE_TOKEN" in source
    # Compared through the one bytes-safe helper (review R6: str compare_digest raised on non-ASCII tokens).
    assert "_token_ok(expected, given)" in source
    assert "OPENCMO_WORKER_TOKEN" not in source
    assert "sweep.spawn()" in source


def test_token_check_compares_bytes():
    source = _code(_functions(_tree(WORKER_APP))["_token_ok"])
    assert "compare_digest" in source and ".encode(" in source


def test_cleanup_sends_the_cleanup_secret():
    source = _code(_functions(_tree(WORKER_APP))["cleanup"])
    assert "CRON_CLEANUP_SECRET" in source
    assert "web_config" not in source, "web_config sends CRON_SECRET"
