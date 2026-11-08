#!/usr/bin/env python3
"""Build and audit Soma's standalone arm64 SearXNG runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
VENV_PYTHON = ROOT / ".searxng" / "package-venv312" / "bin" / "python"
OUTPUT = ROOT / "build-resources" / "search"
# arm64 macOS begins at 11.0. Never silently ship a host-OS-only runtime.
MAX_MINIMUM_OS = (11, 0)
MACHO_MAGICS = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}


def build_python() -> Path:
    override = os.environ.get("SOMA_PACKAGE_PYTHON")
    python = Path(override).expanduser() if override else VENV_PYTHON
    if not python.is_absolute():
        python = ROOT / python
    if not python.is_file():
        raise SystemExit(f"Missing packaging Python: {python}. Create .searxng/package-venv312 with portable Python 3.12, or set SOMA_PACKAGE_PYTHON.")
    # Keep the venv path, rather than resolving its interpreter symlink.
    return python.absolute()


def native_audit(bundle: Path) -> dict:
    records = []
    errors = []
    for path in sorted(bundle.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as stream:
            if stream.read(4) not in MACHO_MAGICS:
                continue
        relative = str(path.relative_to(bundle))
        description = subprocess.check_output(["/usr/bin/file", str(path)], text=True)
        if "arm64" not in description:
            errors.append(f"{relative}: missing arm64 architecture")
        commands = subprocess.check_output(["/usr/bin/otool", "-l", str(path)], text=True)
        minima = re.findall(r"\bminos\s+(\d+(?:\.\d+)+)", commands)
        minima += re.findall(r"cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)+)", commands)
        if not minima:
            errors.append(f"{relative}: no macOS deployment target")
        for minimum in minima:
            if tuple(int(part) for part in minimum.split(".")[:2]) > MAX_MINIMUM_OS:
                errors.append(f"{relative}: minimum macOS {minimum} exceeds 11.0")
        links = subprocess.check_output(["/usr/bin/otool", "-L", str(path)], text=True)
        install_ids = re.findall(r"cmd LC_ID_DYLIB\s+cmdsize \d+\s+name (.*?) \(offset", commands)
        dependencies = [line.strip().split(" (", 1)[0] for line in links.splitlines()[1:] if " (" in line and line.strip().split(" (", 1)[0] not in install_ids]
        rpaths = re.findall(r"cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset", commands)
        for dependency in dependencies:
            if dependency.startswith(("/usr/lib/", "/System/Library/")):
                continue
            if dependency.startswith("@loader_path/"):
                candidates = [path.parent / dependency.removeprefix("@loader_path/")]
            elif dependency.startswith("@executable_path/"):
                candidates = [bundle / dependency.removeprefix("@executable_path/")]
            elif dependency.startswith("@rpath/"):
                candidates = [Path(rpath.replace("@loader_path", str(path.parent)).replace("@executable_path", str(bundle))) / dependency.removeprefix("@rpath/") for rpath in rpaths]
            else:
                candidates = []
            if not any(candidate.is_file() and candidate.resolve().is_relative_to(bundle.resolve()) for candidate in candidates):
                errors.append(f"{relative}: unresolved or external dependency {dependency}")
        signed = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(path)], capture_output=True, text=True)
        if signed.returncode:
            errors.append(f"{relative}: code signature verification failed: {signed.stderr.strip()}")
        records.append({"path": relative, "minimumOS": minima, "dependencies": dependencies, "signatureVerified": signed.returncode == 0})
    if not records:
        errors.append("No Mach-O files found")
    maximum = max((minimum for record in records for minimum in record["minimumOS"]), key=lambda value: tuple(map(int, value.split("."))), default=None)
    report = {"architecture": "arm64", "maximumMinimumOS": maximum, "machOCount": len(records), "errors": errors, "binaries": records}
    (bundle / "native-audit.json").write_text(json.dumps(report, indent=2) + "\n")
    if errors:
        raise SystemExit("Packaged native audit failed:\n" + "\n".join(errors))
    print(f"Verified {len(records)} Mach-O files; maximum minimumOS {maximum}; signatures valid; all dependencies bundled or system.")
    return report


def main() -> int:
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("Soma search packaging must run on macOS arm64.")
    python = build_python()
    env = os.environ.copy()
    for name in ("PYTHONPATH", "PYTHONHOME"):
        env.pop(name, None)
    info = json.loads(subprocess.check_output([str(python), "-c", "import json,sys,sysconfig; print(json.dumps({'version': sys.version, 'deploymentTarget': sysconfig.get_config_var('MACOSX_DEPLOYMENT_TARGET')}))"], env=env, text=True))
    if not info["version"].startswith("3.12."):
        raise SystemExit(f"Packaging requires portable CPython 3.12, got {info['version']}")
    if subprocess.run([str(python), "-m", "PyInstaller", "--version"], capture_output=True, env=env).returncode:
        raise SystemExit("PyInstaller is missing; install it in the selected packaging environment.")
    imports = subprocess.run([str(python), "-c", "import lxml.etree, curl_cffi, msgspec, yaml, flask_babel"], capture_output=True, text=True, env=env)
    if imports.returncode:
        raise SystemExit("Packaging native dependencies cannot import. A hardened managed interpreter may need an isolated, ad-hoc signed build copy.\n" + imports.stderr)

    with tempfile.TemporaryDirectory(prefix="soma-search-pyinstaller-") as work:
        command = [
            str(python), "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
            "--target-arch", "arm64", "--name", "soma-search", "--distpath", str(OUTPUT), "--workpath", work,
            "--specpath", work, "--paths", str(ROOT / ".searxng" / "src"),
            "--hidden-import", "searx.webapp", "--hidden-import", "searx.engines",
        ]
        for package in ("dateutil", "curl_cffi", "flask_babel", "babel", "pygments", "lxml", "valkey", "msgspec", "flask", "whitenoise", "yaml", "pytz", "tzdata"):
            command.extend(("--collect-all", package))
        command.extend((
            "--add-data", f"{ROOT / 'server/searxng/settings.yml'}:.",
            # Engine modules are loaded dynamically from this bundled source tree.
            "--add-data", f"{ROOT / '.searxng/src/searx'}:searx",
            str(ROOT / "server/searxng/frozen_entry.py"),
        ))
        completed = subprocess.run(command, cwd=ROOT, env=env)
        if completed.returncode:
            return completed.returncode

    bundle = OUTPUT / "soma-search"
    executable = bundle / "soma-search"
    if not executable.is_file():
        raise SystemExit(f"PyInstaller did not produce the expected executable: {executable}")
    native_audit(bundle)
    (bundle / "runtime.json").write_text(json.dumps({"python": info, "requirements": (ROOT / ".searxng/src/requirements.txt").read_text().splitlines()}, indent=2) + "\n")
    print(f"Packaged standalone search runtime: {executable}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
